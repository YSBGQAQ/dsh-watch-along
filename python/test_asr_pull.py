r"""pull() / 采集块的回归测试：只碰缓冲、游标、单声道混合，不加载模型、不开录音。

跑法（必须用项目 venv，系统 Python 没装 numpy）：
    cd <repo>
    ..\_deps\venv\Scripts\python.exe -m unittest discover -s python -p "test_*.py" -v

为什么用 stdlib unittest 而不是 pytest：AGENTS.md 规定下载必须交办用户，
装 pytest 要联网，而这里要测的东西一个 unittest 就够。
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asr_service as A  # noqa: E402

RATE = A.RATE


def zeros(sec):
    return np.zeros(int(sec * RATE), dtype=np.float32)


def tone(sec, amp=0.5, freq=220.0):
    t = np.arange(int(sec * RATE)) / RATE
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class PullCase(unittest.TestCase):
    """每个用例都从一个干净的 ACC 起步，转写被替身接管（用例里断言不该被调用）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._patches = [
            mock.patch.object(A, "start_capture", lambda: None),
            mock.patch.object(A, "transcribe", mock.Mock(side_effect=AssertionError("本用例不该真转写"))),
            mock.patch.object(A, "DUMP", os.path.join(self.tmp, "asr-out.jsonl")),
            mock.patch.object(A, "RUN_DIR", self.tmp),
        ]
        for p in self._patches:
            p.start()
        A.ACC.update(buf=zeros(0), base=0.0, emitted_until=0.0, seen=[], error=None,
                     thread=None, stop=False, device=None, raw_path=None, raw_started=None)

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()

    def stub_speech(self, text="测试台词"):
        """让转写返回一句“已说完”的话，时间码相对这一段音频。"""
        A.transcribe.side_effect = None
        A.transcribe.return_value = {
            "lines": [{"text": text, "t0": 1.0, "t1": 2.0}], "ms": 1.0, "lang": "zh",
        }

    # ---------- A1：静音不该把缓冲撑大 ----------

    def test_长静音时缓冲必须裁剪(self):
        A.ACC["buf"] = zeros(120)
        A.pull()
        kept = len(A.ACC["buf"]) / RATE
        self.assertLessEqual(
            kept, A.KEEP_SEC + 1,
            f"静音 120 秒后缓冲还留着 {kept:.1f}s，KEEP_SEC={A.KEEP_SEC} —— 早退绕过了裁剪",
        )

    def test_长静音时游标要前进(self):
        A.ACC["buf"] = zeros(60)
        A.pull()
        self.assertGreater(
            A.ACC["emitted_until"], 55.0,
            "静音期间游标一直钉在 0，之后有声音也要从 0 重转；缓冲越大越转不动",
        )

    def test_静音之后恢复出声能立刻交付(self):
        A.ACC["buf"] = zeros(60)
        A.pull()  # 先过一段静音
        self.stub_speech()
        A.ACC["buf"] = np.concatenate([A.ACC["buf"], tone(10, amp=0.3)])
        out = A.pull()
        self.assertEqual(len(out["lines"]), 1, f"静音后第一句没交付：{out}")

    def test_整拍都是旧句子时游标要能推进(self):
        # 模型返回一段完全落在游标之前的残句（前摇重转出来的）。它过不了
        # 「t1 <= emitted_until」那一关，但不能因此把游标推进也一起堵死。
        A.transcribe.side_effect = None
        A.transcribe.return_value = {
            "lines": [{"text": "之前已经交付过的台词", "t0": 0.0, "t1": 1.0}], "ms": 1.0, "lang": "zh",
        }
        A.ACC["buf"] = tone(40, amp=0.3)
        A.ACC["emitted_until"] = 30.0
        A.pull()
        self.assertGreater(
            A.ACC["emitted_until"], 35.0,
            "游标被一句旧台词钉死了，切片会一路涨到 MAX_SLICE，每拍白转一遍",
        )

    # ---------- A1：rms 不能被历史静音稀释 ----------

    def test_最响的一秒不被静音稀释(self):
        a = np.concatenate([zeros(300), tone(8, amp=0.5)])
        self.assertGreater(A._loudest_second(a), 0.3, "整段平均会把 8 秒人声稀释成 0.057")
        self.assertLess(A._loudest_second(zeros(60)), 0.001)

    def test_pull_上报的_rms_看得见尾部声音(self):
        self.stub_speech()
        A.transcribe.return_value = {"lines": [], "ms": 1.0, "lang": "zh"}
        A.ACC["buf"] = np.concatenate([zeros(300), tone(8, amp=0.5)])
        with mock.patch.object(A, "MAX_SLICE_SEC", 400.0):
            out = A.pull()
        self.assertGreater(out["rms"], 0.2, f"rms={out['rms']}，说明仍在按整段平均")

    def test_真静音仍然判静音(self):
        A.ACC["buf"] = zeros(30)
        out = A.pull()
        self.assertTrue(out.get("silent"), "全零音频没被判静音")

    # ---------- A2：声道混合 ----------

    def test_双声道交错必须按声道平均(self):
        n = 1000
        st = np.stack([np.ones(n, dtype=np.float32), -np.ones(n, dtype=np.float32)], axis=1)
        out = A._to_mono(st)
        self.assertEqual(out.shape, (n,), "立体声块没有压成 n 帧单声道")
        self.assertLess(float(np.abs(out).max()), 1e-6,
                        "没有按声道平均；直接 reshape(-1) 会把左右当成 32k 的一路信号")

    def test_单声道块原样返回(self):
        x = (np.arange(1000, dtype=np.float32) / 1000)
        out = A._to_mono(x.reshape(-1, 1))
        self.assertEqual(out.shape, (1000,))
        np.testing.assert_allclose(out, x)


