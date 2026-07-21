# Codex Route 全方位测试 Checklist

测试通过一项后，可以勾选对应的 `[ ]`，也可以直接删除整个测试段落。

每项测试建议同时记录：

- 微信回复
- Codex GUI 的变化
- 运行 `pnpm desktop` 的 Terminal 日志

如果出现问题，请保留对应测试段落，并附上微信截图、Codex GUI 截图和 Terminal 中相关的 `codex-gui-bridge` 日志。

## 已知遗留问题

- [ ] `/autoopen 1|0` 当前仍然存在于 Codex route 和帮助菜单中，与之前要求删除它不一致。它不影响本轮 GUI-assisted 测试，但之后需要删除。

## 0. 启动前检查

- [ ] Codex/ChatGPT Desktop 已安装并登录。
- [ ] System Settings → Privacy & Security → Accessibility 已授权实际运行 `pnpm desktop` 的宿主。
- [ ] Automation 中允许宿主控制 `System Events` 和 `ChatGPT/Codex`。
- [ ] Mac 当前没有锁屏。
- [ ] 在项目目录启动：

```bash
cd /Users/will/Desktop/wechat2all
pnpm desktop
```

- [ ] Terminal 中 Codex setup check 没有关键 `missing`。
- [ ] Terminal 没有 router 启动失败、端口占用或 app-server 初始化错误。

## 1. Route 基础测试

### 1.1 进入 Codex route

- [ ] 微信发送 `/cd codex`。
- [ ] 微信提示已进入 Codex route。
- [ ] 返回内容中的 route 名称和说明正确。

### 1.2 Help

- [ ] 发送 `help`。
- [ ] 返回 Codex 命令列表。
- [ ] 当前预期仍会看到已知遗留命令 `/autoopen 1|0`。

### 1.3 返回和重新进入

- [ ] 发送 `/cd ..`。
- [ ] 返回主大助手。
- [ ] 再发送 `/cd codex`。
- [ ] 重新进入 Codex route。

## 2. Chat 列表和绑定

### 2.1 列出 Chat

- [ ] 发送 `/ls`。
- [ ] 返回最近可绑定的 Codex Chat。
- [ ] Chat 按项目分组。
- [ ] 每个 Chat 有可用于 `/bind` 的编号。

### 2.2 按编号绑定

- [ ] 发送 `/bind 1`。
- [ ] 返回绑定成功。
- [ ] 项目名、Chat 名和 ID 正确。

### 2.3 查看当前绑定

- [ ] 发送 `/current`。
- [ ] 返回刚才绑定的 Chat。
- [ ] ID 与 `/bind 1` 返回的一致。

### 2.4 精确投递到绑定的 Chat

- [ ] 在 Codex GUI 中故意打开另一个非绑定 Chat。
- [ ] 从微信发送：`回复我：精确绑定测试通过`。
- [ ] 消息进入绑定的 Chat，而不是错误的前台 Chat。
- [ ] 微信收到正确回复。
- [ ] Terminal 显示 `delivery=gui-automation thread=<绑定 ID>`。
- [ ] 本次请求没有出现 `turn/start` fallback。

## 3. 普通文字 GUI automation

### 3.1 单条文字

- [ ] 发送：`回复我：GUI文字测试通过`。
- [ ] Codex GUI 中能看到这条输入。
- [ ] 微信收到正确回复。
- [ ] Terminal 显示 `delivery=gui-automation`。
- [ ] 每条请求只产生一个 Codex turn，没有重复 fallback。

### 3.2 连续消息顺序

- [ ] 快速发送：`第一条，请回复1`。
- [ ] 紧接着发送：`第二条，请回复2`。
- [ ] 两条消息按顺序处理。
- [ ] 没有丢失消息。
- [ ] 没有把消息注入错误的 Chat。

## 4. `/new` 稳定新建

### 4.1 空白 `/new`

