<p align="center">
  <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="SparkCode logo" />
</p>

<h1 align="center">SparkCode</h1>

<p align="center">A deeply customized desktop coding-agent workbench built on <a href="https://github.com/pingdotgg/t3code">T3 Code</a>.</p>

<p align="center">
  <strong>English</strong> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="./README.upstream.md"><strong>Upstream README (T3 Code)</strong></a> ·
  <a href="./docs/README.md">Docs & Architecture</a> ·
  <a href="https://github.com/pingdotgg/t3code">Upstream Repo</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

---

**SparkCode** is a standalone customized distribution built on the open-source [T3 Code](https://github.com/pingdotgg/t3code) project. It retains full upstream multi-agent orchestration (Claude Code, Codex, Cursor, OpenCode, Antigravity, Kiro, ACP, and more), Git worktrees, built-in browser preview, and remote access, while refining the workspace UX and packaging for multi-project parallel development.

> For the full upstream overview, provider setup guides, and general documentation, see **[Upstream README (`README.upstream.md`)](./README.upstream.md)** and **[Documentation (`docs/`)](./docs/README.md)**.

---

## Custom Features & Enhancements

### 1. Project-Grouped Sidebar View

- **Grouped by project directory by default**: Threads in the sidebar are organized under their parent project directory to keep multi-repo parallel workflows clear.
- **In-place active threads**: Threads in the `Working` state remain inside their project group instead of jumping to a separate top-level section while running.
- **One-click view toggle**: Quickly switch between project-grouped mode and chronological flat list mode from the sidebar header.

### 2. Project-Shared Full-Canvas 2D Split Terminal

- **Persistent project-level terminal (`⌘J`)**: Replaces the bottom drawer terminal with a full-canvas workspace terminal toggled from the top bar. All threads in the same project share one persistent terminal workspace, while keeping per-thread side-panel terminals available.
- **2D binary-tree pane splitting**: Split any terminal pane horizontally or vertically to arbitrary depth, drag dividers to resize, highlight focused panes, and automatically collapse panes on close.
- **Streamlined header & quick switching**: Removes redundant framing and chrome; when the full-canvas terminal is open, the top-right toggle switches directly to a return-to-chat action for seamless back-and-forth navigation.

### 3. Hover Port & Process Monitor Menu

- **Automatic port and PID detection**: Continuously detects local listening ports and their owning process `PID`s across the project's terminal tree.
- **Hover quick panel**: Hovering the top-bar port pill reveals all active listening endpoints with protocol URLs and `PID`s—click any entry to open it in the built-in preview or your browser.

### 4. Sidebar Usage Quick Popover

- **Instant lightweight summary**: Clicking the bottom-left `Usage` button opens a compact popover instead of pulling you out of your current thread.
- **Quotas and spend at a glance**: Displays quota progress bars, reset countdowns across connected subscription providers, and 24-hour token usage and cost summaries, with manual refresh and one-click expansion to the full usage view.

### 5. Standalone Branding, Minimal Visuals & Data Isolation

- **Minimal geometric identity**: Custom Swiss-geometric icon set (Option F) across macOS, Windows, Linux, and Web, paired with a borderless adaptive SVG splash loader for both light and dark themes.
- **Fully isolated alongside official T3 Code**:
  - App name & Bundle ID: `SparkCode` (`com.sparkaboo.sparkcode`)
  - Custom URL scheme: `sparkcode://` (`sparkcode-dev://` in development)
  - Default state & database directory: `~/.sparkcode` (overridable via `--base-dir` or `T3CODE_HOME`)
  - Electron app data directory: `~/Library/Application Support/sparkcode`
  - Auto-update isolation: Local builds omit upstream update feeds and explicitly block `pingdotgg/t3code` update URLs so official T3 Code and SparkCode can be installed and run side by side without conflicts.
  - Telemetry disabled by default: Upstream analytics endpoints and keys are removed, and telemetry is off by default.

---

## Mobile Client (iOS / Android)

**SparkCode** preserves the upstream orchestration protocol (`ORCHESTRATION_PROTOCOL_VERSION = 2`) and pairing link format, so it works **directly with the official `T3 Code` mobile app on the App Store and Google Play**:

1. **LAN or Tailscale direct connection (recommended)**: In SparkCode desktop, open **Settings -> Sharing & access**, enable **Network access** or **Tailscale HTTPS**, and scan the QR code or paste the pairing link into **Settings -> Environments -> Add environment** on the mobile app.
2. **About T3 Connect cloud relay**: Official `T3 Connect` relies on private cloud relay credentials injected during official upstream releases and is not bundled in standalone builds. For remote access across networks, use [Tailscale](./docs/user/remote-access.md#tailscale-https).

---

## Download SparkCode

Desktop installers and standalone CLI binaries are available on [SparkCode Releases](https://github.com/Sparkaboo/sparkcode/releases/latest) for macOS (Apple Silicon & Intel), Windows (x64 & arm64), and Linux (x64 & arm64). When upgrading from a locally built `0.1.9` build for the first time, please install the new package manually.

Install the CLI on macOS (Apple Silicon) and Linux with:

```sh
curl -fsSL https://github.com/Sparkaboo/sparkcode/releases/latest/download/install.sh | sh
```

On Windows, run the `install.ps1` script from the release page in PowerShell. Verify installation with `sparkcode --version`.

## Local Development & Packaging

### Setup & Run

```bash
vp i
pnpm dev:desktop
```

### Build macOS Installer (Apple Silicon `.dmg`)

```bash
pnpm dist:desktop:dmg:arm64
```

If your local Rust toolchain is older than required by `native/resource-monitor`, you can reuse the prebuilt binary checked into the repository:

```bash
T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true pnpm dist:desktop:dmg:arm64
```

Build artifacts are written to `release/SparkCode-<version>-arm64.dmg` and `release/SparkCode-<version>-arm64.zip`.

---

## Upstream Documentation & License

- Upstream README: [README.upstream.md](./README.upstream.md)
- Full user and internal architecture docs: [docs/README.md](./docs/README.md)
- License: [MIT](./LICENSE)
