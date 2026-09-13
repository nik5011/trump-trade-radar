"""檢視 OGE 278-T PDF 的結構（頁數、表格、文字行），用來設計解析器。

用法：
    python scripts/inspect-oge-pdf.py data/oge/xxx.pdf [--pages 3] [--tables]
"""

import argparse
import sys

import pdfplumber


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pages", type=int, default=2, help="要檢視的頁數")
    ap.add_argument("--tables", action="store_true", help="嘗試列出表格")
    ap.add_argument("--chars", type=int, default=2600, help="每頁最多印幾個字元")
    args = ap.parse_args()

    with pdfplumber.open(args.pdf) as pdf:
        print(f"檔案：{args.pdf}")
        print(f"頁數：{len(pdf.pages)}")
        first = pdf.pages[0]
        print(f"頁面尺寸：{first.width} x {first.height}")

        for i in range(min(args.pages, len(pdf.pages))):
            page = pdf.pages[i]
            print("\n" + "=" * 90)
            print(f"第 {i + 1} 頁文字")
            print("=" * 90)
            text = page.extract_text() or ""
            print(text[: args.chars])

            if args.tables:
                tables = page.extract_tables()
                print(f"\n--- 第 {i + 1} 頁偵測到 {len(tables)} 個表格 ---")
                for ti, tb in enumerate(tables):
                    print(f"表格 {ti}：{len(tb)} 列 x {len(tb[0]) if tb else 0} 欄")
                    for row in tb[:6]:
                        print("   ", [(c or "").replace("\n", " ")[:38] for c in row])

        full = ""
        for page in pdf.pages[: min(10, len(pdf.pages))]:
            full += page.extract_text() or ""
        print("\n" + "=" * 90)
        print("關鍵字統計（前 10 頁）")
        for kw in ["Transaction", "Buy", "Sell", "Amount", "Date of Transaction", "Description of Asset"]:
            print(f"  {kw:24} {full.count(kw)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
