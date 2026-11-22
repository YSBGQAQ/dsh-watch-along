"""陪看测试期间的资源监控：每 10 秒记一行 GPU 显存 + 各相关进程内存。

用法：
    python scripts/monitor-resources.py
日志：
    .scratch/run/resource-<YYYYMMDD-HHMMSS>.log
停止：
    在窗口里按 Ctrl+C（或关掉窗口）

只记录，不改任何服务行为。Windows WDDM 下 nvidia-smi 拿不到「每进程显存」，
所以 GPU 记全局显存/利用率；各进程内存取 Win32_Process.WorkingSetSize。
"""
import datetime
import os
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN = os.path.join(ROOT, ".scratch", "run")
os.makedirs(RUN, exist_ok=True)
LOG = os.path.join(RUN, "resource-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".log")

PS = r"""
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -match 'ocr_service\.py|asr_service\.py' -or $_.Name -eq 'node.exe'
} | ForEach-Object {
  $tag = if ($_.CommandLine -match 'ocr_service') { 'OCR' }
         elseif ($_.CommandLine -match 'asr_service') { 'ASR' }
         else { 'NODE' }
  "$tag|$($_.ProcessId)|$($_.WorkingSetSize)"
}
"""


def gpu():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10).stdout.strip()
        parts = [p.strip() for p in out.split(",")]
        return f"mem={parts[0]}MB util={parts[1]}%" if len(parts) >= 2 else f"raw={out}"
    except Exception as e:
        return "ERR:" + type(e).__name__


def procs():
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", PS],
            capture_output=True, text=True, timeout=20).stdout
        rows = []
        for line in out.splitlines():
            p = line.strip().split("|")
            if len(p) == 3 and p[2].isdigit():
                rows.append(f"{p[0]}#{p[1]}={int(p[2]) // 1048576}MB")
        return " ".join(rows) if rows else "no-service-process"
    except Exception as e:
        return "ERR:" + type(e).__name__


print("资源监控启动，日志:", LOG, flush=True)
print("每 10 秒一行；Ctrl+C 停止。", flush=True)
try:
    with open(LOG, "a", encoding="utf-8") as f:
        f.write("time gpu mem/util processes(WorkingSet)\n")
        f.flush()
        while True:
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            line = f"{ts} gpu_{gpu()} | {procs()}"
            f.write(line + "\n")
            f.flush()
            print(line, flush=True)
            time.sleep(10)
except KeyboardInterrupt:
    print("监控已停止，日志:", LOG, flush=True)
