"""环回录音 + 转写服务：把"电脑现在在放什么声音"变成文字。

两种用法：
  python asr_service.py --once 8            # 录 8 秒、转写、打印 JSON（验证用）
  python asr_service.py --port 8766         # 常驻，POST /listen → 只返回"新说完"的句子

## 为什么录音要常驻线程（2026-11-21 改）

原来是"每次请求开流录 3 秒、关流"。实测两个后果：

1. **丢音频**：两次请求之间（约 2 秒）声音直接没了。服务日志里成片的
   `data discontinuity in recording` 就是这个。对着字幕文件核对，覆盖率只有 52%
   —— 丢的不是"听不出来"，是"根本没听见"。
2. **时间轴漂**：缓冲里是拼起来的，和视频实际进度越差越远。

现在录音在一个后台线程里**一直开着**，往一个连续缓冲里追加；`/listen` 只做"转写 + 交付"。
"""
import ctypes
import json
import os
import sys
import threading
import time
from difflib import SequenceMatcher
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_DIR = r"C:\Users\24206\Desktop\源码与作者说明\Whisper turbo"
RATE = 16000
KEEP_SEC = 20.0    # 缓冲只留最近 20 秒：够给上下文，又不至于每次转太久
MARGIN_SEC = 0.8   # 句尾离缓冲边缘太近的先不发 —— 它可能还没说完
SEEN_MAX = 200     # 记住最近 200 句的归一化文本

DUMP = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".scratch", "run", "asr-out.jsonl"
)

MODEL = None

# 连续录音的共享缓冲。`base` = 已经裁掉的秒数，对外时间 = base + 缓冲内时间。
ACC = {
    "buf": np.zeros(0, dtype=np.float32),
    "base": 0.0,
    "emitted_until": 0.0,
    "seen": [],
    "thread": None,
    "stop": False,
    "error": None,
    "device": None,  # 当前录的是哪台设备的环回
}


def _register_cuda_dlls():
    """把 nvidia-* wheel 里的 DLL 目录挂进搜索路径。

    不挂的话，ctranslate2 能加载权重、却在第一次 encode 时抛
    `Library cublas64_12.dll is not found or cannot be loaded` ——
    模型"加载成功"但一用就炸，最容易被误判成显存问题。
    """
    import site

    for base in site.getsitepackages():
        for sub in ("cublas/bin", "cudnn/bin", "cuda_nvrtc/bin"):
            p = os.path.join(base, "nvidia", *sub.split("/"))
            if os.path.isdir(p):
                try:
                    os.add_dll_directory(p)
                except OSError:
                    pass
                os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")


def load():
    global MODEL
    if MODEL is not None:
        return MODEL
    _register_cuda_dlls()
    from faster_whisper import WhisperModel

    t0 = time.time()
    for device, ctype in (("cuda", "float16"), ("cpu", "int8")):
        try:
            MODEL = WhisperModel(MODEL_DIR, device=device, compute_type=ctype)
            print(f"[asr] 模型加载完成 {time.time() - t0:.1f}s device={device}", flush=True)
            return MODEL
        except Exception as e:
            print(f"[asr] {device} 不可用：{type(e).__name__}: {str(e)[:120]}", flush=True)
    raise RuntimeError("模型加载失败（GPU 与 CPU 都试过了）")


