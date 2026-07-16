#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly HOMEBREW_INSTALL_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"
readonly RUSTUP_INSTALL_URL="https://sh.rustup.rs"

CHECK_ONLY=0
LAUNCH_APP=1
BREW_BIN=""
PNPM_BIN=""
TEMP_FILE=""

if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
  readonly COLOR_GREEN=$'\033[32m'
  readonly COLOR_YELLOW=$'\033[33m'
  readonly COLOR_RED=$'\033[31m'
  readonly COLOR_BOLD=$'\033[1m'
  readonly COLOR_RESET=$'\033[0m'
else
  readonly COLOR_GREEN=""
  readonly COLOR_YELLOW=""
  readonly COLOR_RED=""
  readonly COLOR_BOLD=""
  readonly COLOR_RESET=""
fi

info() {
  printf '%s[wechat2all]%s %s\n' "$COLOR_BOLD" "$COLOR_RESET" "$*"
}

success() {
  printf '%s[ok]%s %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$*"
}

warn() {
  printf '%s[注意]%s %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$*" >&2
}

die() {
  printf '%s[错误]%s %s\n' "$COLOR_RED" "$COLOR_RESET" "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_FILE" && -f "$TEMP_FILE" ]]; then
    rm -f -- "$TEMP_FILE"
  fi
}

trap cleanup EXIT

usage() {
  cat <<EOF
用法：./$SCRIPT_NAME [选项]

检查并准备运行 wechat2all 主应用所需的 macOS 环境，然后启动桌面应用。

选项：
  --check       只检查，不安装依赖，也不启动应用
  --no-launch   安装/检查依赖，但不启动应用
  -h, --help    显示帮助

脚本不会检查或配置 Codex、Claude 等具体 route 的专属依赖和账号。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      LAUNCH_APP=0
      ;;
    --no-launch)
      LAUNCH_APP=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "未知选项：$1"
      ;;
  esac
  shift
done

find_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi

  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

activate_homebrew() {
  BREW_BIN="$(find_homebrew)" || return 1
  eval "$("$BREW_BIN" shellenv)"
  BREW_BIN="$(command -v brew)"
}

has_xcode_tools() {
  xcode-select -p >/dev/null 2>&1 && xcrun --find clang >/dev/null 2>&1
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 || return 1

  local version major rest minor
  version="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1

  if (( major == 20 )); then
    (( minor >= 19 ))
  elif (( major == 22 )); then
    (( minor >= 12 ))
  else
    (( major > 22 ))
  fi
}

pnpm_is_compatible() {
  command -v pnpm >/dev/null 2>&1 || return 1

  local version major
  version="$(pnpm --version 2>/dev/null)" || return 1
  major="${version%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  (( major >= 9 ))
}

rust_is_available() {
  command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1
}

project_dependencies_are_current() {
  [[ -f "$REPO_ROOT/node_modules/.pnpm/lock.yaml" ]] || return 1
  [[ -x "$REPO_ROOT/node_modules/.bin/tsx" ]] || return 1
  [[ -x "$REPO_ROOT/packages/desktop/node_modules/.bin/tauri" ]] || return 1
  cmp -s "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/node_modules/.pnpm/lock.yaml"
}

download_to_temp() {
  local url="$1"
  TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/wechat2all-onboard.XXXXXX")"
  /usr/bin/curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$TEMP_FILE"
}

install_or_upgrade_formula() {
  local formula="$1"
  if "$BREW_BIN" list --versions "$formula" >/dev/null 2>&1; then
    "$BREW_BIN" upgrade "$formula"
  else
    "$BREW_BIN" install "$formula"
  fi
}

ensure_xcode_tools() {
  if has_xcode_tools; then
    success "Xcode Command Line Tools：$(xcode-select -p)"
    return
  fi

  info "未找到 Xcode Command Line Tools，正在打开 Apple 安装程序……"
  xcode-select --install >/dev/null 2>&1 || true
  warn "请在系统弹窗中完成安装；安装结束后回到这里按 Return 继续。"
  read -r

  has_xcode_tools || die "Xcode Command Line Tools 尚未就绪。完成系统安装后请重新运行 ./$SCRIPT_NAME。"
  success "Xcode Command Line Tools 已安装"
}

ensure_homebrew() {
  if activate_homebrew; then
    success "Homebrew：$($BREW_BIN --version | sed -n '1p')"
    return
  fi

  info "未找到 Homebrew，正在下载安装程序……"
  download_to_temp "$HOMEBREW_INSTALL_URL"
  /bin/bash "$TEMP_FILE"
  rm -f -- "$TEMP_FILE"
  TEMP_FILE=""

  activate_homebrew || die "Homebrew 安装完成后仍无法找到 brew。请重新打开 Terminal 后再运行 ./$SCRIPT_NAME。"
  success "Homebrew 已安装：$($BREW_BIN --version | sed -n '1p')"
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    success "Git：$(git --version)"
    return
  fi

  info "未找到 Git，正在通过 Homebrew 安装……"
  install_or_upgrade_formula git
  hash -r
  command -v git >/dev/null 2>&1 || die "Git 安装失败。"
  success "Git：$(git --version)"
}

