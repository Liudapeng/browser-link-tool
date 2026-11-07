#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import os from "os";
import { spawn, execFileSync } from "child_process";
import { createHash } from "crypto";

// ─── 进程模型: 单实例常驻 daemon + 每会话一个轻量 client ───
// daemon(`--daemon`):全机唯一,独占 WebSocket(:48765,扩展连入、长连接) + HTTP(:48766);
//   与任何 agent 会话解耦(detached 拉起),无 client 心跳超过 DAEMON_IDLE_MS 自退。
// client(默认,agent 以 stdio 拉起):不占端口,每次工具调用都是一次临时 HTTP 请求转发给 daemon;
//   启动时/调用时发现 daemon 不在就拉起一个,发现 daemon 版本比自己旧就让它退出后换新。
const IS_DAEMON = process.argv.includes('--daemon');
// CLI 模式:带子命令(`blt click "#btn"`)或在终端里裸跑。agent 以 stdio 拉起时既无参数、stdin 也不是 TTY → MCP 模式。
// `--mcp` 强制 MCP 模式(终端里手动调试 MCP 握手用)
const CLI_ARGV = process.argv.slice(2);
const IS_CLI = !IS_DAEMON && CLI_ARGV[0] !== '--mcp' && (CLI_ARGV.length > 0 || !!process.stdin.isTTY);

// 端口可经环境变量覆盖,仅供本地测试(扩展固定连 48765,改了扩展就连不上)
const WS_PORT = Number(process.env.BRIDGE_WS_PORT) || 48765;
const HTTP_PORT = Number(process.env.BRIDGE_HTTP_PORT) || 48766;
// 扩展断线后每 2s 重连一次;daemon 刚起时等扩展连上的最长时间
const EXT_RECONNECT_WAIT_MS = 6000;
// daemon 起来后此时长内扩展未连上视为"刚启动",调用方等待重连;超出则视为常态未连接、立即报错
const DAEMON_FRESH_MS = 10000;
// daemon 无任何 client 心跳/调用超过该时长自退(client 每 10s 心跳,agent 开着就不会退)
const DAEMON_IDLE_MS = 10 * 60 * 1000;
// daemon 日志(daemon 无终端,stdout/stderr 落文件);BRIDGE_HOME 可覆盖,供测试隔离
const BRIDGE_HOME = process.env.BRIDGE_HOME || path.join(os.homedir(), '.browser-link-tool');
const DAEMON_LOG = path.join(BRIDGE_HOME, 'daemon.log');
// ─── 会话标识与 client 识别 ───
// 每个 bridge 进程即一个 agent 会话。client 名以 MCP 握手 clientInfo(title || name)为准——协议标准、agent 真实自报:
//   认得的品牌规范成展示名,认不出的原样展示 clientInfo 值(JoyCode 报 codex-mcp-client → 显示 Codex,接受)。
//   只有握手前/没有 clientInfo 时才兜底:BRIDGE_CLIENT 环境变量 > 父进程链 > 环境变量探测 > 'unknown'。
// 把 MCP 上报的原始 name(如 claude-code / cursor-vscode)规范成展示名。
function normalizeClientName(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (s.includes('joycode')) return 'JoyCode'; // 先于 codex:JoyCode 是 Codex 分支
  if (s.includes('claude')) return 'Claude';
  if (s.includes('codex')) return 'Codex';
  if (s.includes('gemini')) return 'Gemini';
  if (s.includes('cursor')) return 'Cursor';
  if (s.includes('cline')) return 'Cline';
  if (s.includes('windsurf')) return 'Windsurf';
  if (s.includes('antigravity')) return 'Antigravity';
  // 认不出 → 原样展示 clientInfo 值(面板 CSS 省略号截断,悬停看全)
  const name = String(raw).trim();
  return name ? name.slice(0, 80) : null;
}
function detectClientFromEnv() {
  const e = process.env;
  if (e.BRIDGE_CLIENT && e.BRIDGE_CLIENT.trim()) return e.BRIDGE_CLIENT.trim();
  if (e.CLAUDECODE || e.CLAUDE_CODE_ENTRYPOINT || e.CLAUDE_CODE_SESSION_ID) return 'Claude';
  if (e.CODEX_HOME || Object.keys(e).some(k => k.startsWith('CODEX_'))) return 'Codex';
  if (e.GEMINI_CLI || e.GEMINI_API_KEY || Object.keys(e).some(k => k.startsWith('GEMINI_'))) return 'Gemini';
  if (e.CURSOR_TRACE_ID || e.CURSOR_SESSION_ID) return 'Cursor';
  return 'unknown';
}
// 沿父进程链识别 agent(就近匹配)及其宿主(IDE/终端)。只在 client 启动时跑一次 ps(~30ms);Windows/无 ps 时返回空
const PROC_AGENTS = [[/joycode/i, 'JoyCode'], [/claude/i, 'Claude'], [/gemini/i, 'Gemini'], [/codex/i, 'Codex'],
  [/cursor/i, 'Cursor'], [/windsurf/i, 'Windsurf'], [/antigravity/i, 'Antigravity'], [/qoder/i, 'Qoder'],
  [/\btrae\b/i, 'Trae'], [/kiro/i, 'Kiro'], [/opencode/i, 'OpenCode']];
const PROC_HOSTS = [[/antigravity/i, 'Antigravity'], [/visual studio code|^code( helper)?/i, 'VSCode'], [/cursor/i, 'Cursor'],
  [/windsurf/i, 'Windsurf'], [/intellij|idea|pycharm|goland|webstorm|jetbrains/i, 'JetBrains'], [/iterm/i, 'iTerm2'],
  [/^terminal$/i, 'Terminal'], [/warp/i, 'Warp'], [/ghostty/i, 'Ghostty'], [/tmux/i, 'tmux'], [/joycode/i, 'JoyCode']];
function detectClientFromProcess() {
  if (process.platform === 'win32') return {};
  try {
    const procs = new Map();
    for (const l of execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 2000 }).split('\n')) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.set(+m[1], { ppid: +m[2], comm: m[3] });
    }
    // 标签:macOS 的 comm 是可执行文件全路径,优先取所属 .app 包名(JoyCode 的 sidecar 叫 codex-app-server,靠包名才认得出);
    // node/bun 等解释器跑的 CLI(npm 装的 claude/gemini)看 args 里的脚本路径
    const label = (pid, comm) => {
      const bundle = (comm.match(/\/([^/]+)\.app\//) || [])[1];
      if (bundle) return bundle;
      const base = path.basename(comm);
      if (!/^(node|bun|deno|python3?)$/i.test(base)) return base;
      try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim().split(/\s+/).slice(0, 3).join(' '); }
      catch { return base; }
    };
    let agent = null;
    let host = null;
    let p = procs.get(process.pid)?.ppid;
    for (let i = 0; i < 15 && p > 1 && procs.has(p) && !host; i++) {
      const l = label(p, procs.get(p).comm);
      if (!agent) {
        const hit = PROC_AGENTS.find(([re]) => re.test(l));
        if (hit) agent = hit[1];
      } else {
        const hit = PROC_HOSTS.find(([re]) => re.test(l));
        if (hit && hit[1] !== agent) host = hit[1];
      }
      p = procs.get(p).ppid;
    }
    return { agent, host };
  } catch { return {}; }
}
// 会话所在项目目录名(agent 一般以工作区为 cwd 拉起 MCP);在 home 或 / 时无意义,不报
function detectProject() {
  const cwd = process.cwd();
  return (cwd === os.homedir() || cwd === '/') ? '' : path.basename(cwd);
}
const STARTED_AT = Date.now();
// CLI 每条命令是一个新进程,会话 ID 必须跨进程稳定,否则每次调用都丢了 tab 绑定:
// 默认按 cwd 派生(同一项目目录里的连续命令共享绑定),BLT_SESSION 可显式指定(多个脚本并行各用各的 tab)
const SESSION_ID = IS_CLI
  ? (process.env.BLT_SESSION || `cli-${createHash('sha1').update(process.cwd()).digest('hex').slice(0, 10)}`)
  : `${process.pid}-${STARTED_AT}`;
const PROC_CLIENT = (IS_DAEMON || IS_CLI) ? {} : detectClientFromProcess(); // agent 仅作无 clientInfo 时兜底;host 供面板展示。CLI 名字固定,省掉同步 ps 遍历
// 握手前的兜底名;握手后由 upgradeClientName 换成 clientInfo
let BRIDGE_CLIENT = IS_CLI ? 'CLI' : ((process.env.BRIDGE_CLIENT || '').trim() || PROC_CLIENT.agent || detectClientFromEnv());
const BRIDGE_PROJECT = IS_DAEMON ? '' : detectProject();
// 会话身份头:随每次请求上报,daemon 据此维护会话表(面板展示)。header 只能 ASCII,中文目录名需编码
const sessionHeaders = () => ({
  'x-bridge-session': SESSION_ID,
  'x-bridge-client': encodeURIComponent(BRIDGE_CLIENT),
  'x-bridge-started': String(STARTED_AT),
  'x-bridge-host': PROC_CLIENT.host || '',
  'x-bridge-project': encodeURIComponent(BRIDGE_PROJECT),
  'x-bridge-client-info': encodeURIComponent(CLIENT_INFO), // 握手原始 clientInfo,仅供面板悬停排查
});
let CLIENT_INFO = ''; // 握手后填 "name/version"(如 JoyCode 报的是 codex-mcp-client/0.162.1)
const SESSION_STALE_MS = 25 * 1000; // 心跳容差:超过此时长无心跳/调用视为离线,从清单移除(=2.5个心跳周期)
const HEARTBEAT_MS = 10 * 1000;     // client 心跳间隔:定时上报在线
const ACTIVE_MS = 90 * 1000;        // 活跃阈值:此时长内有真实工具调用→绿点,否则灰点(连着但空闲)
// 扩展源码在同级 ../extension，热更新监听该目录
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXTENSION_DIR = path.resolve(BRIDGE_DIR, "..", "extension");
// 版本 + 构建戳(脚本 mtime):client 据此判断 daemon 是否比自己旧。二元组全序比较,不会两版互踢。
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })();
const BUILD = (() => { try { return Math.floor(fs.statSync(SCRIPT_PATH).mtimeMs); } catch { return 0; } })();

// ─── 版本一致性:桥 / 扩展 / skill 三端是否同代 ───
// 升级链路最大的坑不是"升级失败",而是"只升了一半却毫不知情":改完 bridge 忘了在浏览器点重载,
// 于是新桥调旧扩展,症状是"某个新工具报 unknown action"之类的怪事。下面几个函数把这种半升级状态显式化。

// 磁盘上扩展源码的最新改动时间(仅开发态有 extension/ 目录;npm 包里没有,返回 0 表示不可判)
let extMtimeCache = { at: 0, value: 0 };
function extDiskMtime() {
  if (Date.now() - extMtimeCache.at < 2000) return extMtimeCache.value; // 2s 缓存:/health 可能被高频轮询
  let max = 0;
  try {
    for (const f of fs.readdirSync(EXTENSION_DIR)) {
      if (!/\.(js|html|css|json)$/.test(f)) continue;
      try { max = Math.max(max, Math.floor(fs.statSync(path.join(EXTENSION_DIR, f)).mtimeMs)); } catch {}
    }
  } catch { max = 0; }
  extMtimeCache = { at: Date.now(), value: max };
  return max;
}

// 判定单个已连浏览器与本桥是否同代。返回 { state, detail }:
//   ok              两端同版本、且扩展跑的是磁盘上的最新代码
//   version-mismatch 扩展版本号与桥不一致 → 必须重载扩展(或桥没升上去)
//   stale-code      版本号一致,但磁盘源码比扩展实例新 → 改完代码忘了点重载
//   unknown         扩展太旧,hello 里压根没带版本字段 → 一定要重载
function browserVersionState(b) {
  if (!b.extVersion) return { state: 'unknown', detail: '扩展未上报版本(属 1.5.x 及更早),请重载扩展' };
  if (b.extVersion !== VERSION) {
    return { state: 'version-mismatch', detail: `扩展 v${b.extVersion} ≠ 桥 v${VERSION},请在 chrome://extensions 重载扩展` };
  }
  const disk = extDiskMtime();
  // 开发态(能看到磁盘源码)下没报加载时刻 = 扩展跑的是加此字段之前的代码,按 stale 报,别默认放行成 ok
  if (disk && !b.codeLoadedAt) {
    return { state: 'stale-code', detail: '扩展实例早于当前源码(未上报加载时刻),请在 chrome://extensions 重载扩展' };
  }
  if (disk && disk > b.codeLoadedAt) {
    const mins = Math.round((disk - b.codeLoadedAt) / 60000);
    const lag = mins >= 1 ? `比磁盘源码旧 ${mins} 分钟` : '比磁盘源码旧';
    return { state: 'stale-code', detail: `扩展实例${lag}(源码改动后没重载),请在 chrome://extensions 重载扩展` };
  }
  return { state: 'ok', detail: `扩展 v${b.extVersion} 与桥同代` };
}

