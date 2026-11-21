"""量具：把一张截图里的文字按"纵向位置"分带报出来。

用法：
  python ocr_bands.py <图片路径> [带数]

为什么需要它：ocr 服务只回文本、不回坐标，所以"文字在哪一条带里"根本无从判断。
之前拍脑袋定"底部 30%"，第一次实测就落空（那部片的字在中间偏左）。
这个工具直接给坐标，让"裁哪一条"变成看数据决定，而不是猜。
"""
import sys

import numpy as np
from rapidocr import RapidOCR

engine = RapidOCR()


def run(path, bands=10):
    res = engine(path)
    boxes = getattr(res, "boxes", None)
    txts = getattr(res, "txts", None) or []
    if boxes is None or len(boxes) == 0:
        print("没检测到文字")
        return

    ys = [[p[1] for p in box] for box in boxes]
    top, bottom = min(min(y) for y in ys), max(max(y) for y in ys)
    span = max(1.0, bottom - top)

    buckets = {}
    for box, text in zip(boxes, txts):
        if not text:
            continue
        y0 = min(p[1] for p in box)
        rel = (y0 - top) / span
        idx = min(bands - 1, int(rel * bands))
        buckets.setdefault(idx, []).append(text.strip())

    print(f"画面文字纵向分布（共 {len(txts)} 行，{bands} 等分）")
    for i in range(bands):
        lo, hi = i / bands, (i + 1) / bands
        items = buckets.get(i, [])
        bar = "#" * min(40, len(items) * 4)
        head = f"{lo:.2f}-{hi:.2f} {bar:<40} {len(items)} 行"
        print(head)
        for t in items[:3]:
            print(f"          · {t[:50]}")
    print()
    print("怎么用：挑字数最多的那几条带的上下界，填进 src/ocr.mjs 的 bands")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    run(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 10)
