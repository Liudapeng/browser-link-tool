#!/usr/bin/env bash
# 把 SKILL.md 同步到本机各客户端的 skills 目录(Claude Code / Codex / Gemini / JoyCode / .agents)。
# 多份是独立副本(非软链),故需主动铺设。仅铺已存在对应客户端配置根目录的那几家。
# 由 post-commit hook 在 SKILL.md 变更时调用,也可手动执行。

set -euo pipefail

MCP_NAME="browser-link-tool"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skill/$MCP_NAME/SKILL.md"

[ -f "$SKILL_SRC" ] || { echo "[skill-sync] 源不存在: $SKILL_SRC" >&2; exit 1; }

install_one() {  # $1 = skills 目录;仅当其上级(客户端配置根)已存在才铺,避免给没装的客户端凭空建目录
  local skills_dir="$1"
  local root; root="$(dirname "$skills_dir")"
  [ -d "$root" ] || { echo "[skill-sync] 跳过 $skills_dir(未检测到 $root)"; return; }
  local dst="$skills_dir/$MCP_NAME"
  # Codex 同时加载 ~/.codex/skills(旧位置)与 ~/.agents/skills(标准位置),两处都铺会在 / 技能列表里重复;
  # ~/.agents/skills 存在时只铺那里,并清掉 ~/.codex/skills 下的同名副本
  if [ "$skills_dir" = "$HOME/.codex/skills" ] && [ -d "$HOME/.agents/skills" ]; then
    if [ -e "$dst" ] || [ -L "$dst" ]; then
      rm -rf "$dst"
      echo "[skill-sync] ✖ 删除重复副本 $dst(Codex 从 ~/.agents/skills 加载)"
    else
      echo "[skill-sync] 跳过 $skills_dir(Codex 从 ~/.agents/skills 加载)"
    fi
    return
  fi
  mkdir -p "$dst"
  cp "$SKILL_SRC" "$dst/SKILL.md"
  echo "[skill-sync] ✔ $dst/SKILL.md"
}

# ~/.agents/skills 必须在 ~/.codex/skills 之前铺:判断 Codex 是否改从标准位置加载时,它要已经存在
for d in \
  "$HOME/.claude/skills" \
  "$HOME/.agents/skills" \
  "$HOME/.codex/skills" \
  "$HOME/.gemini/skills" \
  "$HOME/.gemini/config/skills" \
  "$HOME/.joycode/skills"
do
  install_one "$d"
done
