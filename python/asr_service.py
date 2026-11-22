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

import procloopback  # 同目录兄弟模块（进程回环，票 17）

# 模型目录三级取值：环境变量 → 仓库内 models/whisper-turbo → 加载时报错并指出该设哪个变量。
# 之前是硬编码绝对路径，换台机器直接崩（票 15）。
MODEL_DIR = (
    os.environ.get("WATCH_ALONG_WHISPER_DIR")
    or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "whisper-turbo")
)
RATE = 16000
# 2026-11-22 更正：旧注释写「轮询从 3s 改成 15s」是错的。插件真正的心跳在
# index.js 的 `windowSec: 3`，每 3 秒一次；15 是事件长轮询的 maxWaitSec，与 ASR 无关。
# 40 秒在 3 秒节奏下只是更宽裕（给游标追赶留余量），不影响识别精度。
KEEP_SEC = 40.0    # 缓冲只留最近 40 秒
MARGIN_SEC = 0.8   # 句尾离缓冲边缘太近的先不发 —— 它可能还没说完
SEEN_MAX = 200     # 记住最近 200 句的归一化文本
PREROLL_SEC = 1.5  # 每次送音频前留的前摇：只为给模型上下文，落在里面的话不交付
MAX_SLICE_SEC = 40.0  # 单次最多送多少秒；与 KEEP_SEC 配套
SILENT_RMS = 0.001    # 「最响的一秒」都低于这个值，才算这段真的没声音
GAP_SEC = 6.0         # 连续这么久一句没交付，就把游标推到当前 —— 静音不许把游标钉死
STALL_SEC = 8.0       # 这么久没有新音频块 = 录音流卡死（不是静音，是流不动了）
# 束搜索宽度。不是上限，但再往上不划算：2026-11-22 用真实环回音轨实测
#   1 → 81.4%（p90 156ms）｜5 → 83.6–84.0%（p90 224ms）
#   10 → 84.5%（p90 482ms）｜20 → 82.7%（p90 1292ms，单次最长 6.8s）
# 10 比 5 只高 0.5 点，落在同配置两次抖动（0.4 点）里；而切片追赶到 40 秒时
# beam 10 要 4.9 秒，会掉到 3 秒轮询预算以下。故取 5。
BEAM_SIZE = 5

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
    "raw_path": None,  # WATCH_ALONG_DUMP_RAW=1 时，原始环回 PCM 的落盘路径
    "raw_started": None,  # 本轮录音开始的墙上时间（epoch 秒）
    "last_chunk_at": 0.0,  # 最近一次拿到音频块的时刻；体检用，判断流是不是卡死了
    "rec": None,  # 当前打开的录音器；卡死时要靠它把流打断
    "source_note": None,  # 请求的来源用不上时的原因（回了整机）。给 /health 看，不许只在 stdout
    # ── 墙上时钟锚点（2026-11-23）─────────────────────────────────────────
    # 为什么需要：样本数并不等于真实时间。实测 31 分钟的一轮，音频游标跑了 35.5 分钟
    # （每分钟 0.77–1.42 之间跳，累计 +14%），于是字幕和声音的时间轴对不上。
    # 做法：每接一块音频就记一条 (缓冲位置, 墙上时间)，对外时间一律按锚点换算，
    # 不再用 "样本数 / 采样率" 当时间。t_wall0 = 本场 reset 的时刻。
    "marks": [],  # [(pos_after_append, wall_time)]，只留最近 90 秒
    "t_wall0": 0.0,
}

MARKS_KEEP_SEC = 90.0


def _wall_at(pos):
    """缓冲位置 → 墙上时间（epoch 秒）。没有锚点就返回 None，由调用方兜底。"""
    marks = ACC["marks"]
    if not marks:
        return None
    # pos / end 都是**秒**（base + 样本数/采样率），别再除 RATE
    for end, wall in marks:
        if end >= pos:
            return wall - (end - pos)
    end, wall = marks[-1]
    return wall - (end - pos)


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
    # 默认且唯一走 GPU（ADR 0003）。GPU 起不来时显式报错，不许静默退到 CPU int8：
    # 那是 1× 实时、等于没有字幕，而且用户从日志完全看不出已经降级了。
    try:
        MODEL = WhisperModel(MODEL_DIR, device="cuda", compute_type="float16")
        print(f"[asr] 模型加载完成 {time.time() - t0:.1f}s device=cuda", flush=True)
        return MODEL
    except Exception as e:
        raise RuntimeError(
            f"GPU 转写不可用（{type(e).__name__}: {str(e)[:160]}）。"
            "按 ADR 0003 不静默回退 CPU；请检查 cublas/cudnn 后重启本服务。"
        ) from e


