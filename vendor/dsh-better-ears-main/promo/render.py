"""Render the dsh-better-ears promo: 1920x1080 @ 30 fps, silent video on stdout.

Usage:  python render.py | ffmpeg -f rawvideo -pix_fmt rgb24 -s 1920x1080 -r 30 -i - ...
Every number on screen was produced by the real plugin (see README of the promo).
"""
from __future__ import annotations

import math
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
DUR = 78.0

PING = "/System/Library/Fonts/PingFang.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"

BG0 = (7, 10, 18)
BG1 = (12, 19, 33)
CARD = (15, 21, 36)
CARD_HI = (20, 29, 48)
BORDER = (36, 49, 70)
TEXT = (233, 239, 248)
DIM = (139, 152, 172)
FAINT = (92, 104, 124)
CYAN = (72, 226, 200)
BLUE = (112, 168, 254)
AMBER = (255, 186, 110)
RED = (255, 112, 133)
GREEN = (127, 232, 138)

FONTS: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    key = (kind, size)
    if key in FONTS:
        return FONTS[key]
    if kind == "mono":
        f = ImageFont.truetype(MENLO, size)
    elif kind == "mono_b":
        f = ImageFont.truetype(MENLO, size, index=1)
    elif kind == "cjk":
        f = ImageFont.truetype(PING, size, index=2)
    elif kind == "cjk_m":
        f = ImageFont.truetype(PING, size, index=5)
    elif kind == "cjk_sb":
        try:
            f = ImageFont.truetype(PING, size, index=8)
        except Exception:
            f = ImageFont.truetype(PING, size, index=5)
    else:
        raise ValueError(kind)
    FONTS[key] = f
    return f


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def ease(t: float) -> float:
    t = clamp01(t)
    return t * t * (3 - 2 * t)


def ease_out(t: float) -> float:
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1, c2, t: float):
    t = clamp01(t)
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(3))


def alpha(c, a: float):
    return (c[0], c[1], c[2], int(round(255 * clamp01(a))))


_GLYPHS: dict[tuple[str, int, str], bool] = {}


def glyph_ok(kind: str, size: int, ch: str) -> bool:
    key = (kind, size, ch)
    hit = _GLYPHS.get(key)
    if hit is None:
        try:
            hit = font(kind, size).getmask(ch).getbbox() is not None
        except Exception:
            hit = False
        _GLYPHS[key] = hit
    return hit


def segments(s: str, size: int, cjk: str, mono: str):
    """Split into (font_kind, chunk) runs; characters the CJK face lacks fall back to mono."""
    out: list[tuple[str, str]] = []
    for ch in s:
        if ord(ch) < 128:
            kind = mono
        elif glyph_ok(cjk, size, ch):
            kind = cjk
        elif glyph_ok(mono, size, ch):
            kind = mono
        else:
            kind = cjk
        if out and out[-1][0] == kind:
            out[-1] = (kind, out[-1][1] + ch)
        else:
            out.append((kind, ch))
    return out


def mixed_width(s: str, size: int, cjk: str = "cjk", mono: str = "mono") -> float:
    return sum(font(k, size).getlength(chunk) for k, chunk in segments(s, size, cjk, mono))


def draw_mixed(d, x, y, s, size, fill, cjk="cjk", mono="mono", baseline=True):
    cx = x
    for kind, chunk in segments(s, size, cjk, mono):
        f = font(kind, size)
        d.text((cx, y), chunk, font=f, fill=fill, anchor="ls" if baseline else "la")
        cx += f.getlength(chunk)
    return cx


def wrap_mixed(s: str, size: int, maxw: float, cjk="cjk", mono="mono"):
    lines, cur = [], ""
    for ch in s:
        trial = cur + ch
        if mixed_width(trial, size, cjk, mono) > maxw and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def make_bg():
    img = Image.new("RGB", (W, H), BG0)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=mix(BG0, BG1, y / H * 1.1))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-380, -520, 780, 520], fill=(14, 52, 58))
    gd.ellipse([W - 620, H - 520, W + 420, H + 460], fill=(12, 26, 58))
    glow = glow.filter(ImageFilter.GaussianBlur(190))
    img = Image.blend(img, Image.blend(img, glow, 0.55), 0.6)
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 64):
        gd.line([(x, 0), (x, H)], fill=(120, 170, 200, 10))
    for y in range(0, H, 64):
        gd.line([(0, y), (W, y)], fill=(120, 170, 200, 10))
    img = Image.alpha_composite(img.convert("RGBA"), grid).convert("RGB")
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([-W * 0.22, -H * 0.3, W * 1.22, H * 1.3], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(240))
    dark = Image.blend(img, Image.new("RGB", (W, H), (2, 3, 6)), 0.55)
    return Image.composite(img, dark, mask)


BG = make_bg()