def _capture_loop():
    """后台线程：一直录，并且**跟着系统的默认输出设备走**。

    为什么必须盯设备：用户换耳机/切 HDMI 之后，默认扬声器变了，而我们这条流
    还挂在旧设备上 —— 表现就是"一直没字幕"，但看不出原因。所以每隔 2 秒比一次，
    变了就重开流。
    """
    ctypes.windll.ole32.CoInitialize(None)  # COM 是按线程的，这个线程要自己初始化
    try:
        import soundcard as sc
    except Exception as e:
        ACC["error"] = f"soundcard 不可用：{e}"
        print(f"[asr] {ACC['error']}", flush=True)
        return

    while not ACC["stop"]:
        try:
            spk = sc.default_speaker()
            mic = sc.get_microphone(id=str(spk.name), include_loopback=True)
        except Exception as e:
            ACC["error"] = f"{type(e).__name__}: {e}"
            print(f"[asr] 取环回设备失败：{ACC['error']}", flush=True)
            time.sleep(2)
            continue

        ACC["device"] = spk.name
        ACC["error"] = None
        print(f"[asr] 开始连续录音：{spk.name}", flush=True)
        try:
            with mic.recorder(samplerate=RATE, channels=1) as rec:
                nextCheck = time.time() + 2.0
                while not ACC["stop"]:
                    chunk = np.asarray(rec.record(numframes=RATE // 4)).reshape(-1).astype(np.float32)
                    if len(chunk):
                        ACC["buf"] = np.concatenate([ACC["buf"], chunk])
                    if time.time() >= nextCheck:
                        nextCheck = time.time() + 2.0
                        try:
                            now = sc.default_speaker().name
                        except Exception:
                            now = ACC["device"]
                        if now != ACC["device"]:
                            print(f"[asr] 默认输出设备变了：{ACC['device']} → {now}，重开录音", flush=True)
                            break  # 跳出内层 → 外层用新设备重开
        except Exception as e:
            ACC["error"] = f"{type(e).__name__}: {e}"
            print(f"[asr] 录音中断：{ACC['error']}（2 秒后重试）", flush=True)
            time.sleep(2)


def start_capture():
    if ACC["thread"] is not None:
        return
    ACC["stop"] = False
    ACC["thread"] = threading.Thread(target=_capture_loop, daemon=True, name="capture")
    ACC["thread"].start()


def _norm(text):
    """归一化：只留字母数字与汉字。只有文本是稳定的，时间码会漂。"""
    return "".join(ch for ch in str(text).lower() if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def _is_dup(key):
    """模糊判重：ASR 对同一段音频每次会给出一字之差（是/式、夜戏/夜系）。"""
    for prev in ACC["seen"]:
        if prev == key:
            return True
        if len(key) >= 4 and (key in prev or prev in key):
            return True
        if abs(len(prev) - len(key)) > max(3, int(len(key) * 0.3)):
            continue
        if SequenceMatcher(None, prev, key).ratio() >= 0.85:
            return True
    return False


# Whisper 在静音/音乐段的经典幻觉：字幕组署名、礼貌结尾、重复叹词。
# 词表照 better-ears 的思路（中英各取常见项），命中即丢。
HALLUCINATION_PATTERNS = [
    "谢谢观看", "感谢观看", "谢谢收看", "请订阅", "订阅频道", "点赞", "关注我",
    "中文字幕", "字幕由", "字幕组", "翻译", "校对", "制作",
    "请不吝点赞", "明镜与点点", "amara.org", "subtitle", "subtitles by",
    "thanks for watching", "please subscribe", "like and subscribe",
    "嗯嗯", "啊啊", "哈哈",
]


def _looks_hallucinated(text):
    """事后防幻觉。返回 True = 这条不该发。

    三条判据，任一命中即丢：
    1. 命中常见幻觉词（字幕组署名、礼貌结尾）
    2. 太短且无信息量（单字、纯符号）
    3. 同一字符占比过高（"啊啊啊啊"）
    """
    t = str(text).strip()
    low = t.lower()
    for p in HALLUCINATION_PATTERNS:
        if p in low:
            return True
    core = _norm(t)
    if len(core) < 2:
        return True
    if len(core) >= 4 and len(set(core)) / len(core) < 0.34:
        return True
    return False


def _dump(text, t0, t1):
    """把交付的每一行落到 jsonl，供事后和字幕文件对照（绝对时间才有对照价值）。"""
    try:
        os.makedirs(os.path.dirname(DUMP), exist_ok=True)
        with open(DUMP, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t0": t0, "t1": t1, "text": text}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def transcribe(audio):
    model = load()
    t0 = time.time()
    segments, info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=1,
        condition_on_previous_text=False,
    )
    lines = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            lines.append({"text": text, "t0": round(seg.start, 2), "t1": round(seg.end, 2)})
    return {"lines": lines, "ms": round((time.time() - t0) * 1000, 1), "lang": info.language}


def pull():
    """转写当前缓冲，交付"已经说完且没发过"的句子。不录音 —— 录音在另一个线程里跑。"""
    start_capture()
    buf = ACC["buf"]
    total = len(buf) / RATE

    if ACC["error"]:
        return {"lines": [], "ms": 0, "silent": True, "rms": 0.0, "total": round(total, 2), "error": ACC["error"]}
    if total < 1.0:
        return {"lines": [], "ms": 0, "silent": True, "rms": 0.0, "total": round(total, 2)}

    rms = float(np.sqrt(np.mean(buf**2)))
    if rms < 0.001:
        return {"lines": [], "ms": 0, "silent": True, "rms": round(rms, 5), "total": round(total, 2)}

    res = transcribe(buf)
    done = []
    for line in res["lines"]:
        t0 = ACC["base"] + float(line["t0"])
        t1 = ACC["base"] + float(line["t1"])
        if t1 > ACC["base"] + total - MARGIN_SEC:
            continue  # 尾巴还没说完
        if t1 <= ACC["emitted_until"] + 0.05:
            continue  # 已经交付过（时间水位是绝对的）
        key = _norm(line["text"])
        if not key or _looks_hallucinated(line["text"]) or _is_dup(key):
            continue
        done.append({"text": line["text"], "t0": round(t0, 2), "t1": round(t1, 2)})
        _dump(line["text"], round(t0, 2), round(t1, 2))
        ACC["seen"].append(key)
        if len(ACC["seen"]) > SEEN_MAX:
            ACC["seen"] = ACC["seen"][-SEEN_MAX:]
        ACC["emitted_until"] = max(ACC["emitted_until"], t1)

    # 裁剪缓冲：只前移 base，水位是绝对时间，不用再动
    if total > KEEP_SEC:
        drop = total - KEEP_SEC
        ACC["buf"] = buf[int(drop * RATE):]
        ACC["base"] += drop
        total = KEEP_SEC

    return {"lines": done, "ms": res["ms"], "silent": False, "rms": round(rms, 5), "total": round(total, 2)}


def reset():
    ACC["buf"] = np.zeros(0, dtype=np.float32)
    ACC["base"] = 0.0
    ACC["emitted_until"] = 0.0
    ACC["seen"] = []
    ACC["error"] = None
    try:
        if os.path.exists(DUMP):
            os.remove(DUMP)
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({
            "ok": True,
            "ready": MODEL is not None,
            "capturing": ACC["thread"] is not None,
            "device": ACC["device"],
            "error": ACC["error"],
        })

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            if req.get("reset"):
                reset()
            self._send({"ok": True, **pull()})
        except Exception as e:
            self._send({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--once":
        secs = float(sys.argv[2])
        start_capture()
        print(f"[asr] 录 {secs}s …", flush=True)
        time.sleep(secs)
        print(json.dumps(pull(), ensure_ascii=False))
    else:
        port = 8766
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        print("[asr] 预热模型…", flush=True)
        load()
        start_capture()
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