def _to_mono(chunk):
    """把录音块压成单声道 float32 一维。

    **不能直接 `reshape(-1)`**：若某台设备忽略了 `channels=1` 的请求、回的是
    `(n, 2)` 交错数据，拉平等于把左右声道当成「32k 采样率的一路信号」，
    听感是刺啦声，Whisper 只能认出「嗯。」（see-now 的 listen.py 踩过，注释里写着）。

    本机 2026-11-22 实测：请求 `channels=1` → 回 `(n, 1)`，所以今天等价于原样拉平。
    留这道闸只为设备/USB 声卡行为变化时别静默变坏。
    """
    a = np.asarray(chunk, dtype=np.float32)
    if a.ndim == 2 and a.shape[1] > 1:
        return a.mean(axis=1)
    return a.reshape(-1)


def _resolve_audio_source(spec):
    """决定这一轮走哪条采集。返回 `(kind, payload)`，**永不抛**。

    - `("system", None)`     整机混音
    - `("process", pid)`     只录该进程（票 17）
    - `("system", "<原因>")` 配置用不了，回退整机 —— 原因必须打日志。
      静默回退最糟：用户会以为"只录视频"生效了，实际录的还是整机。
    """
    try:
        kind, target = procloopback.parse_source(spec)
    except ValueError as e:
        return ("system", f"audioSource 配置看不懂（{e}）")
    if kind == "system":
        return ("system", None)
    try:
        pid = procloopback.resolve_pid(target)
    except Exception as e:
        # 连进程表都读不到（权限/系统调用失败）时也得降级 + 留原因，不能把采集线程带走
        return ("system", f"解析 audioSource 出错（{type(e).__name__}: {e}）")
    if pid is None:
        return ("system", f"找不到进程 {target}")
    return ("process", pid)


def _ingest(chunk):
    """把一块单声道 float32 接进缓冲。整机与进程两条采集路径共用。"""
    if not len(chunk):
        return
    ACC["last_chunk_at"] = time.time()
    ACC["buf"] = np.concatenate([ACC["buf"], chunk])
    # 记一条墙上时钟锚点：缓冲位置 → 收到这块音频的时刻。
    # 块内的位置按采样率线性回推（块只有 0.25 秒，误差可忽略）。
    pos = ACC["base"] + len(ACC["buf"]) / RATE
    ACC["marks"].append((pos, ACC["last_chunk_at"]))
    while ACC["marks"] and ACC["marks"][0][0] < pos - MARKS_KEEP_SEC:
        ACC["marks"].pop(0)
    # 没有 reset（直接重启服务就开始录）时，把时间原点定在第一块音频上，
    # 免得 t 是个巨大的绝对时间戳。
    if not ACC["t_wall0"]:
        ACC["t_wall0"] = ACC["last_chunk_at"]
    # 原始 PCM 原样落盘：不受 KEEP_SEC 裁剪影响，事后可拿它和 mp3 做 A/B，
    # 分清「音频本身差」还是「实时管线处理差」。只 append 裸 s16le、不写 wav 头
    # —— 进程被强杀也不会损坏数据。
    rp = ACC["raw_path"]
    if rp:
        try:
            pcm = (np.clip(chunk, -1, 1) * 32767).astype(np.int16).tobytes()
            with open(rp, "ab") as f:
                f.write(pcm)
        except Exception:
            pass


def _capture_process(pid):
    """按进程录。目标退出/流断时抛出去，由 _capture_loop 决定回退整机。"""
    name = procloopback.pid_name(pid) or "?"
    ACC["device"] = f"进程 {name}({pid})"
    with procloopback.ProcessLoopback(pid, rate=RATE) as cap:
        # 挂到 ACC["rec"] 上，看门狗才打得断它（否则 _break_capture_stream 对这路是空操作，
        # 重开时旧线程还在 read() 里，两路会同时往缓冲里塞）
        ACC["rec"] = cap
        print(f"[asr] 开始按进程录音：{name} (pid={pid})", flush=True)
        try:
            while not ACC["stop"]:
                for block in cap.read(0.5):
                    _ingest(block)
        finally:
            ACC["rec"] = None


