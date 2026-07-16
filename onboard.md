# wechat2all 新电脑 Onboarding

这份文档面向第一次在全新 Mac 上运行 wechat2all 的 collaborator。

## 一键 Onboarding（推荐）

在仓库根目录运行：

```bash
./onboard.sh
```

脚本会检查并准备启动大助手主应用所需的环境：

- Xcode Command Line Tools；
- Homebrew；
- Git；
- 项目兼容的 Node.js 和 pnpm；
- Rust stable 与 Cargo；
- 与 `pnpm-lock.yaml` 一致的项目依赖。

缺失项会自动安装。Xcode Command Line Tools 由 macOS 系统安装器负责，因此首次安装时
需要在系统弹窗中确认；完成后回到 Terminal 按 Return，脚本会继续。全部就绪后脚本
直接运行 `pnpm desktop` 打开软件。

它不会检查或配置 Codex Desktop、Anthropic/Claude、route workspace、route 账号或
其他具体 route 的专属依赖。这些能力仍然按需单独配置。

只检查环境而不安装或启动：

```bash
./onboard.sh --check
```

完成安装但暂不启动：

```bash
./onboard.sh --no-launch
```

下面的步骤保留为手动安装说明和故障排查参考。

先说结论：**不是 clone/pull 后立即就能用**。一台全新的电脑需要先完成：

1. 安装 Node.js、pnpm、Rust 和 Xcode Command Line Tools。
2. clone 仓库并安装依赖。
3. 在本机创建 `.env.local`，填入自己的大助手 LLM API key。
4. 启动 `pnpm desktop`，用自己的微信扫码。
5. 如果要使用 Codex route，再安装并登录 ChatGPT/Codex desktop，配置 macOS 权限并绑定一个 Codex chat。
6. 如果要使用 Claude route，再配置自己的 Anthropic API key 和本地 workspace/vault。

完成一次 onboarding 后，日常启动只需要：

```bash
cd /path/to/wechat2all
pnpm desktop
```

`pnpm desktop` 会负责重启旧的本地开发进程，并启动 router-daemon、Vite UI 和
Tauri desktop；不需要分别启动三个进程。

## 0. 本机数据原则

每位 collaborator 都应该有自己的配置、微信 session 和 Codex binding。

不要从其他电脑复制这些内容：

```text
.env.local
~/.wechat2all-runtime-bot/
```

其中包括：

- LLM / Mem0 API keys。
- 微信登录凭据、轮询 cursor 和消息去重记录。
- 本地 memory 与媒体 cache。
- Codex chat binding、auto-open 和 alarm 设置。

这些内容已被 `.gitignore` 排除。**不要提交 `.env.local`，也不要提交任何真实 API
key、微信 credentials 或 `~/.wechat2all-runtime-bot` 内容。**

注意：同一个微信账号重新扫描新的 OpenClaw/iLink 二维码时，可能解除另一台电脑上
已有的连接。collaborator 应优先使用自己的微信账号测试，不要直接复用其他人的扫码
session。

## 1. 准备全新 Mac

### 1.1 系统要求

- macOS。
- Git。
- Node.js 20 或更高版本；当前开发环境使用 Node.js 24。
- pnpm；当前开发环境使用 pnpm 11。
- Rust stable 与 Cargo，用于 Tauri。
- Xcode Command Line Tools。

如果需要 Codex route，当前 ChatGPT desktop 的官方 macOS 要求是 macOS 14 或更高
版本以及 Apple Silicon（M1 或更新）。

### 1.2 安装开发依赖

先安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

Node.js 可以通过 Homebrew、nvm 或其他版本管理器安装。下面是一个 Homebrew 示例：

```bash
brew install node pnpm rustup-init
rustup-init -y
source "$HOME/.cargo/env"
```

如果已经安装 Node.js，但没有 pnpm，也可以使用：

```bash
npm install --global pnpm
```

确认工具可用：