- [ ] 发送 `/current` 并记录当前项目和 Chat ID。
- [ ] 在 Codex GUI 中故意打开另一个项目。
- [ ] 微信发送 `/new`。
- [ ] 微信提示：`已在当前项目准备新的 Codex chat`。
- [ ] 微信提示下一条消息后会完成创建并自动绑定。
- [ ] 回复中显示的新 Chat ID 与旧 ID 不同。

### 4.2 第一条消息完成新建

- [ ] 发送：`这是new chat第一条消息，请回复：新建成功`。
- [ ] 首条消息通过 app-server 进入新的 Chat。
- [ ] 完成后新 Chat 自动在 Codex GUI 打开。
- [ ] 微信收到“新建成功”。
- [ ] 发送 `/current`。
- [ ] `/current` 返回新 Chat 的真实 ID。
- [ ] 新 ID 与 `/new` 前的旧 ID 不同。
- [ ] 不需要刷新或重启 Codex 才能看到新 Chat。
- [ ] 没有出现 `not materialized yet` 错误。

### 4.3 `/new` 携带首条消息

- [ ] 发送：`/new 直接回复我：一条命令新建成功`。
- [ ] 通过 app-server 创建新的 Chat。
- [ ] 首条消息立即发送到新 Chat。
- [ ] 微信收到“一条命令新建成功”。
- [ ] `/current` 已自动绑定到这个新 Chat。
- [ ] 没有出现 `includeTurns is unavailable before first user message`。

## 5. 图片输入

### 5.1 先发图片再发 Prompt

- [ ] 微信发送一张图片，不带文字。
- [ ] 图片被缓存，没有立刻触发错误的空 Prompt。
- [ ] 如果等待约 15 秒，只收到一次“请问想对这些附件做什么操作？”提醒。
- [ ] 接着发送：`描述这张图片`。
- [ ] Codex GUI 中出现图片附件和文字。
- [ ] 微信收到正确的图片描述。
- [ ] Terminal 显示 `delivery=gui-automation`。

### 5.2 输入图片不能被当成输出

- [ ] 上一项处理完成后，原始输入图片没有被 Codex route 再发回微信。
- [ ] 微信只收到 Codex 的文字回答或真正生成的新输出附件。

### 5.3 图片不重复携带

- [ ] 图片请求完成后发送：`现在只回复：普通文字测试`。
- [ ] 新请求不再携带上一张图片。
- [ ] Codex GUI 中只出现普通文字。
- [ ] 微信不会再次收到旧图片。

### 5.4 多图片

- [ ] 连续发送两张不同图片。
- [ ] 发送：`比较刚刚两张图片的区别`。
- [ ] 两张图片都进入同一个 Codex Prompt。
- [ ] 图片顺序正确。
- [ ] Codex 能比较两张图片。
- [ ] 两张原始图片都不会被当作输出回传。

## 6. 文件输入

### 6.1 文件读取

- [ ] 微信发送一个 PDF、TXT 或 Markdown 文件。
- [ ] 发送：`总结这个文件`。
- [ ] 文件通过本地路径引用进入 Codex。
- [ ] Codex GUI 中能看到附件。
- [ ] Codex 能读取文件并正确回复。
- [ ] Terminal 显示 `delivery=gui-automation`。

### 6.2 文件不重复携带

- [ ] 文件请求完成后发送：`这是一条和文件无关的消息，只回复OK`。
- [ ] 旧文件没有再次跟随新请求。
- [ ] Codex GUI 中没有再次出现旧附件。

## 7. 图片和文件混合输入

- [ ] 发送一张图片。
- [ ] 发送一个文件。
- [ ] 发送：`分别告诉我图片是什么、文件讲了什么`。
- [ ] 图片和文件都进入同一个 Codex Prompt。
- [ ] Codex 能分别识别图片和文件。
- [ ] 原始附件不会作为输出重新发回微信。

## 8. Codex 输出附件

