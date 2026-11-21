"""环回录音 + 转写服务：只做一件事——把"电脑现在在放什么声音"变成文字。

两种用法：
  python asr_service.py --once 5            # 录 5 秒、转写、打印 JSON（验证用）
  python asr_service.py --port 8766         # 常驻，POST /listen {"seconds":5} → {"ok":true,"lines":[...]}

为什么要常驻：Whisper 加载 1.6GB 权重约 3–6 秒，而一句话的转写只要几百毫秒。
每次起进程的话，时间全花在加载上（同 ADR 0003 的理由）。
"""
import ctypes
import json
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_DIR = r"C:\Users\24206\Desktop\源码与作者说明\Whisper turbo"
MODEL = None


def _register_cuda_dlls():
    """把 nvidia-* wheel 里的 DLL 目录挂进搜索路径。

    不挂的话，ctranslate2 能加载权重、却在第一次 encode 时抛
    `Library cublas64_12.dll is not found or cannot be loaded`——
    模型"加载成功"但一用就炸，最容易被误判成显存问题。
    """
    import os
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
    # device="auto"：有 CUDA 就用，没有就 CPU。compute_type 跟着退。
    for device, ctype in (("cuda", "float16"), ("cpu", "int8")):
        try:
            MODEL = WhisperModel(MODEL_DIR, device=device, compute_type=ctype)
            print(f"[asr] 模型加载完成 {time.time() - t0:.1f}s device={device}", flush=True)
            return MODEL
        except Exception as e:
            print(f"[asr] {device} 不可用：{type(e).__name__}: {str(e)[:120]}", flush=True)
    raise RuntimeError("模型加载失败（GPU 与 CPU 都试过了）")


def record(seconds=5.0, rate=16000):
    """录系统输出（环回）。没有环回设备时抛错，让上层如实报告。"""
    # WASAPI 走 COM，而 COM 是**按线程**初始化的：ThreadingHTTPServer 每个请求
    # 都在新线程里，不在这里 CoInitialize 就会报 `Error 0x800401f0`
    # （CO_E_NOTINITIALIZED，字面意思是"没调过 CoInitialize"）。
    ctypes.windll.ole32.CoInitialize(None)
    import soundcard as sc

    spk = sc.default_speaker()
    mic = sc.get_microphone(id=str(spk.name), include_loopback=True)
    with mic.recorder(samplerate=rate, channels=1) as rec:
        data = rec.record(numframes=int(rate * seconds))
    return np.asarray(data).reshape(-1).astype(np.float32)


def transcribe(audio, rate=16000):
    model = load()
    t0 = time.time()
    segments, info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,          # 静音切片交给库自带的 VAD
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=1,              # 实时场景不需要大 beam
        condition_on_previous_text=False,
    )
    lines = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            lines.append({"text": text, "t0": round(seg.start, 2), "t1": round(seg.end, 2)})
    return {"lines": lines, "ms": round((time.time() - t0) * 1000, 1), "lang": info.language}


RATE = 16000
# 连续累积的音频 + 已经交付过的句子（按时间码去重）。
# 关键：每次都转**整个缓冲**，不截尾巴 —— 从句子中间开始转会丢上下文，
# Whisper 会吐出"不分有"这种碎片（实测过，别改回去）。
STATE = {"audio": np.zeros(0, dtype=np.float32), "delivered": []}
KEEP_SEC = 20.0    # 留最近 20 秒：够给上下文，又不至于每次转太久
MARGIN_SEC = 0.8   # 句尾离缓冲边缘太近的先不发，它可能还没说完
DUP_SEC = 0.35     # 起点差这么多就当同一句，避免重复交付


def listen(seconds=3.0):
    """录一小段、追加到缓冲，整段转写，只交付"已经说完且没发过"的句子。"""
    global STATE
    chunk = record(seconds)
    if len(chunk):
        STATE["audio"] = np.concatenate([STATE["audio"], chunk])

    buf = STATE["audio"]
    total = len(buf) / RATE
    if total < 1.0:
        return {"lines": [], "ms": 0, "silent": True, "rms": 0.0, "total": round(total, 2)}

    rms = float(np.sqrt(np.mean(buf**2)))
    if rms < 0.001:
        return {"lines": [], "ms": 0, "silent": True, "rms": round(rms, 5), "total": round(total, 2)}

    res = transcribe(buf)
    done = []
    for line in res["lines"]:
        t0, t1 = float(line["t0"]), float(line["t1"])
        if t1 > total - MARGIN_SEC:
            continue  # 尾巴还没说完，下一拍再说
        if any(abs(t0 - d0) < DUP_SEC and abs(t1 - d1) < DUP_SEC for d0, d1 in STATE["delivered"]):
            continue  # 已经发过这一句
        done.append({"text": line["text"], "t0": round(t0, 2), "t1": round(t1, 2)})
        STATE["delivered"].append((t0, t1))

    # 裁剪缓冲：所有时间码一起往前平移，否则下次算出来的位置全错
    if total > KEEP_SEC:
        drop = total - KEEP_SEC
        STATE["audio"] = buf[int(drop * RATE):]
        STATE["delivered"] = [(max(0.0, d0 - drop), max(0.0, d1 - drop)) for d0, d1 in STATE["delivered"]]
        STATE["delivered"] = [x for x in STATE["delivered"] if x[1] > 0.05]
        total = KEEP_SEC

    return {"lines": done, "ms": res["ms"], "silent": False, "rms": round(rms, 5), "total": round(total, 2)}


def reset():
    global STATE
    STATE = {"audio": np.zeros(0, dtype=np.float32), "delivered": []}


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
        self._send({"ok": True, "ready": MODEL is not None})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            if req.get("reset"):
                reset()
            self._send({"ok": True, **listen(float(req.get("seconds", 3)))})
        except Exception as e:
            self._send({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--once":
        print(json.dumps(listen(float(sys.argv[2])), ensure_ascii=False))
    else:
        port = 8766
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        print("[asr] 预热模型…", flush=True)
        load()
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