// ─── tab 定向入参 schema 片段（工具级复用） ───
const BROWSER_PROP = {
  browser: { type: "string", description: "可选，多浏览器(Chrome/Edge/多个 profile)同时连接时指定目标浏览器：填 list_tabs 返回的 browser 值(或其名称片段，如 \"edge\")。缺省按 本会话上次用的浏览器 > 唯一已连浏览器 > 最近获得焦点的浏览器；带 tabId 时须与之同属一个浏览器" }
};
const TAB_TARGET_PROPS = {
  tabId: { type: "number", description: "可选，目标标签页 ID（多会话隔离时指定，优先级最高）。缺省时按 url_match 或当前活动 tab" },
  url_match: { type: "string", description: "可选，按 URL 子串匹配目标标签页。tabId 缺省时生效" },
  ...BROWSER_PROP
};

// ─── client → daemon 的 HTTP 转发(每次一个临时请求) ───
function proxyHttpRequest(urlPath, method = 'GET', body = null, timeout = 120000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: HTTP_PORT,
      path: urlPath,
      method,
      timeout,
      headers: { ...sessionHeaders(), ...extraHeaders },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy request timed out')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── 公共 MCP Tool 定义 ───
const TOOL_DEFINITIONS = [
  {
    name: "mcp_browser_snapshot",
    description: "获取目标标签页的完整HTML源码快照，包含动态渲染的页面最终状态。",
    inputSchema: { type: "object", properties: { ...TAB_TARGET_PROPS } }
  },
  {
    name: "mcp_browser_evaluate",
    description: "在目标标签页的控制台环境中执行任何合法的 JavaScript 脚本，并返回执行结果（转为字符串）。可用于深度DOM遍历、提取全局变量。",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "要执行的 JavaScript 语句" }, ...TAB_TARGET_PROPS },
      required: ["code"]
    }
  },
  {
    name: "mcp_browser_click",
    description: "根据 CSS 选择器，模拟点击目标页面上的特定元素（例如按钮或链接）。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "目标元素的标准 CSS 选择器" }, ...TAB_TARGET_PROPS },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_fill",
    description: "根据 CSS 选择器，找到输入框/文本框/contenteditable 元素并写入内容，自动派发 input/change 事件。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "输入框的 CSS 选择器" },
        value: { type: "string", description: "需要填入的文本" },
        ...TAB_TARGET_PROPS
      },
      required: ["selector", "value"]
    }
  },
  {
    name: "mcp_browser_navigate",
    description: "目标标签页导航:跳转 URL(默认)/后退/前进/刷新,默认等页面加载完成再返回(回报最终 url、title 与加载状态;超时不报错、如实回报 timeout)。SPA 路由跳转不触发整页加载,1.5s 内即返回,其后用 wait_for 等关键元素。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要跳转的完整 URL。action=goto 时必填;缺省且未给 action 时视为 reload" },
        action: { type: "string", enum: ["goto", "back", "forward", "reload"], description: "可选,默认 goto(有 url)/reload(无 url)" },
        bypass_cache: { type: "boolean", description: "可选,reload 时绕过缓存(硬刷新)" },
        wait: { type: "boolean", description: "可选,是否等加载完成,默认 true" },
        timeout: { type: "number", description: "可选,等加载的最长毫秒,默认 30000" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_new_tab",
    description: "在本会话当前 tab 所在窗口新开标签页(默认后台打开不抢焦点),并把本会话绑定到新 tab——之后不带 tabId 的调用都作用于它。用完 close_tab 关掉即还原到原 tab。适合不打扰用户当前页面地另开页面干活。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "可选,要打开的 URL;缺省开 about:blank" },
        active: { type: "boolean", description: "可选,是否切到前台,默认 false(后台打开)。截图前会自动激活,无需为截图设 true" },
        wait: { type: "boolean", description: "可选,有 url 时是否等加载完成,默认 true" },
        timeout: { type: "number", description: "可选,等加载的最长毫秒,默认 30000" },
        ...BROWSER_PROP
      }
    }
  },
  {
    name: "mcp_browser_close_tab",
    description: "关闭标签页。不带 tabId/url_match 时只关本会话经 new_tab 开出的当前绑定 tab(用户自己的页面会拒绝,防误关),关闭后本会话绑定还原到开 tab 前那个;显式带 tabId/url_match 则直接关闭该 tab。",
    inputSchema: { type: "object", properties: { ...TAB_TARGET_PROPS } }
  },
  {
    name: "mcp_browser_scrolling_screenshot",
    description: "截图并保存为文件、返回路径(可随后 Read 查看)。默认截当前可视区一屏;full_page=true 截整页(超长页截前 16384 设备像素);selector 截单个元素(先滚入视口)。后台 tab 会先被激活。",
    inputSchema: {
      type: "object",
      properties: {
        output_path: { type: "string", description: "可选,保存截图的绝对路径。默认 /tmp/screenshot_<timestamp>.<png|jpg>" },
        full_page: { type: "boolean", description: "可选,截整页(含视口外内容)" },
        selector: { type: "string", description: "可选,只截该元素(CSS 选择器)。可配合 frame 截 iframe 内元素" },
        format: { type: "string", enum: ["png", "jpeg"], description: "可选,默认 png;长页面用 jpeg 体积小得多" },
        quality: { type: "number", description: "可选,jpeg 质量 1-100,默认 80" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_drag",
    description: "拖拽元素:拖到另一个元素(target_selector)上,或按像素偏移(offset_x/offset_y,滑块/画布/调整尺寸)。mode=auto 时源元素在 [draggable=true] 内走 HTML5 拖放(合成 DragEvent+DataTransfer),否则走 CDP 真实鼠标按下-移动-松开(pointer 类拖拽库/滑块验证)。结果须用 get_element/outline/截图核实。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "被拖元素(拖拽把手)的 CSS 选择器" },
        target_selector: { type: "string", description: "放置目标元素的 CSS 选择器(与 offset_* 二选一)" },
        offset_x: { type: "number", description: "水平拖动距离(px,可负)" },
        offset_y: { type: "number", description: "垂直拖动距离(px,可负)" },
        steps: { type: "number", description: "可选,移动分几步,默认 10;有阈值/动画的拖拽库可调大" },
        hold_ms: { type: "number", description: "可选,到达终点后松开前停留毫秒,默认 0(某些库需要停顿才识别放置区)" },
        mode: { type: "string", enum: ["auto", "mouse", "html5"], description: "可选,默认 auto" },
        ...TAB_TARGET_PROPS
      },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_upload_file",
    description: "给 <input type=file> 设置本地文件(经 CDP,真实触发 input/change),替代无法自动化的系统文件选择框。selector 指向的不是 file input 时在其内部找;上传按钮常是隐藏 input 的包装,缺省用页面第一个 input[type=file]。设置后多数页面还要再点「上传/提交」。",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "本地文件路径数组(相对路径按 MCP 进程 cwd 解析,建议绝对路径)" },
        selector: { type: "string", description: "可选,file input(或其容器)的 CSS 选择器,默认 input[type=file]" },
        ...TAB_TARGET_PROPS
      },
      required: ["files"]
    }
  },
  {
    name: "mcp_browser_dialog",
    description: "处理 JS 弹窗(alert/confirm/prompt)。⭐ 预期操作会弹 confirm/alert/prompt 时,先设 mode=auto_accept/auto_dismiss(可带 prompt_text),再执行触发操作——弹窗被就地自动应答、页面不阻塞;策略随页面刷新自动重设,直到 off 或该 tab 离开设置时的站点(origin);用完请 off;log 查看自动应答过的弹窗(类型/文案/结果)。accept/dismiss 只能应答 CDP 接管期间弹出的弹窗:事先没设 auto_* 就弹出的原生弹窗会卡住页面(其它工具超时),Chrome 不允许事后远程应答,工具会报 page is blocked,此时请用户手动关掉弹窗,再设 auto_* 重做。",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["accept", "dismiss", "auto_accept", "auto_dismiss", "off", "log"], description: "accept/dismiss=应答当前已弹出的;auto_*=之后的自动应答;off=取消自动;log=看记录。默认 accept" },
        prompt_text: { type: "string", description: "可选,prompt 弹窗的输入值(accept / auto_accept 时用)" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_batch",
    description: "一次调用顺序执行多个浏览器工具,省掉多轮往返(如 fill 账号 → fill 密码 → click 登录 → wait_for 首页)。每步 {tool, args};tool 可省略 mcp_browser_ 前缀;另有伪步骤 {tool:\"sleep\", args:{ms}}。顶层 tabId/url_match/browser/frame 下发给未自带这些参数的步骤。默认遇错即停,返回逐步结果。不可嵌套 batch。",
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] },
          description: "步骤列表,如 [{\"tool\":\"fill\",\"args\":{\"selector\":\"#u\",\"value\":\"a\"}},{\"tool\":\"click\",\"args\":{\"selector\":\"#go\"}}]"
        },
        stop_on_error: { type: "boolean", description: "可选,某步出错是否停止,默认 true" },
        ...TAB_TARGET_PROPS
      },
      required: ["steps"]
    }
  },
  {
    name: "mcp_browser_connection_info",
    description: "只读诊断:返回桥(daemon/client)、各已连浏览器扩展、各客户端 skill 副本的版本与同代结论(verdict/problems),不操作任何页面。升级后确认是否生效、或工具行为诡异疑似版本不一致时先跑它。扩展没连上时同样可用。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "mcp_browser_list_tabs",
    description: "列出浏览器中所有打开的标签页（tabId/title/url/active/windowId）。用于多会话场景先获取 tabId 再定向操作。多个浏览器同时连接时，缺省列出全部浏览器的标签页，每项多带 browser/browserName 字段(后续调用把 browser 原样传回)；传 browser 只列该浏览器。",
    inputSchema: { type: "object", properties: { ...BROWSER_PROP } }
  },
  {
    name: "mcp_browser_activate_tab",
    description: "激活并聚焦指定的标签页（切换到该 tab）。",
    inputSchema: {
      type: "object",
      properties: { ...TAB_TARGET_PROPS },
    }
  },
  {
    name: "mcp_browser_wait_for",
    description: "等待目标页面上匹配 CSS 选择器的元素出现（可选可见性与文本匹配），用于异步渲染后再操作。超时返回错误。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "要等待的元素 CSS 选择器" },
        text: { type: "string", description: "可选，要求元素 textContent 包含该文本" },
        visible: { type: "boolean", description: "可选，是否要求元素可见，默认 true" },
        timeout: { type: "number", description: "可选，超时毫秒数，默认 10000" },
        ...TAB_TARGET_PROPS
      },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_get_storage",
    description: "读取目标页面的 localStorage 或 sessionStorage。传 key 读单项，否则返回全部键值 JSON。",
    inputSchema: {
      type: "object",
      properties: {
        storageType: { type: "string", enum: ["local", "session"], description: "存储类型，默认 local" },
        key: { type: "string", description: "可选，指定读取的键；缺省返回全部" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_set_storage",
    description: "向目标页面的 localStorage 或 sessionStorage 写入一个键值。",
    inputSchema: {
      type: "object",
      properties: {
        storageType: { type: "string", enum: ["local", "session"], description: "存储类型，默认 local" },
        key: { type: "string", description: "键名" },
        value: { type: "string", description: "值（字符串）" },
        ...TAB_TARGET_PROPS
      },
      required: ["key", "value"]
    }
  },
  {
    name: "mcp_browser_get_cookies",
    description: "读取指定 URL（默认当前 tab）的 Cookie 列表，可按 name 过滤。返回 name/value/domain/path 等。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "可选，指定 Cookie 所属 URL，缺省用目标 tab 的 URL" },
        name: { type: "string", description: "可选，按 Cookie 名过滤" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_download_url",
    description: "在目标 tab 内发起一次下载并等待写盘完成，返回文件在磁盘上的真实绝对路径（跨任意 Chromium 内核浏览器通用，无需猜下载目录）。两种用法：① 传 url —— 让浏览器直接下载该 URL（带页面登录态）；② 传 dataUrl —— 下载一段已拼好的内容（如页面内 fetch 得到的 JSON，先在 evaluate 里转成 data: URL）。可选 filename 指定保存文件名（仅文件名，落浏览器默认下载目录）。用于把大体量数据经磁盘交给本地脚本处理而不进模型。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要下载的 URL（http(s) 或 data: 均可）；与 dataUrl 二选一" },
        dataUrl: { type: "string", description: "可选，data: URL 形式的内容（与 url 二选一，等价写法）" },
        filename: { type: "string", description: "可选，保存的文件名（仅文件名，不含目录；缺省由浏览器定）" },
        timeoutMs: { type: "number", description: "可选，等待下载完成的超时毫秒数，默认 60000" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_set_cookies",
    description: "为指定 URL（默认当前 tab）设置一个 Cookie。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "可选，Cookie 所属 URL，缺省用目标 tab 的 URL" },
        name: { type: "string", description: "Cookie 名" },
        value: { type: "string", description: "Cookie 值" },
        path: { type: "string", description: "可选，路径" },
        domain: { type: "string", description: "可选，域名" },
        secure: { type: "boolean", description: "可选，是否 Secure" },
        httpOnly: { type: "boolean", description: "可选，是否 HttpOnly" },
        expirationDate: { type: "number", description: "可选，过期时间（Unix 秒）" },
        ...TAB_TARGET_PROPS
      },
      required: ["name", "value"]
    }
  },
  {
    name: "mcp_browser_outline",
    description: "返回页面【可交互元素精简清单】(按钮/链接/输入框/select/可点击项),纯文本每行一元素,格式 `[i] kind \"text\" [flags] @selector`——序号 i、类型 kind、可读文本 text、可选 [hidden]/[disabled] 标记、行尾 @ 后为可直接喂给 click/fill 的 selector。默认已过滤被 Modal/遮罩遮挡的底层元素(include_hidden=true 可保留)。相比 snapshot 极大节省 context,是定位元素、确定选择器的首选。默认只列可见元素、最多 200 条。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "可选,限定在某容器内(CSS 选择器),如只看某弹窗/表单" },
        include_hidden: { type: "boolean", description: "可选,是否包含隐藏元素,默认 false" },
        max_items: { type: "number", description: "可选,最多返回条数,默认 200" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_get_element",
    description: "读取单个元素的状态或属性。不传 attr 返回 JSON(tag/text/value/visible/disabled/rect),用于点击前探测元素是否存在可见可点;传 attr('value'/'text'/'html'/或任意属性名)只取该项。用于验证操作结果、读回填值。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "目标元素 CSS 选择器" },
        attr: { type: "string", description: "可选,要读的属性:value/text/html 或任意 HTML 属性名;缺省返回状态 JSON" },
        ...TAB_TARGET_PROPS
      },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_select_option",
    description: "为原生 <select> 下拉框选中一个选项,自动派发 input/change 事件。默认按 option 的 value 匹配;by_label=true 时按可见文本匹配。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "<select> 元素的 CSS 选择器" },
        value: { type: "string", description: "要选中的值(默认匹配 option value;by_label 时匹配显示文本)" },
        by_label: { type: "boolean", description: "可选,为 true 时按选项显示文本匹配而非 value" },
        ...TAB_TARGET_PROPS
      },
      required: ["selector", "value"]
    }
  },
  {
    name: "mcp_browser_press_key",
    description: "按键:优先走 CDP 真实键盘输入(能真正录入字符、触发浏览器默认行为如 Tab 真实移焦),DevTools 占用等情况自动降级为合成事件。用于回车提交、Tab 切换、Esc 关弹窗、方向键、逐字符输入触发联想。selector 缺省则作用于 document.activeElement。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "键名:Enter/Tab/Escape/Backspace/Delete/Space/ArrowUp/ArrowDown/ArrowLeft/ArrowRight/Home/End/PageUp/PageDown 或单个字符" },
        selector: { type: "string", description: "可选,目标元素 CSS 选择器;缺省作用于当前焦点元素" },
        ...TAB_TARGET_PROPS
      },
      required: ["key"]
    }
  },
  {
    name: "mcp_browser_hover",
    description: "把鼠标悬停到某元素上(派发 pointerover/mouseover/mouseenter/mousemove)。用于触发 hover 才展开的下拉菜单、tooltip、悬浮操作按钮。注意:只触发 JS 监听,不触发 CSS :hover 伪类——纯 CSS 实现的菜单(.menu:hover>.panel)展不开,此类菜单请改用 evaluate 直接改样式或读取隐藏节点。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "目标元素 CSS 选择器" }, ...TAB_TARGET_PROPS },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_scroll_to",
    description: "把某元素滚动到视口中央(scrollIntoView)。用于操作懒加载/长列表中当前不在视口的元素前先滚动到位。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "目标元素 CSS 选择器" }, ...TAB_TARGET_PROPS },
      required: ["selector"]
    }
  },
  {
    name: "mcp_browser_get_console",
    description: "读取页面 console 日志与运行时报错(log/info/warn/error/debug + window.onerror + unhandledrejection)。⚠️ 首次调用只安装捕获钩子并返回 installed:true(此前的日志抓不到),需在触发操作后【再次调用】才拿到日志。clear=true 读完清空缓存。",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "可选,读取后清空缓存,默认 false" },
        max_items: { type: "number", description: "可选,最多返回最近 N 条,默认 100" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_get_network",
    description: "读取页面发出的 fetch/XHR 请求记录(method/url/status/耗时ms)。⚠️ 首次调用只安装捕获钩子并返回 installed:true(此前的请求抓不到),需在触发操作后【再次调用】才拿到记录。with_body=true 附带响应体(默认前 1000 字符,可用 max_body 调大)。with_headers=true 附带请求/响应头(reqHeaders/resHeaders),逆向对比缺失头时用。clear=true 读完清空。with_body/with_headers/max_body 支持在读取时按需开启,无需重装钩子。",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "可选,读取后清空缓存,默认 false" },
        with_body: { type: "boolean", description: "可选,是否附带响应体片段,默认 false" },
        with_headers: { type: "boolean", description: "可选,是否附带请求/响应头(reqHeaders/resHeaders),默认 false" },
        max_body: { type: "number", description: "可选,响应体截断字符数,默认 1000" },
        max_items: { type: "number", description: "可选,最多返回最近 N 条,默认 50" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_js_grep",
    description: "【逆向用】在页面已加载的 JS 源码(外部 script + 内联 script)里搜字符串/正则,定位某个值/参数的生成逻辑来源(如从 URL 参数反查它怎么被算出来)。默认只回命中片段(行号+列号+来源 url+上下文),绝不回全文,省 token 不压桥。download=true 则把匹配到的 bundle(或指定 sources)落盘返回磁盘路径,交本地脚本处理大文件。bundle 多/大时可用 sources 限定脚本 url 子串缩小范围。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜的字符串或正则源(必填;仅当 download=true 且指定 sources 时可省略)" },
        regex: { type: "boolean", description: "可选,pattern 当正则处理(默认 false,按纯字符串)" },
        context: { type: "number", description: "可选,每个命中返回的上下文字符数,默认 80" },
        max_hits: { type: "number", description: "可选,最多返回命中数,默认 30" },
        sources: { type: "string", description: "可选,只搜 url 含该子串的脚本(缩小范围、规避超时)" },
        download: { type: "boolean", description: "可选,为 true 时把命中(或 sources 限定)的 JS 落盘并返回磁盘路径" },
        filename: { type: "string", description: "可选,download 时的落盘文件名" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_inspect_element",
    description: "取证单个元素(插件开发用):传 selector 或 x/y 坐标，返回该元素的多种候选 CSS selector(按稳定性排序:#id > [name] > [data-*] > .class > nth-of-type 路径)、关键属性(id/class/name/data-*/role/href 等)、文本、value、可见性、rect、祖先链、直接子元素概览。写扩展代码定位元素时用。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "目标元素 CSS 选择器(与 x/y 二选一)" },
        x: { type: "number", description: "视口坐标 X(用 elementFromPoint 取该点元素，与 selector 二选一)" },
        y: { type: "number", description: "视口坐标 Y" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_pick_element",
    description: "点选取证(需用户在浏览器亲手点鼠标，agent 无法代劳):首次调用注入高亮遮罩并进入点选模式，返回 picking:true；用户在页面点中某元素(或 Esc 取消)后，再次调用本工具读取被点元素的候选 selector + 属性。传 cancel:true 主动退出点选模式。适合让用户指认一个 agent 难以描述的元素。",
    inputSchema: {
      type: "object",
      properties: {
        cancel: { type: "boolean", description: "可选，为 true 时退出点选模式、清理遮罩" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_dom_tree",
    description: "返回页面【DOM 结构骨架树】(插件开发用):带层级缩进，每节点显示 tag#id.class[data-*] + 子节点数(可选文本)。超长同类兄弟折叠为 tag ×N。用于看清页面整体结构，区别于 outline(只列可交互元素+可操作 selector)。默认根 body、深度 8、最多 300 节点。",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "可选，根容器 CSS 选择器，默认 body" },
        max_depth: { type: "number", description: "可选，最大深度，默认 8" },
        max_nodes: { type: "number", description: "可选，最大节点数，默认 300" },
        include_text: { type: "boolean", description: "可选，是否附带节点自身文本，默认 false" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_detect_env",
    description: "探测页面 JS 技术环境(插件开发用):识别前端框架及版本(React/Vue/jQuery/ExtJS/Angular/Backbone/d3/ECharts 等)、列出 window 上的自定义全局变量及类型、页面编码/doctype/script 数量与来源域。帮 agent 理解目标站点技术栈，决定插件怎么写。",
    inputSchema: { type: "object", properties: { ...TAB_TARGET_PROPS } }
  },
  {
    name: "mcp_browser_arthas_exec",
    description: "在已打开的 Arthas Web Console(xterm.js 终端)网页中投递一条 Arthas 命令并执行,自动等待命令跑完后采集本次输出的纯文本返回。用于让 AI 远程诊断 Java 应用(thread/watch/trace/jad/ognl/sc/sm 等)。完成判定:终端输出静默且尾部出现 Arthas 提示符。注意:命令会真实在目标 JVM 上执行,危险命令(stop/reset/redefine)请在调用前人工确认。",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 Arthas 命令,如 'version'、'thread'、'sc *ChaseMoney*'" },
        timeout: { type: "number", description: "可选,命令最长等待毫秒数,默认 60000" },
        idle_ms: { type: "number", description: "可选,终端输出连续无变化多久(毫秒)视为完成,默认 800" },
        read_only: { type: "boolean", description: "可选,为 true 时不投递命令,仅采集当前终端 buffer 全文(用于探活/校准)" },
        interrupt: { type: "boolean", description: "可选,为 true 时只发 Ctrl+C 中断当前前台命令(如卡住的 trace/watch),不投递新命令。command 可留空" },
        snapshot: { type: "boolean", description: "可选,全屏/刷新型命令(dashboard 等)用:发命令→等一帧渲染→自动 Ctrl+C 中断→返回最后一帧屏幕快照。默认模式已能自动识别全屏命令,通常无需手动传此项" },
        render_wait: { type: "number", description: "可选,snapshot 模式等待一帧渲染完成的毫秒数,默认 2500" },
        auto_snapshot_ms: { type: "number", description: "可选,全屏刷新自动检测阈值:命令持续输出且始终等不到静默提示符达此毫秒数,则判定为刷新型命令自动中断取最后一帧,默认 4000" },
        ...TAB_TARGET_PROPS
      }
    }
  }
];

// iframe 定向:元素/页面内容类工具统一追加 frame 参数(扩展侧 resolveFrameId 解析)
const FRAME_PROP = { type: "string", description: "可选,在 iframe 内操作:iframe 元素的 CSS 选择器(如 \"#main-frame\")、frame URL 子串,或数字 frameId。缺省=顶层页面。outline 末尾会列出页面上的 iframe" };
const FRAME_TOOLS = new Set(['snapshot', 'evaluate', 'click', 'fill', 'wait_for', 'outline', 'get_element', 'select_option', 'press_key', 'hover', 'scroll_to', 'inspect_element', 'dom_tree', 'detect_env', 'get_console', 'get_network', 'get_storage', 'set_storage', 'drag', 'upload_file', 'scrolling_screenshot', 'batch'].map(n => 'mcp_browser_' + n));
for (const d of TOOL_DEFINITIONS) if (FRAME_TOOLS.has(d.name)) d.inputSchema.properties.frame = FRAME_PROP;

// ─── 工具 → HTTP 路由 + 载荷映射 ───
// bodyFn 接收 args，返回请求体字符串（GET 返回 null）
function pickTabTargets(args) {
  const t = {};
  if (args.tabId != null) t.tabId = args.tabId;
  if (args.url_match != null) t.url_match = args.url_match;
  if (args.browser != null && String(args.browser).trim()) t.browser = String(args.browser).trim(); // daemon 消费,不下发扩展
  if (args.frame != null && String(args.frame).trim()) t.frame = String(args.frame).trim();
  return t;
}

// upload_file 的路径在 client 侧解析:扩展/浏览器不知道 agent 的 cwd,且提前查不存在比 CDP 报错直白
function resolveUploadFiles(files) {
  const list = Array.isArray(files) ? files : (files ? [files] : []);
  if (!list.length) throw new Error('files must be a non-empty array of file paths');
  return list.map((f) => {
    const p = path.resolve(String(f).replace(/^~(?=$|\/)/, os.homedir()));
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`file not found: ${p}`); }
    if (!st.isFile()) throw new Error(`not a regular file: ${p}`);
    return p;
  });
}

