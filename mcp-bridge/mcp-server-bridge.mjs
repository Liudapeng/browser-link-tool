#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

// ─── 多实例策略: 主实例 vs 代理实例 ───
// 第一个进程成为"主实例"，拥有 WebSocket(:48765) + HTTP(:48766) 服务
// 后续进程成为"代理实例"，通过 HTTP(:48766) 转发请求给主实例
let isProxy = false;

const WS_PORT = 48765;
const HTTP_PORT = 48766;
// 代理实例(每个 agent 会话拉起的转发进程)空闲超时：无工具调用超过该时长则自动退出，
// 避免会话不断开导致进程堆积。主实例(连浏览器 WS)不自动退，退出会断开浏览器连接。
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
// 扩展源码在同级 ../extension，热更新监听该目录
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(BRIDGE_DIR, "..", "extension");

// ─── tab 定向入参 schema 片段（工具级复用） ───
const TAB_TARGET_PROPS = {
  tabId: { type: "number", description: "可选，目标标签页 ID（多会话隔离时指定，优先级最高）。缺省时按 url_match 或当前活动 tab" },
  url_match: { type: "string", description: "可选，按 URL 子串匹配目标标签页。tabId 缺省时生效" }
};

// ─── Proxy 模式工具函数 ───
function proxyHttpRequest(urlPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: HTTP_PORT,
      path: urlPath,
      method,
      timeout: 120000,
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
    description: "控制目标标签页跳转到指定的完整网页 URL 地址。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "需要跳转的合法的 HTTP/HTTPS 网址" }, ...TAB_TARGET_PROPS },
      required: ["url"]
    }
  },
  {
    name: "mcp_browser_scrolling_screenshot",
    description: "截取目标标签页当前可视区域一屏,保存为 PNG 并返回文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        output_path: { type: "string", description: "可选,保存截图的绝对路径。默认 /tmp/screenshot_<timestamp>.png" },
        ...TAB_TARGET_PROPS
      }
    }
  },
  {
    name: "mcp_browser_list_tabs",
    description: "列出浏览器中所有打开的标签页（tabId/title/url/active/windowId）。用于多会话场景先获取 tabId 再定向操作。",
    inputSchema: { type: "object", properties: {} }
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
    description: "返回页面【可交互元素精简清单】(按钮/链接/输入框/select/可点击项),每项含序号、类型 kind、可读文本 text、可直接用于 click/fill 的 selector、以及 hidden/disabled 状态。相比 snapshot 极大节省 context,是定位元素、确定选择器的首选。默认只列可见元素、最多 200 条。",
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
    description: "向元素(或当前焦点元素)派发一次按键事件(keydown/keypress/keyup)。用于回车提交、Tab 切换、Esc 关弹窗、方向键等。selector 缺省则作用于 document.activeElement。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "键名:Enter/Tab/Escape/Backspace/Delete/Space/ArrowUp/ArrowDown/ArrowLeft/ArrowRight 或单个字符" },
        selector: { type: "string", description: "可选,目标元素 CSS 选择器;缺省作用于当前焦点元素" },
        ...TAB_TARGET_PROPS
      },
      required: ["key"]
    }
  },
  {
    name: "mcp_browser_hover",
    description: "把鼠标悬停到某元素上(派发 pointerover/mouseover/mouseenter/mousemove)。用于触发 hover 才展开的下拉菜单、tooltip、悬浮操作按钮。",
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
    description: "读取页面发出的 fetch/XHR 请求记录(method/url/status/耗时ms)。⚠️ 首次调用只安装捕获钩子并返回 installed:true(此前的请求抓不到),需在触发操作后【再次调用】才拿到记录。with_body=true 附带响应体前 1000 字符。clear=true 读完清空。",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "可选,读取后清空缓存,默认 false" },
        with_body: { type: "boolean", description: "可选,是否附带响应体片段(前 1000 字符),默认 false" },
        max_items: { type: "number", description: "可选,最多返回最近 N 条,默认 50" },
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
      },
      required: ["command"]
    }
  }
];