def frame_bg(t: float) -> Image.Image:
    img = BG.copy()
    # slow drifting highlight
    d = ImageDraw.Draw(img, "RGBA")
    y = 180 + 40 * math.sin(t * 0.6)
    d.ellipse([1400 + 30 * math.sin(t * 0.4), y - 240, 2100, y + 260], fill=(40, 190, 180, 12))
    return img


def draw_brand(img, t, scene_label=""):
    d = ImageDraw.Draw(img, "RGBA")
    x, y = 84, 62
    # logo mark: three bars
    for i, hh in enumerate((14, 26, 18)):
        d.rounded_rectangle([x + i * 10, y + 22 - hh, x + i * 10 + 6, y + 22], radius=3, fill=alpha(CYAN, 0.95))
    name_font = font("cjk_sb", 27)
    d.text((x + 40, y + 24), "dsh-better-ears", font=name_font, fill=alpha(TEXT, 0.92), anchor="ls")
    nx = x + 40 + name_font.getlength("dsh-better-ears") + 18
    d.text((nx, y + 24), "DeepSeek Harness 音频分析插件", font=font("cjk", 21), fill=alpha(DIM, 0.9), anchor="ls")
    if scene_label:
        w = mixed_width(scene_label, 19)
        bx = W - 84 - w - 34
        d.rounded_rectangle([bx, 46, W - 84, 88], radius=21, fill=(18, 30, 34, 210), outline=alpha(CYAN, 0.35))
        d.ellipse([bx + 14, 62, bx + 24, 72], fill=alpha(CYAN, 0.95))
        draw_mixed(d, bx + 34, 74, scene_label, 19, alpha(CYAN, 0.95))


CAPTIONS = [
    (0.0, 7.94, "你让大模型听一段音频，它只会说：抱歉，我看不到声音。"),
    (10.0, 10.10, "现在，给它装上 better ears。七个本地工具，把声音变成能读的文字和数字。"),
    (20.7, 10.45, "先看人声：切掉音乐和静音，只识别有人说话的地方。"),
    (33.2, 10.95, "音乐也一样——速度、拍点、调性、和弦、段落结构。"),
    (45.6, 6.2, "拿不准的时候，它会说「可能是 90」，而不是随便编一个数字。"),
    (53.2, 5.5, "做视频最关心的卡点：一段六刀全中，另一段只中三成。"),
    (61.0, 5.75, "口播视频不看拍子，看切点有没有落在说话的停顿之间。"),
    (68.4, 7.65, "七个工具，全部本地运行，音频不出门。"),
]

CAP_Y = 1004


def draw_caption(img, t):
    for start, dur, text in CAPTIONS:
        if start - 0.05 <= t <= start + dur:
            local = t - start
            a = ease(local / 0.35) * (1 - ease((local - dur + 0.35) / 0.35))
            if a <= 0.01:
                return
            d = ImageDraw.Draw(img, "RGBA")
            size = 33
            lines = wrap_mixed(text, size, 1560)
            total_h = len(lines) * 46
            top = CAP_Y - total_h / 2 + 12
            maxw = max(mixed_width(s, size) for s in lines)
            bx0 = (W - maxw) / 2 - 34
            bx1 = (W + maxw) / 2 + 34
            d.rounded_rectangle([bx0, top - 30, bx1, top + total_h + 8], radius=16, fill=(6, 9, 16, int(150 * a)))
            for i, s in enumerate(lines):
                x = W / 2 - mixed_width(s, size) / 2
                draw_mixed(d, x, top + i * 46 + 26, s, size, (240, 245, 252, int(248 * a)))
            return


# ---------------------------------------------------------------- scene 1: hook
CHAT = [
    ("user", "帮我看看这段音频说了什么？", 1.15),
    ("dots", "", 3.0),
    ("ai", "抱歉，我看不到声音。", 4.0),
]


