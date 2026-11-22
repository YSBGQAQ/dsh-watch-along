"""进程级环回：只录指定进程（及其子进程树）的输出声音，纯 ctypes。

## 出处

从 `vendor/dsh-see-now-main/examples/floating-chat/procloopback.py`（Apache-2.0，
许可见 `vendor/dsh-see-now-main/LICENSE`）移植，只保留本仓库用得上的部分：

- **保留**：COM 基础设施、进程表（Toolhelp32）、`ActivateAudioInterfaceAsync` 的
  进程回环激活、`ProcessLoopback` 的读写与 `TargetGone`。
- **删掉**：`audio_sessions()` / `auto_target()`（see-now 的"自动找正在出声的进程"）、
  `capture_to_wav()` / CLI。票 17 只要求**显式指定** `process:<pid|名字>`，
  自动挑目标不在范围内，留着就是死代码。

## 为什么用这套而不是 soundcard

`soundcard` 只能抓"默认输出设备"的整机混音，没法按进程过滤。Windows 从 2004 起
提供 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`（`VAD\\Process_Loopback`），
它抓的是**进程树**，所以浏览器那种"主进程不发声、audio utility 子进程发声"的
情况也能覆盖。

## 契约（给调用方）

- 目标静音时**仍然有包**（内容全 0），所以断句按能量判，不能靠"没有数据"判静音；
- 目标进程退出后，`read()` 抛 `TargetGone`，上层据此回退整机环回；
- 所有失败路径都抛 `OSError` / `TargetGone`，**不静默返回空**——静默会让上层
  以为"没声音"，而实际是"抓不到"。
"""
import ctypes
import os
import time
import uuid
from ctypes import wintypes as wt

HRESULT = ctypes.c_long
S_OK = 0
E_NOINTERFACE = -2147467262

IID_UNKNOWN = uuid.UUID("00000000-0000-0000-C000-000000000046")
IID_IHANDLER = uuid.UUID("41D949AB-9862-444A-80F6-C261334DA5EB")
IID_IAGILE = uuid.UUID("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")
IID_IAUDIOCLIENT = uuid.UUID("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")
IID_IAUDIOCAPTURECLIENT = uuid.UUID("C8ADBD64-E71E-48A0-A4DE-185C395CD317")

VT_BLOB = 65
AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0

AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2

CALLBACK_TIMEOUT_SEC = 10.0


# ── 音频来源的解析（纯函数，可单测） ──────────────────────────────────────


def parse_source(spec):
    """把 `audioSource` 的取值解析成 `(kind, target)`。

    `system`           → `("system", None)`     整机混音（默认）
    `process:<名字|pid>` → `("process", "<名字|pid>")`

    其它一律抛 `ValueError`。**不允许静默回退** —— 用户以为"只录视频"生效了、
    实际录的是整机，是最糟的一种错。
    """
    if not isinstance(spec, str):
        raise ValueError(f"audioSource 必须是字符串，收到 {type(spec).__name__}")
    s = spec.strip()
    low = s.lower()  # 只对「种类」宽容大小写；进程名原样保留（Windows 侧不区分）
    if low == "system":
        return ("system", None)
    if low.startswith("process:"):
        target = s[len("process:"):].strip()
        if not target:
            raise ValueError("audioSource=process: 后面必须跟进程名或 PID")
        return ("process", target)
    raise ValueError(f"audioSource 只接受 system 或 process:<名字|pid>，收到 {spec!r}")


def resolve_pid(target, pids_fn=None, alive_fn=None, table_fn=None):
    """把 `process:` 后面的目标解析成一个还活着的 PID；解析不到返回 None。

    纯数字当 PID（还要求活着，防止误用旧 PID）；否则按进程名找，并**优先取进程树的根**。

    为什么必须取根：进程回环的激活模式是 `INCLUDE_TARGET_PROCESS_TREE`
    （目标 + 全部子孙）。浏览器那种「主进程不发声、声音在 audio utility 子进程里」的结构，
    如果随手挑一个渲染子进程，拿到的是**那个子进程树**——里面没有声卡输出，于是
    采到的全是静音（2026-11-22 实测：挑中 pid 35232 时 3 秒拿到 2.99 秒音频、峰值 0.0000）。
    """
    t = str(target or "").strip()
    if not t:
        return None
    pids_fn = pids_fn or find_pids
    alive_fn = alive_fn or is_alive
    if t.isdigit():
        pid = int(t)
        return pid if alive_fn(pid) else None
    pids = [p for p in pids_fn(t) if alive_fn(p)]
    if not pids:
        return None
    if len(pids) == 1:
        return pids[0]
    table_fn = table_fn or iter_processes
    parent = {pid: ppid for pid, _name, ppid in table_fn()}
    same = set(pids)
    roots = [p for p in pids if parent.get(p) not in same]
    return roots[0] if roots else pids[0]