// ─── 工具 → HTTP 路由 + 载荷映射（主/代理共用） ───
// bodyFn 接收 args，返回请求体字符串（GET 返回 null）
function pickTabTargets(args) {
  const t = {};
  if (args.tabId != null) t.tabId = args.tabId;
  if (args.url_match != null) t.url_match = args.url_match;
  return t;
}

const TOOL_ROUTES = {
  mcp_browser_snapshot: { path: '/snapshot', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets(a)) },
  mcp_browser_evaluate: { path: '/eval', method: 'POST', bodyFn: (a) => JSON.stringify({ code: a.code, ...pickTabTargets(a) }) },
  mcp_browser_click: { path: '/click', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_fill: { path: '/fill', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, value: a.value, ...pickTabTargets(a) }) },
  mcp_browser_navigate: { path: '/navigate', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, ...pickTabTargets(a) }) },
  mcp_browser_list_tabs: { path: '/list_tabs', method: 'POST', bodyFn: () => '{}' },
  mcp_browser_activate_tab: { path: '/activate_tab', method: 'POST', bodyFn: (a) => JSON.stringify(pickTabTargets(a)) },
  mcp_browser_wait_for: { path: '/wait_for', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, text: a.text, visible: a.visible, timeout: a.timeout, ...pickTabTargets(a) }) },
  mcp_browser_get_storage: { path: '/get_storage', method: 'POST', bodyFn: (a) => JSON.stringify({ storageType: a.storageType, key: a.key, ...pickTabTargets(a) }) },
  mcp_browser_set_storage: { path: '/set_storage', method: 'POST', bodyFn: (a) => JSON.stringify({ storageType: a.storageType, key: a.key, value: a.value, ...pickTabTargets(a) }) },
  mcp_browser_get_cookies: { path: '/get_cookies', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, name: a.name, ...pickTabTargets(a) }) },
  mcp_browser_set_cookies: { path: '/set_cookies', method: 'POST', bodyFn: (a) => JSON.stringify({ url: a.url, name: a.name, value: a.value, path: a.path, domain: a.domain, secure: a.secure, httpOnly: a.httpOnly, expirationDate: a.expirationDate, ...pickTabTargets(a) }) },
  mcp_browser_outline: { path: '/outline', method: 'POST', bodyFn: (a) => JSON.stringify({ scope: a.scope, include_hidden: a.include_hidden, max_items: a.max_items, ...pickTabTargets(a) }) },
  mcp_browser_get_element: { path: '/get_element', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, attr: a.attr, ...pickTabTargets(a) }) },
  mcp_browser_select_option: { path: '/select_option', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, value: a.value, by_label: a.by_label, ...pickTabTargets(a) }) },
  mcp_browser_press_key: { path: '/press_key', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, key: a.key, ...pickTabTargets(a) }) },
  mcp_browser_hover: { path: '/hover', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_scroll_to: { path: '/scroll_to', method: 'POST', bodyFn: (a) => JSON.stringify({ selector: a.selector, ...pickTabTargets(a) }) },
  mcp_browser_get_console: { path: '/get_console', method: 'POST', bodyFn: (a) => JSON.stringify({ clear: a.clear, max_items: a.max_items, ...pickTabTargets(a) }) },
  mcp_browser_get_network: { path: '/get_network', method: 'POST', bodyFn: (a) => JSON.stringify({ clear: a.clear, with_body: a.with_body, max_items: a.max_items, ...pickTabTargets(a) }) },
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
  '/get_storage': 'get_storage',
  '/set_storage': 'set_storage',
  '/get_cookies': 'get_cookies',
  '/set_cookies': 'set_cookies',
  '/arthas_exec': 'arthas_exec',
  '/get_current_tab': 'get_current_tab',
};

