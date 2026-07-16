# Claude Route 与微信协议审计

审计对象：

- `WilsonZheng0327/wechat-claude-obsidian-bot`
- 审计 commit：`56fac63d7e357893242a96a12698d477b2775684`
- 目标项目使用：`claude-agent-sdk>=0.2`、`weixin-ilink[qr]>=0.3.5`
- 本次对照的 PyPI wheel：`weixin-ilink 0.3.5`

## 目标项目怎么工作

它是一个小型 Python 常驻进程，不是 centralized webhook 服务：

1. `WeixinBot` 通过腾讯 iLink 长轮询收消息。
2. 图片和文件先下载到 Obsidian vault 的 `Wechat_Saved/`。
3. 每条消息启动一次 headless Claude Agent SDK `query()`。
4. Agent 的 `cwd` 是 vault，并通过 project setting source 读取 `CLAUDE.md`。
5. 15 分钟内的后续消息用 Agent SDK 的 `resume=session_id` 继续同一 session。
6. 最终文本通过 iLink 回复；内嵌 MCP 工具负责把 workspace 文件或图片发回微信。

它的 Claude 配置包含 Read/Write/Edit/Grep/Glob/WebFetch/WebSearch、已有 Git
仓库的受限 Git 命令、`acceptEdits`、40 turns、1 USD budget，以及可编辑的
长期 prompt。`/status`、`/new`、`/help` 在本地直接处理，不消耗 Agent run。

## 纳入 wechat2all 的部分

本项目新增了完全独立的 `packages/claude-route`，保留了以下好设计：

- headless Agent SDK，而不是通过 GUI automation 驱动 Claude；
- workspace/vault 作为 `cwd`，读取其中 `CLAUDE.md`；
- per sender 的短窗口 session resume；
- 图片/文件进入 `Wechat_Saved/` 后再交给 Agent；
- 本地 slash commands；
- in-process MCP `status`、`reset_session`、`send_file`、`send_image`；
- 媒体上限、turn/budget/timeout 上限；
- 已有 Git repo 才开放受限 Git 命令。

与目标项目不同，本项目没有再启动一个 WeChat bot，也没有复制 Python
协议层。Claude route 只消费 `RuntimeMessage` 并返回 `RuntimeAction`，所以扫码、
轮询、context token、媒体 CDN、重试和 action queue 仍由现有 client/runtime 负责。

## `weixin-ilink` 值得借鉴的协议层能力

下面是目标项目依赖里存在、当前 `packages/client` 尚未提供同等便利封装的部分。
它们只是候选清单，本次 **没有修改或替换现有协议实现**。

| 能力 | `weixin-ilink` 的做法 | 对 wechat2all 的潜在价值 |
|---|---|---|
| 微信文本 Markdown 清洗 | `markdown.py` 提供一次性和 streaming filter，去掉微信不会渲染的语法 | Agent 长回复在手机/桌面微信中的格式更一致 |
| 微信表情标签转换 | `emoji.py` 把 `[微笑]` 一类标签映射为 Unicode emoji | 避免标签原样显示 |
| 长文本自动分片 | `send_text_chunked` 默认按约 4000 字符发送 | 防止超长 LLM 回复触发单条限制 |
| 高层 reply API | 入站 `IncomingMessage` 直接提供 `reply_text/image/file/typing` 并自动带 context token | 编写独立 bot/示例时更简洁，减少 token 传错 |
| Pairing ACL helper | 注册、注销、查询 allow-from 用户的便利函数 | 后续做多用户访问控制时可参考 |
| 凭据旁 cursor 自动持久化 | 默认从 credentials 文件派生 `.sync` cursor 文件 | 小型 standalone bot 的开箱体验更好 |
| 可选 SILK 转录工具链 | `voice` extra 把 SILK 转 WAV，再接本地 Whisper | 微信没有 transcript 时可作为 runtime 的可选能力 |

这些是“开发体验或上层消息处理更方便”，不代表它的底层整体比当前 client
更 robust。当前 wechat2all 已有 structured errors、可配置 monitor policy、指数/延迟
重试、CDN 上传下载重试、媒体类型覆盖、context token cache、sync buffer 持久化、
action queue 与去重等较完整的 hardening。目标库遇到连续 poll 失败主要采用固定
2/30 秒 sleep，session expired 则 sleep 一小时；这部分不应反向替换现有实现。

## 本次协议决策

- `packages/client`：零改动。
- 不引入 `weixin-ilink` 运行时依赖。
- 不创建第二套凭据、QR login、cursor 或 context-token cache。
- Claude route 的媒体输入统一走 `RuntimeMediaPipeline`。
- Claude route 的文本/媒体输出统一走 runtime action executor。

如果以后采纳上表候选，应该分别作为独立 client/runtime feature 设计、测试和
review，不能借 Claude route 绕过现有协议边界。

