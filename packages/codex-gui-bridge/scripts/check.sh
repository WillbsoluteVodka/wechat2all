#!/usr/bin/env bash

# Read-only Codex route setup diagnostics owned by codex-gui-bridge.
# This intentionally does not duplicate the dependencies managed by ./onboard.sh.

set -u
set -o pipefail

readonly SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)"

PROBE=0
MODE="all"
ENV_FILE="${WECHAT2ALL_ENV_FILE:-$REPO_ROOT/.env.local}"
PASS_COUNT=0
MISSING_COUNT=0
WARN_COUNT=0
UNKNOWN_COUNT=0

if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
  readonly GREEN=$'\033[32m'
  readonly RED=$'\033[31m'
  readonly YELLOW=$'\033[33m'
  readonly BLUE=$'\033[34m'
  readonly BOLD=$'\033[1m'
  readonly RESET=$'\033[0m'
else
  readonly GREEN=""
  readonly RED=""
  readonly YELLOW=""
  readonly BLUE=""
  readonly BOLD=""
  readonly RESET=""
fi

usage() {
  cat <<'EOF'
用法：./packages/codex-gui-bridge/scripts/check.sh [选项]

检查 Codex route 的公共条件、app-server 和 gui-automation 增量条件。
不会检查 ./onboard.sh 已负责的 Homebrew、Node、pnpm、Rust 或项目依赖。

选项：
  --mode all              检查两种模式（默认）
  --mode app-server       只检查公共条件和 app-server
  --mode gui-automation   检查公共条件、app-server 基础和 GUI 增量
  --probe                 运行只读 live probes；可能触发 macOS 权限弹窗，
                          但不会粘贴文字、模拟按键或发送 Codex prompt
  --env-file PATH         从指定 env 文件读取 Codex 配置
  -h, --help              显示帮助

状态：
  PASS     条件已满足
  MISSING  条件未满足
  WARN     非阻塞问题或当前未选择该模式
  UNKNOWN  macOS 不允许被动读取，需要 --probe 或手动确认
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { printf '缺少 --mode 参数\n' >&2; exit 2; }
      MODE="$2"
      shift 2
      ;;
    --probe)
      PROBE=1
      shift
      ;;
    --env-file)
      [[ $# -ge 2 ]] || { printf '缺少 --env-file 参数\n' >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf '未知选项：%s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  all|app-server|gui-automation) ;;
  *)
    printf '无效 mode：%s\n' "$MODE" >&2
    exit 2
    ;;
esac

section() {
  printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '  %sPASS%s     %s\n' "$GREEN" "$RESET" "$1"
}

missing() {
  MISSING_COUNT=$((MISSING_COUNT + 1))
  printf '  %sMISSING%s  %s\n' "$RED" "$RESET" "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '  %sWARN%s     %s\n' "$YELLOW" "$RESET" "$1"
}

unknown() {
  UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
  printf '  %sUNKNOWN%s  %s\n' "$BLUE" "$RESET" "$1"
}

info() {
  printf '  INFO     %s\n' "$1"
}

strip_quotes() {
  local value="$1"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] ||
       [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

env_file_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  /usr/bin/awk -v target="$key" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (line ~ "^" target "[[:space:]]*=") {
        sub(/^[^=]*=[[:space:]]*/, "", line)
        print line
        exit
      }
    }
  ' "$ENV_FILE"
}

config_value() {
  local key="$1"
  local value=""
  value="$(printenv "$key" 2>/dev/null || true)"
  if [[ -z "$value" ]]; then
    value="$(env_file_value "$key" 2>/dev/null || true)"
  fi
  strip_quotes "$value"
}

first_existing_path() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -e "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '该实验检查器目前只支持 macOS。\n' >&2
  exit 2
fi

DELIVERY="$(config_value WECHAT2ALL_CODEX_DELIVERY)"
[[ -n "$DELIVERY" ]] || DELIVERY="gui-automation"
REPLY_MODE="$(config_value WECHAT2ALL_CODEX_REPLY_MODE)"
[[ -n "$REPLY_MODE" ]] || REPLY_MODE="final"

CONFIGURED_APP_PATH="$(config_value WECHAT2ALL_CODEX_GUI_APP_PATH)"
APP_PATH="$(first_existing_path \
  "$CONFIGURED_APP_PATH" \
  "/Applications/ChatGPT.app" \
  "/Applications/Codex.app" \
  "$HOME/Applications/ChatGPT.app" \
  "$HOME/Applications/Codex.app" 2>/dev/null || true)"

CONFIGURED_APP_NAME="$(config_value WECHAT2ALL_CODEX_GUI_APP_NAME)"
CONFIGURED_PROCESS_NAME="$(config_value WECHAT2ALL_CODEX_GUI_PROCESS_NAME)"
APP_NAME="$CONFIGURED_APP_NAME"
PROCESS_NAME="$CONFIGURED_PROCESS_NAME"

