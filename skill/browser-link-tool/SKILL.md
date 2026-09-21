---
name: browser-link-tool
description: 通过浏览器 MCP 控制桥（Browser Link Tool 扩展 + mcp-server-bridge）远程操控真实浏览器网页：列出可交互元素精简清单、DOM 结构树、元素取证(候选selector)、点选取证、探测页面框架/技术栈、读取页面 HTML、读元素状态/属性、点击/填充/下拉选择/按键/悬停/滚动、导航、执行 JS、截图、等待元素、读写 localStorage/sessionStorage/Cookie、捕获 console 日志与 fetch/XHR 网络请求、在 Arthas Web 控制台投递命令并采集执行结果，并支持多会话按 tabId 定向不同标签页互不干扰。TRIGGER — 当用户要求「操作浏览器网页」「点击/填写/下拉选择页面某元素」「按回车/Tab/Esc」「悬停展开菜单」「列出页面可点元素」「看页面 DOM 结构/骨架」「取证元素/拿某元素的 selector」「点选页面元素」「探测页面用什么框架/技术栈」「插件/油猴脚本开发解析网站」「截图当前页面」「读取页面 HTML/DOM」「等页面加载后再操作」「读写网页 Cookie/localStorage」「看页面报错/console 日志」「抓页面接口请求/响应」「在指定标签页执行」「多个会话分别控制不同 tab」「在 Arthas 控制台执行命令」「远程跑 arthas thread/watch/trace/jad」，或提到 mcp_browser_* 工具时使用。
---

# Browser Link Tool — 浏览器 MCP 操控

用 `mcp_browser_*` 系列工具操控真实浏览器。前提：Browser Link Tool 扩展已加载且面板显示「已连接」，bridge 已注册为 MCP Server（见插件目录 `install.sh`）。

## 工具清单