def scene_hook(t, dur):
    img = frame_bg(t)
    chat = img.copy()
    d = ImageDraw.Draw(chat, "RGBA")
    appear = ease((t - 0.75) / 0.6)
    cw, ch = 1080, 380
    cx, cy = (W - cw) / 2, lerp(300, 258, appear)
    if appear > 0.01:
        d.rounded_rectangle([cx, cy + 10, cx + cw, cy + ch + 10], radius=26, fill=(0, 0, 0, int(90 * appear)))
        d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=26, fill=alpha(CARD, appear), outline=(44, 60, 84, int(200 * appear)))
        for i, c in enumerate(((255, 106, 106), (255, 196, 96), (96, 214, 120))):
            d.ellipse([cx + 26 + i * 22, cy + 24, cx + 38 + i * 22, cy + 36], fill=alpha(c, 0.75 * appear))
        d.line([cx, cy + 58, cx + cw, cy + 58], fill=(40, 54, 76, int(170 * appear)))
    # user bubble (right)
    if t >= 1.15:
        a = ease((t - 1.15) / 0.45)
        bw = mixed_width(CHAT[0][1], 30) + 70
        bx = cx + cw - 60 - bw
        by = cy + 96 + (1 - a) * 18
        d.rounded_rectangle([bx, by, bx + bw, by + 68], radius=22, fill=(31, 58, 92, int(235 * a)))
        draw_mixed(d, bx + 34, by + 45, CHAT[0][1], 30, (226, 238, 250, int(255 * a)))
    # typing dots
    if 3.0 <= t < 4.0:
        a = ease((t - 3.0) / 0.3)
        bx, by = cx + 60, cy + 196
        d.rounded_rectangle([bx, by, bx + 116, by + 58], radius=18, fill=(24, 34, 52, int(220 * a)))
        for i in range(3):
            ph = (t * 2.6 + i * 0.33) % 1.0
            r = 6 + 3 * math.sin(ph * math.pi)
            d.ellipse([bx + 30 + i * 26 - r, by + 29 - r, bx + 30 + i * 26 + r, by + 29 + r], fill=alpha(DIM, a * (0.45 + 0.55 * math.sin(ph * math.pi))))
    # ai bubble
    if t >= 4.0:
        a = ease((t - 4.0) / 0.5)
        bx, by = cx + 60, cy + 186 + (1 - a) * 16
        bw = mixed_width(CHAT[2][1], 30) + 70
        d.rounded_rectangle([bx, by, bx + bw, by + 74], radius=20, fill=(24, 33, 50, int(225 * a)))
        draw_mixed(d, bx + 34, by + 48, CHAT[2][1], 30, (198, 210, 226, int(255 * a)))
    if t >= 5.5:
        a = ease((t - 5.5) / 0.35)
        bw = mixed_width(CHAT[2][1], 30) + 70
        bx, by = cx + 60, cy + 186
        d.line([bx + 28, by + 44, bx + 28 + bw - 60, by + 44], fill=(255, 96, 118, int(220 * a)), width=3)
        lx = bx + bw + 22
        d.line([lx, by + 22, lx + 26, by + 52], fill=(255, 96, 118, int(230 * a)), width=5)
        d.line([lx + 26, by + 22, lx, by + 52], fill=(255, 96, 118, int(230 * a)), width=5)
    chat_a = 1 - ease((t - 6.0) / 0.5)
    img = Image.blend(img, chat, chat_a)
    # title reveal
    if t >= 6.15:
        d = ImageDraw.Draw(img, "RGBA")
        a = ease((t - 6.15) / 0.7)
        slide = (1 - a) * 34
        ty = 690 + slide
        draw_mixed(d, W / 2 - mixed_width("dsh-better-ears", 92, mono="mono_b") / 2, ty, "dsh-better-ears", 92, (240, 248, 255, int(255 * a)), mono="mono_b")
        sub = "给 agent 一双耳朵"
        draw_mixed(d, W / 2 - mixed_width(sub, 38) / 2, ty + 70, sub, 38, alpha(CYAN, a * 0.95))
        cap = "DeepSeek Harness 插件 · 语音 / 音乐 / 视频声音"
        draw_mixed(d, W / 2 - mixed_width(cap, 24) / 2, ty + 122, cap, 24, (150, 164, 184, int(230 * a)))
        wf = 260 * a
        for i in range(41):
            ph = t * 2.4 + i * 0.42
            hh = (10 + 30 * abs(math.sin(ph)) * abs(math.sin(i * 0.31))) * a
            xx = W / 2 - wf + i * (wf * 2 / 40)
            d.rounded_rectangle([xx - 3, ty + 176 - hh / 2, xx + 3, ty + 176 + hh / 2], radius=3, fill=alpha(CYAN, 0.55 * a))
    draw_brand(img, t)
    return img


# ------------------------------------------------------------ scene 2: 7 tools
TOOLS = [
    ("audio_read", "一次听全：语音/节奏/调性/结构"),
    ("audio_speech", "逐句转写 · 时间戳 · 导出 SRT"),
    ("audio_rhythm", "BPM · 拍点 · 镜头卡点"),
    ("audio_tonal", "调性 · 和弦根音 · 音高线"),
    ("audio_structure", "几段 · 边界 · 像不像"),
    ("audio_probe", "轨道 · 响度 · 静音 · 切点"),
    ("audio_status", "环境自检 · 识别器就绪"),
]