const TOOL_ROUTES = {
  mcp_browser_snapshot: { path: '/snapshot', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets(a)) },
  mcp_browser_evaluate: { path: '/eval', method: 'POST', bodyFn: (a) => JSON.stringify({ code: a.code, ...pickTabTargets(a) }) },
  mcp_browser_click: { path: '/click', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_fill: { path: '/fill', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, value: a.value, ...pickTabTargets(a) }) },
  mcp_browser_navigate: { path: '/navigate', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, nav_action: a.action, bypass_cache: a.bypass_cache, wait: a.wait, timeout: a.timeout, ...pickTabTargets(a) }) },
  mcp_browser_new_tab: { path: '/new_tab', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, active: a.active, wait: a.wait, timeout: a.timeout, ...pickTabTargets({ browser: a.browser }) }) },
  mcp_browser_close_tab: { path: '/close_tab', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets(a)) },
  mcp_browser_drag: { path: '/drag', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, target_selector: a.target_selector, offset_x: a.offset_x, offset_y: a.offset_y, steps: a.steps, hold_ms: a.hold_ms, mode: a.mode, ...pickTabTargets(a) }) },
  mcp_browser_upload_file: { path: '/upload_file', method: 'POST', bodyFn: (a) => JSON.stringify({ files: resolveUploadFiles(a.files), selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_dialog: { path: '/dialog', method: 'POST', bodyFn: (a) => JSON.stringify({ mode: a.mode, prompt_text: a.prompt_text, ...pickTabTargets(a) }) },
  mcp_browser_list_tabs: { path: '/list_tabs', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets({ browser: a.browser })) },
  mcp_browser_activate_tab: { path: '/activate_tab', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets(a)) },
  mcp_browser_wait_for: { path: '/wait_for', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, text: a.text, visible: a.visible, timeout: a.timeout, ...pickTabTargets(a) }) },
  mcp_browser_get_storage: { path: '/get_storage', method: 'POST', bodyFn: (a) => JSON.stringify({ storageType: a.storageType, key: a.key, ...pickTabTargets(a) }) },
  mcp_browser_set_storage: { path: '/set_storage', method: 'POST', bodyFn: (a) => JSON.stringify({ storageType: a.storageType, key: a.key, value: a.value, ...pickTabTargets(a) }) },
  mcp_browser_get_cookies: { path: '/get_cookies', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, name: a.name, ...pickTabTargets(a) }) },
  mcp_browser_download_url: { path: '/download', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url || a.dataUrl, filename: a.filename, timeoutMs: a.timeoutMs, ...pickTabTargets(a) }) },
  mcp_browser_set_cookies: { path: '/set_cookies', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, name: a.name, value: a.value, path: a.path, domain: a.domain, secure: a.secure, httpOnly: a.httpOnly, expirationDate: a.expirationDate, ...pickTabTargets(a) }) },
  mcp_browser_outline: { path: '/outline', method: 'POST', bodyFn: (a) => JSON.stringify({ scope: a.scope, include_hidden: a.include_hidden, max_items: a.max_items, ...pickTabTargets(a) }) },
  mcp_browser_get_element: { path: '/get_element', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, attr: a.attr, ...pickTabTargets(a) }) },
  mcp_browser_select_option: { path: '/select_option', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, value: a.value, by_label: a.by_label, ...pickTabTargets(a) }) },
  mcp_browser_press_key: { path: '/press_key', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, key: a.key, ...pickTabTargets(a) }) },
  mcp_browser_hover: { path: '/hover', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_scroll_to: { path: '/scroll_to', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_get_console: { path: '/get_console', method: 'POST', bodyFn: (a) => JSON.stringify({ clear: a.clear, max_items: a.max_items, ...pickTabTargets(a) }) },
  mcp_browser_get_network: { path: '/get_network', method: 'POST', bodyFn: (a) => JSON.stringify({ clear: a.clear, with_body: a.with_body, with_headers: a.with_headers, max_body: a.max_body, max_items: a.max_items, ...pickTabTargets(a) }) },
  mcp_browser_js_grep: { path: '/js_grep', method: 'POST', bodyFn: (a) => JSON.stringify({ pattern: a.pattern, regex: a.regex, context: a.context, max_hits: a.max_hits, sources: a.sources, download: a.download, filename: a.filename, ...pickTabTargets(a) }) },
  mcp_browser_inspect_element: { path: '/inspect_element', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, x: a.x, y: a.y, ...pickTabTargets(a) }) },
  mcp_browser_pick_element: { path: '/pick_element', method: 'POST', bodyFn: (a) => JSON.stringify({ cancel: a.cancel, ...pickTabTargets(a) }) },
  mcp_browser_dom_tree: { path: '/dom_tree', method: 'POST', bodyFn: (a) => JSON.stringify({ scope: a.scope, max_depth: a.max_depth, max_nodes: a.max_nodes, include_text: a.include_text, ...pickTabTargets(a) }) },
  mcp_browser_detect_env: { path: '/detect_env', method: 'POST', bodyFn: (a) => JSON.stringify({ ...pickTabTargets(a) }) },
  mcp_browser_arthas_exec: { path: '/arthas_exec', method: 'POST', bodyFn: (a) => JSON.stringify({ command: a.command, timeout: a.timeout, idle_ms: a.idle_ms, read_only: a.read_only, interrupt: a.interrupt, snapshot: a.snapshot, render_wait: a.render_wait, auto_snapshot_ms: a.auto_snapshot_ms, ...pickTabTargets(a) }) },
};