# ── COM 基础设施 ──────────────────────────────────────────────────────────


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    def __init__(self, value=None):
        super().__init__()
        if value is not None:
            ctypes.memmove(ctypes.byref(self), uuid.UUID(str(value)).bytes_le, 16)

    def raw(self):
        return ctypes.string_at(ctypes.byref(self), 16)


class PROCESS_LOOPBACK_PARAMS(ctypes.Structure):
    _fields_ = [
        ("TargetProcessId", wt.DWORD),
        ("ProcessLoopbackMode", ctypes.c_int),
    ]


class ACTIVATION_PARAMS(ctypes.Structure):
    _fields_ = [
        ("ActivationType", ctypes.c_int),
        ("ProcessLoopbackParams", PROCESS_LOOPBACK_PARAMS),
    ]


class PROPVARIANT_BLOB(ctypes.Structure):
    # vt = VT_BLOB 时的 PROPVARIANT：8 字节头 + BLOB{ULONG cbSize; BYTE *pBlobData;}
    _fields_ = [
        ("vt", ctypes.c_ushort),
        ("r1", ctypes.c_ushort),
        ("r2", ctypes.c_ushort),
        ("r3", ctypes.c_ushort),
        ("cbSize", wt.ULONG),
        ("pBlobData", ctypes.c_void_p),
    ]


class WAVEFORMATEX(ctypes.Structure):
    _fields_ = [
        ("wFormatTag", wt.WORD),
        ("nChannels", wt.WORD),
        ("nSamplesPerSec", wt.DWORD),
        ("nAvgBytesPerSec", wt.DWORD),
        ("nBlockAlign", wt.WORD),
        ("wBitsPerSample", wt.WORD),
        ("cbSize", wt.WORD),
    ]


QI_FN = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p))
REF_FN = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
ACT_FN = ctypes.WINFUNCTYPE(HRESULT, ctypes.c_void_p, ctypes.c_void_p)


class _VtblObject(ctypes.Structure):
    _fields_ = [("vtbl", ctypes.POINTER(ctypes.c_void_p))]


def _com_slot(ptr, index, argtypes, restype=HRESULT):
    """把 COM 接口的第 index 个 vtable 槽取成可调用原型。"""
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])


def _release(ptr):
    if not ptr or not ptr.value:
        return
    try:
        _com_slot(ptr, 2, [])(ptr)
    except Exception:
        pass


def _query_interface(ptr, iid):
    qi = _com_slot(ptr, 0, [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)])
    out = ctypes.c_void_p()
    guid = GUID(iid)
    hr = qi(ptr, ctypes.byref(guid), ctypes.byref(out))
    return hr, out


def _co_initialize():
    try:
        ctypes.WinDLL("ole32").CoInitializeEx(None, 0x0)  # COINIT_MULTITHREADED
    except Exception:
        pass


def _co_uninitialize():
    try:
        ctypes.WinDLL("ole32").CoUninitialize()
    except Exception:
        pass


# ── 进程表（Toolhelp32） ─────────────────────────────────────────────────

TH32CS_SNAPPROCESS = 0x2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", wt.WCHAR * 260),
    ]


def iter_processes():
    """(pid, 可执行文件名, 父 pid) 的列表。失败返回空列表（不抛）。

    带父 pid 是为了能找出「进程树的根」—— 见 `resolve_pid` 的注释。
    """
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wt.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
    kernel32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [wt.HANDLE]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap in (None, wt.HANDLE(-1).value):
        return []
    rows = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            rows.append((int(entry.th32ProcessID), entry.szExeFile, int(entry.th32ParentProcessID)))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return rows


def _norm(name):
    base = os.path.basename(str(name or "")).lower()
    return base[:-4] if base.endswith(".exe") else base


def find_pids(process_name):
    """按进程名（带不带 .exe 都行，大小写不敏感）找 PID，按进程表顺序。"""
    want = _norm(process_name)
    if not want:
        return []
    return [pid for pid, name, _ppid in iter_processes() if _norm(name) == want]


def pid_name(pid):
    for p, name, _ppid in iter_processes():
        if p == pid:
            return name
    return ""


def is_alive(pid):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wt.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


# ── 进程回环本体 ─────────────────────────────────────────────────────────


class TargetGone(RuntimeError):
    """目标进程没了（退出/被杀）—— 上层据此回退整机环回。"""