### 8.1 输出文件

- [ ] 发送：`在当前项目创建一个 test-output.txt，内容写“Codex output file test”，完成后把文件返回给我`。
- [ ] 文件创建成功。
- [ ] 微信收到生成的 `test-output.txt`。
- [ ] 微信没有只收到无法使用的本地绝对路径。

### 8.2 输出图片

- [ ] 发送：`生成一张简单的测试图片并返回给我`。
- [ ] 微信收到新生成的图片。
- [ ] 收到的不是之前上传的输入图片。

## 9. 回复模式

### 9.1 Final

- [ ] 发送 `/mode final`。
- [ ] 显示当前模式为 `final`。
- [ ] 发送一个需要简单分析的任务。
- [ ] 微信只收到最终回答。
- [ ] 微信没有收到 commentary/thinking。

### 9.2 Silent

- [ ] 发送 `/mode silent`。
- [ ] 发送：`计算123乘以456`。
- [ ] Route 等待 Codex 任务结束。
- [ ] 微信不返回完整正文，只返回完成通知。

### 9.3 Stream

- [ ] 发送 `/mode stream`。
- [ ] 发送一个稍复杂的任务。
- [ ] Route 可以返回多个 Codex 文本片段。
- [ ] 文本片段顺序正确。

### 9.4 恢复默认模式

- [ ] 发送 `/mode final`。
- [ ] 当前模式恢复为 `final`。

## 10. 状态和 Token

### 10.1 空闲状态

- [ ] 发送 `/status`。
- [ ] 返回当前 Chat、项目和更新时间。
- [ ] 完成任务后状态为 completed 或 idle。

### 10.2 工作状态

- [ ] 启动一个稍长任务。
- [ ] 任务执行期间发送 `/status`。
- [ ] `/status` 不会打断当前任务。
- [ ] 状态显示正在处理。

### 10.3 Token

- [ ] 发送 `/token`。
- [ ] 返回 5h 使用情况。
- [ ] 返回 reset credits。
- [ ] 不再显示之前重复的第二行窗口信息。

## 11. 两分钟处理提醒

- [ ] 发送一个明确会运行超过两分钟的任务。
- [ ] 两分钟左右收到一次等待提醒。
- [ ] 提醒文案不是固定的“请稍等，正在处理。”。
- [ ] 如果收到多次提醒，文案会随机变化。
- [ ] 提醒不会打断 Codex turn。
- [ ] 最终仍能收到正式结果。

## 12. Cache

建议在附件测试完成后再执行。

### 12.1 查看 Cache

- [ ] 发送 `/cache`。
- [ ] 返回 cache 路径。
- [ ] 返回当前文件数和大小。

### 12.2 清理 Cache

- [ ] 发送 `/cache clear`。
- [ ] 返回清理文件数和释放空间。
- [ ] 再发送 `/cache`。
- [ ] 文件数和大小已经减少或清空。

> 注意：这会删除当前 profile 缓存的微信附件。

## 13. Alarm

### 13.1 查看和设置

- [ ] 发送 `/alarm`。
- [ ] 返回当前 alarm 状态。
- [ ] 设置一个未来几分钟的时间，例如 `/alarm 23:50`。
- [ ] 返回启用状态和下次触发时间。

### 13.2 自动触发

- [ ] 到达设置时间后，自动向当前绑定 Chat 发送一次静默的“你好”。
- [ ] 自动消息通过当前 GUI automation 路径发送。
- [ ] Terminal 显示 `delivery=gui-automation`。

### 13.3 关闭

- [ ] 发送 `/alarm off`。
- [ ] Alarm 被关闭，避免第二天继续触发。

## 14. GUI 打不开时 app-server 继续工作

### 14.1 显示器休息状态