if [[ -z "$APP_NAME" && -n "$APP_PATH" ]]; then
  APP_NAME="$(basename "$APP_PATH" .app)"
fi
[[ -n "$APP_NAME" ]] || APP_NAME="ChatGPT"
[[ -n "$PROCESS_NAME" ]] || PROCESS_NAME="$APP_NAME"

CONFIGURED_CODEX_BIN="$(config_value CODEX_CLI_PATH)"
[[ -n "$CONFIGURED_CODEX_BIN" ]] || CONFIGURED_CODEX_BIN="$(config_value WECHAT2ALL_CODEX_BIN)"
CODEX_BIN="$(first_existing_path \
  "$CONFIGURED_CODEX_BIN" \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex" 2>/dev/null || true)"
if [[ -z "$CODEX_BIN" ]] && command -v codex >/dev/null 2>&1; then
  CODEX_BIN="$(command -v codex)"
fi

printf '%sCodex route setup check%s\n' "$BOLD" "$RESET"
printf '  repo: %s\n' "$REPO_ROOT"
printf '  env:  %s%s\n' "$ENV_FILE" "$([[ -f "$ENV_FILE" ]] || printf ' (不存在)')"
printf '  mode: %s / live probe: %s\n' "$MODE" "$([[ "$PROBE" -eq 1 ]] && printf 'on' || printf 'off')"

section "公共 Codex 条件（只检查一次）"

if [[ -n "$APP_PATH" && -d "$APP_PATH" ]]; then
  pass "ChatGPT/Codex desktop 已安装：$APP_PATH"
else
  missing "没有找到 ChatGPT.app 或旧版 Codex.app"
fi

if [[ -n "$APP_PATH" && -f "$APP_PATH/Contents/Info.plist" ]] &&
   /usr/bin/plutil -convert xml1 -o - "$APP_PATH/Contents/Info.plist" 2>/dev/null |
     /usr/bin/grep -q '<string>codex</string>'; then
  pass "desktop app 已注册 codex:// URL scheme"
else
  missing "无法确认 codex:// URL scheme"
fi

if [[ -n "$CODEX_BIN" && -x "$CODEX_BIN" ]]; then
  pass "可执行的 Codex binary 已找到（desktop bundle 或显式 override）"
else
  missing "没有找到可执行的 Codex binary"
fi

if [[ -n "$CODEX_BIN" && -x "$CODEX_BIN" ]]; then
  LOGIN_OUTPUT="$({ "$CODEX_BIN" login status; } 2>&1)"
  LOGIN_STATUS=$?
  if [[ "$LOGIN_STATUS" -eq 0 && "$LOGIN_OUTPUT" == *"Logged in"* ]]; then
    pass "Codex 已登录（不会显示账号或凭据）"
  else
    missing "Codex login status 未通过；请先在 ChatGPT/Codex desktop 登录"
  fi

  if "$CODEX_BIN" app-server --help >/dev/null 2>&1; then
    pass "当前 Codex binary 提供 app-server"
  else
    missing "当前 Codex binary 不提供可用的 app-server 命令"
  fi
fi

case "$REPLY_MODE" in
  final|silent|stream)
    pass "reply mode 有效：$REPLY_MODE"
    ;;
  *)
    missing "WECHAT2ALL_CODEX_REPLY_MODE 无效：$REPLY_MODE"
    ;;
esac

info "当前有效 delivery：$DELIVERY"

THREAD_OVERRIDE="$(config_value WECHAT2ALL_CODEX_THREAD_ID)"
STATE_DIR="$(config_value WECHAT2ALL_STATE_DIR)"
[[ -n "$STATE_DIR" ]] || STATE_DIR="$HOME/.wechat2all-runtime-bot"
BINDING_FILE="$(config_value WECHAT2ALL_CODEX_GUI_BINDING_FILE)"
[[ -n "$BINDING_FILE" ]] || BINDING_FILE="$STATE_DIR/codex-gui-bridge/binding.json"

if [[ -n "$THREAD_OVERRIDE" ]]; then
  pass "已通过 WECHAT2ALL_CODEX_THREAD_ID 指定绑定（ID 已隐藏）"
