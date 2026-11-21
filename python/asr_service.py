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

# 模型目录三级取值：环境变量 → 仓库内 models/whisper-turbo → 加载时报错并指出该设哪个变量。
# 之前是硬编码绝对路径，换台机器直接崩（票 15）。
MODEL_DIR = (
    os.environ.get("WATCH_ALONG_WHISPER_DIR")
    or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "whisper-turbo")
)
RATE = 16000
KEEP_SEC = 20.0    # 缓冲只留最近 20 秒：够给上下文，又不至于每次转太久
MARGIN_SEC = 0.8   # 句尾离缓冲边缘太近的先不发 —— 它可能还没说完
SEEN_MAX = 200     # 记住最近 200 句的归一化文本
PREROLL_SEC = 1.5  # 每次送音频前留的前摇：只为给模型上下文，落在里面的话不交付
MAX_SLICE_SEC = 30.0  # 单次最多送多少秒，防止长时间没调用后一次吃到巨量音频

RUN_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".scratch", "run")
# 每轮测试一个文件（reset 时可指定 session）。全局一个文件时，重启就清空，
# 上一轮的结果没法回头比对 —— 实测丢过整轮 168 条。
DUMP = os.path.join(RUN_DIR, "asr-out.jsonl")

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
    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(
            f"模型目录不存在：{MODEL_DIR}\n"
            "  修法：set WATCH_ALONG_WHISPER_DIR=<含 model.bin 的那个目录>"
        )
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
    # 录音来源：默认整机混音。process:<x> 暂时没有实现采集，明确回退并留日志 ——
    # 静默忽略配置比报错更糟，用户会以为"只录视频"生效了。
    src = os.environ.get("WATCH_ALONG_AUDIO_SOURCE", "system")
    if src != "system":
        print(f"[asr] audioSource={src} 尚未实现，已回退整机混音", flush=True)
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
    if not core:
        return True
    # 注意：**不要**因为"字数少"就丢。真实台词里大量"走""别动""嗯"这类两三字短句，
    # 上一版按 <2 字丢弃，实测把 45 条真实台词吃掉了（覆盖率因此卡在 63%）。
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
    """转写"上次之后的新音频"，只交付已经说完的句子。

    ## 为什么不是"整段重转"（2026-11-21 改）

    以前每次把整个 20 秒缓冲重转一遍。缓冲每滑一次，Whisper 就把同一段音频**重新切分**，
    切法变了，于是同一句话以不同形状反复出现 —— 文本去重、时间水位都只能事后补救
    （实测 5 分钟 26 条重复）。

    现在：只送「上次交付点之前 1.5 秒 + 之后的新音频」，**每段音频只转一次**。
    前摇那 1.5 秒只为给模型上下文，落在这段里的句子不交付。
    """
    start_capture()
    buf = ACC["buf"]
    base = ACC["base"]
    end_abs = base + len(buf) / RATE

    if ACC["error"]:
        return {"lines": [], "ms": 0, "silent": True, "rms": 0.0, "total": round(len(buf) / RATE, 2),
                "error": ACC["error"]}

    # 从哪儿开始转：cursor 往前留一点前摇；第一次就从头
    start_abs = max(base, ACC["emitted_until"] - PREROLL_SEC)
    # 追不上时（比如长时间没调用）别一次送太多，最多 MAX_SLICE 秒
    if end_abs - start_abs > MAX_SLICE_SEC:
        start_abs = end_abs - MAX_SLICE_SEC

    i0 = max(0, int((start_abs - base) * RATE))
    audio = buf[i0:]
    if len(audio) < RATE * 1.0:
        return {"lines": [], "ms": 0, "silent": True, "rms": 0.0, "total": round(len(buf) / RATE, 2)}

    rms = float(np.sqrt(np.mean(audio**2)))
    if rms < 0.001:
        return {"lines": [], "ms": 0, "silent": True, "rms": round(rms, 5), "total": round(len(buf) / RATE, 2)}

    res = transcribe(audio)
    done = []
    for line in res["lines"]:
        t0 = start_abs + float(line["t0"])
        t1 = start_abs + float(line["t1"])
        if t1 <= ACC["emitted_until"]:
            continue  # 落在前摇里：已经交付过，或只是给上下文用的
        if t1 > end_abs - MARGIN_SEC:
            continue  # 尾巴还没说完
        key = _norm(line["text"])
        if not key or _looks_hallucinated(line["text"]) or _is_dup(key):
            continue
        done.append({"text": line["text"], "t0": round(t0, 2), "t1": round(t1, 2)})
        _dump(line["text"], round(t0, 2), round(t1, 2))
        ACC["seen"].append(key)
        if len(ACC["seen"]) > SEEN_MAX:
            ACC["seen"] = ACC["seen"][-SEEN_MAX:]
        ACC["emitted_until"] = max(ACC["emitted_until"], t1)

    # 只有"这一拍压根没有句子"时才推进游标。
    # 若模型给了句子但都因"尾巴还没说完"被跳过，**绝不能推进** ——
    # 推进就等于把那句话永久丢掉（实测丢过"不可怕"这种真实台词）。
    hadSegments = len(res["lines"]) > 0
    if not done and not hadSegments and end_abs - ACC["emitted_until"] > 6.0:
        # 调试开关：把"没交付"的这段音频存下来。事后听一遍就能分清
        # 是"真没台词"、"被 VAD 滤掉"、还是"被跳过" —— 否则三者表现完全一样。
        if os.environ.get("WATCH_ALONG_DUMP_GAPS"):
            try:
                import wave
                d = os.path.join(os.path.dirname(DUMP), "gaps")
                os.makedirs(d, exist_ok=True)
                seg = audio[max(0, int((ACC["emitted_until"] - start_abs) * RATE)):]
                path = os.path.join(d, f"gap_{int(ACC['emitted_until'])}_{int(end_abs)}.wav")
                with wave.open(path, "wb") as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(RATE)
                    w.writeframes((np.clip(seg, -1, 1) * 32767).astype(np.int16).tobytes())
                print(f"[asr] 空档已存：{path}", flush=True)
            except Exception:
                pass
        ACC["emitted_until"] = end_abs - MARGIN_SEC

    # 裁剪缓冲：只前移 base（cursor 是绝对时间，不用动）
    if len(buf) / RATE > KEEP_SEC:
        drop = len(buf) / RATE - KEEP_SEC
        ACC["buf"] = buf[int(drop * RATE):]
        ACC["base"] += drop

    return {"lines": done, "ms": res["ms"], "silent": False, "rms": round(rms, 5),
            "total": round(len(ACC["buf"]) / RATE, 2)}


def reset(session=None):
    global DUMP
    if session:
        safe = "".join(c for c in str(session) if c.isalnum() or c in "-_")
        DUMP = os.path.join(RUN_DIR, f"asr-out-{safe}.jsonl")
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
                reset(req.get("session"))
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
