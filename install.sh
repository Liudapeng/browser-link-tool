#!/usr/bin/env bash
# Browser Link Tool - 一键安装脚本
# 1) 安装 Node 依赖  2) 注册 MCP Server 到 Claude Code  3) 打印扩展加载指引
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$SCRIPT_DIR/extension"
BRIDGE_DIR="$SCRIPT_DIR/mcp-bridge"
BRIDGE="$BRIDGE_DIR/mcp-server-bridge.mjs"
MCP_NAME="browser-link-tool"

echo "==> Browser Link Tool 安装"
echo "    项目目录 : $SCRIPT_DIR"
echo "    扩展目录 : $EXTENSION_DIR"
echo "    MCP 桥   : $BRIDGE_DIR"

# ── 1. 解析 Node 18+（MCP SDK 要求）──────────────────────────
resolve_node() {
  # 优先当前 PATH 的 node
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 18 ]; then command -v node; return 0; fi
  fi
  # 回退到 nvm 中最高的 >=18 版本
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [ -d "$nvm_dir" ]; then
    local best=""
    for d in "$nvm_dir"/v*/bin/node; do
      [ -x "$d" ] || continue
      local m; m="$("$d" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
      [ "$m" -ge 18 ] && best="$d"
    done
    [ -n "$best" ] && { echo "$best"; return 0; }
  fi
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "!! 未找到 Node 18+（MCP SDK 要求）。请安装 Node >= 18 后重试。" >&2
  exit 1
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"
echo "==> 使用 Node: $NODE_BIN ($("$NODE_BIN" -v))"

# ── 2. 安装依赖（mcp-bridge/）─────────────────────────────
echo "==> 安装依赖 (npm install @ mcp-bridge)…"
( cd "$BRIDGE_DIR" && "$NPM_BIN" install --no-audit --no-fund )

# ── 3. 注册 MCP Server 到 Claude Code（user 作用域，跨项目可用）──
# 用 -s user 而非默认 local：写入 ~/.claude.json 的 user 作用域，所有项目都能用；
# 缺省的 local 作用域只当前项目可见，换目录就会"工具消失"。
if command -v claude >/dev/null 2>&1; then
  echo "==> 注册 MCP Server '$MCP_NAME' (scope=user)…"
  claude mcp remove "$MCP_NAME" -s user >/dev/null 2>&1 || true
  claude mcp add "$MCP_NAME" -s user -- "$NODE_BIN" "$BRIDGE" \
    && echo "   ✔ 已注册（command: $NODE_BIN $BRIDGE）" \
    || {
      echo "!! claude mcp add 失败，请手动在 MCP 配置中加入：" >&2
      cat <<EOF >&2
  "$MCP_NAME": {
    "command": "$NODE_BIN",
    "args": ["$BRIDGE"]
  }
EOF
    }
else
  echo "!! 未检测到 claude CLI。可改用 npx 方式（见 README 方式 A），或手动加 MCP 配置片段："
  cat <<EOF
  "$MCP_NAME": {
    "command": "$NODE_BIN",
    "args": ["$BRIDGE"]
  }
EOF
fi

# ── 3b. 若存在 codex，也注册到 Codex（~/.codex/config.toml）──────────
if command -v codex >/dev/null 2>&1; then
  echo "==> 检测到 codex，注册 MCP Server '$MCP_NAME' 到 Codex…"
  codex mcp remove "$MCP_NAME" >/dev/null 2>&1 || true
  if codex mcp add "$MCP_NAME" -- "$NODE_BIN" "$BRIDGE" >/dev/null 2>&1; then
    echo "   ✔ 已注册到 Codex（command: $NODE_BIN $BRIDGE）"
  else
    echo "!! codex mcp add 失败，可改用 npx 方式，或手动在 ~/.codex/config.toml 追加：" >&2
    cat <<EOF >&2
  [mcp_servers.$MCP_NAME]
  command = "$NODE_BIN"
  args = ["$BRIDGE"]
EOF
  fi
fi

# ── 4. 安装 Skill（Claude Code / Codex / Gemini，各家 skills 目录存在才铺）──
if [ -x "$SCRIPT_DIR/sync-skills-local.sh" ]; then
  echo "==> 安装 Skill…"
  "$SCRIPT_DIR/sync-skills-local.sh" || true
fi

# ── 5. 加载扩展指引 ───────────────────────────────────────
if [ -f "$EXTENSION_DIR/manifest.json" ]; then
  EXT_HINT="     $EXTENSION_DIR"
else
  EXT_HINT="     !! 未在 $EXTENSION_DIR 找到 manifest.json，请确认从仓库获取了完整 extension/ 目录"
fi
cat <<EOF

==> 安装完成 ✅

下一步：在浏览器加载扩展（唯一必须人工的步骤）
  1. 打开 chrome://extensions （或 edge://extensions）
  2. 右上角开启「开发者模式」
  3. 点击「加载已解压的扩展程序」，选择 extension/ 子目录（不是项目根目录）：
$EXT_HINT
  4. 打开任意网页，点击工具栏图标查看面板 —— 应显示「已连接」

多会话隔离：在 MCP 工具调用中传 tabId（可用 mcp_browser_list_tabs 获取），
不同 agent 会话即可各自锁定不同标签页，互不干扰。
EOF
