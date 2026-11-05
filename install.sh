#!/usr/bin/env bash
# Browser Link Tool - 一键安装脚本
# 1) 安装 Node 依赖  2) 注册 MCP Server 到 Claude Code / Codex / JoyCode  3) 换代运行中的 bridge  4) 打印下一步指引
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
VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "$BRIDGE_DIR/package.json" 2>/dev/null || echo '?')"
# 末尾「下一步」指引用:注册成功的 agent、会话是否要重开只有本脚本知道,由它统一给出,调用方(其它仓库的 init 脚本)原样转发
REGISTERED=""
add_registered() { REGISTERED="${REGISTERED:+$REGISTERED、}$1"; }

# ── 1b. 版本一致性闸门 ─────────────────────────────────────
# 三处版本(bridge/扩展/skill)必须同代才让装:否则装完也是"新桥配旧扩展",出问题还难查
if [ -f "$SCRIPT_DIR/scripts/bump-version.sh" ]; then
  echo "==> 校验版本一致性…"
  if ! bash "$SCRIPT_DIR/scripts/bump-version.sh" --check; then
    echo "!! 请先执行 ./scripts/bump-version.sh <version> 统一版本后重装" >&2
    exit 1
  fi
fi

# ── 2. 安装依赖（mcp-bridge/）─────────────────────────────
echo "==> 安装依赖 (npm install @ mcp-bridge)…"
( cd "$BRIDGE_DIR" && "$NPM_BIN" install --no-audit --no-fund )

# ── 3. 注册 MCP Server 到 Claude Code（user 作用域，跨项目可用）──
# 用 -s user 而非默认 local：写入 ~/.claude.json 的 user 作用域，所有项目都能用；
# 缺省的 local 作用域只当前项目可见，换目录就会"工具消失"。
if command -v claude >/dev/null 2>&1; then
  echo "==> 注册 MCP Server '$MCP_NAME' (scope=user)…"
  claude mcp remove "$MCP_NAME" -s user >/dev/null 2>&1 || true
  if claude mcp add "$MCP_NAME" -s user -- "$NODE_BIN" "$BRIDGE"; then
    echo "   ✔ 已注册（command: $NODE_BIN $BRIDGE）"
    add_registered "Claude Code"
  else
    echo "!! claude mcp add 失败，请手动在 MCP 配置中加入：" >&2
    cat <<EOF >&2
  "$MCP_NAME": {
    "command": "$NODE_BIN",
    "args": ["$BRIDGE"]
  }
EOF
  fi
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
    add_registered "Codex"
  else
    echo "!! codex mcp add 失败，可改用 npx 方式，或手动在 ~/.codex/config.toml 追加：" >&2
    cat <<EOF >&2
  [mcp_servers.$MCP_NAME]
  command = "$NODE_BIN"
  args = ["$BRIDGE"]
EOF
  fi
fi

# ── 3c. 若存在 JoyCode（基于 Codex CLI 的公司内部工具），注册到 ~/.joycode/config.toml ──
# JoyCode 没有 `mcp add` 子命令，配置格式同 Codex。这里原位 upsert 而非删了重加：
# 只改 command/args,保留用户在该 server 下配的 tools.*.approval_mode 等子表。
JOYCODE_HOME="${JOYCODE_HOME:-$HOME/.joycode}"
JOYCODE_CFG="$JOYCODE_HOME/config.toml"
if [ -f "$JOYCODE_CFG" ]; then
  echo "==> 检测到 JoyCode，注册 MCP Server '$MCP_NAME' 到 $JOYCODE_CFG…"
  if "$NODE_BIN" - "$JOYCODE_CFG" "$MCP_NAME" "$NODE_BIN" "$BRIDGE" <<'JS'
