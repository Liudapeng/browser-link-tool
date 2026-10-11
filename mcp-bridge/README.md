# browser-link-tool

浏览器 MCP 控制桥 —— 让支持 [MCP](https://modelcontextprotocol.io/) 的 AI 助手(Claude Code / Cursor / Codex 等)远程操控你浏览器里**已打开、已登录**的网页,并在 **Arthas Web 控制台**上敲命令诊断线上 Java 应用。

这个 npm 包是其中的 **MCP Server(bridge)**。完整工具还需要一个配套的 **Chrome 扩展**(在浏览器里实际执行操作)——见下文。

> 项目仓库:https://github.com/Liudapeng/browser-link-tool

## 能力

- **前端开发自主调试闭环**:AI 改完代码后自己在你眼前的浏览器里测交互、读控制台报错、抓接口请求、截图确认渲染——**自测通过才交卷**,不再盲写。详见下文。
- **通用网页操作**:读渲染后 HTML、CSS 选择器点击/填表/按键、导航、执行 JS、截图、等元素、读写 localStorage / Cookie。
- **Arthas Web 控制台**:AI 生成命令 → 投递到网页终端执行 → 采集纯文本结果回传,免去人工在终端和对话间来回拷贝。全屏刷新命令(dashboard 等)自动取快照;高危命令(redefine/reset/…)会在页面弹确认框硬拦截。
- **多会话隔离**:多个 AI 会话(Claude / Gemini / Codex …)可同时连一个浏览器。每个会话**自动绑定**它首次操作的标签页,之后不带 `tabId` 也只操作自己那个,互不串扰;需要时仍可显式传 `tabId` / `url_match` 切换目标(会更新绑定)。
- **会话监控面板**:扩展弹窗实时列出当前在线的 AI 会话——自动识别是哪个客户端(靠 MCP 握手上报,零配置)、主/代理模式、正在操作哪个标签页、绿点(活跃)/灰点(空闲),每 3 秒自刷。

## 前端开发调试:为什么要用插件而不是 Playwright

脱离这类工具,AI 写前端只能**盲写**:你描述问题 → AI 改代码 → 你切浏览器看效果、F12 看报错 → 再截图贴回去。

而「让 AI 跑 Playwright 访问 `localhost:5173`」在本地开发中有三个难受的点:

| | 独立 Playwright / 无头浏览器 | 本工具(附着你眼前的 Chrome) |
|---|---|---|
| **深度调试状态** | 白板冷启动。已登录的账号、选好的租户、点开的第三层抽屉、Redux/Pinia 里的 Mock 数据,全要重走前置操作 | 操作的就是你**当前正停在那个弹窗**的标签页,状态完全保留 |
| **HMR 热更新** | 另起浏览器,融不进你眼前的开发主屏 | AI 改完代码,Vite / Next.js 原地热替换,AI 立刻取证,**人机同屏** |
| **F12 共存** | 多数原生 CDP 工具要求独占连接,一按 F12 就断 | **实测可与 DevTools 共存** |

**最实用的 4 个功能点:**

1. **`get_console`** — 页面白屏/逻辑不生效,多半是 `Uncaught TypeError`、React Hydration mismatch、缺 `key`。不用你贴报错,AI 自己拿错误栈和行号就修好。
2. **`get_network`** — 点了保存没反应:没发请求?参数序列化错了?还是后端 400/500?`click` 后调 `get_network({with_body:true})` 截获请求体与响应体,直接定位前端传参还是接口契约问题。
3. **`outline` + `fill` + `click` + `get_element`** — 带表单校验、级联下拉、异步 Loading 的组件,AI 交付前自己跑一遍:填非法邮箱 → 点提交 → 查校验文案是否出现。`outline` 返回可交互元素精简清单,比整页 HTML 省大量 context。
4. **`scrolling_screenshot`** — 调 Tailwind / flex 居中 / 移动端溢出时,AI 截一屏用多模态**亲眼看**渲染结果,确认有没有对齐、是否撑破滚动条。

> ⚠️ `get_console` / `get_network` 首次调用只装捕获钩子、返回 `installed:true`(**此前的日志抓不到**),需在触发操作后**再调一次**才拿到数据。

**推荐姿势**:本地 `npm run dev`,Chrome 常驻一个 `localhost:xxxx` 标签页;下需求时加一句「改完代码后在当前标签页测一下交互,看控制台有没有报错,截图确认效果」。


## 安装

### 1. 注册 MCP Server

需 **Node ≥ 18**(MCP SDK 要求)。用 `npx` 直接跑,无需全局安装,照实际装的 Agent 择一:

- **Claude Code**:`claude mcp add browser-link-tool -s user -- npx -y browser-link-tool`(`-s user` 才跨项目,省略则仅当前项目)
- **Codex**:`codex mcp add browser-link-tool -- npx -y browser-link-tool`(写入 `~/.codex/config.toml`,默认全局)
- **Cursor / Cline / Windsurf 等粘 JSON 的客户端**(配置位置各家不同):

  ```json
  {
    "mcpServers": {
      "browser-link-tool": {
        "command": "npx",
        "args": ["-y", "browser-link-tool"]
      }
    }
  }
  ```

配置后重启 AI 会话。

> 想让 AI 自己判断环境、自动完成注册?仓库主 README 有「AI Agent 自动安装参考」小节(含各 Agent 差异对照表与踩坑清单),整段喂给 AI 即可。

### 2. 加载 Chrome 扩展(必需)

MCP Server 只是"AI 侧";实际操作浏览器要靠配套扩展。从项目仓库 https://github.com/Liudapeng/browser-link-tool 获取 `extension/` 目录 → 打开 `chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」选该目录。**注意选 `extension/` 子目录,不是项目根目录**,否则找不到 `manifest.json` 会加载失败。点工具栏图标,面板显示「已连接」即就绪。

> 扩展与 bridge 通过本地 WebSocket(:48765)/ HTTP(:48766)通信,服务仅绑 `127.0.0.1`、全在本机、不出网。

## 验证

让 AI 执行 `mcp_browser_list_tabs`,能列出标签页即全链路就绪。

## 诊断 Arthas

打开 Arthas Web Console 连上目标 JVM → **刷新一次页面**(让扩展的 WebSocket hook 就位)→ 让 AI 跑命令。高危命令会弹确认框,需让 Arthas 标签页处于前台。

## 说明

- Chrome 扩展无法经 npm 分发,须手动加载(见上)。
- 本包不含截图拼接等重依赖,`npx` 拉起快、跨平台无原生编译。
