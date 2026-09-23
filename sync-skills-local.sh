#!/usr/bin/env bash
# 把 SKILL.md 同步到本机各客户端的 skills 目录(Claude Code / Codex / Gemini)。
# 三份是独立副本(非软链),故需主动铺设。仅铺已存在对应客户端配置根目录的那几家。
# 由 post-commit hook 在 SKILL.md 变更时调用,也可手动执行。

set -euo pipefail

MCP_NAME="browser-link-tool"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skill/$MCP_NAME/SKILL.md"

[ -f "$SKILL_SRC" ] || { echo "[skill-sync] 源不存在: $SKILL_SRC" >&2; exit 1; }

install_one() {  # $1 = 客户端配置根(如 ~/.claude);仅当该根已存在才铺,避免给没装的客户端凭空建目录
  local root="$1" name="$2"
  [ -d "$root" ] || { echo "[skill-sync] 跳过 $name(未检测到 $root)"; return; }
  local dst="$root/skills/$MCP_NAME"
  mkdir -p "$dst"
  cp "$SKILL_SRC" "$dst/SKILL.md"
  echo "[skill-sync] ✔ $name ← $dst/SKILL.md"
}

install_one "$HOME/.claude" "Claude Code"
install_one "$HOME/.codex"  "Codex"
install_one "$HOME/.gemini" "Gemini"