- [ ] 保持 Mac 不锁屏、不睡眠，只让显示器进入休息或关闭状态。
- [ ] 从微信发送普通文字。
- [ ] 即使 GUI 无法访问，微信仍收到 Codex 回复。
- [ ] Terminal 出现 `GUI automation unavailable`。
- [ ] Terminal 显示 `delivery=app-server-fallback`。
- [ ] 没有产生两个相同的 Codex turn。

### 14.2 Accessibility 临时关闭

- [ ] 临时关闭实际启动宿主的 Accessibility 权限。
- [ ] 从微信发送普通文字。
- [ ] 微信仍收到回复。
- [ ] Terminal 显示 `delivery=app-server-fallback`。

### 14.3 `/new` 在 GUI 不可用时

- [ ] 在 Codex GUI 无法打开时发送 `/new`。
- [ ] 微信提示：`已在当前项目准备新的 Codex chat`。
- [ ] 发送下一条消息。
- [ ] app-server 新 Chat 正常完成首条消息。
- [ ] 没有出现 `not materialized yet`。
- [ ] GUI 恢复后可通过 `/current` 的 ID 打开这个 Chat。

## 15. 重启恢复

### 15.1 普通绑定恢复

- [ ] 发送 `/current` 并记录当前 Chat ID。
- [ ] 完全停止 `pnpm desktop`。
- [ ] 重新运行 `pnpm desktop`。
- [ ] 进入 `/cd codex`。
- [ ] 发送 `/current`。
- [ ] 仍然绑定重启前的 Chat。
- [ ] 不需要重新执行 `/bind`。

### 15.2 `/new` 中途重启

- [ ] 发送 `/new`，看到空白 GUI Chat。
- [ ] 不发送第一条消息。
- [ ] 重启 `pnpm desktop`。
- [ ] 再发送第一条普通消息。
- [ ] Route 重新准备一个可用的新 GUI Chat。
- [ ] 第一条消息正常发送。
- [ ] 新 Chat 自动完成绑定。
- [ ] 没有出现 `thread is not materialized yet`。
- [ ] 没有出现 `includeTurns is unavailable before first user message`。

## 16. 错误和边界条件

### 16.1 错误绑定编号

- [ ] 发送 `/bind 9999`。
- [ ] 提示编号不存在。
- [ ] Route 没有崩溃。
- [ ] 原绑定没有被破坏。

### 16.2 `/bind` 缺少参数

- [ ] 发送 `/bind`。
- [ ] 不会改变当前绑定。
- [ ] 不会作为普通 Prompt 注入 Codex GUI。

### 16.3 错误 Mode

- [ ] 发送 `/mode invalid`。
- [ ] 不会改变当前 reply mode。
- [ ] 不会作为普通 Prompt 注入 Codex GUI。

### 16.4 错误 Cache 命令

- [ ] 发送 `/cache invalid`。
- [ ] 返回正确用法。
- [ ] 不会清理 Cache。

### 16.5 未知 Slash 命令

- [ ] 发送 `/abcxyz`。
- [ ] 不会被当作普通 Codex Prompt 注入 GUI。

### 16.6 Busy Chat

- [ ] Codex 正在处理时快速发送下一条消息。
- [ ] 消息能够正确排队或 steer。
- [ ] 没有丢失消息。
- [ ] 没有发送到错误 Chat。

### 16.7 防止重复投递

- [ ] 每条微信请求只产生一个 Codex turn。
- [ ] GUI 只负责打开 Chat，不会再额外键盘提交一次。
- [ ] 微信只收到一份最终答案。

## 建议测试顺序

1. Route、绑定、普通文字
2. `/new`
3. 图片和文件
4. 输入图片不回传
5. GUI unavailable + app-server continuity
6. 重启恢复
7. Mode、Token、Cache、Alarm
8. 长任务和边界情况

## 测试结果记录

发现问题时复制下面的模板：

```text
测试编号：
测试命令/消息：
微信实际结果：
Codex GUI 实际结果：
Terminal 日志：
是否可以稳定复现：
补充截图：
```
