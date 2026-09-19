# Browser Link Tool

浏览器 MCP 控制桥:让 AI 助手(Claude Code / Antigravity / Cursor 等)通过 MCP 协议远程操控你浏览器里已打开的网页,作用于全站 `<all_urls>`。核心场景是**在 Arthas Web 控制台上敲命令诊断线上 Java 应用**——AI 自己生成命令、投递执行、采集纯文本结果回传,免去人工在终端和对话间来回拷贝;通用网页操作(读 HTML、点击、填表、截图等)则是顺带开放的能力。

因为扩展跑在你自己的浏览器里,**天然复用当前登录态**——内网系统不用重新认证。

> MCP Server 已发布到 npm([`browser-link-tool`](https://www.npmjs.com/package/browser-link-tool)),`npx -y browser-link-tool` 即可拉起,无需克隆仓库(仍需手动加载 Chrome 扩展,见下)。

---

## 目录结构

本工具由三个构件组成,分目录存放、各装到各自宿主,目录名即角色:

| 目录 | 构件 | 作用 | 装到哪(宿主) | 由谁 / 如何加载 |
|---|---|---|---|---|
| `extension/` | Chrome 扩展(MV3) | 在浏览器里实际执行注入、抓页面、连 bridge | 浏览器(Chrome / Edge) | 手动:`chrome://extensions` → 开发者模式 →「加载已解压的扩展程序」选**此目录**;常驻后台 service worker |
| `mcp-bridge/` | MCP 桥(Node 进程) | 向 AI 暴露 MCP 工具,HTTP↔WebSocket 转发给扩展 | 装了 Node ≥ 18 的机器 | AI Agent 按其 MCP 配置以 **stdio 拉起** `mcp-server-bridge.mjs`(会话启动时);首个进程占 48765/48766 为主实例,余者降级为代理 |
| `skill/` | Skill 说明 | 告诉 Agent 何时用、怎么用、线上安全准则 | AI Agent 的 skills 目录 | 把 `skill/browser-link-tool/` **整个目录**复制到 `~/.claude/skills/`、`~/.codex/skills/` 等(skills 约定每个 skill 一个同名文件夹);也提供 `browser-link-tool.zip` 便于分发 |

```
browser-link-tool/
├── extension/                    # Chrome 扩展(加载此目录)
│   ├── manifest.json  background.js  arthas-ws-hook.js
│   ├── popup.html/.css/.js
│   └── icons/
├── mcp-bridge/                   # MCP 桥 + Node 依赖
│   ├── mcp-server-bridge.mjs
│   ├── README.md                 # npm 包内说明(发布用)
│   ├── package.json  package-lock.json
│   └── node_modules/
├── skill/                        # Skill 分发
│   ├── browser-link-tool/        # skill 目录(整个拷到 Agent skills 目录)
│   │   └── SKILL.md
│   └── browser-link-tool.zip     # 打包分发副本
├── install.sh                    # 一键安装
├── SHARING.md                    # 分享/介绍文档
└── README.md
```

---

## 快速开始

### 1. 安装

本工具三部分要各就各位:**① MCP Server**(AI Agent 侧)、**② Chrome 扩展**(浏览器侧,实际执行操作)、**③ Skill**(可选,让 Agent 知道怎么用)。① 已发布到 npm,推荐用 `npx` 零克隆安装。

#### 方式 A · npx(推荐,已发布到 npm)

无需克隆仓库、无需绝对路径。需 **Node ≥ 18**(MCP SDK 要求)。照你实际装的 Agent 择一,不必三个都做:

- **Claude Code**:`claude mcp add browser-link-tool -s user -- npx -y browser-link-tool`
  - `-s user` 写入 `~/.claude.json`、**所有项目**可用;省略则默认只当前项目,换目录会"工具消失"。
- **Codex**:`codex mcp add browser-link-tool -- npx -y browser-link-tool`(写入 `~/.codex/config.toml`,默认全局)。
- **Cursor / Cline / Windsurf 等粘 JSON 的客户端**(配置文件位置各家不同,以其文档为准):

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

> **Skill(可选,不装也能用)**:只是让 Agent「知道何时该用这套工具」。需要的话把仓库 `skill/browser-link-tool/` 整个目录拷到 skills 目录(Claude Code:`~/.claude/skills/`;Codex:`~/.codex/skills/`,视版本);目录拿不准就跳过。

> **⚠️ Node 版本可自定义(卡在「正在启动…」多半是这个原因)**:MCP 客户端会用它自己 PATH 里的 `node`/`npx`。若那个 node < 18,`npx` 会因 `engines` 不满足而装不上、命令找不到,表现为**一直卡在启动**。解决:把 `command` 换成 **node ≥18 的 npx 绝对路径**(不是裸 `npx`):
>
> ```json
> {
>   "mcpServers": {
>     "browser-link-tool": {
>       "command": "/opt/homebrew/bin/npx",
>       "args": ["-y", "browser-link-tool"]
>     }
>   }
> }
> ```
>
> 绝对路径按你的环境改:`which npx`(须对应 node ≥18);nvm 用户形如 `~/.nvm/versions/node/v20.x.x/bin/npx`。仍不行可清 npx 缓存 `rm -rf ~/.npm/_npx` 后重试,或改用方式 C(直接用 node 跑本地脚本,最不受 npx 影响)。

#### 方式 B · 克隆仓库 + 一键脚本(Claude Code / Codex)

```bash
cd browser-link-tool
./install.sh
```

脚本会:装依赖 → 检测到 `claude` / `codex` 分别注册 MCP(指向本地 `mcp-server-bridge.mjs`)→ 把 `skill/` 装到对应 skills 目录 → 打印扩展加载指引。适合想改源码 / 用本地版本的场景。

#### 方式 C · 克隆仓库 + 手动注册本地脚本

不想用 npm 版、要指向本地文件时:`cd mcp-bridge && npm install`(Node ≥ 18),拿 node 与 bridge 的**绝对路径**注册——`command` 填 node 绝对路径(勿写 `node`,避免版本不对)、`args` 填 `mcp-server-bridge.mjs` 绝对路径;Codex 用 TOML(`[mcp_servers.browser-link-tool]` + `command`/`args`)。

#### 三种方式都要:加载 Chrome 扩展

Chrome 扩展无法经 npm 分发,须从仓库获取 `extension/` 目录手动加载:`chrome://extensions`(或 `edge://extensions`)开启开发者模式 →「加载已解压的扩展程序」。

> **⚠️ 选 `extension/` 子目录,不是项目根目录**——选错会因找不到 `manifest.json` 加载失败,是最常见踩坑点。选对后点工具栏图标,面板显示「已连接」即就绪。

> **Node 版本**:Node ≥ 18 由 MCP SDK 要求,是硬门槛。

### AI Agent 自动安装参考

> 本节写给 AI:把这段连同仓库路径交给 AI Agent,它即可自行判断环境完成 MCP / Skill 注册(**唯有加载扩展必须人工**)。客户装的 Agent 形态不定,按探测结果择一即可。

**步骤**:① `command -v claude`/`codex` 探测可用 Agent;② `node -p 'process.versions.node'` 确认 ≥18,否则用 npx 绝对路径(见[排错](#排错));③ 按下表注册 MCP;④ 装 Skill(可选,目录拿不准就跳过);⑤ 提示用户手动加载 **`extension/` 子目录**。

| Agent | 注册命令 | 落盘位置 | 关键 | Skill 目录 |
|---|---|---|---|---|
| Claude Code | `claude mcp add browser-link-tool -s user -- npx -y browser-link-tool` | `~/.claude.json` | **必须 `-s user`**,缺省仅当前项目 | `~/.claude/skills/` 或 `.claude/skills/` |
| Codex | `codex mcp add browser-link-tool -- npx -y browser-link-tool` | `~/.codex/config.toml` | 默认全局 | `~/.codex/skills/`(视版本) |
| 粘 JSON 客户端 | 写 `mcpServers` JSON(见方式 A) | 各家不同 | — | 多数无 |

> ⚠️ 三个最常见坑:**扩展选 `extension/` 子目录而非根目录**;**Claude 漏 `-s user` 换目录就失效**;**运行中注册 MCP 需重启会话才生效**。

### 2. 自检全链路就绪

1. **扩展已连接**:点工具栏图标,面板显示「扩展连接:已连接」。同一时刻只保留一个连 bridge 的扩展(其他连 48765 端口的扩展请停用,避免端口争用)。
2. **MCP 已注册**:Claude Code 执行 `claude mcp list`、Codex 执行 `codex mcp list`,应看到 `browser-link-tool`(其他 Agent 用各自的 MCP 管理入口确认)。
3. **工具已进会话**:MCP 在会话启动时加载。**若在会话运行中才注册 MCP,需重启该会话**,`mcp_browser_*` 工具才会出现。

一句话自检:让 Agent 执行 `mcp_browser_list_tabs`,能列出标签页即全链路就绪。

> 适用于任何支持 MCP 的 AI 编码 Agent。上文以 Claude Code 为例,其他 Agent 的 MCP 注册命令与会话重启方式类推。

---

## 使用

对 Agent 说自然语言即可,它自己挑工具。

### 通用网页操作

- 「获取我当前标签页的 HTML」→ `snapshot`
- 「列出我打开的所有标签页」→ `list_tabs`
- 「点击登录按钮」→ 先 `snapshot` 定位选择器,再 `click`
- 「把搜索框填成 xxx 并回车」→ `fill` +(`evaluate` 派发回车或点提交)
- 「跳到某页等首页加载完再截图」→ `navigate` → `wait_for` → `scrolling_screenshot`
- 「读一下这个站点的 cookie / localStorage」→ `get_cookies` / `get_storage`

典型交互范式:`list_tabs` 拿 tabId → `navigate` / `snapshot` 加载读取 → `wait_for` 等关键元素 → `click` / `fill` 交互 → `evaluate` / `snapshot` 验证。

### 多标签页 / 多会话定向

- 缺省作用于**当前活动标签页**。
- 精确指定:先 `list_tabs` 拿 `tabId`,后续调用带 `tabId`;或用 `url_match`(URL 子串,如 `url_match: "github.com"`)。
- **锁定生效 tab**:面板点「锁定」把生效 tab 钉在当前标签页,之后不带 `tabId` / `url_match` 的调用都打到它,切换标签页不受影响,关闭该 tab 自动解锁。
- 优先级:**显式 `tabId` / `url_match` > 锁定 tab > 当前活动 tab**(AI 单次显式指定仍可覆盖锁定)。多个 Agent 会话并发时各带不同 `tabId` 即互不干扰。

### 在 Arthas Web 控制台诊断 Java 应用

让 AI 远程操控已打开的 [Arthas](https://arthas.aliyun.com/) Web Console:AI 生成命令 → `arthas_exec` 投递到网页终端执行 → 自动采集纯文本回传分析。对 Agent 说「跑一下 thread / 反编译某个类 / 看 dashboard」即可。

**行为**:同步阻塞,投递后自动等命令跑完(终端输出静默且尾部出现提示符 `[arthas@pid]$`),返回本次命令的纯文本(已剥离命令回显与提示符、不含历史)。全屏刷新型命令(`dashboard` / `monitor` / `watch -n`)会被**自动识别** → 自动 Ctrl+C 中断 → 返回最后一帧快照,调用方无需关心。原理见下文 [实现原理](#实现原理)。

**前提**:目标 Arthas tab 已 Connect 成功、终端就绪。首次装 / 重载扩展后,Arthas 页面需**刷新一次**,WebSocket hook 才能在建连前就位(否则报 `ws hook 未安装`)。

> **切勿手动发 `q`**:Arthas 提示符下 `q` = `quit`,会终止整个 Web 会话(需重连页面恢复;目标 JVM 的 agent 不受影响)。中断刷新 / 卡住的命令用 `interrupt: true`。

**🚨 线上安全(双层保护)**——命令真实在目标 JVM 上执行:

- **第一层 · 工具硬拦截**:对确定的高危命令名(`redefine` / `retransform` / `stop` / `reset` / `shutdown` / `sysprop` 写 / `vmoption` 写 / `tt --play`),工具会在 Arthas 页面**弹出确认框**展示命令与风险,点确认才执行、取消则返回 `cancelled:true`,无法从 AI 侧绕过(确认框弹在 Arthas 页面,该 tab 需在前台才看得到)。
- **第二层 · AI 把关**:`ognl` / `vmtool` 调有副作用方法等工具无法靠命令名识别的情况,由 AI 先分析风险再向用户说明确认。

- **① 🔴 高危改动 / 进程级 · 工具硬拦截 + 二次确认**:改代码类 `redefine` / `retransform`;进程级 `stop` / `reset` / `shutdown`;改配置 `sysprop` 写 / `vmoption` 写;`tt --play`(重放历史调用会真实再触发业务,可能重复下单/扣款)。这些命令名会在 Arthas 页面弹确认框、取消返回 `cancelled:true`,AI 无法绕过。执行前仍先讲清「做什么、是否可逆、影响范围」再取得同意。
- **② 🔴 隐性副作用 · AI 把关(命令名识别不了)**:`ognl` / `vmtool ... --express` 调 setter / 静态方法 / **有副作用的业务方法**(写库、发 MQ/RPC、改缓存、扣款/发券/改状态等)、访问会触发 lazy-init 的 getter/字段。工具靠命令名识别不了,由 AI 先分析风险(触碰哪些数据下游 / 是否可逆 / 影响范围)再向用户确认;不确定有无副作用时一律按高危,先读源码定性。
- **③ 🟠 可搞挂 JVM / 长 STW · 只读也须先确认版本**:同属「堆遍历 / attach,老版本 JDK 有已知崩溃或长停顿」的操作,虽不改数据但可致 JVM 崩溃 / agent 线程退出 / WebSocket 断开:
  - `vmtool getInstances`:走 JVMTI `FollowReferences` **全堆扫描**找实例。**已实测**:健康进程上其他命令(`thread`/`sc`/`ognl` 等)全正常、唯独此命令重复触发进程崩溃;扫 `@Configuration` 等 CGLIB 增强、结构复杂的类会加剧。
  - `vmtool forceGc`:同走 JVMTI,老版本可能触发 agent 异常。
  - `heapdump`:全堆 dump,老 JDK + 大堆可致长 STW / OOM / 崩溃。
  - `profiler`(async-profiler):靠 `AsyncGetCallTrace` + 信号,部分老版本 JDK 有已知崩溃案例。
  - **共同把关**:① 先 `version` 确认 JVM 版本,老版本(如 1.8.0_65 等早期小版本)一律按高危、先向用户说明崩溃风险并确认;② 优先改用侵入更小的替代(`ognl`/`getstatic` 取已知静态引用、`sc -d` 看类信息、经已知入口 `watch`/`trace` 拿实例);③ 必须执行时 `getInstances` 带 `--limit` 控量,`heapdump`/`profiler` 避开高峰。
- **④ 🟡 性能损耗 / 有残留 · 先说明再执行**:`trace` / `watch` / `tt`(仅观测) / `monitor` / `stack`(字节码增强,高频方法有损耗、残留监听器)。用完及时 `interrupt` 退出、`-n` 限次数;`sc *` / `sm *` 大范围通配全扫也可能卡住,尽量收窄匹配。
- **⑤ 🟢 只读 · 可直接执行**:`sc` / `sm` / `jad` / `thread` / `dashboard` / `session` / `version` / `sysprop`(读)/ `getstatic` / `ognl` 纯读(不调有副作用方法)/ `vmtool` 读字段(⚠️ **不含 `getInstances` / `forceGc`**,见 ③)。

`arthas_exec` 入参:

| 入参 | 说明 |
|---|---|
| `command` | 要执行的 Arthas 命令,如 `version`、`thread`、`sc *ChaseMoney*` |
| `timeout` | 可选,命令最长等待毫秒,默认 60000。`thread` 全量 / `trace`/`watch` 首触发等慢命令请加大 |
| `idle_ms` | 可选,输出连续无变化多久视为完成,默认 800 |
| `read_only` | 可选,`true` 时不投递命令,仅采集当前终端 buffer 全文(探活 / 校准用) |
| `interrupt` | 可选,`true` 时只发 Ctrl+C 中断当前前台命令,不投递新命令,`command` 可留空 |
| `snapshot` | 可选,全屏刷新型命令显式取单帧快照(默认已能自动识别,一般无需手动传);配合 `render_wait`(默认 2500ms)调渲染等待 |
| `auto_snapshot_ms` | 可选,全屏刷新自动检测阈值:命令持续输出且始终等不到静默提示符达此毫秒数,则判定为刷新型命令自动中断取最后一帧,默认 4000 |
| `tabId` / `url_match` | 定位 Arthas tab,如 `url_match: "arthas-console"` |

---

## 参考

### MCP 工具一览

| 工具 | 能力 |
|---|---|
| `mcp_browser_snapshot` | 获取页面完整 HTML |
| `mcp_browser_evaluate` | 执行任意 JS 并返回结果 |
| `mcp_browser_click` | CSS 选择器点击 |
| `mcp_browser_fill` | 填充输入框 / contenteditable |
| `mcp_browser_navigate` | 跳转 URL |
| `mcp_browser_scrolling_screenshot` | 截当前可视区一屏(PNG) |
| `mcp_browser_list_tabs` | 列出所有标签页(拿 tabId) |
| `mcp_browser_activate_tab` | 激活指定标签页 |
| `mcp_browser_wait_for` | 等待元素出现(可选可见性 / 文本) |
| `mcp_browser_get_storage` / `set_storage` | 读写 localStorage / sessionStorage |
| `mcp_browser_get_cookies` / `set_cookies` | 读写 Cookie |
| `mcp_browser_arthas_exec` | 在 Arthas Web 控制台投递命令并采集执行结果 |

除 `list_tabs` 外,所有工具均支持可选 `tabId` / `url_match` 定向目标标签页。

### 扩展面板

- **连接状态**:Bridge 服务是否运行、扩展是否连接、运行模式(主 / 代理)。
- **当前生效标签页**:标题 / URL / tabId,可**锁定**。
- **全部标签页**:列表可点击切换激活,锁定的 tab 高亮。
- **快捷操作**:复制当前 Tab 信息(含 tabId)、刷新。

---

## 架构与实现原理

```
AI Agent ──MCP stdio──► mcp-bridge/mcp-server-bridge.mjs ──HTTP:48766──► WebSocket:48765 ──► extension/(Chrome 扩展) ──► 目标网页
```

- **主 / 代理多实例**:首个进程占用 48765 / 48766 成为主实例;后续进程自动降级为代理,经 48766 转发。多个 agent 会话可并存。
- **多会话定向**:每个工具都支持可选 `tabId` / `url_match`,优先级 `tabId` > `url_match` > 当前活动 tab。

普通网页操作走常规套路:扩展经 `chrome.scripting.executeScript` 把脚本注入目标页执行、回传结果。真正有门道的是 Arthas 控制台桥接——以下是几个「不写清楚就会踩坑」的机制。

### 为什么 Arthas 控制台要特殊处理

Arthas Web Console 是 **xterm.js 终端**,想从「终端渲染层」拿数据的三条常规路全被堵死:

1. **输出画在 `<canvas>` 上,DOM 里没有文本节点** —— `snapshot` / 读 innerText 只能拿到空壳。
2. **页面 CSP 禁止 `eval`** —— 靠 eval 注入执行 JS 的 `mcp_browser_evaluate` 在该页直接被拦。
3. **xterm 实例被封在页面模块闭包里** —— 从 `window`、DOM 元素、组件树各条路径都反查不到那个能读 `buffer` 的实例(实测 xterm DOM 元素的自有属性全为空)。

所以放弃「读终端画面」这个维度,换成接管数据源。

### 换维度:接管页面自己的 WebSocket

分析 Arthas 前端 bundle 后发现:终端的输入输出全走**一条 WebSocket 隧道**,和渲染完全解耦:

```js
// 发命令(用户每次键入,逐字符):
ws.send(JSON.stringify({ action: "read", data: <keystrokes> }))
// 收输出(服务端回的终端字节流,含 ANSI 转义):
ws.onmessage = e => term.write(e.data)
```

于是根本不用碰 xterm 实例,**直接接管这条 ws**:

- 扩展在 `document_start`、以 `MAIN world` 注入脚本,在页面建连**之前**包装 `window.WebSocket`,捕获 Arthas 隧道实例。
- 所有 `message` 的 `data` 带时间戳累积进缓冲区,即完整终端输出流。
- 暴露一个发送入口,投递命令即 `ws.send({action:"read", data: cmd + "\r"})`。

> 代价:动态注册脚本对**已打开的页面不生效**。所以首次装 / 重载扩展后,Arthas 页面必须**刷新一次**,hook 才能赶在建连前就位(否则 `arthas_exec` 报 `ws hook 未安装`)。

### 输出清洗:ANSI 与 \r 覆盖

终端字节流带大量 ANSI 控制序列(颜色、光标、清屏),要还原成人类可读文本:

- 剥离 CSI / OSC / SGR 等转义序列;
- **关键坑**:必须先把 `\r\n` 归一化成 `\n`——否则按 `\n` 分行后每行尾残留 `\r`,处理「回车覆盖」时会把整行清空(曾导致输出全是空行);
- 再处理退格、行内 `\r` 覆盖。

### 命令完成判定 & 全屏命令自动快照

- **顺序命令**:轮询缓冲区,当输出**静默**(`idle_ms` 内无新增)且尾部出现提示符 `[arthas@pid]$` 时判定完成,截取本次新增段清洗返回。
- **全屏刷新命令**(`dashboard` 等):它周期性重打印整屏、永不静默。实测它不用光标定位序列而是顺序重画,特征是「**同一帧头行重复出现**」。据此识别:命令发出超阈值仍在刷新、且帧头重复 ≥2 次 → 判定全屏型 → 自动 Ctrl+C → 按帧头去重取**最后一帧**返回。顺序命令帧头只出现一次,永不误判。

---

## 排错

- **MCP 一直卡在「正在启动…」/ 启动超时**:客户端 PATH 里的 node < 18,`npx` 因 `engines` 装不上导致命令找不到。把配置 `command` 换成 node ≥18 的 **npx 绝对路径**(`which npx` 查,须对应 v18+),或改用方式 C 直接用 node 绝对路径跑本地脚本;必要时先 `rm -rf ~/.npm/_npx` 清缓存。
- **工具不存在 / 调不到**:MCP 未注册或会话未重启 → 确认注册后重启会话(Claude Code 用 `claude mcp list` 核对)。
- **`No Chrome Extension connected`**:扩展面板显示未连接,或 bridge 未运行 → 检查扩展是否启用、端口是否被别的 bridge 占用。
- **`Cannot snapshot internal browser pages`**:`chrome://` / `edge://` / `about:` 页面无法注入,切到普通网页。
- **元素找不到**:先 `snapshot` 看真实 DOM 再取选择器;动态渲染的先 `wait_for`。
- **`arthas_exec` 报 `ws hook 未安装`**:扩展刚装 / 重载,Arthas 页面在 hook 注入前就已建立 WebSocket → **刷新一次 Arthas 页面**即可。可先 `read_only: true` 看 `wsReadyState:1` 确认已捕获连接。
- **`arthas_exec` 输出为空 / 卡住不返回**:多半是终端停在某个前台命令(如之前的 `trace` / `watch` 挂着)→ 用 `interrupt: true` 发 Ctrl+C 回到提示符;切勿手动发 `q`(= quit 会断会话)。