def _activation_handler():
    """一个 4 槽 vtable 的 COM 对象：IUnknown 三个 + ActivateCompleted。"""
    import threading

    state = {"event": threading.Event(), "hr": None, "activate_result": None,
             "unknown": None, "error": None}

    @QI_FN
    def qi(this, riid, ppv):
        try:
            want = riid.contents.raw()
        except Exception:
            return E_NOINTERFACE
        if want in (IID_UNKNOWN.bytes_le, IID_IHANDLER.bytes_le, IID_IAGILE.bytes_le):
            ppv[0] = this
            return S_OK
        ppv[0] = None
        return E_NOINTERFACE

    @REF_FN
    def addref(this):
        return 2

    @REF_FN
    def release(this):
        return 1

    @ACT_FN
    def activate_completed(this, operation):
        try:
            # IActivateAudioInterfaceAsyncOperation::GetActivateResult(HRESULT*, IUnknown**)
            slot = _com_slot(operation, 3, [ctypes.POINTER(HRESULT), ctypes.POINTER(ctypes.c_void_p)])
            result = HRESULT(0)
            unknown = ctypes.c_void_p()
            state["hr"] = slot(operation, ctypes.byref(result), ctypes.byref(unknown))
            state["activate_result"] = result.value
            state["unknown"] = unknown
        except Exception as exc:  # 绝不把异常抛回 COM
            state["hr"] = -1
            state["error"] = repr(exc)
        finally:
            state["event"].set()
        return S_OK

    callbacks = [qi, addref, release, activate_completed]
    vtbl = (ctypes.c_void_p * 4)(*[ctypes.cast(cb, ctypes.c_void_p).value for cb in callbacks])
    holder = _VtblObject(vtbl=ctypes.cast(vtbl, ctypes.POINTER(ctypes.c_void_p)))
    this = ctypes.cast(ctypes.pointer(holder), ctypes.c_void_p)
    return {"holder": holder, "vtbl": vtbl, "callbacks": callbacks, "this": this, "state": state}


