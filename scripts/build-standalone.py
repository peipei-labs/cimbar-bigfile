#!/usr/bin/env python
"""build-standalone.py — 打包 send.html / recv.html 为自包含单文件版

send.standalone.html:
  替换 send.html 里 `<script src="vendor/....js">` 为两段 inline:
    1. base64 -> Uint8Array -> Module.wasmBinary  (让 emscripten glue 跳过 fetch)
    2. 原 glue js 内容直接 inline

recv.standalone.html:
  除上述主线程 glue inline 外, 解码 worker (recv-worker) 也改为 blob worker:
    1. blob 内注入 base64 wasm -> Module.wasmBinary (file:// 下 worker 无法 importScripts)
    2. blob 内 inline glue js 替代 importScripts 行
    3. recv.html 里 `const WORKER_URL = ...` 标记行替换为 URL.createObjectURL(blob)

输出 send.standalone.html (~4 MB) + recv.standalone.html (~5 MB), 双击即可在 file:// 下运行。

用法:
    PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python scripts/build-standalone.py
"""
import base64
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEND_HTML = ROOT / "send.html"
RECV_HTML = ROOT / "recv.html"
GLUE_JS = ROOT / "vendor" / "cimbar-wasm-v0.6.4" / "cimbar_js.2026-01-20T0312.js"
WASM = ROOT / "vendor" / "cimbar-wasm-v0.6.4" / "cimbar_js.2026-01-20T0312.wasm"
WORKER_JS = ROOT / "vendor" / "cimbar-wasm-v0.6.4" / "recv-worker.2026-01-20T0312.js"
OUT_SEND = ROOT / "send.standalone.html"
OUT_RECV = ROOT / "recv.standalone.html"

SCRIPT_TAG = '<script src="vendor/cimbar-wasm-v0.6.4/cimbar_js.2026-01-20T0312.js"></script>'
WORKER_URL_LINE = "const WORKER_URL = 'vendor/cimbar-wasm-v0.6.4/recv-worker.2026-01-20T0312.js';"
WORKER_IMPORT = "importScripts('cimbar_js.2026-01-20T0312.js');"
WORKER_MODULE_LINE = "var Module = {"

# HTML5 spec (WHATWG §13.2.5.16): script data end tag 后只要跟 \s / > 就终止, 不限于 `</script>`.
SCRIPT_END_RE = re.compile(r"</script[\s/>]", re.IGNORECASE)


