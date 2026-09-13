"""檢查 data/oge 下每份 PDF 是否有可抽取的文字層（判斷哪些能直接解析、哪些需要 OCR）。

用法：python scripts/check-pdf-text.py
"""

import glob
import os
import sys

import pdfplumber

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

files = sorted(glob.glob(os.path.join("data", "oge", "*.pdf")))
if not files:
    print("data/oge 底下沒有 PDF，請先執行：node scripts/fetch-oge-filings.mjs --download")
    raise SystemExit(1)

print(f"{'檔案':<52} {'頁數':>5} {'總字元':>9} {'有文字的頁':>9}  判定")
print("-" * 100)

summary = {"text": [], "scanned": []}
for path in files:
    name = os.path.basename(path)
    try:
        with pdfplumber.open(path) as pdf:
            total_pages = len(pdf.pages)
            total_chars = 0
            pages_with_text = 0
            for page in pdf.pages:
                chars = len(page.extract_text() or "")
                total_chars += chars
                if chars > 200:
                    pages_with_text += 1
    except Exception as exc:  # noqa: BLE001
        print(f"{name[:50]:<52} {'-':>5} {'-':>9} {'-':>9}  開啟失敗：{exc}")
        continue

    if pages_with_text >= max(2, total_pages // 4):
        verdict = "可解析文字"
        summary["text"].append(name)
    elif pages_with_text:
        verdict = "少量文字（混合）"
        summary["text"].append(name)
    else:
        verdict = "掃描影像（需 OCR）"
        summary["scanned"].append(name)
    print(f"{name[:50]:<52} {total_pages:>5} {total_chars:>9} {pages_with_text:>9}  {verdict}")

print("-" * 100)
print(f"可直接解析：{len(summary['text'])} 份")
for n in summary["text"]:
    print(f"  ✓ {n}")
print(f"需 OCR：{len(summary['scanned'])} 份")
