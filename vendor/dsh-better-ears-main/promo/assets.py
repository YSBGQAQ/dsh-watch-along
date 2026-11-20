"""Write the Bilibili-ready SRT + the cover image for the promo."""
from __future__ import annotations

import sys

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, ".")

from render import (  # noqa: E402
    BG0, BG1, BLUE, BORDER, CARD, CYAN, DIM, FAINT, GREEN, TEXT,
    alpha, draw_mixed, font, mix, mixed_width,
)

SPEECH = [
    (0.35, 7.94, ["你让大模型听一段音频，它只会说：抱歉，我看不到声音。", "因为它没有耳朵。"]),
    (10.35, 10.10, ["现在，给它装上 better ears。", "七个本地工具，把声音变成能读的文字和数字。", "不联网，也不花钱。"]),
    (21.05, 10.46, ["先看人声。", "切掉音乐和静音，只把有人声的片段送去识别。", "每一句都带时间戳，还能直接导出字幕。"]),
    (33.55, 10.97, ["音乐也一样。", "速度、拍点、调性、和弦根音、段落结构，一次全给你。", "哪段是重复的，也会标出来。"]),
    (45.95, 6.22, ["拿不准的时候，它会说「可能是 90」，", "而不是随便编一个数字。"]),
    (53.55, 5.52, ["做视频最关心的卡点：", "一段六刀全中，另一段只中三成。"]),
    (61.35, 5.78, ["口播视频不看拍子，", "看切点有没有落在说话的停顿之间。"]),
    (68.75, 7.68, ["七个工具，全部本地运行，音频不出门。", "装上它，让 agent 真正听见。"]),
]


def stamp(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path: str) -> None:
    cues = []
    for start, dur, clauses in SPEECH:
        total = sum(len(c) for c in clauses)
        t = start
        for i, c in enumerate(clauses):
            share = dur * len(c) / total
            end = t + share - (0.10 if i < len(clauses) - 1 else 0)
            cues.append((t, end, c))
            t += share
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, text) in enumerate(cues, 1):
            f.write(f"{i}\n{stamp(a)} --> {stamp(b)}\n{text}\n\n")
    print(path, len(cues), "cues")


W, H = 1146, 717


def cover(path: str) -> None:
    img = Image.new("RGB", (W, H), BG0)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=mix(BG0, BG1, y / H * 1.2))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-260, 260, 520, 900], fill=(16, 64, 66))
    gd.ellipse([W - 380, -260, W + 260, 320], fill=(14, 30, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.blend(img, Image.blend(img, glow, 0.6), 0.7)
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        gd.line([(x, 0), (x, H)], fill=(130, 180, 210, 12))
    for y in range(0, H, 48):
        gd.line([(0, y), (W, y)], fill=(130, 180, 210, 12))
    img = Image.alpha_composite(img.convert("RGBA"), grid).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")

    # top-left brand
    for i, hh in enumerate((10, 19, 13)):
        d.rounded_rectangle([54 + i * 8, 66 - hh, 58 + i * 8, 66], radius=2, fill=alpha(CYAN, 0.95))
    d.text((84, 66), "dsh-better-ears", font=font("cjk_sb", 22), fill=alpha(TEXT, 0.95), anchor="ls")
    d.text((84 + font("cjk_sb", 22).getlength("dsh-better-ears") + 14, 66), "DeepSeek Harness", font=font("cjk", 18), fill=alpha(DIM, 0.9), anchor="ls")

    # badge
    bw = mixed_width("实机演示 · 全本地", 19) + 62
    d.rounded_rectangle([W - 46 - bw, 44, W - 46, 88], radius=22, fill=(18, 32, 36, 235), outline=alpha(CYAN, 0.45), width=2)
    d.ellipse([W - 46 - bw + 18, 60, W - 46 - bw + 30, 72], fill=alpha(CYAN, 0.95))
    draw_mixed(d, W - 46 - bw + 40, 73, "实机演示 · 全本地", 19, alpha(CYAN, 0.95))

    # headline
    d.text((56, 214), "给 agent", font=font("cjk_sb", 62), fill=alpha(TEXT, 0.97), anchor="ls")
    d.text((56, 300), "一双耳朵", font=font("cjk_sb", 86), fill=alpha(CYAN, 0.98), anchor="ls")
    draw_mixed(d, 60, 372, "dsh-better-ears · 语音转写 / 音乐分析 / 镜头卡点", 25, (206, 222, 238, 250))
    draw_mixed(d, 60, 414, "七个工具，一条命令，音频不离开本机", 21, (140, 156, 180, 245))

    # beat strip graphic
    sx, sy, sw, sh = 60, 486, 620, 96
    d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=16, fill=(12, 19, 32, 245), outline=(40, 55, 78, 235))
    span = 8.0
    n = 16
    for i in range(n + 1):
        bx = sx + i * (sw - 32) / n + 16
        major = i % 4 == 0
        d.line([(bx, sy + 20), (bx, sy + sh - 20)], fill=alpha(CYAN if major else FAINT, 0.55 if major else 0.28), width=2 if major else 1)
    for ct in (1.0, 2.0, 3.0, 5.0, 6.0):
        bx = sx + 16 + (ct / span) * (sw - 32)
        d.polygon([(bx, sy + 16), (bx - 8, sy + 2), (bx + 8, sy + 2)], fill=alpha(GREEN, 0.95))
        d.line([(bx, sy + 16), (bx, sy + sh - 14)], fill=alpha(GREEN, 0.5), width=2)
    d.text((sx + 22, sy + sh - 8), "100% 切点落在拍上", font=font("cjk", 17), fill=alpha(GREEN, 0.92), anchor="ls")

    # terminal chip
    tx, ty = 700, 470
    d.rounded_rectangle([tx, ty, W - 56, ty + 150], radius=16, fill=(12, 19, 32, 245), outline=(40, 55, 78, 235))
    draw_mixed(d, tx + 22, ty + 40, "$ audio_read mv.mp4", 19, alpha(CYAN, 0.95))
    draw_mixed(d, tx + 22, ty + 78, "音乐 · E major · 4 段", 23, (232, 241, 250, 252))
    draw_mixed(d, tx + 22, ty + 112, "180 BPM（⚠ 也可能 90）", 20, (255, 205, 150, 250))

    # footer
    draw_mixed(d, 60, H - 46, "开源插件 · 装在 DeepSeek Harness 设置里", 19, (128, 144, 168, 240))
    img.save(path, quality=95)
    print(path)


if __name__ == "__main__":
    write_srt("out/dsh-better-ears-promo.srt")
    cover("out/dsh-better-ears-cover.png")
