<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="SparkCode logo" />
</p>

<h1 align="center">SparkCode</h1>

<p align="center">基于 <a href="https://github.com/pingdotgg/t3code">T3 Code</a> 深度定制的个人桌面版编码 Agent 工作台。</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <strong>简体中文</strong>
</p>

<p align="center">
  <a href="./README.upstream.md"><strong>原版 README (T3 Code)</strong></a> ·
  <a href="./docs/README.md">使用与架构文档</a> ·
  <a href="https://github.com/pingdotgg/t3code">上游仓库</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

---

**SparkCode** 是基于开源项目 [T3 Code](https://github.com/pingdotgg/t3code) 构建的独立定制版本，完整保留上游多 Agent 编排（Claude Code、Codex、Cursor、OpenCode、Antigravity、Kiro、ACP 等）、Git Worktree、内置浏览器预览与远程连接能力，并针对日常多项目并行开发工作流进行了交互重构与独立封装。

> 原版完整介绍、Agent 配置指南及通用功能说明请直接查阅 **[原版 README (`README.upstream.md`)](./README.upstream.md)** 与 **[文档目录 (`docs/`)](./docs/README.md)**。

---

## 新增功能与定制改动

### 1. 左侧栏项目分组视图

- **默认按项目目录聚合会话**：左侧会话列表默认将同一项目的会话归组展示，减少多仓库并行时的列表混乱。
- **运行态会话原位保留**：处于 `Working` 状态的活跃会话保持在各自所属项目分组内，不再被单独抽离到顶部独立分组，避免会话执行时位置跳动。
- **一键视图切换**：侧边栏标题栏提供分组模式与时间流平铺模式的快捷切换按钮。

### 2. 项目级共享全画布二维分屏终端

- **项目级终端持久化（`⌘J`）**：移除底部抽屉式终端，升级为顶栏一键切换的全画布工作区终端，同一项目下的所有会话共享同一组项目终端实例；同时保留单个会话独立的右侧面板终端。
- **二维二叉树自由分屏**：重构终端布局引擎，支持任意窗格横向、纵向无限层级二分拆分、拖拽分隔条调整比例、窗格焦点高亮与关闭自动合并。
- **精简顶栏与直觉切换**：去除冗余外框与标题栏，当全画布终端打开时，右上角切换按钮自动切换为返回对话图标，支持随时在对话流与项目终端间无缝往返。

### 3. 悬停式监听端口与进程监控菜单

- **自动端口与 PID 探测**：实时扫描项目终端树内正在监听的本地服务端口及对应进程 `PID`。
- **悬停快捷面板**：顶栏端口胶囊支持鼠标悬停展开完整监听列表，展示每个端口的协议地址与 `PID`，点击即可在内置预览或浏览器中快速打开。

### 4. 侧边栏轻量用量速览（Usage Quick Popover）

- **即点即看的紧凑浮层**：点击左下角 `Usage` 按钮不再直接打断当前工作流跳转全屏页面，而是弹出轻量速览卡片。
- **核心配额与开销聚合**：实时展示各已连接订阅 Provider 的额度进度条、重置倒计时，以及近 24 小时 Token 消耗与费用汇总，支持手动刷新及一键展开完整用量分析视图。

### 5. 独立品牌标识、极简视觉与数据隔离

- **极简几何品牌视觉**：采用瑞士几何极简风格（Option F）重绘全套 macOS / Windows / Linux / Web 图标，并将启动加载页替换为无背景边框的内联自适应矢量图形，完美贴合浅色与深色主题。
- **与官方版完全隔离共存**：
  - 应用名称与 Bundle ID：`SparkCode`（`com.sparkaboo.sparkcode`）
  - 自定义协议：`sparkcode://`（开发态 `sparkcode-dev://`）
  - 默认状态与数据库目录：`~/.sparkcode`（可通过 `--base-dir` 或环境变量 `T3CODE_HOME` 覆盖）
  - Electron 应用数据目录：`~/Library/Application Support/sparkcode`
  - 自动更新隔离：本地打包默认不写入更新源，且构建脚本显式拦截指向上游 `pingdotgg/t3code` 的更新地址，避免被官方版本覆盖，可与官方 `T3 Code` 在同一台设备同时安装和并行运行。
  - 默认关闭遥测上报：不内置上游遥测端点与密钥，默认不对外发送统计数据。

---

## 移动端（iOS / Android）连接说明

本地打包的 **SparkCode** 保持与上游一致的编排通信协议（`ORCHESTRATION_PROTOCOL_VERSION = 2`）与配对链接格式，**可以直接搭配 App Store / Google Play 上的官方 `T3 Code` 手机客户端使用**：

1. **局域网（LAN）或 Tailscale 直连（推荐）**：在 SparkCode 桌面端打开 **Settings -> Sharing & access**，开启 **Network access** 或 **Tailscale HTTPS**，生成配对二维码或链接，使用手机端 `T3 Code` 扫码或粘贴至 **Settings -> Environments -> Add environment** 即可完成配对。
2. **关于 T3 Connect 云中继**：官方 `T3 Connect` 依赖官方发行版构建时注入的私有云端中继与鉴权密钥，本地源码直编版本默认不包含官方云密钥；跨网远程访问建议使用 [Tailscale](./docs/user/remote-access.md#tailscale-https) 直连。

---

## 下载 SparkCode

桌面安装包及独立 CLI 见 [SparkCode Releases](https://github.com/Sparkaboo/sparkcode/releases/latest)。macOS 提供 Apple Silicon 和 Intel 版本，Windows 与 Linux 提供 x64 和 arm64 版本。从本地打包的 0.1.9 首次升级时，请手动下载安装包。

macOS Apple Silicon 和 Linux 可以用以下命令安装 CLI。Windows 在 PowerShell 中使用版本页面提供的 `install.ps1`。安装完成后运行 `sparkcode --version`。

```sh
curl -fsSL https://github.com/Sparkaboo/sparkcode/releases/latest/download/install.sh | sh
```

## 本地开发与打包

### 环境准备与启动

```bash
vp i
pnpm dev:desktop
```

### 构建 macOS 安装包（Apple Silicon `.dmg`）

```bash
pnpm dist:desktop:dmg:arm64
```

若本机 Rust 工具链低于 `native/resource-monitor` 所需的版本，可复用仓库已编译的二进制直接打包：

```bash
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true pnpm dist:desktop:dmg:arm64
```

构建产物输出至 `release/SparkCode-<version>-arm64.dmg` 与 `release/SparkCode-<version>-arm64.zip`。

---

## 上游文档与许可证

- 原版说明文档：[README.upstream.md](./README.upstream.md)
- 完整用户与内部架构文档：[docs/README.md](./docs/README.md)
- 开源许可证：[MIT](./LICENSE)