def _capture_device():
    """整机环回（默认路径）：一直录，并且**跟着系统的默认输出设备走**。

    为什么必须盯设备：用户换耳机/切 HDMI 之后，默认扬声器变了，而我们这条流
    还挂在旧设备上 —— 表现就是"一直没字幕"，但看不出原因。所以每隔 2 秒比一次，
    变了就重开流。
    """
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
                ACC["rec"] = rec
                nextCheck = time.time() + 2.0
                announced = False
                while not ACC["stop"]:
                    raw = rec.record(numframes=RATE // 4)
                    chunk = _to_mono(raw)
                    if len(chunk) and not announced:
                        # 只打一次：以后再遇到「录到的形状变了」，日志第一行就能看出来
                        print(f"[asr] 录音块 shape={np.shape(raw)} → 单声道 {len(chunk)} 帧", flush=True)
                        announced = True
                    _ingest(chunk)
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


def _capture_loop():
    """采集线程入口：先按 audioSource 选路径，进程回环失败就回退整机。

    回退**只发生一次**：这一轮里进程回环一旦中断，剩下的时间都走整机混音。
    反复重试没有意义（目标进程真退了就是退了），而且会每 2 秒刷一行日志。
    """
    ctypes.windll.ole32.CoInitialize(None)  # COM 是按线程的，这个线程要自己初始化
    kind, payload = _resolve_audio_source(os.environ.get("WATCH_ALONG_AUDIO_SOURCE", "system"))
    if kind == "process":
        try:
            _capture_process(payload)
            return  # 正常退出（ACC["stop"] 被置真）
        except Exception as e:
            note = f"进程回环中断（{type(e).__name__}: {e}），已回退整机混音"
            ACC["source_note"] = note
            print(f"[asr] {note}", flush=True)
    elif payload:
        # 配置看不懂 / 找不到进程：明确说一句再回退，不静默
        ACC["source_note"] = payload
        print(f"[asr] {payload}，回退整机混音", flush=True)
    else:
        ACC["source_note"] = None
    _capture_device()


def _break_capture_stream():
    """把卡住的录音流打断，别让它一直占着设备。

    WASAPI 环回有个坑：声音停太久，`rec.record()` 会一直等一个再也不来的事件，
    线程就死在那一行 —— 不抛异常、`error` 是空的、`/health` 还报 capturing:true。
    2026-11-22 实测：视频暂停一会儿，采集再也没恢复，整轮 0 字节、0 句。
    """
    rec = ACC.get("rec")
    ACC["rec"] = None
    if rec is None:
        return
    try:
        rec.__exit__(None, None, None)
    except Exception:
        pass


def start_capture():
    """确保采集线程活着。

    **不能只看「有没有这个线程对象」**：线程死了以后对象还在，老写法
    （`if ACC["thread"] is not None: return`）就永远不再启动 —— health 说在采、
    实际一个字节没有。这是 2026-11-22 那一轮 0 数据的直接原因。
    """
    th = ACC["thread"]
    if th is not None and th.is_alive():
        return
    if th is not None:
        print("[asr] 采集线程已不在，重新拉起", flush=True)
        ACC["stop"] = True
        _break_capture_stream()
        time.sleep(0.2)
    ACC["stop"] = False
    ACC["last_chunk_at"] = time.time()  # 新线程给一段宽限，别一起步就被判卡住
    ACC["thread"] = threading.Thread(target=_capture_loop, daemon=True, name="capture")
    ACC["thread"].start()


def _check_capture_health():
    """每次拉取前体检一次：线程活着、但太久没有新音频块 = 流卡住了，重开。

    为什么要这一层：线程卡在 `record()` 里时 `is_alive()` 仍然是 True，
    光靠 start_capture() 判断不出来。判据必须是「最近有没有真的拿到音频」。
    """
    th = ACC["thread"]
    if th is None or not th.is_alive():
        start_capture()
        return
    age = time.time() - ACC["last_chunk_at"]
    if age <= STALL_SEC:
        return
    print(f"[asr] 录音流 {age:.0f} 秒没有新音频，重开", flush=True)
    _trace(event="reopen", gapSec=round(age, 1), total=round(len(ACC["buf"]) / RATE, 1))
    ACC["stop"] = True
    _break_capture_stream()
    time.sleep(0.3)
    ACC["thread"] = None
    start_capture()


def _norm(text):
    """归一化：只留字母数字与汉字。只有文本是稳定的，时间码会漂。"""
    return "".join(ch for ch in str(text).lower() if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def _is_dup(key):
    """模糊判重：ASR 对同一段音频每次会给出一字之差（是/式、夜戏/夜系）。

    2026-11-21：删掉「子串包含即判重」。回放实测这条会误杀大量真实短句
    （同参数下覆盖率 77.8% → 去掉后 83.7%），而「完全相同」+「相似度 ≥0.85」
    两条已经足够挡住重叠采样带来的重复句。
    """
    for prev in ACC["seen"]:
        if prev == key:
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


def _trace(**kw):
    """每次 pull 落一行状态到 .scratch/run/pull-trace.jsonl。

    为什么值得常开：断流这类问题事后无法从别处还原。有了 total / base / emitted
    三个数，一眼就能分清是「根本没录进来」（total 不涨）、「游标不动」（emitted 卡住）
    还是「转了但一条没交付」（n=0）。每 15 秒一行，一小时约 48KB。
    """
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        kw["t"] = round(time.time(), 1)
        with open(os.path.join(RUN_DIR, "pull-trace.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(kw, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _dump(text, t0, t1):
    """把交付的每一行落到 jsonl，供事后和字幕文件对照（绝对时间才有对照价值）。"""
    try:
        os.makedirs(os.path.dirname(DUMP), exist_ok=True)
        with open(DUMP, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t0": t0, "t1": t1, "text": text}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _loudest_second(audio):
    """这段音频里「最响的那一秒」的 rms。

    为什么不整段平均：缓冲里堆着几十秒静音时，后面真有人说话，整段平均会被稀释到
    阈值以下（823 秒缓冲夹 8 秒人声，平均只剩 0.057），于是永远判静音、永远早退。
    按秒取最大，静音占比再高也稀释不掉。
    """
    a = np.asarray(audio, dtype=np.float32)
    n = len(a) // RATE
    if n <= 0:
        return float(np.sqrt(np.mean(a ** 2))) if len(a) else 0.0
    blocks = a[: n * RATE].reshape(n, RATE)
    return float(np.sqrt(np.mean(blocks ** 2, axis=1)).max())


def _trim_buffer():
    """缓冲只留最近 KEEP_SEC 秒，并把 base 前移同样的量。

    独立成函数，是因为**静音早退那条路也必须走它**。原先裁剪写在 pull() 结尾，
    静音时提前 return 就绕过去了：缓冲实测堆到 823 秒（KEEP_SEC 本该 40 秒），
    越堆越静、越静越判静音，不重启就永远好不了。
    """
    keep = int(KEEP_SEC * RATE)
    buf = ACC["buf"]
    if len(buf) > keep:
        drop = len(buf) - keep
        ACC["buf"] = buf[drop:]
        ACC["base"] += drop / RATE


def transcribe(audio):
    model = load()
    t0 = time.time()
    segments, info = model.transcribe(
        audio,
        language="zh",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400},
        beam_size=BEAM_SIZE,
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
    _check_capture_health()
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

    rms = _loudest_second(audio)
    if rms < SILENT_RMS:
        # 静音也**必须**先裁剪缓冲、推进游标再走 —— 见 _trim_buffer 的注释。
        # 游标只在「确实空了一大段」时才推，短静音留着，免得把刚开头的话跳过。
        if end_abs - ACC["emitted_until"] > GAP_SEC:
            ACC["emitted_until"] = end_abs - MARGIN_SEC
        _trim_buffer()
        _trace(silent=True, n=0, segs=0, slice=round(len(audio) / RATE, 1),
               total=round(len(ACC["buf"]) / RATE, 1), base=round(ACC["base"], 1),
               emitted=round(ACC["emitted_until"], 1), rms=round(rms, 5))
        return {"lines": [], "ms": 0, "silent": True, "rms": round(rms, 5),
                "total": round(len(ACC["buf"]) / RATE, 2)}

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
        # 对外时间按墙上时钟换算（见 ACC["marks"] 的注释）。换不到就退回样本数口径，
        # 至少不会因为锚点缺失而整条丢掉。
        w0, w1 = _wall_at(t0), _wall_at(t1)
        o0 = round(w0 - ACC["t_wall0"], 2) if (w0 is not None and ACC["t_wall0"]) else round(t0, 2)
        o1 = round(w1 - ACC["t_wall0"], 2) if (w1 is not None and ACC["t_wall0"]) else round(t1, 2)
        done.append({"text": line["text"], "t0": o0, "t1": o1})
        _dump(line["text"], o0, o1)
        ACC["seen"].append(key)
        if len(ACC["seen"]) > SEEN_MAX:
            ACC["seen"] = ACC["seen"][-SEEN_MAX:]
        ACC["emitted_until"] = max(ACC["emitted_until"], t1)

    # 只有"这一拍压根没有新句子"时才推进游标。
    # 若模型给了句子、但都因"尾巴还没说完"被跳过，**绝不能推进** ——
    # 推进就等于把那句话永久丢掉（实测丢过"不可怕"这种真实台词）。
    #
    # 但「有新句子」必须按**新内容**算，不能按「segs>0」算：模型经常返回一段完全
    # 落在游标之前的残句（前摇那 1.5 秒重转出来的），它永远过不了 `t1 <= emitted_until`
    # 这一关，却把推进也一起堵死了 —— 游标钉死、切片从 3 秒涨到 40 秒、每拍白转一遍。
    # 2026-11-22 17:28 与 17:33 各实测一次（emitted 冻在 494.2 / 736.3）。
    freshSegs = [s for s in res["lines"]
                 if start_abs + float(s["t1"]) > ACC["emitted_until"]]
    if not done and not freshSegs and end_abs - ACC["emitted_until"] > GAP_SEC:
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

    # 裁剪缓冲：只前移 base（游标是绝对时间，不用动）
    _trim_buffer()

    _trace(silent=False, n=len(done), segs=len(res["lines"]), slice=round(len(audio) / RATE, 1),
           total=round(len(ACC["buf"]) / RATE, 1), base=round(ACC["base"], 1),
           emitted=round(ACC["emitted_until"], 1), rms=round(rms, 5))

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
    ACC["marks"] = []
    ACC["t_wall0"] = time.time()
    # 这里**不要**清 error：采集线程死了/卡住时它是唯一线索。清掉之后 /health
    # 显示一切正常，实际一字节没录到 —— 2026-11-22 正是这么被瞒过去的。
    try:
        if os.path.exists(DUMP):
            os.remove(DUMP)
    except Exception:
        pass

    # 每轮一份原始录音。**默认关闭**：环回录的是整机声音，不显式打开就不落盘。
    # 打开方式：启动本服务时设 WATCH_ALONG_DUMP_RAW=1；重启后 curl /health 看 rawDump 确认。
    if os.environ.get("WATCH_ALONG_DUMP_RAW") == "1":
        os.makedirs(RUN_DIR, exist_ok=True)
        tag = safe if session else "default"
        rp = os.path.join(RUN_DIR, f"raw-{tag}.s16le")
        try:
            open(rp, "wb").close()  # 新一轮从空文件开始
            ACC["raw_path"] = rp
            ACC["raw_started"] = time.time()
            meta = {"session": tag, "rate": RATE, "channels": 1, "sample_width": 2,
                    "encoding": "signed 16-bit little-endian PCM, no header",
                    "started_epoch": ACC["raw_started"],
                    "note": "numpy.fromfile(path, dtype=np.int16) / 32768 即可还原 float32"}
            json.dump(meta, open(os.path.join(RUN_DIR, f"raw-{tag}.json"), "w",
                                 encoding="utf-8"), ensure_ascii=False, indent=1)
            print(f"[asr] 原始录音已开启：{rp}", flush=True)
        except Exception as e:
            ACC["raw_path"] = None
            print(f"[asr] 原始录音开启失败：{e}", flush=True)
    else:
        ACC["raw_path"] = None


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
            # capturing 必须是「线程活着」，不是「有个线程对象」——后者在线程死掉后依然为真
            "capturing": ACC["thread"] is not None and ACC["thread"].is_alive(),
            # 隔多久没拿到音频（秒）。静音时也会持续刷新，只有流卡死才会一直变大。
            "lastAudioAge": (round(time.time() - ACC["last_chunk_at"], 1)
                             if ACC["last_chunk_at"] else None),
            "device": ACC["device"],
            # 请求的来源用不上时会写明原因（例如"找不到进程 xxx，回退整机混音"）。
            # 降级允许，静默不让 —— GLOSSARY「降级」。
            "audioNote": ACC["source_note"],
            "error": ACC["error"],
            # 重启后 curl 一下就能确认录音开关真的开起来了，别等跑完 5 分钟才发现没录到
            "rawDump": ACC["raw_path"],
            "rawStarted": ACC["raw_started"],
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