```bash
git --version
node --version
pnpm --version
rustc --version
cargo --version
```

如果 `rustc` 或 `cargo` 刚安装后仍然找不到，重新打开 Terminal，或者执行：

```bash
source "$HOME/.cargo/env"
```

## 2. Clone 和安装项目

```bash
git clone https://github.com/WillbsoluteVodka/wechat2all.git
cd wechat2all
pnpm install --frozen-lockfile
```

第一次 onboard 建议跑一次完整检查：

```bash
pnpm check
```

第一次 `pnpm desktop` 会编译 Tauri/Rust，通常比后续启动慢。

## 3. General Onboard：启动大助手

大助手使用一个 OpenAI-compatible LLM provider。这个 API key 只负责大助手聊天，
**不负责 Codex route 登录**。

### 3.1 创建本地配置

在仓库根目录执行：

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`。在中国大陆，当前更容易直接测试的配置是 DeepSeek：

```dotenv
WECHAT2ALL_LLM_PROVIDER=openai-compatible
WECHAT2ALL_LLM_BASE_URL=https://api.deepseek.com/v1
WECHAT2ALL_LLM_API_KEY=填入你自己的_DeepSeek_API_Key
WECHAT2ALL_LLM_MODEL=deepseek-chat
WECHAT2ALL_LLM_TEMPERATURE=0.7
WECHAT2ALL_LLM_MAX_TOKENS=800
WECHAT2ALL_LLM_TIMEOUT_MS=30000

WECHAT2ALL_MEMORY_PROVIDER=local
```

也可以使用 OpenAI-compatible 的其他 provider。例如 OpenAI：

```dotenv
WECHAT2ALL_LLM_PROVIDER=openai-compatible
WECHAT2ALL_LLM_BASE_URL=https://api.openai.com/v1
WECHAT2ALL_LLM_API_KEY=填入你自己的_OpenAI_API_Key
WECHAT2ALL_LLM_MODEL=gpt-4.1-mini
WECHAT2ALL_LLM_MAX_TOKENS=800
WECHAT2ALL_LLM_TIMEOUT_MS=30000
```

如果本机访问 provider 需要代理，把代理写进同一个 `.env.local`：

```dotenv
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

端口必须改成该电脑代理软件实际使用的 HTTP/mixed 端口。

Mem0 是可选项。新 collaborator 不需要 Mem0 key 也可以使用大助手；默认 local memory
会写入自己的 `~/.wechat2all-runtime-bot/memory/`。如需 Mem0，再添加：

```dotenv
WECHAT2ALL_MEMORY_PROVIDER=mem0
WECHAT2ALL_MEM0_API_KEY=填入你自己的_Mem0_API_Key
WECHAT2ALL_MEM0_BASE_URL=https://api.mem0.ai
```

### 3.2 启动并扫码

```bash
pnpm desktop
```

保持这个 Terminal 窗口运行。desktop 打开后：

1. 进入 WeChat connection / QR login 页面。
2. 如果页面还没有二维码，点击请求/刷新 QR。
3. 用这台电脑对应用户自己的微信扫码并确认。
4. 等待 dashboard 显示 connected。
5. 在微信里找到新建立的 bot chat，先发送 `/help`。

### 3.3 验证大助手

在主 Router 中依次测试：

```text
/help
/ls
你好，请只回复“大助手连接成功”
```

通过标准：

- `/help` 能返回命令说明。
- `/ls` 能看到 `codex` 等 routes。
- 普通文字能得到 LLM 回复，而不是“连不上 LLM”。

修改 `.env.local` 后必须重启 `pnpm desktop`，已经运行的 daemon 不会自动重新读取
API key。

## 4. Codex Route Onboard

Codex route 与大助手使用两套独立认证：

- 大助手：读取 `.env.local` 中的 `WECHAT2ALL_LLM_API_KEY`。
- Codex route：读取这台 Mac 上 ChatGPT/Codex desktop 的登录和本地 chats。

