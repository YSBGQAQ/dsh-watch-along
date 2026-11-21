"""整屏 OCR 循环：只回答一个问题——**屏幕上的字幕，OCR 能读多准**。

不碰窗口矩形、不算 DPI：抓整屏，裁下方 40%，直接识别。
字幕在屏幕上的相对位置比"窗口内"稳定，也不会因为窗口边框/缩放而偏移。

用法：
  python ocr_screen_loop.py [间隔秒=4] [分钟=3]

输出：每帧一行文本；同时把每帧存到 .scratch/run/ocr/<序号>.png 供事后对照。
"""
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".scratch", "run", "ocr")
TMP = os.path.join(ROOT, ".scratch", "run", "screen_tmp.png")

engine = RapidOCR()


def grab():
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "gdigrab",
         "-framerate", "1", "-i", "desktop", "-frames:v", "1", "-y", TMP],
        check=False,
    )
    return os.path.exists(TMP)


def main():
    gap = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
    minutes = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0
    os.makedirs(OUT, exist_ok=True)

    deadline = time.time() + minutes * 60
    n = 0
    while time.time() < deadline:
        n += 1
        if not grab():
            print(f"[{n}] 抓屏失败（ffmpeg 不在 PATH？）", flush=True)
            time.sleep(gap)
            continue
        im = Image.open(TMP)
        W, H = im.size
        band = im.crop((0, int(H * 0.60), W, H))  # 下方 40%
        band.save(os.path.join(OUT, f"{n:03d}.png"))
        r = engine(np.array(band.convert("RGB"))[:, :, ::-1])
        txt = " | ".join([t for t in (getattr(r, "txts", []) or []) if t.strip()])
        print(f"[{n}] {txt[:110] or '(空)'}", flush=True)
        time.sleep(gap)
    print(f"完成 {n} 帧 → {OUT}")


if __name__ == "__main__":
    main()