def scene_tools(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((120, 190), "七个工具，各管一件事", font=font("cjk_sb", 44), fill=alpha(TEXT, 0.96), anchor="ls")
    d.text((120, 236), "LLM 自己决定调哪一个；输出是它能读的文字与数字。", font=font("cjk", 24), fill=alpha(DIM, 0.95), anchor="ls")
    tw, th, gap = 404, 150, 24
    x0, y0 = 120, 292
    for i, (name, desc) in enumerate(TOOLS):
        app = ease((t - 0.85 - i * 0.22) / 0.5)
        if app <= 0.001:
            continue
        if i < 4:
            x, y = x0 + i * (tw + gap), y0
        else:
            x, y = x0 + (tw + gap) / 2 + (i - 4) * (tw + gap), y0 + th + gap
        y = y - (1 - app) * 22
        d.rounded_rectangle([x, y, x + tw, y + th], radius=18, fill=(16, 24, 41, int(238 * app)), outline=(40, 56, 80, int(210 * app)))
        d.rounded_rectangle([x, y, x + 5, y + th], radius=3, fill=alpha(CYAN, 0.85 * app))
        d.text((x + 28, y + 52), name, font=font("mono_b", 27), fill=(238, 245, 253, int(255 * app)), anchor="ls")
        for j, ln in enumerate(wrap_mixed(desc, 20, tw - 56)):
            draw_mixed(d, x + 28, y + 88 + j * 27, ln, 20, (140, 155, 176, int(240 * app)))
    # install strip
    ia = ease((t - 7.2) / 0.5)
    if ia > 0.01:
        bx, by, bw, bh = 120, 700, 1680, 96
        d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=16, fill=(9, 14, 24, int(240 * ia)), outline=(38, 54, 76, int(210 * ia)))
        draw_mixed(d, bx + 28, by + 58, "$", 26, alpha(CYAN, ia))
        draw_mixed(d, bx + 52, by + 58, "plugin install dsh-better-ears", 26, (214, 226, 240, int(250 * ia)))
        draw_mixed(d, bx + 560, by + 58, "→", 26, alpha(FAINT, ia))
        draw_mixed(d, bx + 590, by + 58, "installed · 7 tools · local only", 26, alpha(GREEN, ia))
        draw_mixed(d, bx + 1120, by + 58, "无 Python 环境 · 复用 DSH 自带识别器", 22, (150, 164, 184, int(220 * ia)))
    draw_brand(img, t, "安装")
    return img


# -------------------------------------------------------------- terminal util
def terminal_card(img, box, title, t_local, lines, t0=0.0, body_size=30, lh=58, cps=70):
    """lines: list of (offset, text, color, kind) — kind: 'cmd' | 'out' | 'ok' | 'warn' | 'dim' | 'big'."""
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0, x1, y1 = box
    d.rounded_rectangle([x0 + 6, y0 + 14, x1 + 6, y1 + 14], radius=22, fill=(0, 0, 0, 95))
    d.rounded_rectangle(box, radius=22, fill=(12, 18, 31, 244), outline=(38, 53, 76, 235))
    d.rounded_rectangle([x0, y0, x1, y0 + 58], radius=22, fill=(17, 25, 41, 250))
    d.rectangle([x0, y0 + 40, x1, y0 + 58], fill=(17, 25, 41, 250))
    d.line([x0, y0 + 58, x1, y0 + 58], fill=(38, 53, 76, 220))
    for i, c in enumerate(((255, 106, 106), (255, 196, 96), (96, 214, 120))):
        d.ellipse([x0 + 24 + i * 22, y0 + 22, x0 + 36 + i * 22, y0 + 34], fill=alpha(c, 0.8))
    draw_mixed(d, x0 + 100, y0 + 36, title, 21, (160, 175, 196, 240))
    y = y0 + 108
    for off, text, color, kind in lines:
        if t_local < t0 + off:
            continue
        a = ease((t_local - t0 - off) / 0.28)
        shown = text
        if kind in ("out", "cmd"):
            full = len(text)
            n = int(clamp01((t_local - t0 - off) / max(0.05, off and 0.55 or 0.4)) * full) if False else full
            shown = text
        yy = y
        if kind == "cmd":
            draw_mixed(d, x0 + 40, yy, "$", body_size, alpha(CYAN, a))
            draw_mixed(d, x0 + 72, yy, text, body_size, (225, 236, 248, int(255 * a)))
        elif kind == "ok":
            draw_mixed(d, x0 + 40, yy, "✓", body_size, alpha(GREEN, a), cjk="cjk")
            draw_mixed(d, x0 + 78, yy, text, body_size, (176, 232, 188, int(250 * a)))
        elif kind == "warn":
            draw_mixed(d, x0 + 40, yy, "⚠", body_size, alpha(AMBER, a), cjk="cjk")
            draw_mixed(d, x0 + 78, yy, text, body_size, (255, 205, 150, int(252 * a)))
        elif kind == "dim":
            draw_mixed(d, x0 + 40, yy, text, body_size - 2, (126, 141, 163, int(235 * a)))
        elif kind == "quote":
            d.rounded_rectangle([x0 + 26, yy - 34, x1 - 26, yy + 18], radius=10, fill=(20, 34, 44, int(210 * a)))
            draw_mixed(d, x0 + 44, yy, text, body_size, (223, 240, 236, int(252 * a)))
        else:
            draw_mixed(d, x0 + 40, yy, text, body_size, color + (int(255 * a),))
        y += lh
    return y