// ─── 主动探活:已有健康主实例？ ───
// macOS 双栈下 IPv6/IPv4 同端口不报 EADDRINUSE，盲听会裂脑；启动前先探活兜底。
// 用内置 http 模块而非 fetch，兼容 Node 16(fetch/AbortSignal.timeout 在 16 不可用)。
// 返回:'primary'=本工具主实例就位 | 'foreign'=端口被陌生服务占用 | 'none'=无人应答
function probePrimaryHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: HTTP_PORT, path: '/health', method: 'GET', timeout: 800 },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          // 探活响应本应很小；陌生服务撞端口回超大 body 时截断防吃内存
          if (data.length > 65536) { res.destroy(); resolve('foreign'); }
        });
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve('foreign'); return; }
          try {
            const j = JSON.parse(data);
            // 指纹 + 端口双校验，确认对端确是本工具而非撞端口的陌生服务
            if (j.service === 'browser-link-tool' && j.status === 'primary'
                && j.wsPort === WS_PORT && j.httpPort === HTTP_PORT) {
              resolve('primary');
            } else {
              resolve('foreign'); // 有人应答但不是本工具
            }
          } catch { resolve('foreign'); }
        });
      }
    );
    req.on('error', () => resolve('none')); // 拒连=端口空闲
    req.on('timeout', () => { req.destroy(); resolve('none'); });
    req.end();
  });
}

// ─── 原子绑定:WS(48765) 与 HTTP(48766) 全绑成功才算主实例 ───
// 任一端口失败 → 回滚关闭已绑 server，降级 PROXY，绝不 process.exit。
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

// ─── 主实例完整逻辑 ───
// wssHttpServer(48765)、httpServer(48766) 均已由 tryStartPrimary 原子绑定成功后传入。
function setupPrimaryInstance(wssHttpServer, httpServer) {
  // maxPayload 提到 512MB:大页面 snapshot / eval 大对象可能超 ws 默认 100MB 上限，
  // 否则会触发 1009 错误。配合下方 ws.on('error') 兜底，双重防崩。
  const wss = new WebSocketServer({ server: wssHttpServer, maxPayload: 512 * 1024 * 1024 });

  // 运行期 error 监听:bindPortAtomic 成功后移除了绑定期的临时监听器，
  // 若不重挂，运行时 socket 错误(ECONNRESET/EMFILE 等)会因 'error' 无监听器直接 throw 崩溃主进程。
  wssHttpServer.on('error', (err) => console.error(`[bridge] WS server runtime error: ${err.message}`));
  httpServer.on('error', (err) => console.error(`[bridge] HTTP server runtime error: ${err.message}`));

  let activeClient = null;
  let pendingRequests = new Map();
  let currentId = 1;

  httpServer.on('request', (req, res) => {
    const url = req.url;

    const handleBrowserAction = (action, extraPayload = {}) => {
      if (!activeClient || activeClient.readyState !== 1) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "No Chrome Extension connected" }));
        return;
      }
      const id = currentId++;
      let timeoutMs;
      if (action === 'scrolling_screenshot') timeoutMs = 120000;
      else if (action === 'wait_for') timeoutMs = 65000;
      else if (action === 'arthas_exec') timeoutMs = Math.max((extraPayload.timeout || 60000) + 5000, 65000);
      else timeoutMs = 15000;
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          res.writeHead(504);
          res.end(JSON.stringify({ error: "Request timed out" }));
        }
      }, timeoutMs);
      pendingRequests.set(id, (response) => {
        clearTimeout(timer);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
      activeClient.send(JSON.stringify({ action, id, ...extraPayload }));
    };

    const readBody = (cb) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        let parsed = {};
        if (body) { try { parsed = JSON.parse(body); } catch (e) { parsed = { __raw: body }; } }
        cb(parsed);
      });
    };

    if (url === "/health") {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        service: "browser-link-tool", // 指纹:供探活确认对端确是本工具而非撞端口的陌生服务
        status: "primary",
        mode: "primary",
        connected: !!(activeClient && activeClient.readyState === 1),
        wsPort: WS_PORT,
        httpPort: HTTP_PORT
      }));
      return;
    }

    const action = HTTP_ACTION_MAP[url];
    if (!action) {
      res.writeHead(200);
      res.end("OK");
      return;
    }

    // GET 仅 /snapshot 兼容旧行为不再需要；统一按 POST 读 body
    if (req.method === "POST") {
      readBody((data) => {
        // eval 旧协议兼容：body 可能是纯代码字符串
        if (action === 'evaluate' && data.__raw != null) {
          handleBrowserAction('evaluate', { code: data.__raw });
          return;
        }
        handleBrowserAction(action, data);
      });
    } else {
      handleBrowserAction(action, {});
    }
  });

  console.error(`[bridge] PRIMARY mode: HTTP listening on 127.0.0.1:${HTTP_PORT}`);

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
            if (activeClient && activeClient.readyState === 1) {
              console.log(`[Hot Reload] File ${filename} changed, sending reload signal...`);
              activeClient.send(JSON.stringify({ action: "reload" }));
            }
          }, 500);
        }
      });
    } catch (e) { /* 监听失败不影响主功能 */ }
  }

  wss.on('connection', (ws) => {
    activeClient = ws;
    console.error('[bridge] Chrome Extension connected');
    // 每个连接必须挂 error 监听:否则 ws 抛错(如超大 payload 触发 1009)在实例上发 'error'
    // 事件而无监听器时，Node 会直接 throw 崩溃主进程、断开浏览器。
    ws.on('error', (e) => console.error(`[bridge] WS connection error: ${e.message}`));
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.id && pendingRequests.has(data.id)) {
          const resolve = pendingRequests.get(data.id);
          resolve(data);
          pendingRequests.delete(data.id);
        }
      } catch (e) {}
    });
    ws.on('close', () => {
      if (activeClient === ws) {
        activeClient = null;
        console.error('[bridge] Chrome Extension disconnected');
      }
    });
  });

  return { wss, wssHttpServer, httpServer, debounceTimer };
}