def _activate_process_loopback(pid):
    """返回 (IAudioClient*, keepalive)。失败抛 OSError（带 HRESULT）。"""
    _co_initialize()
    mmdevapi = ctypes.WinDLL("mmdevapi")
    activate = mmdevapi.ActivateAudioInterfaceAsync
    activate.argtypes = [
        wt.LPCWSTR, ctypes.POINTER(GUID), ctypes.POINTER(PROPVARIANT_BLOB),
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
    ]
    activate.restype = HRESULT

    params = ACTIVATION_PARAMS(
        ActivationType=AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        ProcessLoopbackParams=PROCESS_LOOPBACK_PARAMS(
            TargetProcessId=int(pid),
            ProcessLoopbackMode=PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
        ),
    )
    prop = PROPVARIANT_BLOB(
        vt=VT_BLOB, r1=0, r2=0, r3=0,
        cbSize=ctypes.sizeof(params),
        pBlobData=ctypes.cast(ctypes.byref(params), ctypes.c_void_p),
    )

    handler = _activation_handler()
    riid = GUID(IID_IAUDIOCLIENT)
    operation = ctypes.c_void_p()
    hr = activate("VAD\\Process_Loopback", ctypes.byref(riid), ctypes.byref(prop),
                  handler["this"], ctypes.byref(operation))
    if hr != S_OK:
        raise OSError(f"ActivateAudioInterfaceAsync 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
    if not operation.value:
        raise OSError("ActivateAudioInterfaceAsync 返回空操作")
    if not handler["state"]["event"].wait(CALLBACK_TIMEOUT_SEC):
        raise OSError("等待激活回调超时")
    if handler["state"]["hr"] != S_OK:
        raise OSError(f"GetActivateResult 失败：HRESULT 0x{handler['state']['hr'] & 0xFFFFFFFF:08X}")
    if handler["state"]["activate_result"] != S_OK:
        raise OSError(f"激活结果：HRESULT 0x{handler['state']['activate_result'] & 0xFFFFFFFF:08X}")

    unknown = handler["state"]["unknown"]
    if not unknown or not unknown.value:
        raise OSError("激活没有返回接口")
    hr, audio_client = _query_interface(unknown, IID_IAUDIOCLIENT)
    _release(unknown)
    if hr != S_OK or not audio_client.value:
        raise OSError(f"QueryInterface(IAudioClient) 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
    return audio_client, handler


class ProcessLoopback:
    """按进程抓音频。用法：

        cap = ProcessLoopback(pid)
        cap.open()
        for block in cap.read():   # list[np.float32]，16k 单声道
            ...
        cap.close()

    目标静音时**仍然有包**（内容是 0），所以断句按能量判；目标进程退出时
    下一次 `read()` 抛 `TargetGone`，上层回退整机环回。
    """

    def __init__(self, pid, rate=16000, channels=1, bits=16):
        self.pid = int(pid)
        self.rate = rate
        self.channels = channels
        self.bits = bits
        self.audio_client = ctypes.c_void_p()
        self.capture_client = ctypes.c_void_p()
        self._handler = None
        self._started = False
        self._last_alive_check = 0.0
        self._block_align = channels * bits // 8

    # -- 生命周期 --
    def open(self):
        audio_client, handler = _activate_process_loopback(self.pid)
        self.audio_client = audio_client
        self._handler = handler
        try:
            self._initialize()
            self._get_capture_client()
            self._start()
        except Exception:
            self.close()
            raise
        return self

    def _initialize(self):
        wfx = WAVEFORMATEX(
            wFormatTag=1,
            nChannels=self.channels,
            nSamplesPerSec=self.rate,
            nAvgBytesPerSec=self.rate * self._block_align,
            nBlockAlign=self._block_align,
            wBitsPerSample=self.bits,
            cbSize=0,
        )
        initialize = _com_slot(
            self.audio_client, 3,
            [ctypes.c_int, wt.DWORD, ctypes.c_longlong, ctypes.c_longlong,
             ctypes.POINTER(WAVEFORMATEX), ctypes.c_void_p],
        )
        # 共享模式 + LOOPBACK；进程回环是虚拟设备，格式自定（16k/单声道/16bit）。
        hr = initialize(self.audio_client, AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, ctypes.byref(wfx), None)
        if hr != S_OK:
            raise OSError(f"IAudioClient::Initialize 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")

    def _get_capture_client(self):
        get_service = _com_slot(self.audio_client, 14,
                                [ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)])
        iid = GUID(IID_IAUDIOCAPTURECLIENT)
        client = ctypes.c_void_p()
        hr = get_service(self.audio_client, ctypes.byref(iid), ctypes.byref(client))
        if hr != S_OK or not client.value:
            raise OSError(f"GetService(IAudioCaptureClient) 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
        self.capture_client = client

    def _start(self):
        hr = _com_slot(self.audio_client, 10, [])(self.audio_client)
        if hr != S_OK:
            raise OSError(f"IAudioClient::Start 失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
        self._started = True

    def close(self):
        if self._started and self.audio_client:
            try:
                _com_slot(self.audio_client, 11, [])(self.audio_client)
            except Exception:
                pass
            self._started = False
        _release(self.capture_client)
        self.capture_client = ctypes.c_void_p()
        _release(self.audio_client)
        self.audio_client = ctypes.c_void_p()
        _co_uninitialize()

    def __enter__(self):
        return self.open()

    def __exit__(self, *exc):
        self.close()

    # -- 采集 --
    def read(self, timeout=0.1):
        """取一批音频块（每块 ≈ 一个 WASAPI 包，通常 100ms）。

        返回 `list[np.ndarray]`（float32，[-1,1]）。超过 `timeout` 没包返回空列表。
        """
        import numpy as np

        now = time.monotonic()
        if now - self._last_alive_check > 1.0:
            self._last_alive_check = now
            if not is_alive(self.pid):
                raise TargetGone(f"目标进程 {self.pid} 已经不在了")

        get_next = _com_slot(self.capture_client, 5, [ctypes.POINTER(wt.UINT)])
        get_buffer = _com_slot(
            self.capture_client, 3,
            [ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wt.UINT), ctypes.POINTER(wt.DWORD),
             ctypes.POINTER(ctypes.c_ulonglong), ctypes.POINTER(ctypes.c_ulonglong)],
        )
        release_buffer = _com_slot(self.capture_client, 4, [wt.UINT])

        blocks = []
        deadline = now + timeout
        while time.monotonic() < deadline:
            n = wt.UINT(0)
            hr = get_next(self.capture_client, ctypes.byref(n))
            if hr != S_OK:
                raise TargetGone(f"取包失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
            if n.value == 0:
                break
            got = False
            while n.value:
                data = ctypes.c_void_p()
                frames = wt.UINT(0)
                flags = wt.DWORD(0)
                dev_pos = ctypes.c_ulonglong(0)
                qpc_pos = ctypes.c_ulonglong(0)
                hr = get_buffer(self.capture_client, ctypes.byref(data), ctypes.byref(frames),
                                ctypes.byref(flags), ctypes.byref(dev_pos), ctypes.byref(qpc_pos))
                if hr != S_OK:
                    raise TargetGone(f"读包失败：HRESULT 0x{hr & 0xFFFFFFFF:08X}")
                count = frames.value
                if count:
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT or not data.value:
                        pcm = np.zeros(count, dtype=np.int16)
                    else:
                        raw = ctypes.string_at(data.value, count * self._block_align)
                        pcm = np.frombuffer(raw, dtype="<i2")
                    blocks.append(pcm.astype(np.float32) / 32768.0)
                    got = True
                release_buffer(self.capture_client, count)
                n = wt.UINT(0)
                if get_next(self.capture_client, ctypes.byref(n)) != S_OK:
                    break
            if got:
                break
            time.sleep(0.005)
        return blocks
