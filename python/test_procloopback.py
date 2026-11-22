"""进程回环的纯逻辑测试：解析 audioSource、解析 PID。

不碰 COM、不开流 —— 那些只能真机验（票 17 的验收项也是这么写的）。
这里守的是**判定层**：哪种写法算合法、找不到进程时给什么，因为这些错了
上层会静默回退整机，用户还以为"只录视频"生效了。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import procloopback as P  # noqa: E402


class ParseSourceCase(unittest.TestCase):
    def test_system(self):
        self.assertEqual(P.parse_source("system"), ("system", None))

    def test_大小写宽容(self):
        self.assertEqual(P.parse_source("SYSTEM"), ("system", None))
        self.assertEqual(P.parse_source("Process:msedge.exe"), ("process", "msedge.exe"))

    def test_process_跟名字(self):
        self.assertEqual(P.parse_source("process:msedge.exe"), ("process", "msedge.exe"))

    def test_process_跟_pid(self):
        self.assertEqual(P.parse_source("process:1234"), ("process", "1234"))

    def test_两头空白被去掉(self):
        self.assertEqual(P.parse_source("  process: msedge  "), ("process", "msedge"))

    def test_空目标要报错(self):
        for bad in ("process:", "process:   "):
            with self.assertRaises(ValueError, msg=bad):
                P.parse_source(bad)

    def test_其它取值一律报错(self):
        for bad in ("", "  ", "device", "process", "systm"):
            with self.assertRaises(ValueError, msg=bad):
                P.parse_source(bad)

    def test_带路径的目标按文件名匹配(self):
        # `process:C:\x\msedge.exe` 是允许的：`_norm` 只取 basename，
        # 所以写路径也能命中（名字里不带冒号那条限制因此没必要）
        self.assertEqual(P.parse_source(r"process:C:\x\msedge.exe"),
                         ("process", r"C:\x\msedge.exe"))
        self.assertEqual(P._norm(r"C:\Program Files\App\msedge.exe"), "msedge")

    def test_非字符串要报错(self):
        for bad in (None, 123, {}, ["system"]):
            with self.assertRaises(ValueError, msg=repr(bad)):
                P.parse_source(bad)


class ResolvePidCase(unittest.TestCase):
    def test_纯数字当_pid_且要求活着(self):
        self.assertEqual(P.resolve_pid("1234", alive_fn=lambda p: True), 1234)
        self.assertIsNone(P.resolve_pid("1234", alive_fn=lambda p: False))

    def test_按名字取第一个活着的(self):
        alive = {8}
        pid = P.resolve_pid("msedge", pids_fn=lambda n: [7, 8, 9], alive_fn=lambda p: p in alive)
        self.assertEqual(pid, 8)

    def test_名字找不到返回_None(self):
        self.assertIsNone(P.resolve_pid("nosuch", pids_fn=lambda n: [], alive_fn=lambda p: True))

    def test_找到但全都不活了返回_None(self):
        self.assertIsNone(P.resolve_pid("x", pids_fn=lambda n: [1, 2], alive_fn=lambda p: False))

    def test_空目标返回_None(self):
        self.assertIsNone(P.resolve_pid("", alive_fn=lambda p: True))
        self.assertIsNone(P.resolve_pid(None, alive_fn=lambda p: True))

    def test_多个同名进程时取进程树的根(self):
        # 回环的激活模式是「目标 + 全部子孙」。浏览器主进程不发声、声音在子进程里，
        # 挑到渲染子进程就等于只听那个子树 → 全是静音（真机实测踩过）
        table = [(1, "ego.exe", 100), (2, "ego.exe", 1), (3, "ego.exe", 2),
                 (100, "explorer.exe", 0)]
        pid = P.resolve_pid("ego", pids_fn=lambda n: [1, 2, 3],
                            alive_fn=lambda p: True, table_fn=lambda: table)
        self.assertEqual(pid, 1)

    def test_全是根时取第一个(self):
        table = [(1, "x.exe", 100), (2, "x.exe", 100)]
        pid = P.resolve_pid("x", pids_fn=lambda n: [1, 2],
                            alive_fn=lambda p: True, table_fn=lambda: table)
        self.assertEqual(pid, 1)

    def test_真机_自己这个进程一定活着(self):
        # 唯一一条碰真进程表的断言：python 自己的 PID 必然可解析
        self.assertEqual(P.resolve_pid(str(os.getpid())), os.getpid())


if __name__ == "__main__":
    unittest.main()