ensure_node() {
  if node_is_compatible; then
    success "Node.js：$(node --version)"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    warn "当前 Node.js $(node --version 2>/dev/null || printf 'unknown') 不满足项目要求（需要 20.19+ 或 22.12+）。"
  else
    info "未找到 Node.js。"
  fi
  info "正在通过 Homebrew 安装兼容版本的 Node.js……"
  install_or_upgrade_formula node
  export PATH="$($BREW_BIN --prefix node)/bin:$PATH"
  hash -r

  node_is_compatible || die "Node.js 安装后版本仍不兼容，当前版本：$(node --version 2>/dev/null || printf '未找到')。"
  success "Node.js：$(node --version)"
}

ensure_pnpm() {
  if pnpm_is_compatible; then
    PNPM_BIN="$(command -v pnpm)"
    success "pnpm：$(pnpm --version)"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    warn "当前 pnpm $(pnpm --version 2>/dev/null || printf 'unknown') 过旧（需要 9+）。"
  else
    info "未找到 pnpm。"
  fi
  info "正在通过 Homebrew 安装 pnpm……"
  install_or_upgrade_formula pnpm
  hash -r

  pnpm_is_compatible || die "pnpm 安装失败或版本仍不兼容。"
  PNPM_BIN="$(command -v pnpm)"
  success "pnpm：$(pnpm --version)"
}

ensure_rust() {
  if [[ -d "$HOME/.cargo/bin" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
    hash -r
  fi

  if rust_is_available; then
    success "Rust：$(rustc --version) / $(cargo --version)"
    return
  fi

  info "未找到完整的 Rust/Cargo toolchain，正在通过 rustup 安装 stable toolchain……"
  download_to_temp "$RUSTUP_INSTALL_URL"
  /bin/sh "$TEMP_FILE" -y --profile minimal --default-toolchain stable --no-modify-path
  rm -f -- "$TEMP_FILE"
  TEMP_FILE=""
  export PATH="$HOME/.cargo/bin:$PATH"
  hash -r

  rust_is_available || die "Rust/Cargo 安装后仍不可用。请重新打开 Terminal 后再运行 ./$SCRIPT_NAME。"
  success "Rust：$(rustc --version) / $(cargo --version)"
}

check_environment() {
  local failed=0

  if has_xcode_tools; then
    success "Xcode Command Line Tools：$(xcode-select -p)"
  else
    warn "缺少 Xcode Command Line Tools"
    failed=1
  fi

  if activate_homebrew; then
    success "Homebrew：$($BREW_BIN --version | sed -n '1p')"
  else
    warn "缺少 Homebrew"
    failed=1
  fi

  if command -v git >/dev/null 2>&1; then
    success "Git：$(git --version)"
  else
    warn "缺少 Git"
    failed=1
  fi

  if node_is_compatible; then
    success "Node.js：$(node --version)"
  else
    warn "缺少兼容的 Node.js（需要 20.19+ 或 22.12+）"
    failed=1
  fi

  if pnpm_is_compatible; then
    PNPM_BIN="$(command -v pnpm)"
    success "pnpm：$(pnpm --version)"
  else
    warn "缺少兼容的 pnpm（需要 9+）"
    failed=1
  fi

  if [[ -d "$HOME/.cargo/bin" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
    hash -r
  fi
  if rust_is_available; then
    success "Rust：$(rustc --version) / $(cargo --version)"
  else
    warn "缺少 Rust stable/Cargo"
    failed=1
  fi

  if project_dependencies_are_current; then
    success "项目依赖与 pnpm-lock.yaml 一致"
  else
    warn "项目依赖尚未安装，或与 pnpm-lock.yaml 不一致"
    failed=1
  fi

  if (( failed != 0 )); then
    die "环境检查未通过。运行 ./$SCRIPT_NAME 可自动安装缺失依赖。"
  fi

  success "主应用运行环境检查通过"
}

install_project_dependencies() {
  if project_dependencies_are_current; then
    success "项目依赖已就绪，跳过 pnpm install"
    return
  fi

  info "正在安装项目依赖……"
  "$PNPM_BIN" install --frozen-lockfile
  project_dependencies_are_current || die "项目依赖安装完成后校验仍未通过。"
  success "项目依赖安装完成"
}

main() {
  [[ "$(uname -s)" == "Darwin" ]] || die "当前 onboard 脚本只支持 macOS。"
  [[ -f "$REPO_ROOT/package.json" && -f "$REPO_ROOT/pnpm-lock.yaml" ]] || die "无法定位 wechat2all 仓库根目录。"
  cd "$REPO_ROOT"

  info "准备 wechat2all 主应用环境"
  info "只检查主应用依赖；不会检查 Codex、Claude 等 route 的专属配置。"

  if (( CHECK_ONLY )); then
    check_environment
    return
  fi

  ensure_xcode_tools
  ensure_homebrew
  ensure_git
  ensure_node
  ensure_pnpm
  ensure_rust
  install_project_dependencies

  if (( ! LAUNCH_APP )); then
    success "Onboarding 完成。稍后运行 pnpm desktop 即可启动。"
    return
  fi

  info "环境已就绪，正在启动 wechat2all……"
  exec "$PNPM_BIN" desktop
}

main