def scene_speech(t, dur):
    img = frame_bg(t)
    lines = [
        (0.35, "audio_speech speech-long.wav", TEXT, "cmd"),
        (1.85, "人声切分：整段 93.8s → 4 个识别窗（0.0 / 23.6 / 47.3 / 71.0s）", (170, 188, 210), "out"),
        (3.6, "[0.0s → 22.1s] 大家好，这里是音频分析插件的测试音频。", (232, 241, 250), "quote"),
        (5.2, "[23.6s → 46.2s] 今天我们先讲三件事……", (190, 205, 224), "out"),
        (6.6, "[71.0s → 92.4s] 现在是第三句话，用来测试较长音频的分段。", (190, 205, 224), "out"),
        (8.0, "推理 2.93s（实时率 0.03×）· SRT 4 条 → speech-long.wav.srt", GREEN, "ok"),
    ]
    terminal_card(img, (180, 200, 1740, 780), "audio_speech · 只听有人声的片段", t, lines, t0=0.0, body_size=30, lh=72)
    draw_brand(img, t, "语音")
    return img


# ------------------------------------------------------------ scene 3: music
def bars_chart(d, x, y, w, h, values, labels, color=CYAN, t=None, t0=0.0):
    n = len(values)
    bw = w / n * 0.56
    gap = w / n
    mx = max(values) or 1
    for i, v in enumerate(values):
        app = 1.0
        if t is not None:
            app = ease((t - t0 - i * 0.06) / 0.4)
        hh = max(4, (v / mx) * h * app)
        bx = x + i * gap + (gap - bw) / 2
        d.rounded_rectangle([bx, y + h - hh, bx + bw, y + h], radius=6, fill=alpha(color, 0.28 + 0.5 * (v / mx)))
        d.text((bx + bw / 2, y + h + 34), labels[i], font=font("mono", 22), fill=alpha(TEXT, 0.82), anchor="ms")