// HTTP action 名 → chrome action 名
const HTTP_ACTION_MAP = {
  '/snapshot': 'snapshot',
  '/eval': 'evaluate',
  '/click': 'click',
  '/fill': 'fill',
  '/navigate': 'navigate',
  '/new_tab': 'new_tab',
  '/close_tab': 'close_tab',
  '/drag': 'drag',
  '/upload_file': 'upload_file',
  '/dialog': 'dialog',
  '/scrolling_screenshot': 'scrolling_screenshot',
  '/list_tabs': 'list_tabs',
  '/activate_tab': 'activate_tab',
  '/wait_for': 'wait_for',
  '/inspect_element': 'inspect_element',
  '/pick_element': 'pick_element',
  '/dom_tree': 'dom_tree',
  '/detect_env': 'detect_env',
  '/outline': 'outline',
  '/get_element': 'get_element',
  '/select_option': 'select_option',
  '/press_key': 'press_key',
  '/hover': 'hover',
  '/scroll_to': 'scroll_to',
  '/get_console': 'get_console',
  '/get_network': 'get_network',
  '/js_grep': 'js_grep',
  '/get_storage': 'get_storage',
  '/set_storage': 'set_storage',
  '/get_cookies': 'get_cookies',
  '/download': 'download',
  '/set_cookies': 'set_cookies',
  '/arthas_exec': 'arthas_exec',
  '/get_current_tab': 'get_current_tab',
};

// ─── 读 daemon /health(daemon 启动探活与 client 调用前校验共用) ───
// macOS 双栈下 IPv6/IPv4 同端口不报 EADDRINUSE，盲听会裂脑；启动前先探活兜底。
// 用内置 http 模块而非 fetch，兼容 Node 16(fetch/AbortSignal.timeout 在 16 不可用)。
// 短超时:daemon 挂起(如被 SIGSTOP)时快速失败,别让每次调用卡 120s。
// 返回 { state, health }:state='daemon'=本工具 daemon 就位 | 'foreign'=端口被陌生服务占用 | 'none'=无人应答/超时
function fetchHealth(timeout = 1500) {
  return new Promise((resolve) => {
    const done = (state, health = null) => resolve({ state, health });
    const req = http.request(
      { hostname: '127.0.0.1', port: HTTP_PORT, path: '/health', method: 'GET', timeout,
        headers: sessionHeaders() },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          // 探活响应本应很小；陌生服务撞端口回超大 body 时截断防吃内存
          if (data.length > 65536) { res.destroy(); done('foreign'); }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) { done('foreign'); return; }
          try {
            const j = JSON.parse(data);
            // 指纹 + 端口双校验，确认对端确是本工具而非撞端口的陌生服务
            // 指纹只认 service+端口这类永不改的字段:多认一个字段,将来该字段一改,旧 client 就会把新 daemon 当外人
            if (j.service === 'browser-link-tool' && j.wsPort === WS_PORT && j.httpPort === HTTP_PORT) {
              done('daemon', j);
            } else {
              done('foreign'); // 有人应答但不是本工具
            }
          } catch { done('foreign'); }
        });
      }
    );
    req.on('error', () => done('none')); // 拒连=端口空闲
    req.on('timeout', () => { req.destroy(); done('none'); });
    req.end();
  });
}

// ─── 原子绑定:WS(48765) 与 HTTP(48766) 全绑成功才算 daemon 就位 ───
// 任一端口失败 → 回滚关闭已绑 server,daemon 退出让先到者当家,绝不半绑。
function bindPortAtomic(server, port) {
  return new Promise((resolve) => {
    const onError = () => resolve(false); // EADDRINUSE 等一律降级
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(true);
    });
  });
}

