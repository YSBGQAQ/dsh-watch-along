"""环回录音 + 转写服务：只做一件事——把"电脑现在在放什么声音"变成文字。

两种用法：
  python asr_service.py --once 5            # 录 5 秒、转写、打印 JSON（验证用）
  python asr_service.py --port 8766         # 常驻，POST /listen {"seconds":5} → {"ok":true,"lines":[...]}

为什么要常驻：Whisper 加载 1.6GB 权重约 3–6 秒，而一句话的转写只要几百毫秒。
每次起进程的话，时间全花在加载上（同 ADR 0003 的理由）。
"""
import json
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_DIR = r"C:\Users\24206\Desktop\源码与作者说明\Whisper turbo"
MODEL = None


def load():
    global MODEL
    if MODEL is not None:
        return MODEL
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


def listen(seconds=5.0):
    audio = record(seconds)
    rms = float(np.sqrt(np.mean(audio**2))) if len(audio) else 0.0
    if rms < 0.001:
        return {"lines": [], "ms": 0, "silent": True, "rms": round(rms, 5)}
    out = transcribe(audio)
    out["silent"] = False
    out["rms"] = round(rms, 5)
    return out


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
            self._send({"ok": True, **listen(float(req.get("seconds", 5)))})
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