const fs = require('fs');
const [cfg, name, nodeBin, bridge] = process.argv.slice(2);
const q = (s) => JSON.stringify(s); // JSON 字符串转义与 TOML basic string 兼容
const orig = fs.readFileSync(cfg, 'utf8');
const lines = orig.split('\n');
const isHeader = (l) => /^\s*\[/.test(l);
// 表头比较时去尾注释、空格和引号,兼容 [mcp_servers."browser-link-tool"] # xx 写法
const norm = (l) => l.trim().replace(/\]\s*#.*$/, ']').replace(/[\s"']/g, '');
const findTable = (h) => lines.findIndex((l) => norm(l) === h);
function setKey(table, key, value) {
  const h = `[${table}]`;
  let i = findTable(h);
  if (i < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(h, '');
    i = lines.length - 2;
  }
  let end = i + 1;
  while (end < lines.length && !isHeader(lines[end])) end++;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let j = i + 1; j < end; j++) {
    if (!re.test(lines[j])) continue;
    let k = j; // 多行数组:吃到闭合 ]
    if (/=\s*\[/.test(lines[j]) && !lines[j].includes(']')) while (k < end - 1 && !lines[k].includes(']')) k++;
    lines.splice(j, k - j + 1, `${key} = ${value}`);
    return;
  }
  let at = end; // 无此键:插到表体末尾(跳过尾部空行),保持键顺序
  while (at > i + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `${key} = ${value}`);
}
setKey(`mcp_servers.${name}`, 'command', q(nodeBin));
setKey(`mcp_servers.${name}`, 'args', `[ ${q(bridge)} ]`);
// 不写 env.BRIDGE_CLIENT:面板名以 MCP 握手 clientInfo 为准,BRIDGE_CLIENT 只是无 clientInfo 时的兜底
const next = lines.join('\n');
if (next === orig) { console.log('   ✔ 已是最新，无需修改'); process.exit(0); }
const bak = `${cfg}.bak.browser-link-${Date.now()}`;
fs.copyFileSync(cfg, bak);
fs.writeFileSync(cfg, next);
console.log(`   ✔ 已注册到 JoyCode（command: ${nodeBin} ${bridge}；原配置备份 ${bak}）`);
JS
  then
    echo "   ⚠ JoyCode 运行中需重启（或新开会话）才加载新配置"
    add_registered "JoyCode"
  else
    echo "!! 写入 JoyCode 配置失败，请手动在 $JOYCODE_CFG 追加：" >&2
    cat <<EOF >&2
  [mcp_servers.$MCP_NAME]
  command = "$NODE_BIN"
  args = ["$BRIDGE"]
EOF
  fi
elif [ -d "$JOYCODE_HOME" ]; then
  echo "!! 检测到 $JOYCODE_HOME 但无 config.toml，请先启动一次 JoyCode 再重跑本脚本"
fi

# ── 3d. 让运行中的 bridge 换上本版代码 ─────────────────────────
# daemon 模型:请 daemon 退出即可,各会话 client 下次心跳/调用会按磁盘上的新脚本重拉,会话不受影响。
# 旧"主实例"模型(/health 无 mode:daemon):主实例不认 /shutdown,只有它所在的 agent 会话关闭才释放端口;
# 而旧代理进程只认 status:"primary",把新 daemon 判成「端口被占用」→ 只能全部结束,让 agent 会话重开。
HTTP_PORT="${BRIDGE_HTTP_PORT:-48766}"
BRIDGE_STATE="$("$NODE_BIN" -e '
fetch(`http://127.0.0.1:${process.argv[1]}/health`, { signal: AbortSignal.timeout(2000) })
  .then(r => r.json().catch(() => ({})))
  .then(j => console.log(j.service !== "browser-link-tool" ? "foreign" : j.mode === "daemon" ? "daemon" : "legacy"))
  .catch(() => console.log("none"));
' "$HTTP_PORT" 2>/dev/null || echo none)"
# 末尾指引 ③ 用的会话处置结论,随 bridge 状态定
SESSION_HINT="新注册的 MCP 要新开 agent 会话（或 /mcp 重连）才加载"
case "$BRIDGE_STATE" in
  daemon)
    echo "==> 重启常驻 daemon 以加载新版…"
    "$NODE_BIN" -e '