// ─── daemon 完整逻辑 ───
// wssHttpServer(48765)、httpServer(48766) 均已由 bindDaemonPorts 原子绑定成功后传入。
function setupDaemon(wssHttpServer, httpServer, onShutdown) {
  // maxPayload 提到 512MB:大页面 snapshot / eval 大对象可能超 ws 默认 100MB 上限，
  // 否则会触发 1009 错误。配合下方 ws.on('error') 兜底，双重防崩。
  const wss = new WebSocketServer({ server: wssHttpServer, maxPayload: 512 * 1024 * 1024 });

  // 运行期 error 监听:bindPortAtomic 成功后移除了绑定期的临时监听器，
  // 若不重挂，运行时 socket 错误(ECONNRESET/EMFILE 等)会因 'error' 无监听器直接 throw 崩溃主进程。
  wssHttpServer.on('error', (err) => console.error(`[bridge] WS server runtime error: ${err.message}`));
  httpServer.on('error', (err) => console.error(`[bridge] HTTP server runtime error: ${err.message}`));

  const daemonSince = Date.now();
  const pendingRequests = new Map(); // msgId -> { resolve, entry }
  let currentId = 1;

  // ─── 浏览器注册表:每个扩展连接一条,Chrome/Edge/多个 profile 可同时在线 ───
  // key=browserId:扩展 hello 上报的 per-profile 持久随机 id(未 hello 的连接不登记)。
  const browsers = new Map();       // id -> { id, name, brand, ws, connectedAt, focused, lastFocusAt }
  const sessionBrowser = new Map(); // sessionId -> browserId:会话粘在上次用的浏览器(同扩展侧"会话粘 tab")
  // sessionId -> Map(tabId -> [browserId]):该会话最近一次合并 list_tabs 的结果。各浏览器 tabId 独立编号会撞号,
  // 带 tabId 不带 browser 时按它路由;撞号则报歧义让调用方补 browser,绝不猜
  const sessionTabIndex = new Map();
  const liveBrowsers = () => [...browsers.values()].filter(b => b.ws.readyState === 1);
  const sanitizeId = (s) => String(s || '').replace(/[^\w-]/g, '').slice(0, 32);

  // 显式 browser 参数:id/名称精确匹配优先,再按名称/品牌片段唯一匹配
  function matchBrowser(sel) {
    const live = liveBrowsers();
    const s = String(sel).toLowerCase();
    const exact = live.filter(b => b.id.toLowerCase() === s || b.name.toLowerCase() === s);
    if (exact.length === 1) return { b: exact[0] };
    const fuzzy = live.filter(b => b.name.toLowerCase().includes(s) || b.brand.toLowerCase().includes(s));
    if (fuzzy.length === 1) return { b: fuzzy[0] };
    const list = (fuzzy.length ? fuzzy : live).map(b => `${b.id}(${b.name})`).join(', ') || 'none';
    return { error: fuzzy.length ? `browser "${sel}" is ambiguous, matches: ${list}` : `browser "${sel}" not connected; connected browsers: ${list}` };
  }
  // 缺省选择顺序:本会话上次用的 > 当前有焦点 > 最近获得焦点 > 最近连上
  function rankedBrowsers(sid) {
    const live = liveBrowsers().sort((a, b) =>
      (b.focused - a.focused) || (b.lastFocusAt - a.lastFocusAt) || (b.connectedAt - a.connectedAt));
    const bound = live.find(b => b.id === sessionBrowser.get(sid));
    return bound ? [bound, ...live.filter(b => b !== bound)] : live;
  }
  const TAB_NOT_FOUND_RE = /Tab \S+ not found|No tab matching url|No tab with id/;

  function actionTimeout(action, payload) {
    if (action === 'scrolling_screenshot') return 120000;
    if (action === 'wait_for' || action === 'js_grep') return 65000;
    if (action === 'arthas_exec') return Math.max((payload.timeout || 60000) + 5000, 65000);
    if (action === 'download') return Math.max((payload.timeoutMs || 60000) + 5000, 65000);
    if (action === 'navigate' || action === 'new_tab') return (Number(payload.timeout) || 30000) + 5000;
    // upload_file 扩展侧 CDP 超时累计 10+10+15s,daemon 必须更长,否则先报超时、扩展却仍把文件设上,agent 重试即重复上传
    if (action === 'upload_file') return 45000;
    if (action === 'drag' || action === 'dialog') return 30000;
    return 15000;
  }
  // 超时的最常见隐因:页面弹着 alert/confirm,JS 被阻塞、注入脚本挂住。直接把出路写进报错
  const TIMEOUT_HINT = ' — if the page may be showing a native JS dialog (alert/confirm/prompt), it blocks the page and cannot be answered remotely after the fact: ask the user to close it, then call mcp_browser_dialog mode=auto_accept/auto_dismiss BEFORE repeating the action';
  // 向某个浏览器下发一条 action,resolve 扩展回包(超时/断连也 resolve 成 {error},不 reject)
  function dispatch(b, action, payload, sid) {
    return new Promise((resolve) => {
      const id = currentId++;
      const timer = setTimeout(() => {
        if (pendingRequests.delete(id)) resolve({ error: "Request timed out" + (action === 'arthas_exec' || action === 'dialog' ? '' : TIMEOUT_HINT), __status: 504 });
      }, actionTimeout(action, payload));
      pendingRequests.set(id, { entry: b, resolve: (r) => { clearTimeout(timer); resolve(r); } });
      // __session 随 action 下发扩展,供扩展按会话维度绑定/解析目标 tab(每会话独立)
      try { b.ws.send(JSON.stringify({ action, id, __session: sid, ...payload })); }
      catch (e) { pendingRequests.delete(id); clearTimeout(timer); resolve({ error: `send to ${b.id} failed: ${e.message}`, __status: 503 }); }
    });
  }

  // ─── 会话表:sessionId -> {client, pid, startedAt, lastSeen, lastCallAt, calls} ───
  // lastSeen=最近任意上报(含心跳)→ 判在线;lastCallAt=最近真实工具调用 → 判活跃(绿/灰)。
  // daemon 自身不是 agent 会话,不入表;只登记各 client。
  const sessions = new Map();
  let lastClientSeenAt = Date.now(); // 供 daemon 空闲自退判断
  // 读请求 header 更新会话表。countCall=true 时累加调用次数并刷新 lastCallAt(仅业务路由;health/ping 不计)。
  const touchSession = (req, countCall) => {
    const sid = req.headers['x-bridge-session'];
    if (!sid) return;
    const now = Date.now();
    lastClientSeenAt = now;
    // client 名规范化(claude-code→Claude 等);client 对原值 URI 编码(clientInfo 可能含中文)
    const dec = (h) => { try { return decodeURIComponent(String(req.headers[h] || '')).slice(0, 80) || null; } catch { return null; } };
    const clientRaw = dec('x-bridge-client');
    const client = clientRaw === 'unknown' ? null : normalizeClientName(clientRaw); // null = 无有效名
    const host = dec('x-bridge-host');
    const project = dec('x-bridge-project');
    const clientInfo = dec('x-bridge-client-info');
    const prev = sessions.get(sid);
    if (prev) {
      prev.lastSeen = now;
      if (client) prev.client = client; // 仅在拿到有效名时覆盖,避免把已升级的名打回 unknown
      if (host) prev.host = host;
      if (project) prev.project = project;
      if (clientInfo) prev.clientInfo = clientInfo;
      if (countCall) { prev.calls++; prev.lastCallAt = now; }
    } else {
      // startedAt 合理性校验:非法/未来/超 30 天前一律回退 now,防面板显示错乱的接入时长
      const raw = Number(req.headers['x-bridge-started']);
      const startedAt = (Number.isFinite(raw) && raw <= now && raw >= now - 30 * 86400 * 1000) ? raw : now;
      sessions.set(sid, {
        client,
        host,
        project,
        clientInfo,
        pid: Number(String(sid).split('-')[0]) || 0,
        startedAt,
        lastSeen: now,
        lastCallAt: countCall ? now : 0,
        calls: countCall ? 1 : 0,
      });
    }
  };

  httpServer.on('request', (req, res) => {
    const url = req.url;

    // 防网页跨站调用:任意网站都能向 127.0.0.1 发 no-cors POST(如 /eval 执行任意 JS、读 Cookie)。
    // 浏览器发起的跨源 POST 必带 Origin;本工具 client 是 Node、不带 Origin;扩展 popup 只 GET /health。
    // 故除 /health 外:必须 POST,且 Origin 若存在只认 chrome-extension://。
    if (url !== '/health') {
      const origin = req.headers.origin;
      if (req.method !== 'POST' || (origin && !String(origin).startsWith('chrome-extension://'))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: browser-link-tool only accepts local POST from its own clients' }));
        return;
      }
    }

    // 每个请求登记会话在线;/health(popup轮询)和 /session_ping(心跳)不算"调用"
    touchSession(req, url !== '/health' && url !== '/session_ping' && url !== '/shutdown');

    const handleBrowserAction = async (action, payload = {}) => {
      const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const sid = req.headers['x-bridge-session'] || SESSION_ID;
      const { browser: sel, ...rest } = payload;
      const live = liveBrowsers();
      if (live.length === 0) return reply(503, { error: "No Chrome Extension connected" });
      const multi = live.length > 1;
      const s = sessions.get(sid);

      let picked = null;
      if (sel) {
        const m = matchBrowser(sel);
        if (m.error) return reply(200, { error: m.error });
        picked = m.b;
      }

      // list_tabs 多浏览器且未指定:并发拉全部浏览器,每项标注所属浏览器
      if (action === 'list_tabs' && multi && !picked) {
        const all = [];
        const errs = [];
        await Promise.all(live.map(async (b) => {
          const r = await dispatch(b, 'list_tabs', rest, sid);
          if (r.error) { errs.push(`${b.id}: ${r.error}`); return; }
          try { for (const t of JSON.parse(r.result)) all.push({ ...t, browser: b.id, browserName: b.name }); } catch {}
        }));
        if (!all.length && errs.length) return reply(200, { error: errs.join('; ') });
        const idx = new Map();
        for (const t of all) idx.set(t.tabId, [...(idx.get(t.tabId) || []), t.browser]);
        sessionTabIndex.set(sid, idx);
        return reply(200, { result: JSON.stringify(all) });
      }

      // 显式 tabId/url_match 但没指明浏览器、首选浏览器里找不到该 tab → 依次试其余浏览器
      // (找不到 tab 时扩展在 resolveTab 阶段即报错、action 未执行,重试无副作用)
      if (!picked && multi && rest.tabId != null) {
        const owners = (sessionTabIndex.get(sid)?.get(Number(rest.tabId)) || []).filter(id => browsers.has(id));
        if (owners.length > 1) return reply(200, { error: `tabId ${rest.tabId} exists in multiple browsers (${owners.join(', ')}); pass browser to disambiguate` });
        if (owners.length === 1) picked = browsers.get(owners[0]);
      }
      const candidates = picked ? [picked] : rankedBrowsers(sid);
      const retryable = !picked && multi && (rest.tabId != null || rest.url_match != null);
      let b = null;
      let r = null;
      for (const cand of (retryable ? candidates : candidates.slice(0, 1))) {
        b = cand;
        r = await dispatch(b, action, rest, sid);
        if (!(retryable && r && typeof r.error === 'string' && TAB_NOT_FOUND_RE.test(r.error))) break;
      }
      if (!(r && typeof r.error === 'string' && TAB_NOT_FOUND_RE.test(r.error))) sessionBrowser.set(sid, b.id);

      if (action === 'list_tabs' && multi && r && r.result) {
        try { r = { ...r, result: JSON.stringify(JSON.parse(r.result).map(t => ({ ...t, browser: b.id, browserName: b.name }))) }; } catch {}
      }
      // 扩展回传本次实际操作的 tab → 更新会话表,面板显示真实 tab 而非笼统"活动标签页"
      const rt = r && r.__resolvedTab;
      if (s && rt) { s.lastTabId = rt.tabId; s.lastTabTitle = rt.title || null; }
      if (s) s.lastBrowser = multi ? b.name : null;
      const status = (r && r.__status) || 200;
      if (r) delete r.__status;
      reply(status, r);
    };

    const readBody = (cb) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        let parsed = {};
        if (body) { try { parsed = JSON.parse(body); } catch (e) { parsed = {}; } }
        cb(parsed);
      });
    };

    if (url === "/session_ping") {
      // client 心跳:touchSession 已在入口刷新 lastSeen,这里直接回 200
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    if (url === "/shutdown") {
      // 新版 client 发现本 daemon 版本旧时请求退出,随后由它拉起新版;手动重启 daemon 也走这里。
      // 带 x-bridge-target-pid 时只认自己:升级瞬间多个新 client 都读到旧 daemon 的 health,
      // 晚到的 shutdown 会落到刚被拉起的新 daemon 上,不校验就把新 daemon 也踢掉了
      const target = req.headers['x-bridge-target-pid'];
      if (target && String(target) !== String(process.pid)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `pid mismatch: target ${target}, self ${process.pid}` }));
        return;
      }
      console.error(`[bridge] shutdown requested by session ${req.headers['x-bridge-session'] || '?'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      setTimeout(() => onShutdown(), 50);
      return;
    }

    if (url === "/health") {
      // popup 探活/client 探活都打这里。若带会话 header 则刷新其在线状态
      const now = Date.now();
      // 回收僵尸会话:超期条目直接从 Map 删除(否则退出的进程/外部客户端会永久累积 → 内存泄漏)
      for (const [sid, s] of sessions) {
        if (now - s.lastSeen > SESSION_STALE_MS) { sessions.delete(sid); sessionBrowser.delete(sid); sessionTabIndex.delete(sid); }
      }
      const onlineSessions = [...sessions.values()]
        .filter(s => now - s.lastSeen <= SESSION_STALE_MS) // 心跳在→在线清单
        .sort((a, b) => (b.lastCallAt || 0) - (a.lastCallAt || 0) || b.lastSeen - a.lastSeen)
        .map(s => ({
          client: s.client,
          host: s.host || null,       // 宿主 IDE/终端(进程链识别)
          project: s.project || null, // 会话所在项目目录名
          clientInfo: s.clientInfo || null, // MCP 握手原始 name/version
          pid: s.pid,
          uptimeMs: now - s.startedAt,
          idleMs: s.lastCallAt ? now - s.lastCallAt : null, // 距最近一次真实调用(null=从未调用)
          active: !!(s.lastCallAt && now - s.lastCallAt <= ACTIVE_MS), // 绿点判据
          calls: s.calls,
          lastTool: s.lastTool || null,
          lastTabId: s.lastTabId != null ? s.lastTabId : null,
          lastTabTitle: s.lastTabTitle || null,
          lastBrowser: s.lastBrowser || null, // 多浏览器在线时才有值
        }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: "browser-link-tool", // 指纹:供探活确认对端确是本工具而非撞端口的陌生服务
        mode: "daemon",
        version: VERSION,
        build: BUILD,
        pid: process.pid,
        connected: liveBrowsers().length > 0,
        browsers: liveBrowsers().map(b => {
          const vs = browserVersionState(b);
          return {
            id: b.id, name: b.name, brand: b.brand, focused: b.focused, connectedAt: b.connectedAt,
            extVersion: b.extVersion || null,
            extVersionName: b.extVersionName || null,
            codeLoadedAt: b.codeLoadedAt || null,
            versionState: vs.state,   // ok | version-mismatch | stale-code | unknown
            versionDetail: vs.detail, // 人话结论,popup 与 connection_info 直接展示
          };
        }),
        extDiskMtime: extDiskMtime(), // 0 = 非开发态(npm 包无 extension/ 目录),此时只比版本号
        daemonSince, // daemon 就位时刻:调用方据此判断是否刚启动、值得等扩展重连
        wsPort: WS_PORT,
        httpPort: HTTP_PORT,
        sessions: onlineSessions,
      }));
      return;
    }

    const action = HTTP_ACTION_MAP[url];
    if (!action) {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    // 记录该会话本次操作:工具名 + 目标 tab(供面板显示"谁在操作哪个 tab")
    const recordOp = (data) => {
      const sid = req.headers['x-bridge-session'];
      const s = sid && sessions.get(sid);
      if (!s) return;
      s.lastTool = action;
      // lastTabId/lastTabTitle 由扩展回传的 __resolvedTab 独家更新(真实操作的 tab,含活动 tab 场景)
    };

    // 闸门已保证业务路由只有 POST 进来
    readBody((data) => {
      recordOp(data);
      handleBrowserAction(action, data);
    });
  });

  console.error(`[bridge] DAEMON: HTTP listening on 127.0.0.1:${HTTP_PORT}`);

  // Hot Reload 文件监听
  let debounceTimer = null;
  // 热重载仅开发场景(仓库内 ../extension 存在)启用;npm 发布包里无此目录,静默跳过。
  if (fs.existsSync(EXTENSION_DIR)) {
    try {
      fs.watch(EXTENSION_DIR, (eventType, filename) => {
        if (filename && (filename.endsWith('.css') || filename.endsWith('.js') || filename.endsWith('.html'))) {
          if (filename === 'background.js' || filename === 'mcp-server-bridge.mjs' || filename.startsWith('test')) return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            for (const b of liveBrowsers()) {
              console.error(`[Hot Reload] File ${filename} changed, sending reload signal to ${b.id}...`);
              b.ws.send(JSON.stringify({ action: "reload" }));
            }
          }, 500);
        }
      });
    } catch (e) { /* 监听失败不影响主功能 */ }
  }

  wss.on('connection', (ws) => {
    // 扩展连上即发 hello 上报 browserId;收到 hello 才登记进注册表,限时不发(非本扩展/版本过旧)直接断开
    const entry = { id: null, name: null, brand: null, ws, connectedAt: Date.now(), focused: false, lastFocusAt: 0 };
    const helloTimer = setTimeout(() => {
      console.error('[bridge] WS client sent no hello within 5s, closing');
      try { ws.close(1008, 'hello required'); } catch {}
    }, 5000);
    // 每个连接必须挂 error 监听:否则 ws 抛错(如超大 payload 触发 1009)在实例上发 'error'
    // 事件而无监听器时，Node 会直接 throw 崩溃主进程、断开浏览器。
    ws.on('error', (e) => console.error(`[bridge] WS connection error: ${e.message}`));
    ws.on('message', (message) => {
      let data;
      try { data = JSON.parse(message.toString()); } catch (e) { return; }
      if (data && data.type === 'hello') {
        const newId = sanitizeId(data.browserId);
        if (!newId) { try { ws.close(1008, 'invalid browserId'); } catch {} return; }
        clearTimeout(helloTimer);
        if (newId !== entry.id) {
          const old = browsers.get(newId);
          // 同一浏览器(扩展重载/SW 重启)的旧连接:让位给新连接
          if (old && old.ws !== ws) { browsers.delete(newId); try { old.ws.close(); } catch {} }
          if (entry.id) browsers.delete(entry.id);
          entry.id = newId;
          browsers.set(newId, entry);
        }
        entry.brand = String(data.brand || 'Chromium').slice(0, 32);
        entry.name = String(data.name || `${entry.brand}-${entry.id}`).slice(0, 64);
        // 版本三件套:扩展版本号 / 带 build 戳的展示名 / 扩展代码加载时刻(判"改了代码没重载")
        entry.extVersion = data.extVersion ? String(data.extVersion).slice(0, 32) : null;
        entry.extVersionName = data.extVersionName ? String(data.extVersionName).slice(0, 64) : null;
        entry.codeLoadedAt = Number(data.codeLoadedAt) || 0;
        if (data.focused != null) { entry.focused = !!data.focused; if (entry.focused) entry.lastFocusAt = Date.now(); }
        const vs = browserVersionState(entry);
        console.error(`[bridge] browser connected: ${entry.id} (${entry.name}, ext v${entry.extVersion || '?'}, bridge v${VERSION}, total ${liveBrowsers().length})`);
        if (vs.state !== 'ok') console.error(`[bridge] ⚠ VERSION ${vs.state}: ${vs.detail}`);
        return;
      }
      if (!entry.id) return; // hello 前的其它消息一律忽略
      if (data && data.type === 'focus') {
        entry.focused = !!data.focused;
        if (entry.focused) {
          entry.lastFocusAt = Date.now();
          // 焦点互斥:一个浏览器拿到焦点,其他的必然失焦(失焦事件可能晚到或丢失)
          for (const b of browsers.values()) if (b !== entry) b.focused = false;
        }
        return;
      }
      if (data && data.id && pendingRequests.has(data.id)) {
        const p = pendingRequests.get(data.id);
        pendingRequests.delete(data.id);
        p.resolve(data);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!entry.id) return; // 未 hello 的连接从未登记
      if (browsers.get(entry.id) === entry) browsers.delete(entry.id);
      // 该浏览器上的在途请求立即失败,别让调用方干等超时
      for (const [id, p] of pendingRequests) {
        if (p.entry === entry) {
          pendingRequests.delete(id);
          p.resolve({ error: `Chrome Extension (${entry.name}) disconnected during request`, __status: 503 });
        }
      }
      console.error(`[bridge] Chrome Extension disconnected (${entry.id}, remaining ${liveBrowsers().length})`);
    });
  });

  return {
    wss, wssHttpServer, httpServer,
    getDebounceTimer: () => debounceTimer,
    getLastClientSeenAt: () => lastClientSeenAt,
    getPendingCount: () => pendingRequests.size,
  };
}

// ─── 截图:扩展回 dataUrl,client 落盘 ───
async function runScrollingScreenshot(args) {
  const format = (args.format === 'jpeg' || args.format === 'jpg') ? 'jpeg' : 'png';
  const outputPath = args.output_path
    ? path.resolve(String(args.output_path).replace(/^~(?=$|\/)/, os.homedir()))
    : `/tmp/screenshot_${Date.now()}.${format === 'jpeg' ? 'jpg' : 'png'}`;
  const responseText = await proxyHttpRequest('/scrolling_screenshot', 'POST', JSON.stringify({
    full_page: args.full_page, selector: args.selector, format, quality: args.quality,
    ...pickTabTargets(args)
  }));
  const response = JSON.parse(responseText);
  if (response.error) {
    return { content: [{ type: "text", text: `Error: ${response.error}` }], isError: true };
  }
  const { dataUrl, note } = JSON.parse(response.result);
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
  return { content: [{ type: "text", text: `Screenshot saved to: ${outputPath}` + (note ? `\nnote: ${note}` : '') }] };
}

// ─── client 名升级:握手后一律以 clientInfo 为准(覆盖 BRIDGE_CLIENT/进程链等兜底值) ───
let server = null; // client 模式下的 MCP Server 实例
function upgradeClientName() {
  if (!server) return;
  try {
    const ci = server.getClientVersion();
    if (ci?.name) CLIENT_INFO = `${ci.name}${ci.version ? '/' + ci.version : ''}`.slice(0, 80);
    const fromMcp = normalizeClientName(ci?.title || ci?.name);
    if (fromMcp) BRIDGE_CLIENT = fromMcp;
  } catch {}
}

// ─── 版本自检(client 侧):把"只升了一半"变成调用时就能看见的一行告警 ───
// skill 副本是 cp 出去的独立文件,最容易漏同步:改了 SKILL.md 忘跑 sync-skills-local.sh,
// agent 读的就还是旧用法说明。故把各客户端 skills 目录里的副本版本也一并扫出来。
const SKILL_DIRS = ['.claude/skills', '.agents/skills', '.codex/skills', '.gemini/skills', '.gemini/config/skills', '.joycode/skills'];
function collectSkillVersions() {
  const out = [];
  for (const rel of SKILL_DIRS) {
    const p = path.join(os.homedir(), rel, 'browser-link-tool', 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    let version = null;
    try { version = (fs.readFileSync(p, 'utf8').match(/<!--\s*blt-version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*-->/) || [])[1] || null; } catch {}
    out.push({ path: p, version, state: version === VERSION ? 'ok' : (version ? 'version-mismatch' : 'unknown') });
  }
  return out;
}

// 汇总本次调用涉及的版本问题,返回一行告警(无问题返回 null)。
// 刻意只警告不阻断:排查线上问题时被一个版本号拦死,比版本不一致本身更糟。
function versionWarning(health) {
  const bad = (health?.browsers || []).filter(b => b.versionState && b.versionState !== 'ok');
  if (!bad.length) return null;
  const items = bad.map(b => `${b.name}: ${b.versionDetail}`).join(' | ');
  return `⚠️ 版本不一致(桥 v${VERSION}) — ${items}`;
}

// 把告警贴在工具返回的正文前面。只在有问题时插入,正常调用的输出一个字都不改。
function withWarning(result, warn) {
  if (!warn || !result?.content?.length) return result;
  const first = result.content[0];
  if (first?.type === 'text') first.text = `${warn}\n\n${first.text}`;
  return result;
}

// ─── 连接与版本诊断(只读,不碰浏览器;扩展没连上时也能用) ───
async function runConnectionInfo() {
  const { state, health } = await fetchHealth();
  // daemon 比自己旧时,它根本不认识版本字段:此时扩展的版本信息不可得,只能先换代再谈。
  // 不做这层判断就会给每个扩展报一条 "xxx: undefined" 的废话。
  const daemonTooOld = state === 'daemon' && health.version !== VERSION;
  const info = {
    bridge: state === 'daemon'
      ? { version: health.version, build: health.build, pid: health.pid, wsPort: health.wsPort, httpPort: health.httpPort, daemonSince: health.daemonSince ? new Date(health.daemonSince).toISOString() : null }
      : { state, note: state === 'none' ? 'daemon 未运行' : `端口 ${HTTP_PORT} 被非本工具服务占用` },
    client: { version: VERSION, build: BUILD, sessionId: SESSION_ID, script: SCRIPT_PATH },
    extensions: (health?.browsers || []).map(b => ({
      name: b.name, id: b.id, brand: b.brand, focused: b.focused,
      version: b.extVersion || null, versionName: b.extVersionName || null,
      state: b.versionState || 'unknown',
      detail: b.versionDetail || (daemonTooOld ? 'daemon 版本过旧,拿不到扩展版本(先让 daemon 换代)' : '扩展未上报版本,请重载扩展'),
    })),
    skills: collectSkillVersions(),
  };
  // 一句话结论:AI 和用户都只需看这行
  const problems = [];
  if (state !== 'daemon') problems.push('daemon 不可用');
  if (daemonTooOld) problems.push(`daemon v${health.version} ≠ 本会话 client v${VERSION}:重启本 agent 的 MCP(或等它空闲自退)即可换代`);
  if (state === 'daemon' && !info.extensions.length) problems.push('没有扩展连上来');
  // daemon 太旧时扩展状态不可信,不逐条报,免得把"换代"这一个根因放大成一堆噪音
  if (!daemonTooOld) for (const e of info.extensions) if (e.state !== 'ok') problems.push(`${e.name}: ${e.detail}`);
  for (const s of info.skills) if (s.state !== 'ok') problems.push(`skill 副本 ${s.path} 版本 ${s.version || '未标注'} ≠ v${VERSION},请跑 sync-skills-local.sh`);
  info.verdict = problems.length ? `有 ${problems.length} 处不一致` : `全部同代 ✔ v${VERSION}`;
  info.problems = problems;
  return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
}

// ─── 通用工具调用(client 侧:每次调用一个临时 HTTP 请求转发给 daemon) ───
const errResult = (msg) => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
// 工具名容错:CLI / batch 里允许省略 mcp_browser_ 前缀,另有几个顺手的别名
const TOOL_ALIASES = { eval: 'evaluate', js: 'evaluate', screenshot: 'scrolling_screenshot', shot: 'scrolling_screenshot', tabs: 'list_tabs', status: 'connection_info', info: 'connection_info', goto: 'navigate', open: 'new_tab', close: 'close_tab', upload: 'upload_file', key: 'press_key', wait: 'wait_for' };
function normalizeToolName(name) {
  let n = String(name || '').trim().replace(/-/g, '_');
  if (n.startsWith('mcp__')) n = n.slice(n.lastIndexOf('__') + 2); // agent 侧带 server 前缀的全名
  if (n.startsWith('mcp_browser_')) n = n.slice('mcp_browser_'.length);
  return 'mcp_browser_' + (TOOL_ALIASES[n] || n);
}

// 调用前探活:daemon 不在(被杀/崩溃/空闲退出)就就地拉起;刚起的 daemon 等扩展重连一下。返回 { health } 或 { error }
async function preflight() {
  let { state, health } = await fetchHealth();
  // 比自己旧的 daemon 也就地换代:CLI 没有 MCP client 那样的启动期 ensureDaemon,不在这里换就永远调到旧 daemon
  if (state === 'none' || (state === 'daemon' && isOlderThanMe(health))) ({ state, health } = await ensureDaemon());
  if (state === 'daemon' && !health.connected && Date.now() - (health.daemonSince || 0) < DAEMON_FRESH_MS) {
    ({ state, health } = await waitExtensionConnected(EXT_RECONNECT_WAIT_MS));
  }
  if (state === 'none') return { error: errResult(`Bridge daemon on :${HTTP_PORT} is unreachable and could not be (re)started; see ${DAEMON_LOG}. Ask the user to check it (do NOT switch to another browser tool).`) };
  if (state === 'foreign') return { error: errResult(`Port ${HTTP_PORT} is occupied by a non-browser-link service; cannot forward.`) };
  if (!health.connected) return { error: errResult("Bridge daemon reports no Chrome Extension connected. Ask the user to check the extension popup shows 'connected'.") };
  return { health };
}

// 执行单个工具(已过 preflight)。工具未知/参数错误返回 isError 结果,不抛
async function execTool(toolName, args) {
  if (toolName === 'mcp_browser_connection_info') return runConnectionInfo();
  if (toolName === 'mcp_browser_scrolling_screenshot') return runScrollingScreenshot(args);
  if (toolName === 'mcp_browser_batch') return runBatch(args);
  const route = TOOL_ROUTES[toolName];
  if (!route) return errResult(`Unknown tool ${toolName}`);
  const body = route.bodyFn ? route.bodyFn(args) : null;
  const responseText = await proxyHttpRequest(route.path, route.method, body);
  try {
    const parsed = JSON.parse(responseText);
    if (parsed.error) {
      const extra = parsed.diag ? `\n${JSON.stringify(parsed.diag, null, 2)}` : '';
      return errResult(`${parsed.error}${extra}`);
    }
    // 不能写 parsed.result || responseText:空串/0/false 是合法结果(如空输入框的 value),会漏出整个响应信封
    if (parsed.html) return { content: [{ type: "text", text: parsed.html }] };
    if (parsed.result !== undefined && parsed.result !== null) {
      const r = parsed.result;
      return { content: [{ type: "text", text: r === '' ? '""' : (typeof r === 'string' ? r : JSON.stringify(r)) }] };
    }
    return { content: [{ type: "text", text: responseText }] };
  } catch {
    return { content: [{ type: "text", text: responseText }] };
  }
}

// batch:client 侧顺序执行,每步仍是一次独立 HTTP 调用(daemon/扩展无需感知 batch)
const BATCH_MAX_STEPS = 50;
const BATCH_STEP_TEXT_MAX = 4000;
async function runBatch(args) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) return errResult('steps must be a non-empty array of {tool, args}');
  if (steps.length > BATCH_MAX_STEPS) return errResult(`too many steps (${steps.length} > ${BATCH_MAX_STEPS})`);
  const stopOnError = args.stop_on_error !== false;
  const inherit = pickTabTargets(args);
  const lines = [];
  let failed = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const label = String(st.tool || '?');
    const name = normalizeToolName(st.tool);
    const a = { ...(st.args && typeof st.args === 'object' ? st.args : {}) };
    let r;
    try {
      if (name === 'mcp_browser_sleep') {
        const ms = Math.max(0, Math.min(60000, Number(a.ms) || 0));
        await sleep(ms);
        r = { content: [{ type: "text", text: `slept ${ms}ms` }] };
      } else if (name === 'mcp_browser_batch') {
        r = errResult('nested batch is not allowed');
      } else {
        // tab 定向成组继承:步骤自带 tabId 或 url_match 任一,就不再继承另一个(避免两者打架)
        if (a.tabId == null && a.url_match == null) {
          if (inherit.tabId != null) a.tabId = inherit.tabId;
          if (inherit.url_match != null) a.url_match = inherit.url_match;
        }
        if (a.browser == null && inherit.browser != null) a.browser = inherit.browser;
        if (a.frame == null && inherit.frame != null) a.frame = inherit.frame;
        r = await execTool(name, a);
      }
    } catch (e) {
      r = errResult(e.message);
    }
    let text = (r.content || []).map(c => c.text).join('\n');
    if (text.length > BATCH_STEP_TEXT_MAX) text = text.slice(0, BATCH_STEP_TEXT_MAX) + `… (${text.length} chars, truncated; run this step alone for full output)`;
    lines.push(`[${i + 1}] ${label} ${r.isError ? '✗' : '✓'}\n${text}`);
    if (r.isError) {
      failed++;
      if (stopOnError) {
        if (i < steps.length - 1) lines.push(`(stopped: ${steps.length - i - 1} remaining step(s) not run; pass stop_on_error=false to continue past errors)`);
        break;
      }
    }
  }
  return { content: [{ type: "text", text: `batch: ${steps.length} step(s), ${failed} failed\n\n${lines.join('\n\n')}` }], isError: failed > 0 };
}

async function callTool(request) {
  const toolName = normalizeToolName(request.params.name);
  const args = request.params.arguments || {};
  upgradeClientName();

  // 诊断工具排在所有校验之前:扩展没连上、版本对不上时它才最该用
  if (toolName === 'mcp_browser_connection_info') {
    try { return await runConnectionInfo(); }
    catch (e) { return errResult(e.message); }
  }
  if (!TOOL_ROUTES[toolName] && toolName !== 'mcp_browser_scrolling_screenshot' && toolName !== 'mcp_browser_batch') {
    return errResult(`Unknown tool ${request.params.name}`);
  }

  const pre = await preflight();
  if (pre.error) return pre.error;
  const warn = versionWarning(pre.health);
  try {
    return withWarning(await execTool(toolName, args), warn);
  } catch (e) {
    return errResult(e.message);
  }
}

// ─── daemon 绑定端口:探活 → 原子绑定 WS+HTTP → 失败返回 null(说明已有 daemon 在跑) ───
async function bindDaemonPorts(onShutdown) {
  const probe = (await fetchHealth(800)).state;
  if (probe === 'daemon') {
    console.error(`[bridge] Another bridge already serving :${HTTP_PORT}, this daemon exits.`);
    return null;
  }
  if (probe === 'foreign') {
    console.error(`[bridge] Port ${HTTP_PORT} answered but not as browser-link; this daemon exits.`);
    return null;
  }

  const wssHttpServer = http.createServer();
  const httpServer = http.createServer();
  const rollback = (reason) => {
    console.error(`[bridge] ${reason}, daemon not started.`);
    try { wssHttpServer.close(); } catch {}
    try { httpServer.close(); } catch {}
    return null;
  };
  // 探活扑空但端口已被占:典型竞态(另一 client 同时拉起的 daemon 抢先绑定),让它当家
  if (!(await bindPortAtomic(wssHttpServer, WS_PORT))) return rollback(`WS port ${WS_PORT} occupied`);
  console.error(`[bridge] DAEMON: WebSocket listening on 127.0.0.1:${WS_PORT}`);
  // WS 已绑成功但 HTTP 冲突 → 必须先关掉 WS,否则占着端口空转
  if (!(await bindPortAtomic(httpServer, HTTP_PORT))) return rollback(`HTTP port ${HTTP_PORT} occupied (WS already bound, releasing)`);

  return setupDaemon(wssHttpServer, httpServer, onShutdown);
}

// 轮询 /health 直到扩展连上或超时,返回最后一次 { state, health }
async function waitExtensionConnected(ms) {
  const deadline = Date.now() + ms;
  let r = await fetchHealth();
  while (!(r.state === 'daemon' && r.health.connected) && Date.now() < deadline) {
    await sleep(500);
    r = await fetchHealth();
  }
  return r;
}
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ─── client:确保 daemon 在跑且不旧于自己 ───
// (version, build) 二元组全序比较:只有严格更新的 client 才会让 daemon 退位,两版并存时不会互踢。
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function isOlderThanMe(h) {
  const c = cmpVersion(h.version || '0.0.0', VERSION);
  return c !== 0 ? c < 0 : (Number(h.build) || 0) < BUILD;
}

function spawnDaemon() {
  fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  try { if (fs.statSync(DAEMON_LOG).size > 5 * 1024 * 1024) fs.truncateSync(DAEMON_LOG, 0); } catch {}
  const fd = fs.openSync(DAEMON_LOG, 'a');
  // detached:脱离 agent 的进程组,agent 会话退出/杀进程组时 daemon 不受牵连
  const child = spawn(process.execPath, [SCRIPT_PATH, '--daemon'], {
    detached: true, stdio: ['ignore', fd, fd], env: process.env, cwd: os.homedir(),
  });
  child.unref();
  fs.closeSync(fd);
  console.error(`[bridge] spawned daemon pid ${child.pid} (log: ${DAEMON_LOG})`);
}

async function waitHealth(pred, ms) {
  const deadline = Date.now() + ms;
  let r = await fetchHealth(500);
  while (!pred(r) && Date.now() < deadline) {
    await sleep(200);
    r = await fetchHealth(500);
  }
  return r;
}

let ensuring = null;
function ensureDaemon() {
  if (!ensuring) {
    ensuring = (async () => {
      let r = await fetchHealth();
      if (r.state === 'daemon' && isOlderThanMe(r.health)) {
        // daemon 比自己旧(升级了 bridge 但旧 daemon 还在跑)→ 请它退位,再拉起自己这版
        const oldPid = r.health.pid;
        console.error(`[bridge] daemon v${r.health.version || '?'} (pid ${oldPid || '?'}) older than v${VERSION}, asking it to shut down`);
        const resp = await proxyHttpRequest('/shutdown', 'POST', null, 2000,
          oldPid ? { 'x-bridge-target-pid': String(oldPid) } : {}).catch(() => '');
        if (resp.includes('"ok"')) {
          r = await waitHealth(x => x.state !== 'daemon' || x.health.pid !== oldPid, 3000);
        } else {
          r = await fetchHealth(); // 409=别的 client 已换代完成,端口上已是新 daemon;重新取一次,别拿旧快照往下走
        }
      }
      if (r.state === 'none') {
        spawnDaemon();
        r = await waitHealth(x => x.state === 'daemon', 5000);
      }
      return r;
    })().finally(() => { ensuring = null; });
  }
  return ensuring;
}

// ─── daemon 主流程 ───
async function runDaemon() {
  process.title = 'browser-link-tool-daemon';
  // 日志落文件,加时间戳便于排查
  for (const k of ['log', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => orig(new Date().toISOString(), ...a);
  }
  let res = null;
  let exiting = false;
  const shutdown = (reason) => {
    if (exiting) return;
    exiting = true;
    console.error(`[bridge] daemon exiting: ${reason}`);
    if (res) {
      const { wss, wssHttpServer, httpServer, getDebounceTimer } = res;
      try { wss.clients.forEach(c => c.close()); wss.close(); } catch {}
      try { wssHttpServer.close(); } catch {}
      try { httpServer.close(); } catch {}
      clearTimeout(getDebounceTimer());
    }
    setTimeout(() => process.exit(0), 100);
  };
  res = await bindDaemonPorts(() => shutdown('shutdown requested'));
  if (!res) process.exit(0);
  console.error(`[bridge] daemon v${VERSION} build ${BUILD} pid ${process.pid} ready`);

  // 空闲自退:所有 agent 会话都关了(无心跳)且无在途请求
  setInterval(() => {
    if (Date.now() - res.getLastClientSeenAt() > DAEMON_IDLE_MS && res.getPendingCount() === 0) {
      shutdown(`no client for ${DAEMON_IDLE_MS / 60000}min`);
    }
  }, 60 * 1000);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => {}); // 无控制终端,忽略
}

// ─── client 主流程(agent 以 stdio 拉起的那个进程) ───
async function runClient() {
  // 异常兜底:client 一退,Codex/JoyCode 不会重拉 → 该会话永久 Transport closed。故未捕获异常只记日志不退出;
  // 唯一例外是 stdout 的 EPIPE(agent 已关管道,留着也没人收),此时正常退出。
  const isPipeGone = (e) => e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED');
  process.stdout.on('error', (e) => { if (isPipeGone(e)) process.exit(0); });
  process.on('uncaughtException', (e) => {
    if (isPipeGone(e)) process.exit(0);
    console.error('[bridge] uncaughtException (kept alive):', e?.stack || e);
  });
  process.on('unhandledRejection', (e) => console.error('[bridge] unhandledRejection (kept alive):', e?.stack || e));

  server = new Server(
    { name: "browser_link_tool", version: VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, callTool);
  server.oninitialized = upgradeClientName;

  // 先连 stdio 再管 daemon:握手不被 daemon 拉起耗时拖慢
  await server.connect(new StdioServerTransport());
  console.error(`[bridge] MCP client v${VERSION} connected via stdio (session ${SESSION_ID})`);

  // 心跳:向 daemon 上报在线(面板展示 + 维持 daemon 不空闲退出);失败=daemon 不在 → 拉起
  const beat = () => {
    proxyHttpRequest('/session_ping', 'POST', null, 3000).catch(() => { ensureDaemon().catch(() => {}); });
  };
  ensureDaemon().catch(() => {}).finally(beat);
  setInterval(beat, HEARTBEAT_MS).unref();

  // client 不再空闲自退:Codex 等不会自动重拉 MCP,自退即 Transport closed。只随 agent 关闭 stdio 而退。
  const exit = () => process.exit(0);
  process.stdin.on('close', exit);
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}

// ─── CLI 主流程(`blt <tool> ...`:不走 MCP,脚本/任意 agent 的 shell 直接调,与 MCP 共用同一个 daemon) ───
// 位置参数默认按 schema.required 顺序映射;下表覆盖 required 为空、但有一个"主参数"的工具
const CLI_POSITIONAL = { navigate: ['url'], new_tab: ['url'], close_tab: ['tabId'], activate_tab: ['tabId'], outline: ['scope'], dom_tree: ['scope'], inspect_element: ['selector'], get_cookies: ['url'], get_storage: ['key'], scrolling_screenshot: ['output_path'], dialog: ['mode', 'prompt_text'] };
const CLI_HELP = `blt — Browser Link Tool 命令行(与 MCP 工具同源,共用常驻 daemon)

用法:
  blt <tool> [位置参数...] [--key value] [--flag]   调用工具(tool 可省 mcp_browser_ 前缀)
  blt <tool> '{"selector":"#go"}'                  也可直接给一个 JSON 参数对象
  blt batch steps.json | '<JSON>' | -             批量:文件 / JSON 字面量 / stdin;支持 [..步骤] 或 {steps:[..],tabId..}
  blt tools                                       列出全部工具
  blt help <tool>                                 查看某工具参数
  blt status                                      连接与版本诊断(= connection_info)

示例:
  blt tabs
  blt open https://example.com --active
  blt outline --url-match example.com
  blt click "#submit" --tabId 123
  blt fill "#q" "hello"
  blt eval "document.title"
  blt shot /tmp/a.png --full-page
  blt dialog auto_accept

环境变量:BLT_SESSION=<id> 指定会话(缺省按当前目录派生,同目录多次调用共享 tab 绑定);BLT_DEBUG=1 打印内部日志。
退出码:成功 0;工具报错/参数错误 1。`;

function cliToolDef(name) { return TOOL_DEFINITIONS.find(t => t.name === name); }
function cliShortName(name) { return name.replace(/^mcp_browser_/, ''); }

function cliCoerce(val, schema, key) {
  const t = schema?.type;
  if (val === true) {
    if (!t || t === 'boolean') return true;
    throw new Error(`--${key} 需要一个值`);
  }
  if (t === 'number' || t === 'integer') {
    const n = Number(val);
    if (!Number.isFinite(n)) throw new Error(`--${key} 需要数字,收到 ${val}`);
    return n;
  }
  if (t === 'boolean') {
    if (/^(true|1|yes|on)$/i.test(val)) return true;
    if (/^(false|0|no|off)$/i.test(val)) return false;
    throw new Error(`--${key} 需要 true/false,收到 ${val}`);
  }
  if (t === 'array' || t === 'object') {
    try { return JSON.parse(val); }
    catch { if (t === 'array') return [val]; throw new Error(`--${key} 需要 JSON 对象`); }
  }
  return val;
}

// 把 argv 解析成工具 args。flag 名容错:--url-match / --url_match / --urlmatch 都映射到 url_match
function cliParseArgs(def, argv) {
  const props = def.inputSchema?.properties || {};
  const findKey = (raw) => {
    if (props[raw]) return raw;
    const norm = (s) => s.replace(/[-_]/g, '').toLowerCase();
    return Object.keys(props).find(k => norm(k) === norm(raw)) || null;
  };
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      let raw = a.slice(2), val;
      const eq = raw.indexOf('=');
      if (eq > 0) { val = raw.slice(eq + 1); raw = raw.slice(0, eq); }
      const key = findKey(raw);
      if (!key) throw new Error(`未知参数 --${raw}(可用:${Object.keys(props).join(', ') || '无'})`);
      if (val === undefined) {
        const next = argv[i + 1];
        val = (props[key].type !== 'boolean' && next !== undefined && !(next.startsWith('--') && next.length > 2)) ? argv[++i] : true;
        if (props[key].type === 'boolean' && next !== undefined && /^(true|false)$/i.test(next)) val = argv[++i];
      }
      args[key] = cliCoerce(val, props[key], key);
    } else {
      positional.push(a);
    }
  }
  // 唯一一个 JSON 对象形式的位置参数 → 整体当 args;解析不了(如 eval '{ const a=1; return a }')就仍当普通位置参数
  let parsedObj = null;
  if (positional.length === 1 && /^\s*\{/.test(positional[0])) {
    try { const o = JSON.parse(positional[0]); if (o && typeof o === 'object' && !Array.isArray(o)) parsedObj = o; } catch (_) {}
  }
  if (parsedObj) Object.assign(args, { ...parsedObj, ...args });
  else {
    const order = CLI_POSITIONAL[cliShortName(def.name)] || def.inputSchema?.required || [];
    const slots = order.filter(k => args[k] === undefined);
    for (let i = 0; i < positional.length; i++) {
      const k = slots[i];
      if (!k) throw new Error(`多余的位置参数: ${positional.slice(i).join(' ')}(位置参数依次对应 ${order.join(', ') || '无'})`);
      // 数组型参数(如 upload_file 的 files)吞掉剩余全部位置参数
      if (props[k]?.type === 'array') { args[k] = positional.slice(i); break; }
      args[k] = cliCoerce(positional[i], props[k], k);
    }
  }
  const missing = (def.inputSchema?.required || []).filter(k => args[k] === undefined);
  if (missing.length) throw new Error(`缺少必填参数: ${missing.join(', ')}`);
  return args;
}

function cliToolHelp(def) {
  const props = def.inputSchema?.properties || {};
  const req = new Set(def.inputSchema?.required || []);
  const order = CLI_POSITIONAL[cliShortName(def.name)] || def.inputSchema?.required || [];
  const lines = [`blt ${cliShortName(def.name)}${order.map(k => ` <${k}>`).join('')} [选项]`, '', def.description, '', '参数:'];
  for (const [k, p] of Object.entries(props)) {
    lines.push(`  --${k}${req.has(k) ? ' (必填)' : ''}  [${p.type || 'any'}${p.enum ? ': ' + p.enum.join('|') : ''}]  ${(p.description || '').replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function runCli(argv) {
  // macOS 下写管道是异步的,写完立刻 process.exit 会截断大输出(blt snapshot | grep / > file)。
  // 置为阻塞写,保留各处 fail()/exit 的同步「到此为止」语义
  for (const s of [process.stdout, process.stderr]) { try { s._handle?.setBlocking?.(true); } catch (_) {} }
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
  const fail = (s) => { process.stderr.write(`blt: ${s}\n`); process.exit(1); };
  // 内部诊断日志(拉 daemon、换代等)默认静音,别污染脚本的 stderr
  if (!process.env.BLT_DEBUG) console.error = () => {};
  process.on('unhandledRejection', (e) => fail(e?.message || String(e)));

  const [cmd0, ...rest] = argv;
  if (!cmd0 || cmd0 === 'help' || cmd0 === '-h' || cmd0 === '--help') {
    if (rest[0]) {
      const def = cliToolDef(normalizeToolName(rest[0]));
      if (!def) fail(`未知工具 ${rest[0]},用 blt tools 查看全部`);
      out(cliToolHelp(def));
    } else out(CLI_HELP);
    process.exit(0);
  }
  if (cmd0 === '-v' || cmd0 === '--version' || cmd0 === 'version') { out(VERSION); process.exit(0); }
  if (cmd0 === 'tools') {
    out(TOOL_DEFINITIONS.map(t => `${cliShortName(t.name).padEnd(22)} ${t.description.split(/[。.!?;(]/)[0].slice(0, 70)}`).join('\n'));
    process.exit(0);
  }

  const toolName = normalizeToolName(cmd0);
  const def = cliToolDef(toolName);
  if (!def) fail(`未知命令/工具 ${cmd0},用 blt tools 查看全部`);

  let args;
  try {
    if (toolName === 'mcp_browser_batch' && rest[0] && !rest[0].startsWith('--')) {
      // batch 的主参数是整份 JSON:文件路径 / 字面量 / '-' 读 stdin
      const src = rest[0];
      const text = src === '-' ? await readStdin() : (/^\s*[[{]/.test(src) ? src : fs.readFileSync(path.resolve(src), 'utf8'));
      const parsed = JSON.parse(text);
      args = { ...(Array.isArray(parsed) ? { steps: parsed } : parsed), ...cliParseArgs({ ...def, inputSchema: { ...def.inputSchema, required: [] } }, rest.slice(1)) };
    } else {
      args = cliParseArgs(def, rest);
    }
  } catch (e) {
    fail(`${e.message}\n\n${cliToolHelp(def)}`);
  }

  const result = await callTool({ params: { name: toolName, arguments: args } });
  const text = (result.content || []).map(c => c.text).join('\n');
  if (result.isError) { process.stderr.write(text + '\n'); process.exit(1); }
  out(text);
  process.exit(0);
}

if (IS_DAEMON) await runDaemon();
else if (IS_CLI) await runCli(CLI_ARGV);
else await runClient();
