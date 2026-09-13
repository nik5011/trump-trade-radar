"""從 OGE 278-T PDF 抽出交易明細，轉成 App 可匯入的 CSV。

這些 PDF 是「掃描後 OCR」的檔案，文字有雜訊，但有固定結構：

    33 LAUDER ESTEE COS INC Cl A sale 4/17/2026 Yos $50 001 • $100 000
    │  └── 資產描述 ──────────┘ └類型┘ └─日期─┘ └是/否┘ └── 金額區間 ──┘

處理策略：
 1. 日期用「後面接著 Yes/No 欄位」來定位（描述裡可能出現 12/31/49 這種到期日）。
 2. 金額先移除空白再切分（OCR 會把千分位逗號變成空白：「$250 001」= $250,001）。
 3. 買賣別用模糊比對分類，並輸出未知詞彙清單供人工確認。
 4. 資產描述用 ticker-seed.json（第三方整理的 OGE 別名表）解析成股票代號。

用法：
    python scripts/extract-oge-transactions.py --seed data/external/ticker-seed.json \
        --index data/oge/index.json --out data/oge/transactions.csv
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
from collections import Counter
from difflib import SequenceMatcher

import pdfplumber

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 交易日期後面一定接著 Yes/No 欄位，用這個定位可避開描述中的到期日
ROW_RE = re.compile(
    r"^\s*(\d{1,4})\s+(?P<desc>.+?)\s+(?P<type>[A-Za-z0-9'’:.\[\]|()]{3,14})\s+"
    r"(?P<date>\d{1,2}/\d{1,2}/\d{2,4})\s+"
    r"(?P<notif>[YVNynv][A-Za-z0-9]{0,3})\s+"
    r"(?P<amount>.+?)\s*$"
)

# 買賣別：OCR 會把首字母 p 誤判成 l/D/N/1/ID 等，但字根 rch/se 通常保留
BUY_MARKERS = ("urchas", "urchas", "urchao", "urchas", "urchase")
SELL_MARKERS = ("sale", "salo", "sa1e", "sale", "se11", "sale")


def norm_desc(text: str) -> str:
    """正規化描述：只留英數，用來比對別名。"""
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def classify_type(token: str) -> str | None:
    """把 OCR 雜訊的類型欄位分成 BUY / SELL；無法判斷回 None。"""
    t = re.sub(r"[^A-Za-z]", "", (token or "")).lower()
    if not t:
        return None
    if any(m in t for m in BUY_MARKERS) or "rch" in t:
        return "BUY"
    if any(m in t for m in SELL_MARKERS) or re.fullmatch(r"[a-z]*s[a-z]?[a-z]?l[a-z]*", t):
        return "SELL"
    # 最後用相似度判斷長度差異（purchase 8 字母、sale 4 字母）
    r_buy = SequenceMatcher(None, t, "purchase").ratio()
    r_sell = SequenceMatcher(None, t, "sale").ratio()
    if max(r_buy, r_sell) >= 0.45:
        return "BUY" if r_buy >= r_sell else "SELL"
    return None


def parse_amount(text: str) -> tuple[int, int] | None:
    """解析金額區間；OCR 會把千分位逗號變成空白。"""
    if not text:
        return None
    cleaned = re.sub(r"[\s\u00a0]", "", text)
    nums = re.findall(r"\d[\d,]{2,}", cleaned)
    values = []
    for n in nums:
        v = int(n.replace(",", ""))
        if v >= 100:
            values.append(v)
    if not values:
        return None
    if len(values) == 1:
        return values[0], values[0]
    return min(values[0], values[1]), max(values[0], values[1])


def parse_row(line: str):
    m = ROW_RE.match(line)
    if not m:
        return None
    amount = parse_amount(m.group("amount"))
    if not amount:
        return None
    side = classify_type(m.group("type"))
    return {
        "rowNumber": int(m.group(1)),
        "description": m.group("desc").strip(),
        "typeToken": m.group("type"),
        "side": side,
        "date": m.group("date"),
        "notification": m.group("notif"),
        "amountMin": amount[0],
        "amountMax": amount[1],
    }


def to_iso(date_text: str) -> str:
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", date_text)
    if not m:
        return date_text
    mm, dd, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yy < 100:
        yy += 2000
    return f"{yy:04d}-{mm:02d}-{dd:02d}"


class Resolver:
    """用 ticker-seed 的別名表把 OGE 描述解析成股票代號。"""

    def __init__(self, seed: dict):
        self.entries = []
        self.by_first = {}
        for ticker, info in seed.items():
            names = [info.get("name", "")] + list(info.get("aliases") or [])
            for name in names:
                key = norm_desc(name)
                if len(key) < 4:
                    continue
                self.entries.append((key, ticker, info.get("name", ""), info.get("sector", "")))
                self.by_first.setdefault(key[:4], []).append((key, ticker, info.get("name", ""), info.get("sector", "")))
        self.fuzzy_cache = {}

    def resolve(self, description: str):
        key = norm_desc(description)
        if not key:
            return None
        cache = self.fuzzy_cache.get(key)
        if cache is not None:
            return cache

        # 1) 完全相同
        for cand_key, ticker, name, sector in self.entries:
            if cand_key == key:
                result = (ticker, name, sector, 1.0)
                self.fuzzy_cache[key] = result
                return result

        # 2) 短名單模糊比對：先用前 4 碼過濾，找不到再退而求其次
        pool = self.by_first.get(key[:4])
        if not pool:
            pool = self.by_first.get(key[:3]) or self.entries
        best = None
        for cand_key, ticker, name, sector in pool:
            # 便宜的長度過濾，避免大量 SequenceMatcher
            if abs(len(cand_key) - len(key)) > 14:
                continue
            ratio = SequenceMatcher(None, key, cand_key).ratio()
            if best is None or ratio > best[3]:
                best = (ticker, name, sector, ratio)
        if best and best[3] >= 0.82:
            self.fuzzy_cache[key] = best
            return best
        self.fuzzy_cache[key] = None
        return None


def load_filing_dates(index_path: str) -> dict:
    """從 index.json 取得每個 PDF 對應的 OGE 公開日（docDate）。"""
    if not index_path or not os.path.exists(index_path):
        return {}
    with open(index_path, encoding="utf-8") as fh:
        index = json.load(fh)
    out = {}
    for f in index.get("files", []):
        local = os.path.basename(f.get("localPath", ""))
        if local:
            out[local] = f.get("docDate")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default="data/external/ticker-seed.json")
    ap.add_argument("--index", default="data/oge/index.json")
    ap.add_argument("--dir", default="data/oge")
    ap.add_argument("--out", default="data/oge/transactions.csv")
    ap.add_argument("--min-ratio", type=float, default=0.0, help="只輸出解析信心高於此值的資料（0=全部）")
    args = ap.parse_args()

    with open(args.seed, encoding="utf-8") as fh:
        seed = json.load(fh)
    resolver = Resolver(seed)
    print(f"載入 ticker 別名表：{len(seed)} 檔標的、{len(resolver.entries)} 組別名")

    filing_dates = load_filing_dates(args.index)
    files = sorted(glob.glob(os.path.join(args.dir, "*.pdf")))
    print(f"待處理 PDF：{len(files)} 份\n")

    rows = []
    unknown_types = Counter()
    per_file = []

    for path in files:
        name = os.path.basename(path)
        doc_date = filing_dates.get(name)
        parsed = 0
        unresolved = 0
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                for line in text.split("\n"):
                    row = parse_row(line)
                    if not row:
                        continue
                    parsed += 1
                    if row["side"] is None:
                        unknown_types[row["typeToken"]] += 1
                    hit = resolver.resolve(row["description"])
                    if hit:
                        ticker, company, sector, ratio = hit
                    else:
                        ticker, company, sector, ratio = None, row["description"], "", 0.0
                        unresolved += 1
                    rows.append(
                        {
                            "tradeDate": to_iso(row["date"]),
                            "filedDate": doc_date or "",
                            "ticker": ticker or "",
                            "company": company,
                            "sector": sector,
                            "side": row["side"] or "",
                            "amountMin": row["amountMin"],
                            "amountMax": row["amountMax"],
                            "description": row["description"],
                            "matchRatio": round(ratio, 3),
                            "rowNumber": row["rowNumber"],
                            "sourceFile": name,
                        }
                    )
        per_file.append((name, parsed, unresolved, doc_date))
        print(f"  {name[:46]:<48} 解析 {parsed:>5} 列  未對應 {unresolved:>4}  公開日 {doc_date or '?'}")

    resolved = [r for r in rows if r["ticker"]]
    unknown_side = [r for r in rows if not r["side"]]
    print(f"\n總計：{len(rows)} 列；已對應股票 {len(resolved)} 列（{len(resolved) / max(1, len(rows)) * 100:.1f}%）；"
          f"買賣別未判定 {len(unknown_side)} 列")

    if unknown_types:
        print("\n未判定的買賣別詞彙（前 20 個）：")
        for token, count in unknown_types.most_common(20):
            print(f"  {count:>5}  {token}")

    bad_ratio = [r for r in resolved if r["matchRatio"] < 0.85]
    if bad_ratio:
        print(f"\n低信心對應（<0.85）：{len(bad_ratio)} 列，例如：")
        for r in bad_ratio[:8]:
            print(f"  {r['matchRatio']}  {r['description'][:46]:<48} → {r['ticker']}")

    out_rows = [r for r in rows if r["ticker"] and r["side"] and r["matchRatio"] >= args.min_ratio]
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "tradeDate", "filedDate", "ticker", "company", "sector", "side",
                "amountMin", "amountMax", "description", "matchRatio", "rowNumber", "sourceFile",
            ],
        )
        writer.writeheader()
        writer.writerows(out_rows)
    print(f"\n已寫出 {len(out_rows)} 列到 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