fetch(`http://127.0.0.1:${process.argv[1]}/shutdown`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(() => {});
' "$HTTP_PORT" 2>/dev/null || true
    echo "   ✔ 已重启 daemon（各 agent 会话下次调用自动换上新版，无需重开）"
    SESSION_HINT="已开着的会话无需重开（daemon 已换新，下次调用自动生效）；新增的工具 / 参数要 /mcp 重连或新开会话后才出现"
    ;;
  legacy)
    echo "==> 检测到旧版 bridge（agent 拉起的主实例模型），结束全部旧进程以切换到常驻 daemon…"
    if command -v pkill >/dev/null 2>&1; then
      OLD_COUNT="$( (pgrep -f 'mcp-server-bridge\.mjs' 2>/dev/null || true) | wc -l | tr -d ' ')"
      pkill -f 'mcp-server-bridge\.mjs' 2>/dev/null || true
      # npx 拉起的旧版命令行里不含 mcp-server-bridge.mjs,按监听端口补刀
      if command -v lsof >/dev/null 2>&1; then
        lsof -ti "tcp:$HTTP_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
      fi
      echo "   ✔ 已结束旧版 bridge 进程 ${OLD_COUNT} 个"
      echo "   ⚠ 需重开会话：已开着的 agent 会话（Claude Code / Codex / JoyCode 等）请重开，或在会话里 /mcp 重连 browser-link-tool"
      SESSION_HINT="已结束旧版 bridge 进程，正开着的 agent 会话必须重开（或 /mcp 重连），否则报「Transport closed」或「端口被其他服务占用」"
    else
      echo "!! 本机无 pkill，请先关闭所有 agent 会话（或在任务管理器结束 node 的 mcp-server-bridge 进程）后再开" >&2
      SESSION_HINT="旧版 bridge 进程未能自动结束：先关闭所有 agent 会话再重开"
    fi
    ;;
  foreign)
    echo "!! 端口 $HTTP_PORT 被其他程序占用，browser-link-tool 无法启动；用 lsof -i :$HTTP_PORT 查看占用者" >&2
    SESSION_HINT="端口 $HTTP_PORT 被其他程序占用，桥起不来：先用 lsof -i :$HTTP_PORT 查出占用者并结束"
    ;;
esac

# ── 4. 安装 Skill（Claude Code / Codex / Gemini / JoyCode / .agents，客户端配置根存在才铺）──
if [ -x "$SCRIPT_DIR/scripts/sync-skills-local.sh" ]; then
  echo "==> 安装 Skill…"
  "$SCRIPT_DIR/scripts/sync-skills-local.sh" || true
fi

# ── 5. 下一步指引 ─────────────────────────────────────────
# 🚨「==> 安装完成」这一行是与调用方的唯一约定:其它仓库的 init 脚本从这行起原样转发给用户,改措辞会让它们取不到指引
if [ -f "$EXTENSION_DIR/manifest.json" ]; then
  EXT_HINT="       $EXTENSION_DIR"
else
  EXT_HINT="       !! 未在 $EXTENSION_DIR 找到 manifest.json，请确认从仓库获取了完整 extension/ 目录"
fi
if [ -n "$REGISTERED" ]; then
  MCP_HINT="已注册到 ${REGISTERED}；其他 agent（Cursor / Gemini 等）按 $SCRIPT_DIR/README.md「方式 A」手动添加"
else
  MCP_HINT="!! 未自动注册到任何 agent（未检测到 claude / codex / JoyCode，或注册失败），按 $SCRIPT_DIR/README.md「方式 A」手动添加"
fi
cat <<EOF

==> 安装完成 ✅（browser-link-tool v$VERSION）

下一步：
  ① 浏览器扩展（唯一必须人工的步骤）
     首次：chrome://extensions（或 edge://extensions）→ 开启「开发者模式」→「加载已解压的扩展程序」
           → 选 extension/ 子目录（不是项目根目录）：
$EXT_HINT
     已加载过：代码每次更新后都要在该页点 Browser Link Tool 的刷新按钮 ⟳（每个浏览器 / profile 各点一次）
  ② MCP：$MCP_HINT
  ③ agent 会话：$SESSION_HINT
  ④ 自检：点扩展图标，面板显示「已连接」且「版本」行 扩展 v$VERSION ↔ 桥 v$VERSION 未标红；
     或让 agent 调 mcp_browser_connection_info，看到三端同代即就绪
EOF
