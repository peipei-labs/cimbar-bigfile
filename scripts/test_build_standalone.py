"""build-standalone.py 的发布事务测试 (含第二次 os.replace 故障注入)。

运行: python -I -m unittest discover -s scripts -p 'test_*.py'
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
import importlib.util
from unittest import mock

_SCRIPT_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("build_standalone", _SCRIPT_DIR / "build-standalone.py")
assert _spec and _spec.loader
build_standalone = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_standalone)


class PublishGenerationTest(unittest.TestCase):
    def _make_pair(self, root: Path):
        send = root / "send.standalone.html"
        recv = root / "recv.standalone.html"
        send.write_text("old-send", encoding="utf-8")
        recv.write_text("old-recv", encoding="utf-8")
        send_tmp = root / "send.standalone.html.tmp"
        recv_tmp = root / "recv.standalone.html.tmp"
        send_tmp.write_text("new-send", encoding="utf-8")
        recv_tmp.write_text("new-recv", encoding="utf-8")
        return [(send, send_tmp), (recv, recv_tmp)], (send, recv)

    def test_success_publishes_both_and_cleans_backups(self):
        with tempfile.TemporaryDirectory() as d:
            pairs, (send, recv) = self._make_pair(Path(d))
            build_standalone.publish_generation(pairs)
            self.assertEqual(send.read_text(encoding="utf-8"), "new-send")
            self.assertEqual(recv.read_text(encoding="utf-8"), "new-recv")
            self.assertFalse((Path(d) / "send.standalone.html.prev").exists())
            self.assertFalse((Path(d) / "recv.standalone.html.prev").exists())
            self.assertFalse((Path(d) / "send.standalone.html.tmp").exists())
            self.assertFalse((Path(d) / "recv.standalone.html.tmp").exists())

    def test_second_rename_failure_rolls_back_both(self):
        # 注入故障: 第 4 次 os.replace (recv 的 tmp→final) 失败, 两个产物必须回到旧内容
        with tempfile.TemporaryDirectory() as d:
            pairs, (send, recv) = self._make_pair(Path(d))
            real_replace = os.replace
            state = {"n": 0}

            def flaky(src, dst, *args, **kwargs):
                state["n"] += 1
                if state["n"] == 4:
                    raise OSError("injected failure on second publish")
                return real_replace(src, dst, *args, **kwargs)

            with mock.patch.object(build_standalone.os, "replace", side_effect=flaky):
                with self.assertRaises(OSError):
                    build_standalone.publish_generation(pairs)
            self.assertEqual(send.read_text(encoding="utf-8"), "old-send")
            self.assertEqual(recv.read_text(encoding="utf-8"), "old-recv")
            self.assertFalse((Path(d) / "send.standalone.html.prev").exists())
            self.assertFalse((Path(d) / "recv.standalone.html.prev").exists())

    def test_first_rename_failure_leaves_both_untouched(self):
        # 第 1 次 os.replace 就失败: 不应发布任何文件
        with tempfile.TemporaryDirectory() as d:
            pairs, (send, recv) = self._make_pair(Path(d))
            with mock.patch.object(build_standalone.os, "replace", side_effect=OSError("injected")):
                with self.assertRaises(OSError):
                    build_standalone.publish_generation(pairs)
            self.assertEqual(send.read_text(encoding="utf-8"), "old-send")
            self.assertEqual(recv.read_text(encoding="utf-8"), "old-recv")

    def test_publish_failure_removes_new_file_when_no_previous_exists(self):
        # 新克隆场景: recv 目标原本不存在, 其发布失败时已发布的新 send 被回滚,
        # 新 recv 被删除 — 状态与初始一致
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            send = root / "send.standalone.html"
            recv = root / "recv.standalone.html"  # 不存在
            send.write_text("old-send", encoding="utf-8")
            send_tmp = root / "send.standalone.html.tmp"
            recv_tmp = root / "recv.standalone.html.tmp"
            send_tmp.write_text("new-send", encoding="utf-8")
            recv_tmp.write_text("new-recv", encoding="utf-8")
            pairs = [(send, send_tmp), (recv, recv_tmp)]

            real_replace = os.replace
            state = {"n": 0}

            def flaky(src, dst, *args, **kwargs):
                state["n"] += 1
                if state["n"] == 3:  # recv 的 tmp→final
                    raise OSError("injected failure")
                return real_replace(src, dst, *args, **kwargs)

            with mock.patch.object(build_standalone.os, "replace", side_effect=flaky):
                with self.assertRaises(OSError):
                    build_standalone.publish_generation(pairs)
            self.assertEqual(send.read_text(encoding="utf-8"), "old-send")
            self.assertFalse(recv.exists())


if __name__ == "__main__":
    unittest.main()