| 工具 | 入参（除 tabId/url_match 外） | 用途 |
|---|---|---|
| `mcp_browser_list_tabs` | 无 | 列出所有 tab，拿 `tabId` |
| `mcp_browser_activate_tab` | — | 激活/聚焦指定 tab |
| `mcp_browser_outline` | `scope?`,`include_hidden?`,`max_items?` | ⭐ 可交互元素精简清单(带 selector/文本/状态)，定位元素首选 |
| `mcp_browser_dom_tree` | `scope?`,`max_depth?`,`max_nodes?`,`include_text?` | DOM 结构骨架树(层级+tag#id.class+data)，看页面结构 |
| `mcp_browser_inspect_element` | `selector?`,`x?`,`y?` | 取证单个元素→多种候选 selector+属性+祖先链 |
| `mcp_browser_pick_element` | `cancel?` | 点选取证(需用户在浏览器亲手点)，回吐被点元素的 selector |
| `mcp_browser_detect_env` | — | 探测框架(React/Vue/ExtJS…)+全局变量+技术栈 |
| `mcp_browser_snapshot` | — | 返回完整 HTML（渲染后），outline/dom_tree 不够时才用 |
| `mcp_browser_get_element` | `selector`,`attr?` | 读元素状态(visible/disabled/rect)或属性(value/text/html) |
| `mcp_browser_evaluate` | `code` | 执行 JS，返回结果字符串 |
| `mcp_browser_click` | `selector` | 点击元素 |
| `mcp_browser_fill` | `selector`,`value` | 填充输入框/contenteditable |
| `mcp_browser_select_option` | `selector`,`value`,`by_label?` | 选原生 `<select>` 下拉项 |
| `mcp_browser_press_key` | `key`,`selector?` | 派发按键(Enter/Tab/Esc/方向键等) |
| `mcp_browser_hover` | `selector` | 悬停触发下拉菜单/tooltip |
| `mcp_browser_scroll_to` | `selector` | 滚动元素到视口中央 |
| `mcp_browser_navigate` | `url` | 跳转 |
| `mcp_browser_wait_for` | `selector`,`text?`,`visible?`,`timeout?` | 等待元素出现 |
| `mcp_browser_scrolling_screenshot` | `output_path?` | 截当前可视区一屏 → PNG 路径 |
| `mcp_browser_get_console` | `clear?`,`max_items?` | 读 console 日志/报错(⚠️首调仅装钩子) |
| `mcp_browser_get_network` | `clear?`,`with_body?`,`max_items?` | 读 fetch/XHR 请求记录(⚠️首调仅装钩子) |
| `mcp_browser_get_storage` | `storageType?`,`key?` | 读 local/session storage |
| `mcp_browser_set_storage` | `storageType?`,`key`,`value` | 写 storage |
| `mcp_browser_get_cookies` | `url?`,`name?` | 读 Cookie |
| `mcp_browser_set_cookies` | `url?`,`name`,`value`,… | 写 Cookie |
| `mcp_browser_arthas_exec` | `command`,`timeout?`,`idle_ms?`,`read_only?`,`interrupt?`,`snapshot?`,`render_wait?`,`auto_snapshot_ms?` | 在 Arthas Web 控制台投递命令并采集输出 |

## 多会话定向（关键）

每个 agent 会话在 bridge 侧是独立会话,**自动绑定**它操作的标签页,多会话互不串扰:

- **自动绑定**:你(本会话)首次操作某 tab 后,bridge 记住它——之后不带 `tabId` 的调用都只作用于这个 tab,即使用户切到别的标签页、或别的 agent 会话在操作别的 tab,都不影响你。
- **显式切换**:任何调用带 `tabId`(先 `list_tabs` 拿)或 `url_match`(URL 子串)即操作该 tab,并把本会话重新绑定到它。
- **优先级**:显式 `tabId` / `url_match` > 本会话已绑定的 tab > 当前活动 tab(首次操作时用活动 tab 并绑定)。
- **要严格作用于某 tab 时**:优先显式带 `tabId`,最稳妥;不带时依赖自动绑定,首次操作前请确认当前活动 tab 是你想要的。

## 标准操作范式

1. **定位目标 tab**：`mcp_browser_list_tabs` → 选出目标 `tabId`（或直接用 `url_match`）。
2. **加载**：需要跳转则 `mcp_browser_navigate`。
3. **摸清页面结构**：优先 `mcp_browser_outline` 拿【可交互元素清单】——它直接给出每个按钮/链接/输入框的 `selector`、文本、可见/禁用状态，省去啃整页 HTML。**outline 不够时**（要看非交互文本、复杂结构、特殊 DOM）才 `mcp_browser_snapshot` 取全量 HTML。
4. **等待就绪**：异步渲染页面先 `mcp_browser_wait_for`（带 selector，必要时 text/visible），避免操作过早失败。
5. **交互**：`click` / `fill` / `select_option` / `press_key` / `hover`；元素不在视口先 `scroll_to`。
6. **验证**：`mcp_browser_get_element`（读 value/text/visible）或再次 `outline` 确认结果符合预期。

## 选择器与元素定位策略

- **别凭空猜 selector**：先 `outline`（首选，省 context）或 `snapshot` 拿到真实 DOM 再操作。`outline` 返回的 `selector` 可直接喂给 `click`/`fill`。
- **outline 输出格式**：纯文本每行一元素 `[i] kind "text" [flags] @selector`，行尾 `@` 后即 selector（截取喂 `click`/`fill`）；默认已过滤被 Modal/遮罩遮挡的元素，需看被遮挡元素传 `include_hidden=true`。
- **outline 的 selector 稳定性**：优先 `#id` > `[name]` > `[aria-label]` > `nth-of-type` 路径。带 id/name 的最稳；纯 `nth-of-type` 路径在动态列表里可能失效，操作前用 `wait_for`/`get_element` 复核。
- **范围收窄**：页面元素多时给 `outline` 传 `scope`（如某弹窗/表单容器的选择器），只列该容器内的可交互元素，更省更准。
- **点击前探测**：`click` 已内置——disabled/aria-disabled 元素直接返回 `Error: element is disabled`，视口外元素自动 `scrollIntoView` 滚入再点。拿不准是否就绪时仍可先 `get_element`（看 visible/disabled）复核。
- **交互原子选型**：原生 `<select>` 用 `select_option`（别用 click 硬点选项）；回车提交/Tab 切换/Esc 关窗用 `press_key`；hover 才展开的菜单先 `hover` 再操作;懒加载列表先 `scroll_to`。

## 插件开发解析（dom_tree / inspect_element / pick_element / detect_env）

为浏览器扩展/油猴脚本开发解析目标站点时用，比啃 `snapshot` 整页 HTML 高效：

- **先看骨架**：`dom_tree` 拿页面结构树（tag#id.class[data-*] + 层级 + 子节点数），超长同类兄弟自动折叠。定位「大致在哪个容器」。
- **取证具体元素**：`inspect_element` 传 selector 或 `x`/`y` 坐标，回吐**多种候选 selector**（按稳定性排序）+ 全部关键属性 + 祖先链 + 子元素概览。写扩展代码要 selector 时用这个，别自己从 snapshot 里猜。
- **让用户指认**：`pick_element` 用于 agent 难以描述、但用户一眼能认的元素。首次调用进入点选模式（页面出现高亮遮罩），**需用户在浏览器亲手点击**目标（agent 代劳不了），点完 agent 再次调用读取结果；`cancel:true` 退出。
- **摸技术栈**：`detect_env` 识别页面框架（React/Vue/jQuery/ExtJS/Angular…）及版本、window 自定义全局变量、script 来源域。决定扩展怎么注入、怎么和页面 JS 交互前先跑一次。

## 调试捕获（get_console / get_network）

排查页面报错、确认接口是否发出/返回什么时用这两个工具。**注入式捕获，务必理解时序**：

- **首次调用只安装钩子**，返回 `installed:true`、日志/请求为空——**此前发生的日志和请求抓不到**。
- 正确用法：**先调一次装钩子 → 触发页面操作（点击/提交/跳转）→ 再调一次读取**。
- `get_network` 默认只给 method/url/status/耗时；要看响应体传 `with_body:true`（截前 1000 字符）。
- `clear:true` 读完清空，便于下一轮只看增量。
- 局限：`navigate`/刷新会重建页面、钩子丢失，需重新装；跨页面持续追踪不适用。

## Arthas Web 控制台操控（mcp_browser_arthas_exec）

Arthas Console 是 xterm.js 终端(canvas 渲染、DOM 无文本、CSP 禁 eval),`snapshot`/`evaluate` 取不到结果,必须用本工具。

**⭐ 先查源码再发命令**:对某个类/方法/字段动手前,先在当前工作区 grep 源码确认——完整包名、方法重载/参数、字段拼写(避免 `sc`/`trace` 类名猜错空转);该类是否属于当前连接的 JVM(不同微服务互不可见,可 `sysprop sun.java.command` 核对);`trace`/`watch` 前搞清方法怎么被触发(避免空等超时)。读不到源码再 `jad` 反编译。

**行为**:同步阻塞,投递 `command` → 等命令跑完(输出静默且尾部现提示符 `[arthas@pid]$`)→ 返回本次纯文本(已剥离回显/提示符、不含历史)。

**参数与模式**:
- `read_only:true` — 只读当前终端 buffer,不发命令(探活/校准)。
- `interrupt:true` — 只发 Ctrl+C 中断卡住的前台命令(如挂着空等的 `trace`/`watch`),`command` 可空。**勿手动发 `q`**(=quit,会断整个 Web 会话)。
- 全屏刷新命令(`dashboard`/`monitor`/`watch -n`)**自动识别+取快照**,照常只传 `command`;想省几秒等待可显式 `snapshot:true`(配 `render_wait`,默认 2500ms)。
- `timeout` 默认 60s,`thread` 全量 / `trace` 首触发等更慢时加大。

**🚨 线上安全**:命令真实在目标 JVM 执行。按风险分档,逐档把关:

- **① 🔴 高危改动/进程级——工具硬拦截 + 二次确认**:`redefine`/`retransform`(改类字节码)、`stop`/`reset`/`shutdown`(动进程/卸载增强)、`sysprop` 写/`vmoption` 写(改配置)、`tt --play`(重放历史调用,会真实再触发业务、可能重复下单/扣款)。这些命令名会在 Arthas 页面**弹确认框**,取消则返回 `cancelled:true`,AI 无法绕过。弹窗在 Arthas 页面,该 tab 需在前台用户才看得到;须在 `timeout` 内点击,否则超时返回。
- **② 🔴 隐性副作用——AI 把关(命令名识别不了)**:`ognl`/`vmtool ... --express` 调 setter/静态方法/**有副作用的业务方法**(写库、发 MQ/RPC、改缓存、扣款/发券等)、访问会触发 lazy-init 的 getter/字段。执行前**先分析风险**(做什么/触碰哪些数据下游/是否可逆/影响范围)**再向用户确认**;不确定有无副作用时一律按高危,先读源码定性。
- **③ 🟠 可搞挂 JVM / 长 STW(老 JDK 尤甚)——执行前走标准流程**:下列命令依赖 JNI 本地库 / 堆遍历 / attach,虽不改数据,但在老 JDK 或高负载进程上可致 **进程崩溃 / 被探针摘除**。两种失败模式(实测均见过,别混为一谈):
  - **A. native 库崩溃**:`vmtool getInstances` 需加载 Arthas JNI 本地库,老环境(glibc/libstdc++ ABI 不兼容)会在 `dlopen` 初始化时 `free(): invalid pointer` 直接崩进程、打 dump。**实测** 1.8.0_65 反复触发;社区同款 [arthas#2839](https://github.com/alibaba/arthas/issues/2839)(1.8.0_202)命令结构一致、"一旦崩基本可复现"。反之较新 JDK(实测 1.8.0_452)对 `--express` 调 JDK 核心类 native 方法(如 `Runtime.maxMemory()`)会被 **OGNL stricter invocation mode** 拦下报 `IllegalAccessException ... under stricter invocation mode`——是被主动挡住,别硬试,改走下方替代。
  - **B. 全堆遍历 STW**:`getInstances` 底层堆扫描代价跟**堆大小**相关(与实例数无关),在内存高位 + GC 已吃力的进程上叠加一次 STW,停顿放大 → 命令超时 + ws 断开 → 存活探针拿不到响应 → 实例被重启/摘除。**实测** 高位 GC 进程(~2.9G 堆、young GC 极频)上命令即超时、ws readyState=3、实例被 down。
  - 同类命令:`vmtool forceGc`(走 JVMTI,老版本可能触发 agent 异常)、`heapdump`(全堆 dump,老 JDK+大堆致长 STW/OOM/崩溃)、`profiler`(async-profiler 靠 `AsyncGetCallTrace`+信号,部分老 JDK 有崩溃案例)。

  **标准作业流程(跑上述任一命令前逐步执行,不可跳步)**:
  1. **提醒摘流量**:明确告知用户「此命令可能致进程崩溃或被探针摘除,建议先把该实例从负载均衡摘除 / 停止流量再操作」,取得确认。
  2. **风险提示**:讲清做什么、是否可逆、影响范围(A 类崩进程不可逆需重启,B 类冻应用可能触发自动摘除)。
  3. **查 JVM 版本**:先 `version`(或 `sysprop java.version`)拿到确切版本号。
  4. **查下表判定**:命中「高危」行则默认不执行,先向用户说明并寻求替代;确需执行时按「缓解」列操作。

  **版本 × 命令 风险对照表**(⚠️ 阈值区分实测与经验,勿当绝对保证;拿不准一律按高危):

  | 命令 | 高危区间 | 相对稳(经验值,非保证) | 缓解 / 替代 |
  |---|---|---|---|
  | `vmtool getInstances` | **JDK 8 早期小版本**(实测 1.8.0_65 崩;社区 1.8.0_202 崩) | 经验上 8u252+ 较少见崩溃报告,但**非确证**;高负载进程仍可能 STW 摘除 | 读环境数据别用它 → `dashboard`/`jvm` 看内存 CPU;取已知静态引用用 `ognl @类@静态`/`getstatic`;找实例经已知入口 `watch`/`trace`;必须用时带 `--limit` 控量、避开高峰、先摘流量 |
  | `vmtool forceGc` | JDK 8 早期小版本 | 8u252+ 经验较稳 | 一般无需手动 GC;观测 GC 用 `dashboard`/`jstat` |
  | `heapdump` | 任意版本 + 大堆 / 高峰 | 小堆 / 低峰相对安全 | 避开高峰;能定位问题优先 `jmap -histo` 之类轻量方式 |
  | `profiler` | 部分老 JDK(有崩溃案例) | 较新 JDK 相对稳 | 短时采样、避开高峰;先在预发验证 |
- **④ 🟡 性能损耗/有残留——先说明再执行**:`trace`/`watch`/`monitor`/`stack`/`tt`(仅观测)(字节码增强,高频方法有损耗、残留监听器)。用完及时 `interrupt` 退出、`-n` 限次数;`sc *`/`sm *` 大范围通配全扫也可能卡住,尽量收窄匹配。
- **⑤ 🟢 只读 · 可直接执行**:`sc`/`sm`/`jad`/`thread`/`dashboard`/`session`/`version`/`sysprop` 读/`getstatic`/`ognl` 纯读(不调有副作用方法)/`vmtool` 读字段。⚠️ **不含 `vmtool getInstances`/`forceGc`**(见 ③)。

**前提**:Arthas tab 已 Connect、终端就绪(`url_match:"arthas-console"` 定位)。首次装/重载扩展后需**刷新一次** Arthas 页面,ws hook 才就位(否则报 `ws hook 未安装`)。

## 常见坑与约定

- **选择器先取证**：不要凭空猜 selector，先 `snapshot` 或 `evaluate` 查真实 DOM。
- **fill 后需触发事件**：工具已自动派发 input/change，并用原生原型 setter 穿透 React/Vue 受控组件劫持（受控表单填值不再被回滚）；对 contenteditable（富文本）走 execCommand 模拟输入。
- **evaluate 无需写 `return`**：裸表达式（`document.title`）、多行以表达式结尾、顶层 `await`（`await fetch(u).then(r=>r.status)`）都能直接拿到值——内部自动判包裹。**唯一例外**：多语句且以表达式结尾又无 return（如 `let x=1; x+1`）会得 `undefined`，改写成 `let x=1; return x+1` 即可。返回值经 `String()` 序列化，复杂对象请自行 `JSON.stringify(...)`。
- **evaluate 读页面对象靠 MAIN world**：主路径走 debugger、降级路径走 executeScript，两者都注入页面 MAIN world，故 `window.Ext`/`VueRouter` 等页面全局变量都读得到。若目标页**开着 F12**，debugger 被 DevTools 独占 → 自动走降级路径（同样 MAIN，仍正常）。读到 `undefined` 先排查该全局变量是否本就不存在（而非「桥不通」）。
- **截图**:`scrolling_screenshot` 截当前可视区一屏(不滚动拼接),返回 PNG 文件路径,随后可用 Read 查看。
- **wait_for 超时**：默认 10s，慢页面显式加大 `timeout`。
- **内部页不可操作**：`chrome://` / `edge://` / `about:` 无法 snapshot/注入。
- **未连接报错**：若返回「No Chrome Extension connected」，提示用户检查扩展面板是否「已连接」、bridge 是否运行。
