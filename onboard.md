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
5. 按需从 Community 安装额外 route，并按照该 route 仓库自己的 setup guide 配置。
6. 如果要使用 Claude route，再配置自己的 Anthropic API key 和本地 workspace/vault。

完成一次 onboarding 后，日常启动只需要：

```bash
cd /path/to/wechat2all
pnpm desktop
```

`pnpm desktop` 会负责重启旧的本地开发进程，并启动 router-daemon、Vite UI 和
Tauri desktop；不需要分别启动三个进程。

## 0. 本机数据原则

每位 collaborator 都应该有自己的配置、微信 session 和 route 本地状态。

不要从其他电脑复制这些内容：

```text
.env.local
~/.wechat2all-runtime-bot/
```

其中包括：

- LLM / Mem0 API keys。
- 微信登录凭据、轮询 cursor 和消息去重记录。
- 本地 memory 与媒体 cache。
- Community route 的 binding、alarm 和其他本地设置。

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
不负责 Community route 的账号登录或第三方依赖。

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
- `/ls` 能看到当前已安装的 routes。
- 普通文字能得到 LLM 回复，而不是“连不上 LLM”。

修改 `.env.local` 后必须重启 `pnpm desktop`，已经运行的 daemon 不会自动重新读取
API key。

## 4. Community Route Onboard

Codex、Office、Upochi 等 Community route 不再随 WeConnect 主仓库内置。打开
desktop 的 Community 页面，按需安装 route；安装完成后 route 会立即出现在
dashboard 和微信主 Router 的 `/ls` 中。

每个 route 的第三方 app、账号、系统权限、命令和配置都由它自己的独立仓库说明。
卸载 route 会移除其可执行 package，但不会把 route 代码重新写回 WeConnect 主仓库。

## 5. Claude Route Onboard

Claude route 使用与大助手彼此独立的 provider：

- 大助手使用 OpenAI-compatible key。
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
- 普通消息由 Claude 处理，而不是大助手或其他 route。
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

### Community route 安装后没有出现

1. 在 Community 页面确认安装状态是 `Installed`。
2. 查看 route 卡片上的 setup/requirements 信息。
3. 在微信主 Router 发送 `/ls`；如果仍未出现，重启 desktop 后再检查。
4. route 自身的连接、权限或第三方 app 问题，请按照该 route 仓库的 setup guide 排查。

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
- [ ] 如需 Community route，已从 Community 页面安装并按照其独立 setup guide 验证。
- [ ] 如需 Claude route，已配置自己的 Anthropic key 和 workspace。
- [ ] `/cd claude` -> `/status` -> 普通消息 -> `/new` 均正常。