class CaptureHealthCase(unittest.TestCase):
    """采集线程的生死判断。这类问题不会抛异常，只会让整轮悄悄变成 0 句。"""

    def setUp(self):
        A.ACC.update(buf=zeros(0), base=0.0, emitted_until=0.0, seen=[], error=None,
                     thread=None, stop=False, device=None, raw_path=None, raw_started=None,
                     last_chunk_at=0.0, rec=None)
        self.tmp = tempfile.mkdtemp()
        self._p = mock.patch.object(A, "RUN_DIR", self.tmp)
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_线程死了要自动重起(self):
        dead = threading.Thread(target=lambda: None)
        dead.start()
        dead.join()
        A.ACC["thread"] = dead
        with mock.patch.object(A, "_capture_loop", lambda: time.sleep(0.5)):
            A.start_capture()
            self.assertIsNot(A.ACC["thread"], dead, "死掉的线程对象把重起挡住了")
            self.assertTrue(A.ACC["thread"].is_alive())

    def test_流卡住要重开(self):
        live = threading.Thread(target=lambda: time.sleep(1.5))
        live.start()
        A.ACC["thread"] = live
        A.ACC["last_chunk_at"] = time.time() - 30
        with mock.patch.object(A, "start_capture") as sc, \
                mock.patch.object(A, "_break_capture_stream") as br:
            A._check_capture_health()
        self.assertTrue(br.called, "卡住时没有去打断旧流")
        self.assertTrue(sc.called, "卡住时没有重开")

    def test_有音频时不折腾(self):
        live = threading.Thread(target=lambda: time.sleep(1.5))
        live.start()
        A.ACC["thread"] = live
        A.ACC["last_chunk_at"] = time.time()
        with mock.patch.object(A, "start_capture") as sc:
            A._check_capture_health()
        self.assertFalse(sc.called, "音频正常时不该重开")


class AudioSourceCase(unittest.TestCase):
    """audioSource 的判定层（票 17）：哪种写法走哪条采集、回退时给不给原因。"""

    def test_默认走整机(self):
        self.assertEqual(A._resolve_audio_source("system"), ("system", None))

    def test_配置看不懂要回退并留原因(self):
        kind, why = A._resolve_audio_source("device")
        self.assertEqual(kind, "system")
        self.assertTrue(why and "看不懂" in why, f"回退没给原因：{why!r}")

    def test_找不到进程要回退并留原因(self):
        kind, why = A._resolve_audio_source("process:no-such-process-xyz")
        self.assertEqual(kind, "system")
        self.assertIn("找不到进程", why)

    def test_能解析到活进程(self):
        # python 自己的 PID 必然存在，这条同时验证「纯数字当 PID」那条支路
        self.assertEqual(A._resolve_audio_source(f"process:{os.getpid()}"), ("process", os.getpid()))

    def test_解析出错也不抛(self):
        # 进程表读不到（权限 / 系统调用失败）不能让采集线程直接死掉
        with mock.patch.object(A.procloopback, "resolve_pid", side_effect=OSError("拒绝访问")):
            kind, why = A._resolve_audio_source("process:ego")
        self.assertEqual(kind, "system")
        self.assertIn("出错", why)


class CaptureLoopFallbackCase(unittest.TestCase):
    """进程回环失败时的回退语义：必须真的走整机，且**在状态里**留下原因。"""

    def setUp(self):
        A.ACC.update(buf=zeros(0), base=0.0, emitted_until=0.0, seen=[], error=None,
                     thread=None, stop=False, device=None, raw_path=None, raw_started=None,
                     last_chunk_at=0.0, rec=None, source_note=None)
        self.tmp = tempfile.mkdtemp()
        self._p = mock.patch.object(A, "RUN_DIR", self.tmp)
        self._p.start()

    def tearDown(self):
        self._p.stop()

    def test_进程回环中断要回退整机并留原因(self):
        calls = []
        with mock.patch.object(A, "_resolve_audio_source", lambda spec: ("process", 4321)), \
                mock.patch.object(A, "_capture_process",
                                  side_effect=A.procloopback.TargetGone("目标走了")), \
                mock.patch.object(A, "_capture_device", lambda: calls.append(1)):
            A._capture_loop()
        self.assertEqual(calls, [1], "中断后没有回退到整机")
        self.assertIn("进程回环中断", A.ACC["source_note"] or "")

    def test_来源用不了也要留原因(self):
        calls = []
        with mock.patch.object(A, "_resolve_audio_source", lambda spec: ("system", "找不到进程 x")), \
                mock.patch.object(A, "_capture_device", lambda: calls.append(1)):
            A._capture_loop()
        self.assertEqual(calls, [1])
        self.assertIn("找不到进程", A.ACC["source_note"])

    def test_走整机时不写原因(self):
        calls = []
        with mock.patch.object(A, "_resolve_audio_source", lambda spec: ("system", None)), \
                mock.patch.object(A, "_capture_device", lambda: calls.append(1)):
            A._capture_loop()
        self.assertEqual(calls, [1])
        self.assertIsNone(A.ACC["source_note"], "正常走整机却记了一条降级原因")


if __name__ == "__main__":
    unittest.main()