DeepSeek key 或 OpenAI API key不会自动登录 Codex desktop。

### 4.1 安装并登录 ChatGPT/Codex desktop

1. 从 [OpenAI 官方页面](https://openai.com/chatgpt/desktop/) 安装当前 ChatGPT desktop。
2. 打开 app，并使用 collaborator 自己的 ChatGPT 账号登录。
3. 切换到 Codex。
4. 按照 [Codex 官方入门](https://openai.com/codex/get-started/) 添加本地
   wechat2all 仓库作为 project。
5. 至少创建并打开一个 Codex chat，发送一条普通消息，确认 Codex 本身可用。

当前 bridge 会优先识别：

```text
/Applications/ChatGPT.app
```

同时兼容旧路径：

```text
/Applications/Codex.app
```

正常情况下不需要单独安装 Codex CLI，因为 bridge 会使用 desktop app bundle 里的
`Contents/Resources/codex`。如果 app 安装在非标准路径，可以在 `.env.local` 显式配置：

```dotenv
WECHAT2ALL_CODEX_GUI_APP_NAME=ChatGPT
WECHAT2ALL_CODEX_GUI_APP_PATH=/Applications/ChatGPT.app
WECHAT2ALL_CODEX_GUI_PROCESS_NAME=ChatGPT
```

### 4.2 配置 Codex delivery

如果希望微信消息能出现在可见的 Codex GUI chat 中，在 `.env.local` 添加：

```dotenv
WECHAT2ALL_CODEX_DELIVERY=gui-automation
WECHAT2ALL_CODEX_REPLY_MODE=final
WECHAT2ALL_CODEX_TURN_TIMEOUT_MS=180000
WECHAT2ALL_CODEX_PROCESSING_REMINDER_MS=120000
```

`gui-automation` 会打开绑定的 chat、粘贴文字并按 Return；图片和结果读取仍会使用
Codex app-server 能力。

如果只需要协议调用、不要求输入立即显示在 GUI，可以使用：

```dotenv
WECHAT2ALL_CODEX_DELIVERY=app-server
```

`app-server` 通常不需要 Accessibility 权限，但外部 turn 不保证立刻渲染到当前打开的
GUI 窗口。

不要把 `desktop-ipc` 设置成默认 delivery。项目只将 Codex Desktop IPC 用于只读的
实时 `/status`；普通消息发送仍使用当前稳定的 delivery 路径。

### 4.3 macOS Privacy & Security

只有 `gui-automation` 需要控制 GUI。macOS 权限应该授予**实际运行
`pnpm desktop` 的 app**：

- 从 Terminal 启动：授权 `Terminal`。
- 从 iTerm 启动：授权 `iTerm`。
- 从 Codex 内置 terminal 启动：可能需要授权 `ChatGPT` / `Codex`，以及系统列出的
  对应 helper。

设置步骤：

1. 打开 `System Settings`。
2. 进入 `Privacy & Security -> Accessibility`。
3. 找到实际启动 `pnpm desktop` 的 Terminal/iTerm/ChatGPT，并打开开关。
4. 如果列表中没有，点击 `+` 手动添加对应 app。
5. 进入 `Privacy & Security -> Automation`。
6. 如果系统列出了启动 app 对 `System Events` 或 `ChatGPT` 的控制权限，全部打开。
7. 如果 ChatGPT 访问 repo 时出现文件夹权限提示，允许访问 repo 所在的 Desktop、
   Documents 或其他父目录。
8. 完全退出并重新打开获得权限的 Terminal/iTerm，然后重新运行 `pnpm desktop`。

不需要为了 onboarding 开启 Full Disk Access。只授予系统实际提示且上述功能需要的
权限。

macOS 通常会在第一次 GUI 注入时才弹出 Automation/Accessibility 提示。因此，设置
完 `.env.local` 后应实际发送一次 Codex 消息，再回到 System Settings 检查新出现的
开关。

### 4.4 绑定 Codex chat

确保 ChatGPT desktop 已打开，并且刚创建的 Codex chat 已经能在左侧列表看到。然后
在微信主 Router 中发送：

```text
/cd codex
```

进入 Codex route 后：

```text
/ls
```

`/ls` 会返回当前可绑定 chats 的编号。选择一个编号，例如：

```text
/bind 1
```

不要手工输入很长的 thread id；优先使用 `/ls` 给出的序号。

继续验证：

```text
/current
/status
/token
请只回复“Codex route 连接成功”
```

通过标准：

- `/current` 显示刚绑定的 chat。
- `/status` 能区分正在工作、已完成与未知，不会在 chat 正在运行时误报空闲。
- 普通消息被发送到绑定的 Codex chat，最终回复回到微信。
- 在 `gui-automation` 模式下，微信输入也能在绑定的 Codex GUI chat 中看到。

绑定结果保存在这台电脑自己的：

```text
~/.wechat2all-runtime-bot/codex-gui-bridge/binding.json
```

不需要提交，也不要复制给其他 collaborator。

可选：让下一次 `pnpm desktop` 自动打开 ChatGPT/Codex desktop：

```text
/autoopen 1
```

关闭自动打开：

```text
/autoopen 0
```

## 5. Claude Route Onboard

Claude route 与大助手、Codex route 是第三套独立 provider：

- 大助手使用 OpenAI-compatible key。
- Codex route 使用本机 ChatGPT/Codex desktop。
- Claude route 使用官方 Claude Agent SDK，默认要求 `ANTHROPIC_API_KEY`。

在 `.env.local` 添加：

```dotenv
ANTHROPIC_API_KEY=填入你自己的_Anthropic_API_Key
WECHAT2ALL_CLAUDE_WORKDIR=/绝对路径/到/你的/ObsidianVault
WECHAT2ALL_CLAUDE_LANGUAGE=zh
WECHAT2ALL_CLAUDE_SESSION_WINDOW_MINUTES=15
```

`WECHAT2ALL_CLAUDE_WORKDIR` 也可以是普通本地项目目录，不强制使用 Obsidian。
如果目录内有 `CLAUDE.md`，Agent SDK 会加载里面的项目约定。第三方 app 默认不复用
Claude Code consumer login；只有明确理解认证影响时才设置：

```dotenv
WECHAT2ALL_CLAUDE_ALLOW_CLI_AUTH=1
```

重启 `pnpm desktop`，然后在微信测试：

```text
/ls
/cd claude
/status
请只回复“Claude route 连接成功”
/new
/cd ..
```

通过标准：

- `/ls` 能看到 `claude`。
- `/status` 显示 `Claude Agent SDK`、正确 workspace 和 auth 状态。
- 普通消息由 Claude 处理，而不是大助手或 Codex。
- `/new` 清除当前用户的短期 session；`/cd ..` 回到主 Router。
- 图片/文件会保存到 workspace 的 `Wechat_Saved/`，Claude 可读取；视频会被明确拒绝。

Claude route 本地状态在：

```text
~/.wechat2all-runtime-bot/claude-route/                    # default profile
~/.wechat2all-runtime-bot/profiles/<profile>/claude-route/ # named profile
```

不要提交该目录，也不要把其他 collaborator 的 session 文件复制过来。

## 6. 日常启动和停止

启动整套本地开发环境：

```bash
cd /path/to/wechat2all
pnpm desktop
```

停止：在启动它的 Terminal 中按 `Control-C`。

再次执行 `pnpm desktop` 时，脚本默认会清理旧的 wechat2all desktop、router 端口
`39787` 和 UI 端口 `5173`，然后启动一套新的进程。因此通常不需要手工分别重启
daemon、runtime 和 desktop。

## 7. 常见问题

### `pnpm` / `cargo` 找不到

重新打开 Terminal，并检查：

```bash
node --version
pnpm --version
source "$HOME/.cargo/env"
cargo --version
```

### 大助手提示连不上 LLM

依次检查：

1. `.env.local` 位于 repo 根目录，不是 package 子目录。
2. `WECHAT2ALL_LLM_API_KEY` 和 `WECHAT2ALL_LLM_MODEL` 都存在。
3. `WECHAT2ALL_LLM_BASE_URL` 包含正确的 `/v1`。
4. key 没有多余空格，也没有使用另一个 provider 的 key。
5. 当前网络能访问 provider；需要代理时配置 `HTTP_PROXY` / `HTTPS_PROXY`。
6. 修改配置后已经完整重启 `pnpm desktop`。

### Dashboard 没有二维码或连接不上 daemon

检查 daemon：

```bash
curl http://127.0.0.1:39787/health
```

检查端口占用：

```bash
lsof -nP -iTCP:39787 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

通常重新运行一次 `pnpm desktop` 会清理旧的 wechat2all 进程。

### Codex route 的 `/ls` 没有 chats

检查：

1. ChatGPT/Codex desktop 已安装、已登录且正在运行。
2. 已在 Codex 中添加本地 project，并至少创建一个 chat。
3. app 位于 `/Applications/ChatGPT.app` 或 `/Applications/Codex.app`。
4. bridge 能找到 desktop bundle 中的 Codex executable。

可以在 repo 根目录单独测试发现能力：

```bash
pnpm --filter @wechat2all/codex-gui-bridge dev -- ls
```

### Codex 能收到消息，但 GUI 不显示或 AppleScript 报错

1. 确认 `.env.local` 是 `WECHAT2ALL_CODEX_DELIVERY=gui-automation`。
2. 重新检查 Accessibility 和 Automation。
3. 权限授予对象必须是启动 `pnpm desktop` 的 app。
4. 修改权限后完全退出并重开 Terminal/iTerm。
5. 保持 ChatGPT/Codex desktop 已打开。

### `/status` 显示未知 / 未连接

`/status` 会读取绑定 chat 的 Codex Desktop 实时 snapshot。确认：

- ChatGPT/Codex desktop 正在运行。
- 当前仍有有效 `/bind`。
- `/current` 显示的 thread 仍存在。

如果 chat 被删除或属于另一台电脑，重新执行 `/ls` 和 `/bind <序号>`。

### Claude route 显示 Workspace Missing 或 auth unavailable

1. 确认 `.env.local` 中 `WECHAT2ALL_CLAUDE_WORKDIR` 是存在的绝对目录。
2. 确认 `ANTHROPIC_API_KEY` 已设置，且没有被提交到 Git。
3. 修改配置后完整重启 `pnpm desktop`。
4. 在 `/cd claude` 后执行 `/status` 查看 route 自检原因。
5. 只有明确选择复用本地 Claude CLI 认证时才打开
   `WECHAT2ALL_CLAUDE_ALLOW_CLI_AUTH=1`。

## 8. Onboarding 完成检查表

- [ ] `pnpm install --frozen-lockfile` 成功。
- [ ] `pnpm check` 成功。
- [ ] 本机 `.env.local` 已创建且未提交。
- [ ] `pnpm desktop` 能打开 dashboard。
- [ ] 使用自己的微信扫码并显示 connected。
- [ ] 大助手普通消息可以得到 LLM 回复。
- [ ] ChatGPT/Codex desktop 已安装并登录。
- [ ] Codex project/chat 已创建。
- [ ] macOS Accessibility/Automation 已按启动方式授权。
- [ ] `/cd codex` -> `/ls` -> `/bind 1` 成功。
- [ ] Codex 普通消息可以从微信进入绑定 chat，并把最终结果返回微信。
- [ ] 如需 Claude route，已配置自己的 Anthropic key 和 workspace。
- [ ] `/cd claude` -> `/status` -> 普通消息 -> `/new` 均正常。