elif [[ -f "$BINDING_FILE" ]]; then
  BOUND_THREAD="$(/usr/bin/plutil -extract threadId raw -o - "$BINDING_FILE" 2>/dev/null || true)"
  if [[ -n "$BOUND_THREAD" ]]; then
    pass "本机已有 Codex task binding（ID 已隐藏）"
    BINDING_MODE="$(/usr/bin/stat -f '%Lp' "$BINDING_FILE" 2>/dev/null || true)"
    if [[ -n "$BINDING_MODE" && $((10#$BINDING_MODE % 100)) -eq 0 ]]; then
      pass "binding 文件没有 group/other 权限：$BINDING_MODE"
    else
      warn "binding 文件权限建议为 600；当前为 ${BINDING_MODE:-未知}"
    fi
  else
    missing "binding 文件存在，但没有有效 threadId"
  fi
else
  missing "尚未绑定 Codex task；进入微信 Codex route 后执行 /ls 和 /bind <序号>"
fi

section "app-server"

if [[ "$DELIVERY" == "app-server" ]]; then
  pass "当前已选择 app-server delivery"
elif [[ "$DELIVERY" == "gui-automation" ]]; then
  info "当前选择 GUI delivery；它仍依赖本节的 app-server 基础能力"
else
  missing "当前 delivery '$DELIVERY' 不是受支持的 app-server/gui-automation"
fi

if [[ "$PROBE" -eq 1 ]]; then
  if ! command -v node >/dev/null 2>&1 || [[ ! -d "$REPO_ROOT/node_modules/tsx" ]]; then
    missing "live app-server probe 无法运行；请先完成仓库根目录 ./onboard.sh"
  elif [[ -z "$CODEX_BIN" || ! -x "$CODEX_BIN" ]]; then
    missing "live app-server probe 缺少 Codex binary"
  else
    PROBE_STDERR="$(mktemp "${TMPDIR:-/tmp}/codex-app-server-probe.XXXXXX")"
    APP_SERVER_OUTPUT="$(
      cd "$REPO_ROOT" &&
      CODEX_CLI_PATH="$CODEX_BIN" \
        NODE_NO_WARNINGS=1 \
        node --import tsx packages/codex-gui-bridge/src/index.ts ls 2>"$PROBE_STDERR"
    )"
    APP_SERVER_STATUS=$?
    APP_SERVER_ERROR="$(/usr/bin/grep -m 2 -E '^(Error:|WARNING:)' "$PROBE_STDERR" 2>/dev/null |
      /usr/bin/tr '\n' ' ' |
      /usr/bin/sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' || true)"
    if [[ -z "$APP_SERVER_ERROR" ]]; then
      APP_SERVER_ERROR="$(/usr/bin/tail -n 1 "$PROBE_STDERR" 2>/dev/null || true)"
    fi
    APP_SERVER_ERROR="${APP_SERVER_ERROR//$HOME/~}"
    APP_SERVER_ERROR="${APP_SERVER_ERROR//$REPO_ROOT/<repo>}"
    rm -f "$PROBE_STDERR"
    if [[ "$APP_SERVER_STATUS" -eq 0 ]]; then
      THREAD_COUNT="$(printf '%s' "$APP_SERVER_OUTPUT" | node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => raw += chunk);
        process.stdin.on("end", () => {
          try {
            const value = JSON.parse(raw);
            process.stdout.write(String(Array.isArray(value) ? value.length : -1));
          } catch {
            process.stdout.write("-1");
          }
        });
      ' 2>/dev/null || printf '%s' '-1')"
      if [[ "$THREAD_COUNT" =~ ^[0-9]+$ && "$THREAD_COUNT" -gt 0 ]]; then
        pass "app-server live probe 成功，并找到 $THREAD_COUNT 个可绑定 task"
      elif [[ "$THREAD_COUNT" == "0" ]]; then
        missing "app-server 可连接，但没有可绑定 task；先在 Codex 创建一个 task"
      else
        warn "app-server 命令成功，但实验检查器无法解析 task 列表"
      fi
    else
      missing "app-server live probe 失败：${APP_SERVER_ERROR:-未知错误}"
    fi
  fi
else
  unknown "尚未 live probe app-server；使用 --probe 验证 JSON-RPC 和 task 列表"
fi

if [[ "$MODE" == "all" || "$MODE" == "gui-automation" ]]; then
  section "gui-automation 增量（不重复 app-server 条件）"

  if [[ "$DELIVERY" == "gui-automation" ]]; then
    pass "当前已选择 gui-automation delivery"
  else
    warn "GUI delivery 未启用；需要时把 WECHAT2ALL_CODEX_DELIVERY 改为 gui-automation"
  fi

  if [[ -x /usr/bin/osascript ]]; then
    pass "macOS 内置 /usr/bin/osascript 可执行"
  else
    missing "没有找到 /usr/bin/osascript"
  fi

  if [[ -x /usr/bin/open ]]; then
    pass "macOS 内置 /usr/bin/open 可用于打开 codex:// task"
  else
    missing "没有找到 /usr/bin/open"
  fi

  if [[ -n "$APP_PATH" && -f "$APP_PATH/Contents/Info.plist" ]]; then
    PLIST_EXECUTABLE="$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
    if [[ -n "$PLIST_EXECUTABLE" && "$PROCESS_NAME" == "$PLIST_EXECUTABLE" ]]; then
      pass "GUI process name 与 app executable 一致：$PROCESS_NAME"
    else
      warn "GUI process 配置为 '$PROCESS_NAME'，app executable 为 '${PLIST_EXECUTABLE:-未知}'"
    fi
  fi

  for NUMERIC_KEY in \
    WECHAT2ALL_CODEX_GUI_POLL_INTERVAL_MS \
    WECHAT2ALL_CODEX_GUI_THREAD_OPEN_DELAY_MS; do
    NUMERIC_VALUE="$(config_value "$NUMERIC_KEY")"
    if [[ -n "$NUMERIC_VALUE" ]] && ! is_positive_integer "$NUMERIC_VALUE"; then
      missing "$NUMERIC_KEY 必须是正整数；当前为 '$NUMERIC_VALUE'"
    fi
  done

  COMPUTER_USE_PATH=""
  if [[ -d "$HOME/.codex/computer-use/Codex Computer Use.app" ]]; then
    COMPUTER_USE_PATH="$HOME/.codex/computer-use/Codex Computer Use.app"
  elif [[ -d "$HOME/.codex/plugins/cache/openai-bundled/computer-use" ]]; then
    COMPUTER_USE_PATH="$(find "$HOME/.codex/plugins/cache/openai-bundled/computer-use" \
      -name 'Codex Computer Use.app' -type d -print -quit 2>/dev/null || true)"
  fi

  if [[ -n "$COMPUTER_USE_PATH" ]]; then
    info "Codex Computer Use 已安装；仅在 macOS 将控制权限归因给它时需要授权"
  else
    info "未找到 Codex Computer Use；普通 osascript GUI 注入并不强制安装它"
  fi

  if [[ "$PROBE" -eq 1 ]]; then
    ACCESS_OUTPUT="$(/usr/bin/osascript \
      -e 'tell application "System Events" to get UI elements enabled' 2>&1)"
    ACCESS_STATUS=$?
    if [[ "$ACCESS_STATUS" -eq 0 && "$ACCESS_OUTPUT" == "true" ]]; then
      pass "当前启动链可通过 System Events 使用 Accessibility"
    elif [[ "$ACCESS_STATUS" -eq 0 ]]; then
      missing "System Events 返回 Accessibility 未启用；检查实际启动宿主和 osascript"
    else
      missing "无法向 System Events 发送 Automation event；检查 Automation 权限"
    fi

    if pgrep -x "$PROCESS_NAME" >/dev/null 2>&1; then
      pass "$PROCESS_NAME 当前正在运行"
      GUI_OUTPUT="$(/usr/bin/osascript \
        -e 'tell application "System Events"' \
        -e 'tell first process whose bundle identifier is "com.openai.codex" to get count of windows' \
        -e 'end tell' 2>&1)"
      GUI_STATUS=$?
      if [[ "$GUI_STATUS" -eq 0 && "$GUI_OUTPUT" =~ ^[0-9]+$ ]]; then
        pass "System Events 可以读取 ChatGPT/Codex GUI（未输入文字或按键）"
      else
        missing "System Events 无法读取 ChatGPT/Codex GUI；检查 Accessibility/Automation"
      fi

      APP_EVENT_OUTPUT="$(/usr/bin/osascript \
        -e 'tell application id "com.openai.codex" to get name' 2>&1)"
      APP_EVENT_STATUS=$?
      if [[ "$APP_EVENT_STATUS" -eq 0 ]]; then
        pass "当前启动链可以向 ChatGPT/Codex 发送只读 Automation event"
      else
        missing "无法向 ChatGPT/Codex 发送 Automation event；把对应 requester 下的 ChatGPT/Codex 打开"
      fi
    else
      unknown "$PROCESS_NAME 未运行，未探测目标 GUI；打开 desktop app 后重跑 --probe"
    fi
  else
    unknown "Accessibility/Automation 不能被动可靠读取；使用同一启动宿主重跑 --probe"
  fi

  if [[ -n "$COMPUTER_USE_PATH" ]]; then
    unknown "Computer Use 的 Screen Recording 权限必须在 System Settings 中手动确认"
  fi
fi

section "汇总"
printf '  PASS=%d  MISSING=%d  WARN=%d  UNKNOWN=%d\n' \
  "$PASS_COUNT" "$MISSING_COUNT" "$WARN_COUNT" "$UNKNOWN_COUNT"

if [[ "$PROBE" -eq 0 ]]; then
  info "下一步：从实际启动 WeConnect 的同一个 Terminal/iTerm/Codex 环境运行本脚本 --probe"
fi

if [[ "$MISSING_COUNT" -gt 0 ]]; then
  exit 1
fi

exit 0