def main() -> int:
    for p in (SEND_HTML, RECV_HTML, GLUE_JS, WASM, WORKER_JS):
        if not p.is_file():
            print(f"ERR: 文件缺失: {p}", file=sys.stderr)
            return 1

    glue = GLUE_JS.read_text(encoding="utf-8")
    if SCRIPT_END_RE.search(glue):
        print("ERR: glue js 含 </script> 子串变体, 需要转义后再 inline", file=sys.stderr)
        return 1

    wasm_bytes = WASM.read_bytes()
    wasm_b64 = base64.b64encode(wasm_bytes).decode("ascii")

    b64_shim = (
        "(() => {\n"
        f'  const b64 = "{wasm_b64}";\n'
        "  const bin = atob(b64);\n"
        "  const arr = new Uint8Array(bin.length);\n"
        "  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);\n"
        "  return arr;\n"
        "})()"
    )

    main_inline = (
        "<script>\n"
        "// === build-standalone.py: inline wasm (base64 -> Module.wasmBinary) ===\n"
        "// emscripten glue 检测到 Module.wasmBinary 已设置就跳过 fetch, 走 sync path\n"
        f"Module.wasmBinary = {b64_shim};\n"
        "</script>\n"
        "<script>\n"
        "// === build-standalone.py: original cimbar_js glue inlined ===\n"
        + glue
        + "\n</script>"
    )

    # ---------- send.standalone.html ----------
    send_html = SEND_HTML.read_text(encoding="utf-8")
    if SCRIPT_TAG not in send_html:
        print(
            f"ERR: send.html 找不到目标 script 标签:\n  {SCRIPT_TAG}\n"
            "  (可能 vendor 版本号变了, 同步更新本脚本的常量)",
            file=sys.stderr,
        )
        return 1
    out_send_html = send_html.replace(SCRIPT_TAG, main_inline, 1)

    # ---------- recv.standalone.html ----------
    recv_html = RECV_HTML.read_text(encoding="utf-8")
    if SCRIPT_TAG not in recv_html:
        print(
            f"ERR: recv.html 找不到目标 script 标签:\n  {SCRIPT_TAG}\n"
            "  (可能 vendor 版本号变了, 同步更新本脚本的常量)",
            file=sys.stderr,
        )
        return 1
    if WORKER_URL_LINE not in recv_html:
        print(
            f"ERR: recv.html 找不到 worker 标记行:\n  {WORKER_URL_LINE}\n"
            "  (build 标记被改动? 该行由 build-standalone.py 替换)",
            file=sys.stderr,
        )
        return 1

    worker_js = WORKER_JS.read_text(encoding="utf-8")
    if WORKER_IMPORT not in worker_js:
        print(
            f"ERR: {WORKER_JS.name} 找不到 importScripts 行:\n  {WORKER_IMPORT}\n"
            "  (可能 vendor 版本号变了, 同步更新本脚本的常量)",
            file=sys.stderr,
        )
        return 1
    if WORKER_MODULE_LINE not in worker_js:
        print(f"ERR: {WORKER_JS.name} 找不到 `var Module = {{` 行, 无法注入 wasmBinary", file=sys.stderr)
        return 1

    # blob worker 源码: wasm 注入 Module + glue inline 替代 importScripts
    worker_src = (
        f"var __OMB_WASM_BINARY__ = {b64_shim};\n"
        + worker_js.replace(WORKER_MODULE_LINE, "var Module = { wasmBinary: __OMB_WASM_BINARY__,", 1)
                   .replace(WORKER_IMPORT, glue, 1)
    )
    if SCRIPT_END_RE.search(worker_js):
        print("ERR: recv-worker js 含 </script> 子串变体", file=sys.stderr)
        return 1

    # 作为 JS 字符串嵌进 inline <script>: 转义 `</` 防止 HTML 解析器提前终止 script
    worker_literal = json.dumps(worker_src, separators=(",", ":"))
    worker_literal = worker_literal.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    worker_blob_line = (
        "const WORKER_URL = URL.createObjectURL(new Blob(["
        + worker_literal
        + "], { type: 'text/javascript' }));"
    )

    out_recv_html = recv_html.replace(SCRIPT_TAG, main_inline, 1)
    out_recv_html = out_recv_html.replace(WORKER_URL_LINE, worker_blob_line, 1)

    # 两个产物作为同一代发布:
    # 1) 先把所有易失败的 I/O (tmp 写入) 全部做完 — 任一 tmp 写入失败都不触碰现有产物;
    # 2) publish_generation 逐文件 "旧→.prev 备份, 新→发布", 任一 rename 失败即整体回滚,
    #    不留新旧混合 (跨文件完美原子性在文件系统层面不存在, 回滚将失败窗口收敛为可恢复)。
    pairs = []
    for out, text in ((OUT_SEND, out_send_html), (OUT_RECV, out_recv_html)):
        tmp = out.with_suffix(out.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        pairs.append((out, tmp))
    publish_generation(pairs)

    wasm_mb = len(wasm_bytes) / 1024 / 1024
    print("[OK] standalone 构建完成")
    print(f"     vendor wasm  : {wasm_mb:.2f} MB (base64 后 ~{wasm_mb*4/3:.2f} MB)")
    for out, src in ((OUT_SEND, SEND_HTML), (OUT_RECV, RECV_HTML)):
        print(f"     {out.name}: {out.stat().st_size / 1024 / 1024:.2f} MB (源 {src.name}: {src.stat().st_size / 1024:.1f} KB)")
    return 0


def publish_generation(pairs: list[tuple[Path, Path]]) -> None:
    """把多文件作为'一代产物'发布, 任一 rename 失败即整体回滚。

    每个文件: 旧文件原子移入 `<final>.prev` 备份, 再把新 tmp 原子移入 final。
    失败时按逆序回滚: 有备份的用备份覆盖已发布文件, 无备份的 (目标原本不存在)
    删除已发布的新文件。回滚自身依赖 rename 可用性; 进程在两次 rename 之间被
    强杀时 `.prev` 备份留在原地, 状态可诊断、可手动恢复。
    """
    published: list[tuple[Path, Path | None]] = []  # (final, backup 或 None)
    try:
        for final, tmp in pairs:
            backup = final.with_suffix(final.suffix + ".prev")
            had_previous = final.exists()
            if had_previous:
                os.replace(final, backup)
            published.append((final, backup if had_previous else None))
            os.replace(tmp, final)
    except BaseException:
        for final, backup in reversed(published):
            try:
                if backup is None:
                    final.unlink(missing_ok=True)
                else:
                    os.replace(backup, final)
            except OSError as exc:
                print(
                    f"ERR: 回滚失败, 旧产物仍备份在 {backup or '(无备份, 新文件已发布)'}: {exc}",
                    file=sys.stderr,
                )
        raise
    for _final, backup in published:
        if backup is None:
            continue
        try:
            backup.unlink(missing_ok=True)
        except OSError as exc:
            print(f"Install warning: 备份清理失败, 请手动删除 {backup}: {exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
