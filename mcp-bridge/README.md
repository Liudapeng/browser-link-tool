# browser-link-tool

浏览器 MCP 控制桥 —— 让支持 [MCP](https://modelcontextprotocol.io/) 的 AI 助手(Claude Code / Cursor / Codex 等)远程操控你浏览器里**已打开、已登录**的网页,并在 **Arthas Web 控制台**上敲命令诊断线上 Java 应用。

这个 npm 包是其中的 **MCP Server(bridge)**。完整工具还需要一个配套的 **Chrome 扩展**(在浏览器里实际执行操作)——见下文。

> 项目仓库:https://github.com/Liudapeng/browser-link-tool

## 能力

- **通用网页操作**:读渲染后 HTML、CSS 选择器点击/填表、导航、执行 JS、截图、等元素、读写 localStorage / Cookie。
- **Arthas Web 控制台**:AI 生成命令 → 投递到网页终端执行 → 采集纯文本结果回传,免去人工在终端和对话间来回拷贝。全屏刷新命令(dashboard 等)自动取快照;高危命令(redefine/reset/…)会在页面弹确认框硬拦截。
- **多会话隔离**:多个 AI 会话(Claude / Gemini / Codex …)可同时连一个浏览器。每个会话**自动绑定**它首次操作的标签页,之后不带 `tabId` 也只操作自己那个,互不串扰;需要时仍可显式传 `tabId` / `url_match` 切换目标(会更新绑定)。
- **会话监控面板**:扩展弹窗实时列出当前在线的 AI 会话——自动识别是哪个客户端(靠 MCP 握手上报,零配置)、主/代理模式、正在操作哪个标签页、绿点(活跃)/灰点(空闲),每 3 秒自刷。

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