def scene_music(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    # card A
    a1 = ease((t - 0.4) / 0.55)
    if a1 > 0.01:
        x0, y0, x1, y1 = 170, 190, 1750, 430
        d.rounded_rectangle([x0, y0, x1, y1], radius=22, fill=(12, 18, 31, int(244 * a1)), outline=(38, 53, 76, int(230 * a1)))
        tn = font("mono_b", 26).getlength("audio_read")
        draw_mixed(d, x0 + 36, y0 + 52, "audio_read", 26, alpha(CYAN, a1), mono="mono_b")
        draw_mixed(d, x0 + 36 + tn + 22, y0 + 52, "花に亡霊.mp3", 24, (170, 184, 204, int(240 * a1)))
        ov = "【总览】3:22.1 · mp3 · 音乐 · E major · 4 段"
        draw_mixed(d, x0 + 36, y0 + 116, ov, 34, (235, 242, 251, int(255 * a1)))
        for i, (k, v, c) in enumerate((("调性", "E major 0.92", CYAN), ("BPM", "180.0", TEXT), ("段落", "4 段", BLUE))):
            bx = x0 + 36 + i * 380
            d.text((bx, y0 + 186), k, font=font("cjk", 20), fill=alpha(FAINT, a1), anchor="ls")
            draw_mixed(d, bx, y0 + 226, v, 30, alpha(c, a1))
        wa = ease((t - 2.6) / 0.5) * a1
        if wa > 0.01:
            d.rounded_rectangle([x0 + 1180, y0 + 150, x1 - 36, y0 + 238], radius=14, fill=(46, 30, 20, int(230 * wa)), outline=alpha(AMBER, 0.55 * wa))
            draw_mixed(d, x0 + 1200, y0 + 186, "⚠", 24, alpha(AMBER, wa), cjk="cjk")
            draw_mixed(d, x0 + 1236, y0 + 186, "可能是 90.0", 24, (255, 208, 156, int(250 * wa)))
            draw_mixed(d, x0 + 1200, y0 + 220, "倍频歧义 · ambiguous", 19, (205, 170, 130, int(230 * wa)))
    # card B
    a2 = ease((t - 5.0) / 0.55)
    if a2 > 0.01:
        x0, y0, x1, y1 = 170, 466, 1750, 884
        d.rounded_rectangle([x0, y0, x1, y1], radius=22, fill=(12, 18, 31, int(244 * a2)), outline=(38, 53, 76, int(230 * a2)))
        tn2 = font("mono_b", 26).getlength("audio_tonal")
        draw_mixed(d, x0 + 36, y0 + 50, "audio_tonal", 26, alpha(CYAN, a2), mono="mono_b")
        draw_mixed(d, x0 + 36 + tn2 + 22, y0 + 50, "Shelter (Piano).mp3", 24, (170, 184, 204, int(240 * a2)))
        draw_mixed(d, x0 + 36, y0 + 106, "调性 C major · 置信 0.92 · 与调性一致性 100%", 28, (232, 241, 250, int(255 * a2)))
        bars_chart(d, x0 + 60, y0 + 168, 760, 120, [56, 17, 16, 9, 2], ["C", "E", "G", "A", "B"], color=CYAN, t=t, t0=5.6)
        d = ImageDraw.Draw(img, "RGBA")
        for i, ln in enumerate(("和弦根音占比（每 0.5s 一个片段，归并后）", "只保证根音，和弦性质不可靠")):
            draw_mixed(d, x0 + 60, y0 + 344 + i * 30, ln, 19, alpha(DIM if i else FAINT, a2))
        # sections
        sec_a = ease((t - 7.2) / 0.5) * a2
        if sec_a > 0.01:
            sx = x0 + 980
            d.text((sx, y0 + 160), "段落（前 30 秒）", font=font("cjk", 20), fill=alpha(FAINT, sec_a), anchor="ls")
            segs = [("A", 0.0, 15.2), ("A'", 15.2, 21.8), ("B", 21.8, 30.0)]
            for i, (lab, s, e) in enumerate(segs):
                bx = sx + (s / 30.0) * 560
                bw2 = ((e - s) / 30.0) * 560 - 6
                d.rounded_rectangle([bx, y0 + 186, bx + bw2, y0 + 250], radius=8, fill=alpha(CYAN if i % 2 == 0 else BLUE, (0.20 + 0.06 * i) * sec_a), outline=alpha(CYAN, 0.35 * sec_a))
                d.text((bx + bw2 / 2, y0 + 224), lab, font=font("cjk_sb", 26), fill=alpha(TEXT, sec_a), anchor="mm")
            d.text((sx, y0 + 300), "采用的分段边界：15.2s · 21.8s", font=font("cjk", 20), fill=alpha(DIM, sec_a), anchor="ls")
            d.text((sx, y0 + 336), "另有 1 个候选边界未采用：5.8s", font=font("cjk", 20), fill=alpha(FAINT, sec_a), anchor="ls")
    draw_brand(img, t, "音乐")
    return img


# ------------------------------------------------------- scene 4: honesty
def scene_honest(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    a = ease((t - 0.3) / 0.5)
    big = "180.0"
    f = font("mono_b", 150)
    bpm_f = font("cjk", 34)
    group = f.getlength(big) + 26 + bpm_f.getlength("BPM")
    x = W / 2 - group / 2
    d.text((x, 470), big, font=f, fill=alpha(TEXT, a), anchor="ls")
    d.text((x + f.getlength(big) + 26, 470), "BPM", font=bpm_f, fill=alpha(DIM, a), anchor="ls")
    aw = ease((t - 1.5) / 0.5) * a
    if aw > 0.01:
        bx, by = W / 2 - 470, 530
        d.rounded_rectangle([bx, by, bx + 940, by + 96], radius=18, fill=(48, 32, 20, int(235 * aw)), outline=alpha(AMBER, 0.5 * aw))
        draw_mixed(d, bx + 30, by + 60, "⚠ 倍频歧义 ambiguous —— 也可能是 90.0 BPM", 27, (255, 210, 160, int(252 * aw)), cjk="cjk_m")
    ta = ease((t - 3.4) / 0.55)
    if ta > 0.01:
        d.text((W / 2, 730), "报告里的每个数字，都带着它自己的不确定度", font=font("cjk_m", 34), fill=alpha(TEXT, ta * 0.95), anchor="mm")
        d.text((W / 2, 786), "BPM 歧义 · 小节相位 · 和弦性质 · 分段阈值 · 分析窗口", font=font("cjk", 24), fill=alpha(DIM, ta * 0.95), anchor="mm")
    draw_brand(img, t, "诚实")
    return img


# ------------------------------------------------------------ scene 5: cuts
def beat_strip(d, x, y, w, h, cuts, color, span=14.0, label=""):
    n = int(span / 0.5)  # 120 BPM
    beat_px = w / n
    d.rounded_rectangle([x, y, x + w, y + h], radius=12, fill=(10, 15, 26, 235), outline=(34, 48, 70, 220))
    for i in range(n + 1):
        bx = x + i * beat_px
        major = i % 4 == 0
        d.line([bx, y + 14, bx, y + h - 14], fill=alpha(CYAN if major else FAINT, 0.30 if not major else 0.55), width=2 if major else 1)
    for ct in cuts:
        bx = x + (ct / span) * w
        d.polygon([(bx, y + 8), (bx - 9, y - 6), (bx + 9, y - 6)], fill=alpha(color, 0.95))
        d.line([bx, y + 8, bx, y + h - 8], fill=alpha(color, 0.55), width=2)


def scene_cuts(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    panels = [
        (118, "aligned.mp4", "6 个切点 · 100% 落在 ±60ms 内", "偏差中位数 34ms", "通篇按拍剪辑", GREEN, [2, 4, 6, 8, 10, 12]),
        (1002, "offbeat.mp4", "7 个切点 · 29% 落在容差内", "偏差中位数 87ms", "不按拍", RED, [1.7, 3.4, 5.35, 7.1, 8.9, 10.55, 12.3]),
    ]
    for idx, (px, name, l1, l2, verdict, col, cuts) in enumerate(panels):
        a = ease((t - 0.35 - idx * 0.75) / 0.55)
        if a <= 0.01:
            continue
        y0 = 196
        x1 = px + 800
        d.rounded_rectangle([px, y0, x1, y0 + 560], radius=22, fill=(12, 18, 31, int(242 * a)), outline=(38, 53, 76, int(225 * a)))
        draw_mixed(d, px + 34, y0 + 56, name, 27, (226, 237, 248, int(255 * a)), mono="mono_b")
        draw_mixed(d, px + 34, y0 + 112, l1, 22, (158, 174, 196, int(240 * a)))
        beat_strip(d, px + 34, y0 + 176, 732, 92, cuts, col)
        draw_mixed(d, px + 34, y0 + 330, l2, 24, (196, 210, 228, int(245 * a)))
        va = ease((t - 1.4 - idx * 0.75) / 0.45) * a
        if va > 0.01:
            d.rounded_rectangle([px + 34, y0 + 386, px + 34 + 360, y0 + 456], radius=14, fill=alpha(col, 0.14 * va), outline=alpha(col, 0.5 * va))
            draw_mixed(d, px + 58, y0 + 424, verdict, 28, alpha(col, va), cjk="cjk_m")
        # big percent
        pa = ease((t - 1.0 - idx * 0.75) / 0.5) * a
        if pa > 0.01:
            pct = "100%" if idx == 0 else "29%"
            f = font("mono_b", 72)
            d.text((x1 - 40, y0 + 500), pct, font=f, fill=alpha(col, pa), anchor="rs")
            d.text((x1 - 40, y0 + 442), "落在拍上" if idx == 0 else "落在容差内", font=font("cjk", 19), fill=alpha(DIM, pa), anchor="rs")
    # bottom line
    ba = ease((t - 5.0) / 0.5)
    if ba > 0.01:
        d.text((W / 2, 830), "同一套节奏模型，直接回答「卡点准不准」", font=font("cjk_m", 30), fill=alpha(TEXT, ba * 0.95), anchor="mm")
    draw_brand(img, t, "卡点")
    return img


# ------------------------------------------------------- scene 6: talking head
def scene_talk(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    a = ease((t - 0.35) / 0.55)
    if a <= 0.01:
        draw_brand(img, t, "口播")
        return img
    x0, y0, x1, y1 = 170, 190, 1750, 700
    d.rounded_rectangle([x0, y0, x1, y1], radius=22, fill=(12, 18, 31, int(242 * a)), outline=(38, 53, 76, int(225 * a)))
    draw_mixed(d, x0 + 36, y0 + 54, "audio_read talk.mp4", 27, (230, 240, 250, int(255 * a)), mono="mono_b")
    d.rounded_rectangle([x1 - 196, y0 + 24, x1 - 36, y0 + 70], radius=12, fill=(22, 52, 44, int(240 * a)), outline=alpha(CYAN, 0.5 * a))
    draw_mixed(d, x1 - 172, y0 + 58, "判为语音", 23, alpha(CYAN, a), cjk="cjk_m")
    # waveform with speech blocks
    wx, wy, ww, wh = x0 + 36, y0 + 120, 1500, 150
    blocks = [(0.0, 3.6), (4.4, 8.2), (9.0, 13.4), (14.2, 18.1), (19.0, 21.4), (22.0, 22.5)]
    for i, (s, e) in enumerate(blocks):
        bx = wx + (s / 22.5) * ww
        bw2 = ((e - s) / 22.5) * ww
        d.rounded_rectangle([bx, wy - 6, bx + bw2, wy + wh + 6], radius=6, fill=(26, 60, 52, int(120 * a)))
    for i in range(150):
        xx = wx + i * (ww / 150)
        tt = (i / 150) * 22.5
        inside = any(s <= tt <= e for s, e in blocks)
        amp = (0.35 + 0.65 * abs(math.sin(i * 1.7))) * (1.0 if inside else 0.12)
        hh = amp * wh * 0.46
        d.line([(xx, wy + wh / 2 - hh), (xx, wy + wh / 2 + hh)], fill=alpha(CYAN if inside else FAINT, (0.75 if inside else 0.4) * a), width=3)
    # cut markers
    ca = ease((t - 2.2) / 0.5) * a
    if ca > 0.01:
        for ct in (5.0, 10.0, 15.0):
            bx = wx + (ct / 22.5) * ww
            d.line([bx, wy - 34, bx, wy + wh + 34], fill=alpha(RED, 0.9 * ca), width=3)
            d.text((bx + 8, wy - 40), "切点", font=font("cjk", 18), fill=alpha(RED, ca), anchor="ls")
    rd = ease((t - 3.1) / 0.5) * a
    if rd > 0.01:
        draw_mixed(d, x0 + 36, y0 + 340, "【切点】说话停顿处切画面 0/3 个（±250ms 内，0%）· 偏差中位数 1155ms", 24, (220, 232, 246, int(250 * rd)))
        draw_mixed(d, x0 + 36, y0 + 388, "结论：与说话停顿无关", 26, (255, 168, 180, int(252 * rd)), cjk="cjk_m")
    na = ease((t - 4.2) / 0.5) * a
    if na > 0.01:
        d.text((W / 2, 720), "同一段音频，问题不同，结论就不同", font=font("cjk_m", 32), fill=alpha(TEXT, na * 0.95), anchor="mm")
        d.text((W / 2, 772), "音乐问「踩不踩拍」，口播问「断在不在气口」", font=font("cjk", 25), fill=alpha(DIM, na * 0.95), anchor="mm")
    draw_brand(img, t, "口播")
    return img


# --------------------------------------------------------------- scene 7: end
def scene_end(t, dur):
    img = frame_bg(t)
    d = ImageDraw.Draw(img, "RGBA")
    la = ease((t - 0.2) / 0.6)
    # mark
    cx, cy = W / 2, 300
    for i, hh in enumerate((36, 72, 52, 88, 44)):
        xx = cx - 88 + i * 44
        d.rounded_rectangle([xx - 10, cy - hh / 2, xx + 10, cy + hh / 2], radius=10, fill=alpha(CYAN, 0.9 * la))
    ta = ease((t - 0.5) / 0.6)
    d.text((W / 2, cy + 110), "dsh-better-ears", font=font("mono_b", 64), fill=alpha(TEXT, ta), anchor="mm")
    d.text((W / 2, cy + 190), "让 agent 真正听见", font=font("cjk_m", 40), fill=alpha(CYAN, 0.95 * ta), anchor="mm")
    ca = ease((t - 1.5) / 0.6)
    chips = ["语音转写", "音乐分析", "卡点检测", "曲式结构", "响度", "本地运行"]
    total = sum(mixed_width(c, 22) + 46 for c in chips) + 14 * (len(chips) - 1)
    x = W / 2 - total / 2
    for c in chips:
        w = mixed_width(c, 22) + 46
        d.rounded_rectangle([x, 596, x + w, 648], radius=26, fill=(18, 30, 46, int(235 * ca)), outline=alpha(CYAN, 0.35 * ca))
        draw_mixed(d, x + 23, 630, c, 22, (206, 222, 238, int(250 * ca)))
        x += w + 14
    ia = ease((t - 2.4) / 0.6)
    if ia > 0.01:
        d.rounded_rectangle([W / 2 - 520, 700, W / 2 + 520, 812], radius=16, fill=(9, 14, 24, int(240 * ia)), outline=(38, 54, 76, int(220 * ia)))
        draw_mixed(d, W / 2 - 490, 748, "$", 26, alpha(CYAN, ia))
        draw_mixed(d, W / 2 - 462, 748, "plugin install dsh-better-ears", 26, (220, 232, 246, int(252 * ia)))
        draw_mixed(d, W / 2 - 500, 786, "设置 → 插件 → dsh-better-ears（音频分析）· 全本地 · 零上传", 21, (168, 184, 206, int(245 * ia)))
    fa = ease((t - 3.4) / 0.6)
    if fa > 0.01:
        d.text((W / 2, 890), "全本地推理 · 零上传 · 零 API 费用", font=font("cjk", 25), fill=(176, 196, 216, int(250 * fa)), anchor="mm")
    draw_brand(img, t)
    return img


SCENES = [
    (0.0, 10.0, scene_hook),
    (10.0, 20.7, scene_tools),
    (20.7, 33.2, scene_speech),
    (33.2, 45.6, scene_music),
    (45.6, 53.2, scene_honest),
    (53.2, 61.0, scene_cuts),
    (61.0, 68.4, scene_talk),
    (68.4, 78.0, scene_end),
]

XFADE = 0.26


def render(t: float) -> Image.Image:
    scene = None
    prev = None
    for i, (s, e, fn) in enumerate(SCENES):
        if s <= t < e or (i == len(SCENES) - 1 and t >= s):
            scene = (s, e, fn, i)
            if i > 0 and t - s < XFADE:
                prev = SCENES[i - 1]
            break
    s, e, fn, idx = scene
    img = fn(t - s, e - s)
    if prev is not None:
        ps, pe, pfn = prev
        pimg = pfn(t - ps, pe - ps)
        a = ease((t - s) / XFADE)
        img = Image.blend(pimg.convert("RGB"), img.convert("RGB"), a)
    draw_caption(img, t)
    return img.convert("RGB")


def main():
    total = int(round(DUR * FPS))
    out = sys.stdout.buffer
    for i in range(total):
        t = i / FPS
        img = render(t)
        out.write(img.tobytes())
        if i % 150 == 0:
            print(f"frame {i}/{total} t={t:.2f}", file=sys.stderr, flush=True)
    out.flush()


if __name__ == "__main__":
    main()
