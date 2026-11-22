"""常驻 OCR 服务：模型只加载一次，之后每次请求只做推理。

两种用法：
  python ocr_service.py --once <图片路径>      # 单次，验证用
  python ocr_service.py --port 8765            # 常驻，POST {"path": "..."} 返回 {"lines":[...]}

为什么必须常驻：rapidocr 加载模型要 1–3 秒，而一帧字幕的推理只要几十毫秒到
一秒；如果每次调用都起进程，字幕通道的时间全花在加载上（ADR 0002）。

## 2026-11-22 回退 CPU

GPU 版（onnxruntime-gpu 1.26 + CUDA）在常驻服务里出现显存/内存线性泄漏：
开测约 20 秒显存打满 16GB、OCR 进程内存涨到 17.9GB，最后连 cuBLAS 句柄都建不起来。
已卸载 `onnxruntime-gpu`、离线装回 CPU 版 `onnxruntime 1.32.0`。
CPU 版两轮 5 分钟实测 OCR 79.2% / 76.1%，全程不卡，是这个场景的稳定基线。

**别只看 /health**：它只说明模型加载了，不代表推理能跑。要确认就 POST 一张图。
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rapidocr import RapidOCR

ENGINE = None
DEVICE = "cpu"


def load():
    t0 = time.time()
    engine = RapidOCR()
    # rapidocr 延迟加载模型：先跑一张空图把 det/cls/rec 建起来，
    # 别让第一帧字幕独自承担 1–3 秒的加载。
    try:
        import numpy as np
        engine(np.zeros((720, 2532, 3), dtype=np.uint8))
    except Exception as e:
        print(f"[ocr] 预热跳过（不影响启动）：{type(e).__name__}: {e}", flush=True)
    print(f"[ocr] 模型加载完成 {time.time() - t0:.1f}s device=cpu", flush=True)
    return engine


def run_one(path):
    global ENGINE
    if ENGINE is None:
        ENGINE = load()
    t0 = time.time()
    res = ENGINE(path)
    ms = (time.time() - t0) * 1000
    txts = getattr(res, "txts", None) or []
    scores = getattr(res, "scores", None) or []
    lines = []
    for i, t in enumerate(txts):
        if not t:
            continue
        s = float(scores[i]) if i < len(scores) else 0.0
        lines.append({"t": t, "s": round(s, 3)})
    return {"lines": lines, "ms": round(ms, 1)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send({"ok": True, "ready": ENGINE is not None, "device": DEVICE})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            path = req.get("path")
            if not path:
                self._send({"ok": False, "error": "缺 path"}, 400)
                return
            out = run_one(path)
            self._send({"ok": True, **out})
        except Exception as e:  # 任何异常都要回 JSON，不然客户端只能看到断连
            self._send({"ok": False, "error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--once":
        print(json.dumps(run_one(sys.argv[2]), ensure_ascii=False))
    else:
        port = 8765
        if "--port" in sys.argv:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        ENGINE = load()
        ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
