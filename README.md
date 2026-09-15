**中文** | [English](README.en.md)

🚀 **在线试用**：[发送端](https://xpeipeix.github.io/cimbar-bigfile/send.standalone.html) · [PC 接收端](https://xpeipeix.github.io/cimbar-bigfile/recv.standalone.html) · [拼接端](https://xpeipeix.github.io/cimbar-bigfile/reassemble.html) · [离线下载](https://github.com/xPeiPeix/cimbar-bigfile/releases/latest)

# cimbar-bigfile

> 基于 [sz3/libcimbar](https://github.com/sz3/libcimbar) 的大文件光学传输工具——通过多 fountain stream 并行突破单 stream 容量上限（libcimbar Mode B 单 stream wirehair cap ~40.5 MB），无网络环境下**实测传输 100+ MB 文件**（理论上限 ~1.2 GB / 单会话, 详见 [manifest-spec](docs/manifest-spec.md#chunk_size-选择参考-wirehair-硬限制推导)）。

## 这是什么？

`cimbar-bigfile` 在 libcimbar 之上做了一层**纯 HTML/JS 包装**，把大文件切成 chunk（默认 10 MB，**libcimbar 作者推荐 10-15 MB sweet spot**，留出冗余 headroom），每块独立用 fountain code 编码（不同 `encode_id`），在屏幕上依次播放彩色码动画。

接收端用作者的 **CameraFileCopy (CFC)** 安卓应用扫码，CFC 内置的 `fountain_decoder_sink` 已经原生支持按 `encode_id` 并发分桶解码，**完全无需修改**。所有块收完后用浏览器打开拼接页面，拖入文件即可还原原始大文件。

```
[发送端 send.html]  →  屏幕动画  →  [手机 CFC]  →  保存 N 个块  →  [拼接 reassemble.html]  →  原文件
[发送端 send.html]  →  屏幕动画  →  [PC 接收端 recv.html (摄像头或屏幕捕获)]  →  自动拼接 + 下载原文件
```

## 用法
### 准备

1. **接收端（二选一）**：
   - **PC 接收端（本仓库新增，推荐无手机场景）**：双击打开 `recv.standalone.html`（自包含单文件，无需联网），用**摄像头**对准发送端屏幕，或用**屏幕/窗口捕获**直接抓取发送端窗口（见下文 [PC 接收端](#pc-接收端-recvhtml)）
   - **手机**：安装 [CameraFileCopy](https://github.com/sz3/cfc/releases) (F-Droid / Google Play / GitHub Release APK)
2. **发送端**：电脑浏览器双击打开 `send.standalone.html`（自包含单文件版，无需联网，**推荐**）
3. **拼接端**：手机接收方案需要；PC 接收端**自动拼接**，无需此步骤。任意浏览器双击打开 `reassemble.html`（零依赖纯 JS，无需联网）

> 也可以用模块化的 `send.html` / `recv.html`（开发版），但需要先起本地 HTTP server（见下文 [开发](#开发) 段），因为浏览器在 `file://` 协议下会拦截 wasm 文件加载。普通用户用 standalone 版更简单。

发送页、接收页和拼接页的界面**默认使用英文**。点击页面右上角的 `中文` / `EN` 按钮可以随时切换语言；浏览器会记住选择，刷新或下次打开页面时继续使用所选语言。

## PC 接收端 (recv.html)

不想用手机时，PC 浏览器也能当接收端：`recv.standalone.html` 内置 libcimbar wasm 解码器（复用 vendor 版 `recv-worker` 提取 + 主线程 fountain 解码，原生支持多 stream 分桶），收到全部块后**自动校验 SHA256、拼接并下载原文件**，无需再把文件倒腾到别处。

### 两种捕获来源

| 来源 | 适用场景 | 要点 |
|---|---|---|
| 📷 **摄像头** | 两台设备之间（另一台电脑/手机屏幕播放动画） | 对准发送端屏幕，保持稳定、光线充足 |
| 🖥️ **屏幕 / 窗口捕获** | 同一台电脑（发送窗口 + 接收窗口并排） | 选择发送端窗口；**保持窗口可见、不要最小化**（窗口捕获在部分遮挡时仍有效，但最小化会停止出帧） |

### 使用

1. 双击打开 `recv.standalone.html`，等解码器就绪（显示 "WASM decoder ready"）
2. 点 `📷 Camera` 或 `🖥️ Screen / window` 选择来源；屏幕捕获会弹出浏览器选择器，选发送端窗口即可
3. 页面实时显示活跃 stream 进度；manifest 收到后展示预期文件清单和每块 ✓ 状态
4. 全部块收齐后**自动拼接 + 校验 + 下载**原文件（每个分块也有单独 ⬇ 下载按钮，便于备份或重发排错）

> 与 CFC 一样，接收窗口必须保持可见：浏览器对不可见页面的渲染/回调会节流，隐藏窗口会停止解码。若窗口短暂被遮挡，rVFC 看门狗会自动切换到 rAF 回退路径继续解码。

> 手机 CFC 接收流程见下文 [接收](#接收手机-cfc) / [拼接](#拼接仅大文件需要)；PC 接收端已在上方完成，自动拼接，无需 reassemble.html。

### 发送

1. 打开 `send.standalone.html`
2. 把要传的文件拖入页面
3. 点击 "Start"（中文界面为“开始传输”），屏幕开始播放彩色码动画
4. **保持屏幕不动直到所有块发完**

也可以在发送端先临时收集内容再发送：

- `Ctrl+V` 粘贴文本：页面会自动生成一个 `clipboard-*.txt` 暂存项
- `Ctrl+V` 粘贴剪贴板里的文件，或点击 "添加文件" / "添加文件夹"：加入暂存列表
- 暂存区只有一个普通文件或一段粘贴文本时，按钮显示 "开始传输"，直接发送原文件
- 暂存区有多个文件，或内容来自 "添加文件夹"（即使文件夹中只有一个文件）时，按钮显示 "打包并开始传输"，浏览器本地生成 `cimbar-bundle-*.tar` 后发送

需要打包时，过程全在浏览器本地完成，不上传网络；接收结果是无压缩的 `cimbar-bundle-*.tar`，必须再用 Windows 自带 `tar`、7-Zip 等工具解包。从 "添加文件夹" 选择的内容即使只有一个文件，也遵循这一规则。

#### 💡 加速接收：手动跳转 + 锁定 + 标记已保存

大文件（多块）模式下，发送端 UI 自动切到「三栏响应式布局」：左栏 = 跳转列表，中间 = cimbar 码 canvas，右栏 = ✅ 已保存按钮 + 进度面板。

![发送端 UI 主界面](docs/screenshots/send-ui-overview.png)

**默认行为**是发送方按 `manifest → part00 → part01 → ... → 循环回 manifest` 的顺序循环播放，CFC 扫到哪块靠随机命中——100MB 文件总扫描时间约 ~55 分钟。

**3 种操作消除等待**：

| 操作 | 效果 | 触发 |
|---|---|---|
| **单击块按钮** | 立即跳转到该块（清锁，自由循环） | 鼠标单击 / Tab + Enter |
| **双击块按钮** | 🔒 锁定该块（发送方专攻该块, fountain 持续补帧, CFC 下次扫到必然是它）；再次双击 / 切别块 = 转移 / 解锁 | 鼠标双击 / Tab + **Shift+Enter**（键盘等效） |
| **✅ 已保存, 跳下一块**（右栏绿色主按钮） | 当前块标 ✓ 已保存（持久化到 localStorage）+ 自动跳到下一个未完成块 | CFC 弹"保存到哪里"对话框且保存完后点 |

按钮状态视觉（截图左栏）：
- 🟢 `✓ 前缀 + 绿底` = 已确认保存
- 🔵 `蓝底` = 屏幕正在播放（active）
- 🟡 `淡琥珀 + 🔒` = 双击锁定的块；进度面板同步显示 "🔒 锁定 partXX · 补帧 N 轮"

**预期收益**：100MB 文件总扫描时间从 ~55 分钟降到 ~17 分钟（消除随机扫描等待）。

> simpleMode（小文件 ≤ 块大小，单文件直发）下隐藏跳转列表——只有 1 个 stream，跳转无意义。

#### 🔍 全屏扫码

传输开始后，点击发送页的 "Fullscreen code"（中文界面为“全屏显示码图”）可将 cimbar 码图放大到全屏，方便手机相机对焦和扫描。全屏模式隐藏左右操作栏，但会在码图外保留状态栏。大文件会进入 guided lock：锁定当前（或下一个未完成）分片，持续补帧，并显示当前分片、总分片数、已保存数量以及“✅ 已保存，锁定下一块”按钮；状态栏会常驻，避免手机保存期间发送端切到别的分片后误标。

- 按 `Esc` 或点击浮动退出按钮可返回普通布局
- CFC 保存完当前分片后，直接在全屏状态栏确认；发送端会切换并锁定下一个未完成分片
- 全部分片标记完成后，状态栏会提示可以停止传输并禁用继续确认
- guided lock 状态栏常驻；移动鼠标或用键盘聚焦时，自动淡出的退出按钮会重新出现
- 退出全屏会解除本次全屏自动施加的锁；进入全屏前已有的手动锁会保留
- 点击停止传输时会自动退出全屏

### 接收（手机 CFC）

> PC 接收端用户跳过本段：`recv.html` 已自动完成接收与拼接（见上文 [PC 接收端](#pc-接收端-recvhtml)）。

1. 手机打开 CFC，对着电脑屏幕
2. 每完成一块，CFC 会弹出"保存到哪里"对话框
3. **每次都选同一个目录**（推荐建一个 `cimbar-bigfile-job1/` 目录）
4. 全部接收完后：
   - **小文件（≤ 块大小，默认 ≤ 10 MB）**：直接 1 个原文件名的文件，**不需要拼接**，CFC 落盘的就是原文件
   - **大文件（> 块大小）**：N+1 个文件 `manifest.json` + `<filename>.part00.bin` ... `<filename>.partNN.bin`，需要走下面的拼接步骤

> 如果发送的是 `cimbar-bundle-*.tar`，无论它作为小文件直接接收，还是作为大文件先完成拼接，最终都需要再解包。

### 拼接（仅大文件需要）

1. 把手机里的所有文件传到电脑（USB / 邮件 / 任何方式）
2. 浏览器打开 `reassemble.html`
3. 全选所有文件拖入页面
4. 自动校验 SHA256 → 通过 → 自动下载还原后的原文件

拼接页同样默认使用英文，可通过右上角的 `中文` / `EN` 按钮切换语言；切换不会清空已选择的文件或当前校验状态。

## 已知限制

- **每块完成 CFC 弹一次保存对话框**：10MB / 块时，100MB 文件需要点 11 次"保存"（PC 接收端 `recv.html` 无此问题，全程自动）。
- **吞吐量**：约 **106 KB/s**（libcimbar Mode B 默认）。100MB 文件预计耗时 16-20 分钟。
- **接收窗口必须可见**：PC 接收端与 CFC 一样依赖实时取帧；窗口最小化或完全被遮挡时浏览器会节流回调、停止解码（短暂遮挡有 rAF 回退看门狗兜底）。
- **内存占用**：PC 接收端把全部已收块保存在浏览器内存里，超大文件（数百 MB 以上）请留意浏览器内存压力。
- **上游 web 解码器仍不推荐**：libcimbar 上游 v0.6.4 release 自带的 web 解码器（本仓库 `vendor/cimbar-wasm-v0.6.4/recv.html`）实测大文件（≥ 3MB）会中途停滞（见 [issue #4](https://github.com/xPeiPeix/cimbar-bigfile/issues/4)），且它是单 stream 设计，无法消费本仓库的多 stream 分块输出。**本仓库根目录的 `recv.html` / `recv.standalone.html` 是重写实现**：原生多 stream 分桶 + 完成即回收 slot + 自动拼接，与上游那个不同。

## 故障排除

| 症状 | 可能原因 | 解决方法 |
|------|---------|---------|
| CFC 扫不到任何码 | 屏幕亮度低 / 距离不对 | 屏幕调最高亮度，离手机 10-30 cm |
| CFC 扫描很慢 | 帧率太高摄像头跟不上 | send.html 把 FPS 调到 10-12 |
| 某些块没收到 | fountain 冗余不够 | send.html 把 "冗余" 调到 2.0 或更高，让发送端给每块多发些帧 |
| 拼接 SHA256 校验失败 | 某块在传输中损坏 | 看哪块失败 → 重新发送（用同一 encode_id_base 重启 send.html，跳到那块） |
| PC 接收端收不到任何码 | 摄像头没对准/失焦；窗口捕获选了错误来源 | 对准发送端屏幕（10-30cm、最高亮度）；屏幕捕获确认选的是发送端窗口 |
| PC 接收端中途停止 | 接收窗口被最小化/完全遮挡 | 保持窗口可见；短暂遮挡会自动恢复（看门狗切 rAF） |
| 浏览器加载 wasm 失败 | file:// 协议被 CORS 拦截（开发版 `send.html`/`recv.html` 才有此问题） | 改用 `*.standalone.html`（双击即可），或用本地 HTTP server：`python -m http.server 8000` |
| 文件名乱码 | 系统字符编码问题 | manifest 强制 UTF-8，检查浏览器/手机系统编码 |
| 浏览器卡顿 | 文件太大 wasm 堆压力 | 降低单块大小（默认 10MB → 5MB） |
| 总扫描时间太长 | CFC 每次保存重置 fountain 状态，发送方循环导致命中靠运气 | 用新加的「跳转按钮」主动指定下一个目标 chunk（见上方"加速接收"段） |

## 性能参考

参考环境：1080p 屏幕 + Pixel 5 + 默认参数（Mode B / 15 fps / 10 MB 块 / 2.0x 冗余）

| 文件大小 | 块数 | 弹窗次数 | 预估耗时 | 参考吞吐 (Mode B) |
|---------|------|---------|---------|-------------------|
| 5 MB | 1 块（直发，无 manifest） | 1 次 | ~1 分钟 | ~85 KB/s |
| 28 MB | 3 块 | 4 次（manifest + 3 块） | ~4-5 分钟 | ~100 KB/s |
| 100 MB | 10 块 | 11 次（manifest + 10 块） | ~16-20 分钟 | ~106 KB/s |

> 验证覆盖：5 MB（bundled `test/test-5m.bin`）+ ~28 MB（手动光学链路 end-to-end）+ 100 MB（应用层 round-trip via `scripts/test-round-trip-100mb.js`）。其他规模线性外推。
>
> 实际吞吐受光线、屏幕亮度、相机自动对焦稳定性影响很大。

### 冗余倍数 (redundancy) 怎么选

libcimbar 作者在 [sz3/libcimbar#165 评论](https://github.com/sz3/libcimbar/pull/165#issuecomment-4421610294) 中明确 **"no penalty for redundant blocks (e.g. 3x or 4x for 10 MB chunks)"**——也就是说 fountain code 的本质决定了：

- **冗余只影响发送端的发帧总数**，不影响 CFC 接收完成所需帧数（CFC 只要凑齐足够独立帧就完成）
- 多余的帧 CFC 会被自动忽略，**不浪费接收时间**
- 高冗余的实际价值是：**单 chunk 第一轮没收齐时**，发送端循环里继续补帧的兜底厚度

| redundancy | 适用场景 |
|------------|---------|
| 1.2-1.5x | 屏幕固定支架 + 良好光线 + 对焦稳定（aggressive 预设） |
| **2.0x（默认）** | 一般室内光线 + 手持稳定（balanced 预设） |
| 3.0-4.0x | 差光线 / 反光 / 手抖明显（conservative 预设） |

发送端 UI 的 redundancy 输入框上限放宽到 5.0x，覆盖极端场景。

## 进阶：超过 ~1.2 GB 的超大文件

单次会话受 wirehair `uint16_t` encode_id slot 限制，`chunk_count` 应保守约束在 ~120 块以内（即 ~1.2 GB at 10MB/chunk）。**libcimbar 作者在 [sz3/libcimbar#165 评论](https://github.com/sz3/libcimbar/pull/165#issuecomment-4421610294) 提到两种突破方法**，但都需要用户手动 babysit：

**方法 1：变 chunk size 重启会话**

> "Provided you're finished sending a chunk, you can re-use the encode_id if you slightly vary the chunk size... (e.g. 10.01 MB chunks after the first go around)"

第一轮把文件前 ~1.2 GB 用 10 MB chunk 发完；第二轮把剩余部分用稍微不同的 chunk size（如 10.01 MB 或 10.5 MB）重启发送端。wirehair 会把不同 chunk size 视为新文件，**不会占用旧的 encode_id slot**。

**方法 2：CFC 端重启 decoder 清缓存**

> "you can also restart the decoder to clear its cache of 'done' files, which will have the same effect without changing the chunk size"

把 CFC 应用整个重启一次，它的 `fountain_decoder_sink` 内部 "done files" 缓存被清空。之后同 encode_id 可以复用。但**前一轮的部分进度也会一并丢失**——只适合"前一轮已全部完成保存"后的新一轮场景。

⚠️ 两种方法都未在 cimbar-bigfile 中自动化实现，需要用户手动操作。理论上可传任意大文件，实测最大已验证至 100 MB（见上方性能表）。

## 开发

### 更新 libcimbar 依赖

详见 [`vendor/README.md` 的 "Updating to newer libcimbar release" 章节](vendor/README.md#updating-to-newer-libcimbar-release)。

### 协议规范

- [docs/manifest-spec.md](docs/manifest-spec.md) - manifest JSON 字段语义
- [docs/architecture.md](docs/architecture.md) - 数据流、wasm API、设计决策

### 本地测试发送端 / 接收端

```bash
# 起本地 HTTP 服务器（避免 file:// CORS 问题）
python -m http.server 8000
# 浏览器访问 http://localhost:8000/send.html（发送端）
# 浏览器访问 http://localhost:8000/recv.html（PC 接收端）
```

### wasm 编解码管线测试

[`scripts/pipeline-test.html`](scripts/pipeline-test.html) 是开发用测试页：在浏览器里跑通 编码 → canvas 渲染 → 提取 → fountain 解码 → 多 stream 分桶 → 拼接 + SHA256 校验 的完整数据路径（不经过光学链路）。需要本地 HTTP server 后访问 `http://localhost:8000/scripts/pipeline-test.html`，页面日志输出 `PASS` 即通过。它同时向外部暴露 `window.__pipeline` 辅助函数，可被自动化测试驱动。

### 采集回归测试

运行 `node --test scripts/test-recv-capture.js`，检查停止／重启、延迟帧、Worker 返回结果、看门狗切换，以及像素格式和尺寸匹配。测试使用可控的浏览器 API 替身；真实摄像头的对焦、光照和传输效果需要在设备上验证。

### 构建自包含单文件版

`send.standalone.html` 和 `recv.standalone.html` 是给最终用户的"双击即用"版本，把 vendor wasm + glue js 都 base64 inline 进 HTML，脱离 HTTP server。每次升级 vendor 后必须重新构建：

```bash
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python scripts/build-standalone.py
# 输出 send.standalone.html (约 2.6 MB) + recv.standalone.html (约 5 MB)
```

构建脚本只读 `send.html` / `recv.html` + `vendor/cimbar-wasm-v0.6.4/cimbar_js.*.js` + `cimbar_js.*.wasm` + `recv-worker.*.js`，输出独立文件到仓库根目录。原理：替换 `<script src="vendor/...">` 为 inline `<script>` 把 base64 解码成 `Module.wasmBinary`，emscripten glue 检测到就跳过 fetch。`recv.standalone.html` 额外把解码 worker 打包成 blob worker（file:// 下 worker 不能 importScripts，wasm 同样以 `Module.wasmBinary` 注入）。

## 架构与协议

- 协议规范：[docs/manifest-spec.md](docs/manifest-spec.md)
- 架构图：[docs/architecture.md](docs/architecture.md)

## License & Acknowledgements

cimbar-bigfile 是 libcimbar 之上的轻量包装器。**本仓库由 MIT、MPL-2.0、BSD-3-Clause 三个许可证共同管理**：

| 部分 | 许可证 | 版权 | 说明 |
|------|-------|------|------|
| `send.html` / `recv.html` / `reassemble.html` / `scripts/*` / `docs/*` 等本项目原创代码 | **MIT** | © 2026 peipei | 详见 [`LICENSE`](LICENSE) |
| `vendor/cimbar_js.html` / `vendor/cimbar-wasm-v0.6.4/*` | **MPL-2.0** | © sz3 (libcimbar) | 详见 [`vendor/LICENSE-libcimbar`](vendor/LICENSE-libcimbar) |
| 上述 wasm 内嵌的 wirehair fountain code 库 | **BSD-3-Clause** | © 2018 Christopher A. Taylor | 详见 [`vendor/LICENSE-wirehair`](vendor/LICENSE-wirehair) |
| 用户独立安装的 CFC Android 接收端 (未 vendor) | **MIT** | © sz3 | 见 [github.com/sz3/cfc](https://github.com/sz3/cfc) |

**MPL-2.0 source obligation**：本项目分发了 libcimbar 的 wasm 二进制（Executable Form），按 MPL-2.0 §3.2，对应的 source code 可在 https://github.com/sz3/libcimbar/tree/v0.6.4 免费获取。


### 致谢

- [sz3/libcimbar](https://github.com/sz3/libcimbar) — 核心 fountain code + cimbar 编解码引擎
- [sz3/cfc](https://github.com/sz3/cfc) — 接收端 Android 应用
- [catid/wirehair](https://github.com/catid/wirehair) — 底层 fountain code 库
