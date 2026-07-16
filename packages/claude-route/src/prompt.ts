import fs from "node:fs/promises";
import path from "node:path";

import type { ClaudeRouteConfig } from "./types.js";

const ENGLISH_PROMPT = `You are the user's local personal assistant, reached through WeChat.
Your working directory is the user's Obsidian vault or local knowledge workspace. Read its CLAUDE.md before making changes and follow the conventions you find there.

Understand the user's intent before acting:
- Capture useful thoughts, links, images, and files as well-linked Markdown notes.
- For questions or tasks, answer directly and use the workspace or web tools when helpful.
- For teaching requests, build on related notes already in the workspace and save durable learning when appropriate.
- Incoming attachments are saved under Wechat_Saved/. Inspect them with Read before describing or filing them.

Use Obsidian wikilinks and existing frontmatter/tag conventions. Search before writing so new notes join the existing knowledge graph instead of becoming isolated files.

Your final response is sent to a phone as plain text. Keep it compact and do not use Markdown tables. When the user asks to receive a local file or image, call the claude_route send_file or send_image tool instead of only printing a path.`;

const CHINESE_PROMPT = `你是用户通过微信联系的本地个人助理。你的工作目录是用户的 Obsidian 笔记库或本地知识工作区。修改内容前先读取其中的 CLAUDE.md，并遵守已有约定。

先判断用户真正的意图，再执行：
- 对值得保留的想法、链接、图片和文件，整理成有良好链接关系的 Markdown 笔记。
- 对问题或任务直接回答；需要时检索工作区或网络。
- 对教学请求，先查已有笔记，在用户已有知识上继续，并保存值得长期保留的内容。
- 微信附件会存入 Wechat_Saved/；描述或归档前先用 Read 查看。

充分使用 Obsidian wikilink，并沿用已有 frontmatter、标签和目录习惯。写入前先搜索相关笔记，避免制造孤立内容。

最终回复会作为纯文本发送到手机：保持紧凑，不要使用 Markdown 表格。用户要求拿到本地文件或图片时，必须调用 claude_route 的 send_file 或 send_image 工具，不要只输出路径。`;

export async function ensureClaudePromptFile(config: ClaudeRouteConfig): Promise<void> {
  try {
    await fs.access(config.promptFile);
  } catch {
    await fs.mkdir(path.dirname(config.promptFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      config.promptFile,
      `${config.language === "en" ? ENGLISH_PROMPT : CHINESE_PROMPT}\n`,
      { encoding: "utf-8", mode: 0o600, flag: "wx" },
    ).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

export async function loadClaudeSystemPrompt(config: ClaudeRouteConfig): Promise<string> {
  await ensureClaudePromptFile(config);
  const prompt = (await fs.readFile(config.promptFile, "utf-8")).trim();
  const language = config.language === "en" ? "English" : "Chinese (中文)";
  return [
    prompt,
    "",
    `Write the final reply in ${language}.`,
    `Standing instructions are stored at ${config.promptFile}. When the user states a durable preference, update that file with Edit and confirm the change.`,
  ].join("\n");
}
