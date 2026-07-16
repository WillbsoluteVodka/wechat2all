# Git Pull / Commit / Push SOP

本文档约定本仓库在 Codex 对话中执行 `pull`、`commit`、`push` 的标准流程。

> `pull`、`commit`、`push` 是 `git` 命令，不是 `gh` 命令。GitHub CLI（`gh`）主要用于 PR、Issue、Actions 等 GitHub API 操作。

## 基本信息

- 仓库：`WillbsoluteVodka/wechat2all`
- 远端：`origin`
- 默认分支：`main`
- 远端地址：`https://github.com/WillbsoluteVodka/wechat2all.git`

## 通用安全检查

每次操作前先运行：

```bash
git status -sb
git branch --show-current
git remote -v
```

规则：

- 不覆盖或丢弃用户已有改动。
- 提交前检查 `git diff` 和 `git diff --cached`。
- 工作区包含无关改动时，只按明确文件路径暂存，不使用 `git add -A`。
- 不使用 `git push --force`，除非用户明确要求并确认风险。
- 默认不创建 PR；只有用户明确要求时才使用 `gh pr create`。

## Pull

先确认工作区状态，再对当前分支执行只允许快进的拉取：

```bash
branch="$(git branch --show-current)"
git pull --ff-only origin "$branch"
```

如果出现分叉，停止操作并报告，不自动创建 merge commit，也不擅自 rebase。

## Commit

检查改动：

```bash
git status -sb
git diff
```

只暂存本次范围内的文件，并复核暂存内容：

```bash
git add -- path/to/file
git diff --cached
git commit -m "简洁、准确的提交说明"
```

提交后记录提交号：

```bash
git log -1 --oneline
```

## Push

将当前分支推送到 `origin`。首次推送该分支时建立 upstream：

```bash
branch="$(git branch --show-current)"
git push -u origin "$branch"
```

推送后验证：

```bash
git status -sb
git log -1 --oneline --decorate
```

## 对话中的快捷约定

后续用户直接说以下关键词时，按对应流程执行：

- `pull`：安全检查后执行 `git pull --ff-only`。
- `commit`：检查差异，只暂存本次相关文件，使用准确的提交信息提交；范围或提交信息无法可靠判断时再询问。
- `push`：确认当前分支和待推送提交后，推送到 `origin`，不自动创建 PR。
- `pull, commit, push`：严格按此顺序执行并报告每一步结果。

## 首次演练记录

2026-07-16 在 `main` 分支完成演练：

1. `git pull --ff-only origin main` 成功，仓库从 `80305e3` 快进到 `fe70a86`。
2. 新增本 SOP，并仅暂存该文件。
3. 提交后使用 `git push -u origin main` 推送。

当时 `gh auth status` 显示保存的 GitHub token 已失效，但 Git HTTPS 凭据仍可正常完成 pull/push。若后续需要使用 PR、Issue 或 Actions 等 `gh` 功能，应先运行 `gh auth login -h github.com` 重新认证。