// ─── 单屏截图（主/代理共用）───
async function runScrollingScreenshot(args) {
  const outputPath = args.output_path || `/tmp/screenshot_${Date.now()}.png`;
  const responseText = await proxyHttpRequest('/scrolling_screenshot', 'POST', JSON.stringify({
    ...pickTabTargets(args)
  }));
  const response = JSON.parse(responseText);
  if (response.error) {
    return { content: [{ type: "text", text: `Error: ${response.error}` }], isError: true };
  }
  const { dataUrl } = JSON.parse(response.result);
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  fs.writeFileSync(outputPath, buf);
  return { content: [{ type: "text", text: `Screenshot saved to: ${outputPath}` }] };
}

// ─── 通用工具调用（主/代理统一走 HTTP :48766） ───
async function callTool(request) {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  bumpIdleTimer(); // 每次工具调用视为一次交互，重置空闲计时

  // 代理模式先探活:校验对端确是本工具主实例，再看浏览器是否在线
  if (isProxy) {
    try {
      const healthText = await proxyHttpRequest('/health', 'GET');
      const health = JSON.parse(healthText);
      if (health.service !== 'browser-link-tool' || health.status !== 'primary') {
        return { content: [{ type: "text", text: `Error: Port ${HTTP_PORT} is occupied by a non-browser-link service; cannot forward.` }], isError: true };
      }
      if (!health.connected) {
        return { content: [{ type: "text", text: "Error: Primary bridge reports no Chrome Extension connected." }], isError: true };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Cannot reach primary bridge on :${HTTP_PORT}. Is it still running?` }], isError: true };
    }
  }

  if (toolName === 'mcp_browser_scrolling_screenshot') {
    try {
      return await runScrollingScreenshot(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }

  const route = TOOL_ROUTES[toolName];
  if (!route) throw new Error("Tool not found");

  try {
    const body = route.bodyFn ? route.bodyFn(args) : null;
    const responseText = await proxyHttpRequest(route.path, route.method, body);
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.error) {
        const extra = parsed.diag ? `\n${JSON.stringify(parsed.diag, null, 2)}` : '';
        return { content: [{ type: "text", text: `Error: ${parsed.error}${extra}` }], isError: true };
      }
      return { content: [{ type: "text", text: parsed.html || parsed.result || responseText }] };
    } catch {
      return { content: [{ type: "text", text: responseText }] };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

// ─── 尝试晋升主实例:探活 → 原子绑定 → 失败即降级 PROXY ───
async function tryStartPrimary() {
  // 1. 探活优先
  const probe = await probePrimaryHealth();
  if (probe === 'primary') {
    // 本工具主实例已就位，自觉转 PROXY，不争端口
    console.error(`[bridge] Active primary instance detected on :${HTTP_PORT}, running in PROXY mode.`);
    isProxy = true;
    return null;
  }
  if (probe === 'foreign') {
    // 端口被非本工具服务占用(或本工具正在启动、/health 尚未就绪)。
    // 不 exit(避免误杀竞态中的正常场景)、也不抢端口,降级 PROXY;
    // 运行期 callTool 的探活会对每次调用二次校验,对端不可用时返回明确错误。
    console.error(`[bridge] Port ${HTTP_PORT} answered but not as browser-link primary; running in PROXY mode (will re-verify per call).`);
    isProxy = true;
    return null;
  }

  // 2. 端口空闲(probe==='none') → 原子绑定 WS(48765) + HTTP(48766)
  const wssHttpServer = http.createServer();
  const httpServer = http.createServer();
  const rollback = (reason) => {
    console.error(`[bridge] ${reason}, rolling back to PROXY mode.`);
    try { wssHttpServer.close(); } catch {}
    try { httpServer.close(); } catch {}
    isProxy = true;
    return null;
  };

  if (!(await bindPortAtomic(wssHttpServer, WS_PORT))) {
    // 探活扑空但 WS 已被占:典型竞态(另一进程刚抢先绑定)，降级 PROXY 让它当主
    return rollback(`WS port ${WS_PORT} occupied`);
  }
  console.error(`[bridge] PRIMARY mode: WebSocket listening on 127.0.0.1:${WS_PORT}`);

  if (!(await bindPortAtomic(httpServer, HTTP_PORT))) {
    // WS 已绑成功但 HTTP 冲突 → 必须先关掉 WS 再降级，否则占着端口空转
    return rollback(`HTTP port ${HTTP_PORT} occupied (WS already bound, releasing)`);
  }

  return setupPrimaryInstance(wssHttpServer, httpServer);
}

// ─── 启动主流程 ───
let primaryResources = await tryStartPrimary();
// primaryResources 为 null 说明当前进程作为 PROXY 运行，请求透明转发至 127.0.0.1:48766。

const server = new Server(
  { name: "browser_link_tool", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
server.setRequestHandler(CallToolRequestSchema, callTool);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[bridge] MCP server connected via stdio (mode: ${isProxy ? 'PROXY' : 'PRIMARY'})`);

// ─── 空闲自退（仅代理实例）───
// 主实例连着浏览器 WS，退出会断连，故不启用；代理实例是每会话拉起的转发进程，空闲即退避免堆积。
let idleTimer = null;
function bumpIdleTimer() {
  if (!isProxy) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error(`[bridge] PROXY idle for ${IDLE_TIMEOUT_MS / 60000}min, exiting.`);
    cleanup();
  }, IDLE_TIMEOUT_MS);
  if (idleTimer.unref) idleTimer.unref(); // 计时器不阻止进程正常退出
}
bumpIdleTimer(); // 启动即开始计时；主实例中为 no-op

async function cleanup() {
  if (primaryResources) {
    const { wss, wssHttpServer, httpServer, debounceTimer } = primaryResources;
    if (wss) { wss.clients.forEach(c => c.close()); wss.close(); }
    if (wssHttpServer) wssHttpServer.close();
    if (httpServer) httpServer.close();
    if (debounceTimer) clearTimeout(debounceTimer);
  }
  process.exit(0);
}

process.stdin.on('close', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
