let socket = null;
let reconnectTimer = null;

// ─── 注册 Arthas WebSocket hook(document_start / MAIN world)──────────
// 必须在页面建立 WebSocket 之前注入,故用 document_start。注册后已打开的页面需刷新一次才生效。
async function registerArthasHook() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['arthas-ws-hook'] });
    if (existing && existing.length) return;
  } catch (e) { /* ignore */ }
  try {
    await chrome.scripting.registerContentScripts([{
      id: 'arthas-ws-hook',
      matches: ['*://*/*'],
      js: ['arthas-ws-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false
    }]);
  } catch (e) {
    console.error('[arthas-hook] register failed:', e);
  }
}
chrome.runtime.onInstalled.addListener(registerArthasHook);
chrome.runtime.onStartup.addListener(registerArthasHook);
registerArthasHook();


// ─── 目标 Tab 解析：tabId > urlMatch > 活动 tab ───
async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true });
  }
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

// ─── 锁定生效 tab:存 chrome.storage.local,跨 popup/background 共享(MV3 休眠也不丢)───
const LOCKED_TAB_KEY = 'lockedTabId';

async function getLockedTabId() {
  try {
    const o = await chrome.storage.local.get(LOCKED_TAB_KEY);
    const v = o && o[LOCKED_TAB_KEY];
    return typeof v === 'number' ? v : null;
  } catch (e) { return null; }
}

async function clearLockedTab() {
  try { await chrome.storage.local.remove(LOCKED_TAB_KEY); } catch (e) {}
}

// 被锁定的 tab 关闭时自动解锁
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const locked = await getLockedTabId();
  if (locked != null && locked === tabId) await clearLockedTab();
  await unbindClosedTab(tabId); // 该 tab 被任何会话绑定的,一并解绑
});

// ─── 会话 ↔ tab 绑定:每个 agent 会话独立锁定自己操作的 tab(多会话互不干扰)───
// 存 chrome.storage.local 的对象 map { sessionId: tabId }。可重绑:会话每次显式带 tabId 即更新。
const SESSION_BIND_KEY = 'sessionTabBindings';

async function getBindings() {
  try {
    const o = await chrome.storage.local.get(SESSION_BIND_KEY);
    return (o && o[SESSION_BIND_KEY]) || {};
  } catch (e) { return {}; }
}
// 串行化所有 read-modify-write:storage 异步,多会话并发写会互相覆盖(后写者丢前写者),
// 用一条 Promise 链把写操作排队,保证读-改-写原子。
let bindWriteChain = Promise.resolve();
function mutateBindings(fn) {
  bindWriteChain = bindWriteChain.then(async () => {
    try {
      const b = await getBindings();
      if (fn(b)) await chrome.storage.local.set({ [SESSION_BIND_KEY]: b });
    } catch (e) {}
  });
  return bindWriteChain;
}
async function setBinding(sessionId, tabId) {
  if (!sessionId) return;
  await mutateBindings((b) => { b[sessionId] = tabId; return true; });
}
async function getBinding(sessionId) {
  if (!sessionId) return null;
  const b = await getBindings();
  const v = b[sessionId];
  return typeof v === 'number' ? v : null;
}
async function unbindClosedTab(tabId) {
  await mutateBindings((b) => {
    let changed = false;
    for (const k of Object.keys(b)) { if (b[k] === tabId) { delete b[k]; changed = true; } }
    return changed;
  });
}

// 记录每次调用 resolve 到的真实 tab(按 msg.id),供 send 回传给 bridge 更新面板显示
const resolvedTabByMsgId = new Map();
async function resolveTab(msg) {
  const tab = await resolveTabInner(msg);
  if (msg && msg.id != null && tab) {
    resolvedTabByMsgId.set(msg.id, { tabId: tab.id, title: tab.title || '' });
  }
  return tab;
}

async function resolveTabInner(msg) {
  const sid = msg && msg.__session;
  if (msg && msg.tabId != null) {
    try {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      if (tab) { await setBinding(sid, tab.id); return tab; } // 显式 tabId 更新会话绑定
    } catch (e) { /* fall through */ }
    throw new Error(`Tab ${msg.tabId} not found`);
  }
  if (msg && msg.urlMatch) {
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find(t => t.url && t.url.includes(msg.urlMatch));
    if (hit) { await setBinding(sid, hit.id); return hit; }
    throw new Error(`No tab matching url "${msg.urlMatch}"`);
  }
  // 无显式目标:优先该会话已绑定的 tab(每会话独立)
  const boundId = await getBinding(sid);
  if (boundId != null) {
    try {
      const tab = await chrome.tabs.get(boundId);
      if (tab) return tab;
    } catch (e) {
      await unbindClosedTab(boundId); // 绑定 tab 已关,解绑后继续回退
    }
  }
  // 会话无绑定 → 退全局锁(popup 手动锁,作跨会话兜底)
  const lockedId = await getLockedTabId();
  if (lockedId != null) {
    try {
      const tab = await chrome.tabs.get(lockedId);
      if (tab) { await setBinding(sid, tab.id); return tab; }
    } catch (e) {
      await clearLockedTab();
    }
  }
  // 最终回退活动 tab,并绑定给该会话(此后该会话钉在此 tab,直到显式改)
  const active = await getActiveTab();
  if (!active) throw new Error('No active tab found (Browser might be fully hidden)');
  await setBinding(sid, active.id);
  return active;
}

function isInternalPage(url) {
  return url && (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:'));
}

// 通过 DevTools 协议在页面上下文执行代码，不受页面 CSP（script-src 无 unsafe-eval）约束。
// attach → Runtime.evaluate（returnByValue 拿可序列化结果）→ 无论成败都 detach，避免顶部调试黄条常驻。
async function evaluateViaDebugger(tabId, code) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const res = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      // 包进 async IIFE：与降级路径语义一致（允许顶层 return / 多条语句），
      // 且支持用户代码里写顶层 await（配合 awaitPromise:true 拿到 resolve 后的值）。
      expression: '(async function(){' + code + '})()',
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const desc = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text;
      return 'Error: ' + desc;
    }
    const r = res && res.result;
    if (!r) return 'undefined';
    if (r.type === 'undefined') return 'undefined';
    if ('value' in r) return typeof r.value === 'object' ? JSON.stringify(r.value) : r.value;
    return r.description != null ? r.description : String(r.type);
  } finally {
    try { await chrome.debugger.detach(target); } catch (e) {}
  }
}

function send(id, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    // 附带本次实际操作的 tab(供 bridge 面板显示"谁在操作哪个 tab"),随后清理
    const rt = resolvedTabByMsgId.get(id);
    if (rt) resolvedTabByMsgId.delete(id);
    socket.send(JSON.stringify({ id, ...payload, __resolvedTab: rt || null }));
  }
}

function connect() {
  if (socket && socket.readyState !== WebSocket.CLOSED) return;

  socket = new WebSocket('ws://127.0.0.1:48765');

  socket.onopen = () => {
    console.log('MCP Bridge connected!');
    clearTimeout(reconnectTimer);
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) { return; }

    try {
      switch (msg.action) {
        case 'reload': {
          send(msg.id, { status: 'reloading' });
          setTimeout(() => chrome.runtime.reload(), 300);
          return;
        }

        case 'list_tabs': {
          const tabs = await chrome.tabs.query({});
          const list = tabs.map(t => ({
            tabId: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            windowId: t.windowId,
            favIconUrl: t.favIconUrl
          }));
          send(msg.id, { result: JSON.stringify(list) });
          return;
        }

        case 'get_current_tab': {
          const tab = await resolveTab(msg);
          send(msg.id, { result: JSON.stringify({
            tabId: tab.id, title: tab.title, url: tab.url,
            active: tab.active, windowId: tab.windowId, favIconUrl: tab.favIconUrl
          }) });
          return;
        }

        case 'activate_tab': {
          const tab = await resolveTab(msg);
          await chrome.tabs.update(tab.id, { active: true });
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
          send(msg.id, { result: `Activated tab ${tab.id}: ${tab.title}` });
          return;
        }

        case 'snapshot': {
          const tab = await resolveTab(msg);
          if (isInternalPage(tab.url)) {
            return send(msg.id, { error: 'Cannot snapshot internal browser pages' });
          }
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML
          });
          if (results && results[0]) send(msg.id, { html: results[0].result });
          else send(msg.id, { error: 'Failed to extract HTML' });
          return;
        }

        case 'evaluate': {
          const tab = await resolveTab(msg);
          // 优先走 chrome.debugger（DevTools 协议 Runtime.evaluate）：在页面上下文执行动态字符串，
          // 但不受页面 CSP 的 script-src 约束，可正常跑严格 CSP（禁 eval）站点的代码。
          try {
            const result = await evaluateViaDebugger(tab.id, msg.code);
            const s = String(result);
            if (s.startsWith('Error: ')) send(msg.id, { error: s.slice(7) });
            else send(msg.id, { result: s });
            return;
          } catch (dbgErr) {
            // debugger 不可用（如已被 DevTools 占用、权限被拒）时，降级到扩展注入器 new Function。
            // 该路径受页面 CSP 约束，仅适用于未禁 eval 的普通页面。
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              world: 'MAIN', // 必须注入 MAIN world：页面的 Ext/框架/自定义全局变量都挂在 MAIN 的 window 上，ISOLATED world 是隔离副本读不到，会返回 undefined。
              func: async (codeStr) => {
                // async + await：与 debugger 路径一致，支持用户代码写顶层 await。
                try { return String(await (new Function('return (async()=>{' + codeStr + '})()'))()); }
                catch (e) { return 'Error: ' + e.message; }
              },
              args: [msg.code]
            });
            const s = String(results[0] ? results[0].result : 'undefined');
            if (s.startsWith('Error: ')) send(msg.id, { error: s.slice(7) });
            else send(msg.id, { result: s });
            return;
          }
        }

        case 'click': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector) => {
              try {
                const el = document.querySelector(selector);
                if (!el) return `Error: Element ${selector} not found`;
                // 派发完整鼠标序列，兼容仅监听 mousedown/mouseup 的元素（如 CodeMirror 工具条、ExtJS 按钮）。
                // executeScript 为扩展特权注入，不受页面 CSP 限制，可安全构造并派发事件。
                const r = el.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
                const fire = (Ctor, type, init) => el.dispatchEvent(new Ctor(type, init));
                try { fire(PointerEvent, 'pointerdown', { ...base, pointerId: 1, isPrimary: true }); } catch (_) {}
                fire(MouseEvent, 'mousedown', base);
                try { el.focus(); } catch (_) {}
                try { fire(PointerEvent, 'pointerup', { ...base, buttons: 0, pointerId: 1, isPrimary: true }); } catch (_) {}
                fire(MouseEvent, 'mouseup', { ...base, buttons: 0 });
                fire(MouseEvent, 'click', { ...base, buttons: 0 });
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'fill': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, val) => {
              try {
                const el = document.querySelector(sel);
                if (!el) return `Error: Element ${sel} not found`;
                if (el.isContentEditable) {
                  el.focus();
                  const s = window.getSelection();
                  s.selectAllChildren(el);
                  document.execCommand('insertText', false, val);
                  return 'success';
                }
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector, msg.value]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'navigate': {
          const tab = await resolveTab(msg);
          await chrome.tabs.update(tab.id, { url: msg.url });
          send(msg.id, { result: `Navigated to ${msg.url}` });
          return;
        }

        case 'wait_for': {
          const tab = await resolveTab(msg);
          const timeout = msg.timeout || 10000;
          const interval = msg.interval || 300;
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (selector, text, wantVisible, timeoutMs, intervalMs) => {
              const deadline = Date.now() + timeoutMs;
              const isVisible = (el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
              };
              while (Date.now() < deadline) {
                const el = document.querySelector(selector);
                if (el) {
                  const visOk = !wantVisible || isVisible(el);
                  const textOk = !text || (el.textContent || '').includes(text);
                  if (visOk && textOk) return 'found';
                }
                await new Promise(r => setTimeout(r, intervalMs));
              }
              return 'timeout';
            },
            args: [msg.selector, msg.text || null, msg.visible !== false, timeout, interval]
          });
          const r = results[0].result;
          if (r === 'found') send(msg.id, { result: `Element "${msg.selector}" ready` });
          else send(msg.id, { error: `Timed out (${timeout}ms) waiting for "${msg.selector}"` });
          return;
        }

        case 'outline': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (opts) => {
              const { includeHidden, maxItems, scope } = opts;
              const root = scope ? document.querySelector(scope) : document;
              if (!root) return 'Error: scope not found: ' + scope;
              const isVisible = (el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
              };
              // 为元素算一个尽量稳定、可直接喂给 click/fill 的 CSS 选择器：
              // id > [name] > [aria-label] > 唯一 class 组合 > :nth-of-type 兜底。
              const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
              const selectorFor = (el) => {
                if (el.id) return '#' + cssEscape(el.id);
                const name = el.getAttribute('name');
                if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
                const aria = el.getAttribute('aria-label');
                if (aria) return el.tagName.toLowerCase() + '[aria-label="' + aria + '"]';
                // nth-of-type 路径（相对最近有 id 的祖先，控制长度）
                const parts = [];
                let cur = el;
                while (cur && cur.nodeType === 1 && parts.length < 4) {
                  if (cur.id) { parts.unshift('#' + cssEscape(cur.id)); break; }
                  const tag = cur.tagName.toLowerCase();
                  const parent = cur.parentElement;
                  if (!parent) { parts.unshift(tag); break; }
                  const sames = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
                  parts.unshift(sames.length > 1 ? tag + ':nth-of-type(' + (sames.indexOf(cur) + 1) + ')' : tag);
                  cur = parent;
                }
                return parts.join(' > ');
              };
              const label = (el) => {
                const tag = el.tagName.toLowerCase();
                let t = '';
                if (tag === 'input' || tag === 'textarea') {
                  t = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || '';
                  if (el.value) t += (t ? ' =' : '') + '「' + el.value.slice(0, 40) + '」';
                } else if (tag === 'select') {
                  const opt = el.options[el.selectedIndex];
                  t = (el.getAttribute('aria-label') || el.getAttribute('name') || '') + (opt ? ' →' + opt.text : '');
                } else {
                  t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
                  if (!t) t = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
                }
                return t;
              };
              const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [contenteditable=true], [onclick]';
              const seen = new Set();
              const out = [];
              for (const el of root.querySelectorAll(SEL)) {
                if (seen.has(el)) continue;
                seen.add(el);
                const vis = isVisible(el);
                if (!vis && !includeHidden) continue;
                const tag = el.tagName.toLowerCase();
                const type = el.getAttribute('type');
                const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
                const kind = tag === 'input' ? 'input:' + (type || 'text')
                  : tag === 'a' ? 'link' : tag;
                out.push({
                  i: out.length,
                  kind,
                  text: label(el),
                  selector: selectorFor(el),
                  ...(vis ? {} : { hidden: true }),
                  ...(disabled ? { disabled: true } : {})
                });
                if (out.length >= maxItems) break;
              }
              return JSON.stringify({ count: out.length, truncated: out.length >= maxItems, elements: out });
            },
            args: [{ includeHidden: msg.include_hidden === true, maxItems: msg.max_items || 200, scope: msg.scope || null }]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'get_element': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector, attr) => {
              try {
                const el = document.querySelector(selector);
                if (!el) return `Error: Element ${selector} not found`;
                if (attr) {
                  if (attr === 'value') return String(el.value != null ? el.value : '');
                  if (attr === 'text') return (el.textContent || '').trim();
                  if (attr === 'html') return el.innerHTML;
                  return String(el.getAttribute(attr));
                }
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
                return JSON.stringify({
                  tag: el.tagName.toLowerCase(),
                  text: (el.textContent || '').trim().slice(0, 200),
                  value: el.value != null ? el.value : undefined,
                  visible,
                  disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
                  rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
                });
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector, msg.attr || null]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'select_option': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector, value, byLabel) => {
              try {
                const el = document.querySelector(selector);
                if (!el) return `Error: Element ${selector} not found`;
                if (el.tagName.toLowerCase() !== 'select') return 'Error: not a <select> element';
                let matched = -1;
                for (let k = 0; k < el.options.length; k++) {
                  const o = el.options[k];
                  if (byLabel ? o.text.trim() === value : o.value === value) { matched = k; break; }
                }
                if (matched < 0) return `Error: option not found (${byLabel ? 'label' : 'value'}=${value})`;
                el.selectedIndex = matched;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector, msg.value, msg.by_label === true]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'press_key': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector, key) => {
              try {
                const el = selector ? document.querySelector(selector) : document.activeElement;
                if (!el) return `Error: Element ${selector} not found`;
                // 常用键名 → keyCode 映射（够覆盖回车/Tab/Esc/方向键等高频场景）。
                const map = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
                const k = key === 'Space' ? ' ' : key;
                const code = map[key] || map[k] || 0;
                // 生成合法 DOM code：命名键(Enter/Tab/箭头等)用键名本身；
                // 单个字母→KeyX，数字→DigitN，空格→Space；其余回退键名。
                let domCode;
                if (key === ' ' || key === 'Space') domCode = 'Space';
                else if (/^[a-zA-Z]$/.test(key)) domCode = 'Key' + key.toUpperCase();
                else if (/^[0-9]$/.test(key)) domCode = 'Digit' + key;
                else domCode = key;
                try { el.focus(); } catch (_) {}
                const init = { bubbles: true, cancelable: true, composed: true, key: k, code: domCode, keyCode: code, which: code };
                el.dispatchEvent(new KeyboardEvent('keydown', init));
                el.dispatchEvent(new KeyboardEvent('keypress', init));
                el.dispatchEvent(new KeyboardEvent('keyup', init));
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector || null, msg.key]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'hover': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector) => {
              try {
                const el = document.querySelector(selector);
                if (!el) return `Error: Element ${selector} not found`;
                const r = el.getBoundingClientRect();
                const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
                try { el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1 })); } catch (_) {}
                el.dispatchEvent(new MouseEvent('mouseover', base));
                el.dispatchEvent(new MouseEvent('mouseenter', base));
                el.dispatchEvent(new MouseEvent('mousemove', base));
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'scroll_to': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector) => {
              try {
                const el = document.querySelector(selector);
                if (!el) return `Error: Element ${selector} not found`;
                el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'inspect_element': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (selector, px, py) => {
              try {
                const el = selector ? document.querySelector(selector)
                  : (px != null && py != null) ? document.elementFromPoint(px, py) : null;
                if (!el) return 'Error: element not found (selector or x/y)';
                const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
                // 多候选 selector，按稳定性从高到低
                const cands = [];
                if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) cands.push('#' + cssEscape(el.id));
                const nm = el.getAttribute('name'); if (nm) cands.push(el.tagName.toLowerCase() + '[name="' + nm + '"]');
                for (const a of el.getAttributeNames()) {
                  if (a.startsWith('data-') && el.getAttribute(a)) {
                    const s = el.tagName.toLowerCase() + '[' + a + '="' + el.getAttribute(a) + '"]';
                    if (document.querySelectorAll(s).length === 1) { cands.push(s); break; }
                  }
                }
                const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/).filter(Boolean) : [];
                if (cls.length) { const s = el.tagName.toLowerCase() + '.' + cls.map(cssEscape).join('.'); if (document.querySelectorAll(s).length === 1) cands.push(s); }
                // nth-of-type 路径兜底
                const path = []; let cur = el;
                while (cur && cur.nodeType === 1 && path.length < 5) {
                  if (cur.id) { path.unshift('#' + cssEscape(cur.id)); break; }
                  const tag = cur.tagName.toLowerCase(); const p = cur.parentElement;
                  if (!p) { path.unshift(tag); break; }
                  const same = Array.from(p.children).filter(c => c.tagName === cur.tagName);
                  path.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag);
                  cur = p;
                }
                cands.push(path.join(' > '));
                // 关键属性
                const attrs = {};
                for (const a of el.getAttributeNames()) {
                  if (['id', 'class', 'name', 'type', 'role', 'href', 'src', 'placeholder', 'title'].includes(a) || a.startsWith('data-') || a.startsWith('aria-')) {
                    attrs[a] = (el.getAttribute(a) || '').slice(0, 120);
                  }
                }
                // 祖先链（简写）
                const brief = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '');
                const ancestors = []; let a = el.parentElement;
                while (a && ancestors.length < 6) { ancestors.unshift(brief(a)); a = a.parentElement; }
                // 直接子元素概览
                const childCount = {}; for (const c of el.children) { const t = c.tagName.toLowerCase(); childCount[t] = (childCount[t] || 0) + 1; }
                const r = el.getBoundingClientRect(); const csv = getComputedStyle(el);
                return JSON.stringify({
                  tag: el.tagName.toLowerCase(),
                  selectors: cands,
                  attrs,
                  text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150),
                  value: el.value != null ? el.value : undefined,
                  visible: r.width > 0 && r.height > 0 && csv.visibility !== 'hidden' && csv.display !== 'none',
                  rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
                  ancestors,
                  children: childCount
                });
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.selector || null, msg.x != null ? msg.x : null, msg.y != null ? msg.y : null]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'pick_element': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (cancel) => {
              const OKEY = '__blt_pick_overlay__', RKEY = '__blt_pick_result__', SKEY = '__blt_pick_state__';
              const teardown = () => {
                if (window[OKEY]) { try { window[OKEY].box.remove(); window[OKEY].tip.remove(); } catch (_) {} }
                if (window[OKEY] && window[OKEY].handlers) { const h = window[OKEY].handlers; document.removeEventListener('mousemove', h.mm, true); document.removeEventListener('click', h.ck, true); document.removeEventListener('keydown', h.kd, true); }
                window[OKEY] = null; window[SKEY] = 'idle';
              };
              if (cancel) { teardown(); return JSON.stringify({ picking: false, cancelled: true }); }
              // 已有结果：吐出并清理
              if (window[RKEY]) { const res = window[RKEY]; window[RKEY] = null; window[SKEY] = 'idle'; return JSON.stringify({ picked: true, element: res }); }
              // 正在拾取中：还没点
              if (window[SKEY] === 'picking') return JSON.stringify({ picked: false, picking: true, hint: '请在浏览器中点击目标元素（Esc 取消）' });
              // 首次：装遮罩 + 监听
              const box = document.createElement('div');
              box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:2px;transition:all .03s;';
              const tip = document.createElement('div');
              tip.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;right:0;background:#2563eb;color:#fff;font:13px/28px -apple-system,sans-serif;text-align:center;height:28px;pointer-events:none;';
              tip.textContent = '点选取证：移动鼠标高亮元素，点击选定，Esc 取消';
              document.documentElement.appendChild(box); document.documentElement.appendChild(tip);
              const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s);
              const extract = (el) => {
                const cands = [];
                if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) cands.push('#' + cssEscape(el.id));
                const nm = el.getAttribute('name'); if (nm) cands.push(el.tagName.toLowerCase() + '[name="' + nm + '"]');
                const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\s+/).filter(Boolean) : [];
                if (cls.length) { const s = el.tagName.toLowerCase() + '.' + cls.map(cssEscape).join('.'); if (document.querySelectorAll(s).length === 1) cands.push(s); }
                const path = []; let cur = el;
                while (cur && cur.nodeType === 1 && path.length < 5) { if (cur.id) { path.unshift('#' + cssEscape(cur.id)); break; } const tag = cur.tagName.toLowerCase(); const p = cur.parentElement; if (!p) { path.unshift(tag); break; } const same = Array.from(p.children).filter(c => c.tagName === cur.tagName); path.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(cur) + 1) + ')' : tag); cur = p; }
                cands.push(path.join(' > '));
                const attrs = {}; for (const a of el.getAttributeNames()) { if (['id', 'class', 'name', 'type', 'role', 'href'].includes(a) || a.startsWith('data-')) attrs[a] = (el.getAttribute(a) || '').slice(0, 120); }
                return { tag: el.tagName.toLowerCase(), selectors: cands, attrs, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150) };
              };
              const mm = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); if (!el || el === box || el === tip) return; const r = el.getBoundingClientRect(); box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px'; window[OKEY]._hover = el; };
              const ck = (e) => { e.preventDefault(); e.stopPropagation(); const el = window[OKEY] && window[OKEY]._hover; if (el) window[RKEY] = extract(el); teardown(); };
              const kd = (e) => { if (e.key === 'Escape') { teardown(); } };
              document.addEventListener('mousemove', mm, true); document.addEventListener('click', ck, true); document.addEventListener('keydown', kd, true);
              window[OKEY] = { box, tip, handlers: { mm, ck, kd }, _hover: null };
              window[SKEY] = 'picking';
              return JSON.stringify({ picked: false, picking: true, hint: '已进入点选模式，请在浏览器中点击目标元素（Esc 取消），然后再次调用本工具读取结果' });
            },
            args: [msg.cancel === true]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'dom_tree': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (opts) => {
              try {
                const { scope, maxDepth, maxNodes, includeText } = opts;
                const root = scope ? document.querySelector(scope) : document.body;
                if (!root) return 'Error: scope not found: ' + scope;
                const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'TEMPLATE']);
                const lines = []; let count = 0; let truncated = false;
                const brief = (el) => {
                  const tag = el.tagName.toLowerCase();
                  const id = el.id ? '#' + el.id : '';
                  const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
                  const data = el.getAttributeNames().filter(a => a.startsWith('data-')).slice(0, 2).map(a => '[' + a + '=' + (el.getAttribute(a) || '').slice(0, 20) + ']').join('');
                  return tag + id + cls + data;
                };
                const walk = (el, depth) => {
                  if (count >= maxNodes) { truncated = true; return; }
                  if (SKIP.has(el.tagName)) return;
                  count++;
                  let line = '  '.repeat(depth) + brief(el);
                  if (includeText) {
                    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
                    if (own) line += '  "' + own.replace(/\s+/g, ' ').slice(0, 40) + '"';
                  }
                  const kids = Array.from(el.children).filter(c => !SKIP.has(c.tagName));
                  if (kids.length) line += '  {' + kids.length + '}';
                  lines.push(line);
                  if (depth >= maxDepth) { if (kids.length) lines.push('  '.repeat(depth + 1) + '…(' + kids.length + ' more, max depth)'); return; }
                  // 折叠超长同 tag 兄弟：连续 >8 个同 tag 只展开前 3 + 计数
                  let i = 0;
                  while (i < kids.length) {
                    const tag = kids[i].tagName; let j = i;
                    while (j < kids.length && kids[j].tagName === tag) j++;
                    const run = j - i;
                    if (run > 8) {
                      for (let k = i; k < i + 3; k++) walk(kids[k], depth + 1);
                      lines.push('  '.repeat(depth + 1) + tag.toLowerCase() + ' ×' + run + ' (省略 ' + (run - 3) + ' 个同类)');
                    } else {
                      for (let k = i; k < j; k++) walk(kids[k], depth + 1);
                    }
                    i = j;
                  }
                };
                walk(root, 0);
                return JSON.stringify({ nodes: count, truncated, tree: lines.join('\n') });
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [{ scope: msg.scope || null, maxDepth: msg.max_depth || 8, maxNodes: msg.max_nodes || 300, includeText: msg.include_text === true }]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'detect_env': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN', // 框架挂在页面 window 上，必须 MAIN world 才探得到
            func: () => {
              try {
                const fw = [];
                const push = (name, ver) => fw.push(ver ? name + ' ' + ver : name);
                if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot],#root [class]')) {
                  let v = window.React && window.React.version; push('React', v || '(detected)');
                }
                if (window.__VUE__ || window.Vue || document.querySelector('[data-v-app],#app.__vue_app__')) { push('Vue', window.Vue && window.Vue.version || '(detected)'); }
                if (window.jQuery) push('jQuery', window.jQuery.fn && window.jQuery.fn.jquery);
                if (window.Ext) push('ExtJS', window.Ext.version || (window.Ext.getVersion && String(window.Ext.getVersion())));
                if (window.ng || window.getAllAngularRootElements || document.querySelector('[ng-version]')) { const a = document.querySelector('[ng-version]'); push('Angular', a ? a.getAttribute('ng-version') : '(detected)'); }
                if (window.Backbone) push('Backbone', window.Backbone.VERSION);
                if (window.Zepto) push('Zepto');
                if (window.d3) push('d3', window.d3.version);
                if (window.echarts) push('ECharts', window.echarts.version);
                // 自定义全局变量（排除标准内建）
                // 用一个干净的 about:blank iframe 的 window 作基线：页面 window 上多出来的键
                // 才是站点自定义全局，天然滤掉所有 JS 语言内建(Object/Array/Promise…)和 DOM 内建。
                let baseKeys;
                try {
                  const fr = document.createElement('iframe');
                  fr.style.display = 'none'; document.documentElement.appendChild(fr);
                  if (!fr.contentWindow) throw new Error('no contentWindow');
                  baseKeys = new Set(Object.getOwnPropertyNames(fr.contentWindow));
                  fr.remove();
                } catch (_) {
                  // iframe 基线拿不到(CSP frame-src 拦截 / documentElement 未就绪)时，
                  // 退回当前 window 自身的键作基线：宁可漏报自定义全局，也不把全部内建当自定义泄漏。
                  baseKeys = new Set(Object.getOwnPropertyNames(window));
                }
                const globals = [];
                for (const k of Object.getOwnPropertyNames(window)) {
                  if (baseKeys.has(k) || k.startsWith('on') || k.startsWith('webkit') || k.startsWith('__')) continue;
                  let t; try { t = typeof window[k]; } catch (_) { continue; }
                  if (t === 'undefined') continue;
                  globals.push(k + ':' + t);
                  if (globals.length >= 60) break;
                }
                const scripts = Array.from(document.scripts);
                const srcHosts = {}; scripts.forEach(s => { if (s.src) { try { srcHosts[new URL(s.src).host] = (srcHosts[new URL(s.src).host] || 0) + 1; } catch (_) {} } });
                return JSON.stringify({
                  frameworks: fw,
                  charset: document.characterSet,
                  doctype: document.doctype ? document.doctype.name : null,
                  scriptCount: scripts.length,
                  scriptHosts: srcHosts,
                  customGlobals: globals
                });
              } catch (e) { return 'Error: ' + e.message; }
            }
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'get_network': {
          const tab = await resolveTab(msg);
          // 注入式捕获：劫持 fetch + XHR，记录 method/url/status/耗时（可选响应体片段）。
          // 首次调用装 hook 返回 installed:true，之后读缓存。避免 debugger 黄条 + SW 休眠丢数据。
          // 必须注入 MAIN world：页面的 fetch/XHR 都在 MAIN，ISOLATED world 的 window 是另一个对象、劫持不到。
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (clear, max, withBody) => {
              const KEY = '__blt_net_buf__';
              if (!window[KEY]) {
                const buf = [];
                window[KEY] = buf;
                const cap = 300;
                const rec = (e) => { buf.push(e); if (buf.length > cap) buf.shift(); };
                const clip = (s) => { try { return String(s).slice(0, 1000); } catch (_) { return ''; } };
                const origFetch = window.fetch;
                window.fetch = function (...a) {
                  const t0 = Date.now();
                  const url = (a[0] && a[0].url) || a[0];
                  const method = (a[1] && a[1].method) || 'GET';
                  return origFetch.apply(this, a).then(async (res) => {
                    const e = { type: 'fetch', method, url: String(url).slice(0, 300), status: res.status, ms: Date.now() - t0, t: t0 };
                    if (withBody) { try { e.body = clip(await res.clone().text()); } catch (_) {} }
                    rec(e); return res;
                  }).catch(err => { rec({ type: 'fetch', method, url: String(url).slice(0, 300), status: 0, error: String(err), ms: Date.now() - t0, t: t0 }); throw err; });
                };
                const OrigXHR = window.XMLHttpRequest;
                const origOpen = OrigXHR.prototype.open;
                const origSend = OrigXHR.prototype.send;
                OrigXHR.prototype.open = function (m, u) { this.__blt = { method: m, url: String(u).slice(0, 300), t0: Date.now() }; return origOpen.apply(this, arguments); };
                OrigXHR.prototype.send = function () {
                  if (this.__blt) this.addEventListener('loadend', () => {
                    const e = { type: 'xhr', method: this.__blt.method, url: this.__blt.url, status: this.status, ms: Date.now() - this.__blt.t0, t: this.__blt.t0 };
                    if (withBody) { try { e.body = clip(this.responseText); } catch (_) {} }
                    rec(e);
                  });
                  return origSend.apply(this, arguments);
                };
                return JSON.stringify({ installed: true, requests: [] });
              }
              const buf = window[KEY];
              const reqs = buf.slice(-max);
              if (clear) buf.length = 0;
              return JSON.stringify({ installed: false, count: reqs.length, requests: reqs });
            },
            args: [msg.clear === true, msg.max_items || 50, msg.with_body === true]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'get_console': {
          const tab = await resolveTab(msg);
          // 注入式捕获：首次调用装 hook（劫持 console + onerror，写入页面全局环形数组），
          // 之后每次调用读出缓存。SW 休眠也不丢日志（数据存在页面里）。clear=true 读完清空。
          // 必须注入 MAIN world：页面的 console/onerror 都在 MAIN，ISOLATED world 劫持不到页面日志。
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (clear, max) => {
              const KEY = '__blt_console_buf__';
              if (!window[KEY]) {
                const buf = [];
                window[KEY] = buf;
                const cap = 500;
                const push = (level, args) => {
                  try {
                    const text = args.map(a => {
                      if (a instanceof Error) return a.stack || a.message;
                      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
                      return String(a);
                    }).join(' ');
                    buf.push({ level, text: text.slice(0, 2000), t: Date.now() });
                    if (buf.length > cap) buf.shift();
                  } catch (_) {}
                };
                ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
                  const orig = console[level];
                  console[level] = function (...a) { push(level, a); return orig.apply(this, a); };
                });
                window.addEventListener('error', e => push('error', [e.message + ' @ ' + (e.filename || '') + ':' + e.lineno]));
                window.addEventListener('unhandledrejection', e => push('error', ['UnhandledRejection: ' + (e.reason && e.reason.stack || e.reason)]));
                return JSON.stringify({ installed: true, logs: [] });
              }
              const buf = window[KEY];
              const logs = buf.slice(-max);
              if (clear) buf.length = 0;
              return JSON.stringify({ installed: false, count: logs.length, logs });
            },
            args: [msg.clear === true, msg.max_items || 100]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'get_storage': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (type, key) => {
              try {
                const store = type === 'session' ? sessionStorage : localStorage;
                if (key) return JSON.stringify({ [key]: store.getItem(key) });
                const out = {};
                for (let i = 0; i < store.length; i++) {
                  const k = store.key(i);
                  out[k] = store.getItem(k);
                }
                return JSON.stringify(out);
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.storageType || 'local', msg.key || null]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'set_storage': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (type, key, value) => {
              try {
                const store = type === 'session' ? sessionStorage : localStorage;
                store.setItem(key, value);
                return 'success';
              } catch (e) { return 'Error: ' + e.message; }
            },
            args: [msg.storageType || 'local', msg.key, msg.value]
          });
          send(msg.id, { result: results[0].result });
          return;
        }

        case 'get_cookies': {
          const tab = await resolveTab(msg);
          const url = msg.url || tab.url;
          const query = { url };
          if (msg.name) query.name = msg.name;
          const cookies = await chrome.cookies.getAll(query);
          send(msg.id, { result: JSON.stringify(cookies.map(c => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate
          }))) });
          return;
        }

        case 'set_cookies': {
          const tab = await resolveTab(msg);
          const url = msg.url || tab.url;
          const detail = { url, name: msg.name, value: msg.value };
          if (msg.path) detail.path = msg.path;
          if (msg.domain) detail.domain = msg.domain;
          if (msg.secure != null) detail.secure = msg.secure;
          if (msg.httpOnly != null) detail.httpOnly = msg.httpOnly;
          if (msg.expirationDate != null) detail.expirationDate = msg.expirationDate;
          await chrome.cookies.set(detail);
          send(msg.id, { result: `Cookie ${msg.name} set for ${url}` });
          return;
        }

        case 'arthas_exec': {
          const tab = await resolveTab(msg);
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: async (command, opts) => {
              const sleep = (ms) => new Promise(r => setTimeout(r, ms));

              // ── 剥离 ANSI/控制序列,还原为可读纯文本 ──
              function stripAnsi(s) {
                if (!s) return '';
                // OSC: ESC ] ... BEL 或 ESC \
                s = s.replace(/\x1b\][\s\S]*?(\x07|\x1b\\)/g, '');
                // CSI: ESC [ ... 字母
                s = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
                // 其他单字符 ESC 序列
                s = s.replace(/\x1b[=>NOME78Hc]/g, '');
                s = s.replace(/\x1b\([AB012]/g, '');
                // 先归一化换行:\r\n -> \n(否则按 \n split 后每行尾残留 \r,导致后续 \r 覆盖逻辑把整行清空)
                s = s.replace(/\r\n/g, '\n');
                // 逐行处理孤立 \r(行内回车覆盖)与退格
                const rawLines = s.split('\n');
                const outLines = rawLines.map(line => {
                  // 孤立 \r:回车把光标移到行首,后写覆盖前写,取最后一段
                  let seg = line;
                  if (seg.indexOf('\r') !== -1) {
                    const parts = seg.split('\r');
                    seg = parts[parts.length - 1];
                  }
                  // 退格
                  let res = '';
                  for (const ch of seg) {
                    if (ch === '\b') res = res.slice(0, -1);
                    else if (ch === '\x07') { /* bell */ }
                    else res += ch;
                  }
                  return res;
                });
                return outLines.join('\n');
              }

              const hookOk = typeof window.__arthasSend__ === 'function' && Array.isArray(window.__arthasWsBuffer__);
              if (!hookOk) {
                return {
                  error: 'Arthas ws hook 未安装(需 document_start 注入后刷新页面)',
                  diag: {
                    hookInstalled: !!window.__arthasWsHookInstalled__,
                    hasSend: typeof window.__arthasSend__,
                    hasBuffer: Array.isArray(window.__arthasWsBuffer__),
                    wsReadyState: window.__arthasWs__ ? window.__arthasWs__.readyState : null
                  }
                };
              }

              const promptRe = /\[arthas@\d+\]\$\s*$/;
              const buf = window.__arthasWsBuffer__;
              const joinFrom = (idx) => stripAnsi(buf.slice(idx).map(c => c.d).join(''));

              // read_only:仅采集当前累积输出,用于探活/校准提示符
              if (opts && opts.read_only) {
                const full = stripAnsi(buf.map(c => c.d).join(''));
                const tail = full.replace(/\n+$/, '');
                return {
                  output: full,
                  chunkCount: buf.length,
                  wsReadyState: window.__arthasWs__ ? window.__arthasWs__.readyState : null,
                  promptMatched: promptRe.test(tail),
                  lastLine: tail.split('\n').slice(-1)[0] || ''
                };
              }

              // interrupt:仅发 Ctrl+C(\x03)中断当前前台命令(如卡住的 trace/watch),不投递新命令
              if (opts && opts.interrupt) {
                const baseI = buf.length;
                window.__arthasSend__('\x03');
                const dl = Date.now() + 3000;
                let ok = false;
                while (Date.now() < dl) {
                  await sleep(150);
                  if (promptRe.test(joinFrom(baseI).replace(/\n+$/, '')) || promptRe.test(stripAnsi(buf.map(c => c.d).join('')).replace(/\n+$/, ''))) { ok = true; break; }
                }
                return { interrupted: ok, done: true };
              }

              // 基线:发送前的 chunk 数,之后只截新增输出
              const baseIdx = buf.length;

              // ── 高危命令识别 + 页面确认弹窗(硬拦截,不依赖 AI 自觉)──
              // 仅按确定的高危命令名判定(ognl/vmtool 无法靠命令名判断副作用,交由 AI 按 skill 准则把关)。
              function highRiskReason(cmd) {
                const c = (cmd || '').trim();
                const first = c.split(/\s+/)[0].toLowerCase();
                if (first === 'redefine' || first === 'retransform') return '热替换/重定义类字节码,直接改变线上运行代码';
                if (first === 'stop') return '卸载 Arthas(结束整个诊断会话)';
                if (first === 'reset') return '重置所有已增强的类(撤销 trace/watch 等)';
                if (first === 'shutdown') return '关闭 Arthas 并卸载 agent';
                if (first === 'sysprop' && c.split(/\s+/).length >= 3) return '修改 JVM 系统属性(运行期配置变更)';
                if (first === 'vmoption' && c.split(/\s+/).length >= 3) return '修改 JVM 运行参数';
                if (first === 'tt' && /(^|\s)(--play|-p)(\s|$)/.test(c)) return '重放历史调用(tt --play)——会真实再触发一次业务逻辑,可能造成重复下单/扣款等副作用';
                return null;
              }
              // 硬拦截:高危命令弹自建确认弹层(window.confirm 在注入脚本里会被浏览器静默忽略,故自建 DOM 弹层)
              const reason = highRiskReason(command);
              if (reason) {
                const confirmed = await new Promise((resolve) => {
                  try {
                    const OV = 'blt-arthas-confirm-overlay';
                    const old = document.getElementById(OV);
                    if (old) old.remove();
                    const overlay = document.createElement('div');
                    overlay.id = OV;
                    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
                    const box = document.createElement('div');
                    box.style.cssText = 'max-width:520px;width:86%;background:#1e1e28;color:#e4e4ed;border:1px solid rgba(251,191,36,0.4);border-radius:12px;padding:22px 24px;box-shadow:0 12px 40px rgba(0,0,0,0.5);';
                    const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
                    box.innerHTML =
                      '<div style="font-size:16px;font-weight:700;color:#fbbf24;margin-bottom:14px;">⚠️ 高危 Arthas 命令确认</div>' +
                      '<div style="font-size:13px;line-height:1.7;margin-bottom:8px;"><span style="color:#8b8ba0;">命令</span><br><code style="color:#c7d2fe;word-break:break-all;">' + esc(command) + '</code></div>' +
                      '<div style="font-size:13px;line-height:1.7;margin-bottom:8px;"><span style="color:#8b8ba0;">风险</span><br>' + esc(reason) + '</div>' +
                      '<div style="font-size:12px;color:#f87171;line-height:1.6;margin:12px 0 18px;">此命令将真实在目标 JVM 上执行,可能影响线上代码 / 状态 / 数据且难以回滚。</div>' +
                      '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
                      '<button id="blt-cancel" style="padding:8px 18px;font-size:13px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);color:#c4c4d0;cursor:pointer;">取消</button>' +
                      '<button id="blt-ok" style="padding:8px 18px;font-size:13px;border-radius:7px;border:1px solid rgba(248,113,113,0.5);background:rgba(248,113,113,0.18);color:#fca5a5;cursor:pointer;font-weight:600;">确认执行</button>' +
                      '</div>';
                    overlay.appendChild(box);
                    document.documentElement.appendChild(overlay);
                    const done = (v) => { try { overlay.remove(); } catch (e) {} resolve(v); };
                    box.querySelector('#blt-ok').addEventListener('click', () => done(true));
                    box.querySelector('#blt-cancel').addEventListener('click', () => done(false));
                    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
                  } catch (e) { resolve(false); }
                });
                if (!confirmed) return { cancelled: true, reason, sent: null, note: '用户在页面确认弹层取消了高危命令' };
              }

              // 取最后一帧:按"帧头行去重",只保留最后一次刷新的整屏(供全屏刷新型命令使用)
              const extractLastFrame = (baseIndex) => {
                let lines = joinFrom(baseIndex).split('\n');
                if (lines.length && lines[0].includes(command)) lines.shift();
                while (lines.length && (promptRe.test(lines[lines.length - 1]) || lines[lines.length - 1].trim() === '')) lines.pop();
                const firstContent = lines.findIndex(l => l.trim() !== '');
                if (firstContent >= 0) {
                  const headerLine = lines[firstContent].trim();
                  let lastFrameStart = firstContent;
                  for (let i = lines.length - 1; i > firstContent; i--) {
                    if (lines[i].trim() === headerLine) { lastFrameStart = i; break; }
                  }
                  lines = lines.slice(lastFrameStart);
                }
                return lines.join('\n').trim();
              };

              // 显式快照模式:跳过等待,直接渲染一帧 → 中断 → 取最后一帧
              if (opts && opts.snapshot) {
                const rs = window.__arthasSend__(command + '\r');
                if (!rs || !rs.ok) return { error: 'ws 发送失败: ' + (rs && rs.reason || 'unknown'), diag: rs };
                await sleep(opts.render_wait || 2500);
                window.__arthasSend__('\x03');
                const intDeadline = Date.now() + 3000;
                while (Date.now() < intDeadline) {
                  await sleep(150);
                  if (promptRe.test(joinFrom(baseIdx).replace(/\n+$/, ''))) break;
                }
                return { output: extractLastFrame(baseIdx), done: true, snapshot: true, sent: command };
              }

              const sendRes = window.__arthasSend__(command + '\r');
              if (!sendRes || !sendRes.ok) {
                return { error: 'ws 发送失败: ' + (sendRes && sendRes.reason || 'unknown'), diag: sendRes };
              }

              const timeout = (opts && opts.timeout) || 60000;
              const idleMs = (opts && opts.idle_ms) || 800;
              // 全屏刷新自动检测:命令发出后持续输出、始终等不到静默提示符达此时长 → 判定刷新型 → 自动中断取最后一帧
              const autoSnapMs = (opts && opts.auto_snapshot_ms) || 4000;
              const pollMs = 150;
              const startAt = Date.now();
              const deadline = startAt + timeout;

              let lastLen = -1;
              let lastChange = Date.now();
              let sawContent = false;        // 是否收到过实质输出
              let truncated = false;
              let autoSnapshot = false;

              while (true) {
                await sleep(pollMs);
                const now = Date.now();
                const curLen = buf.length;
                if (curLen !== lastLen) { lastLen = curLen; lastChange = now; }

                const seg = joinFrom(baseIdx).replace(/\n+$/, '');
                if (seg.replace(promptRe, '').trim().length > 0) sawContent = true;
                const idleEnough = (now - lastChange) >= idleMs;

                // 正常完成:静默 + 提示符
                if (promptRe.test(seg) && idleEnough) break;

                // 自动快照:当前仍在刷新(未静默)、已超 autoSnapMs、且检测到"帧头行重复出现"(全屏刷新特征)
                // 顺序命令只打印一次(帧头不重复),不会误触发;全屏命令周期重打印整屏 → 帧头必重复。
                if (sawContent && !idleEnough && (now - startAt) >= autoSnapMs && curLen > baseIdx + 10) {
                  const lines = joinFrom(baseIdx).split('\n').filter(l => l.trim() !== '' && !promptRe.test(l) && !l.includes(command));
                  if (lines.length > 2) {
                    const head = lines[0].trim();
                    let headCount = 0;
                    for (const l of lines) { if (l.trim() === head) headCount++; }
                    if (headCount >= 2) { autoSnapshot = true; break; }
                  }
                }
                if (now >= deadline) { truncated = true; break; }
              }

              if (autoSnapshot) {
                // 检测到全屏刷新:中断 → 取最后一帧,对调用方无感知
                window.__arthasSend__('\x03');
                const intDeadline = Date.now() + 3000;
                while (Date.now() < intDeadline) {
                  await sleep(150);
                  if (promptRe.test(joinFrom(baseIdx).replace(/\n+$/, ''))) break;
                }
                return { output: extractLastFrame(baseIdx), done: true, snapshot: true, autoDetected: true, sent: command };
              }

              let output = joinFrom(baseIdx);
              const outLines = output.split('\n');
              // 去掉首行命令回显
              if (outLines.length && outLines[0].includes(command)) outLines.shift();
              // 去掉末尾提示符行
              while (outLines.length && promptRe.test(outLines[outLines.length - 1])) outLines.pop();
              output = outLines.join('\n').trim();

              return { output, done: !truncated, truncated, sent: command };
            },
            args: [msg.command || '', {
              read_only: !!msg.read_only,
              interrupt: !!msg.interrupt,
              timeout: msg.timeout,
              idle_ms: msg.idle_ms,
              snapshot: !!msg.snapshot,
              render_wait: msg.render_wait
            }]
          });
          const r = results && results[0] ? results[0].result : null;
          if (r && r.error) send(msg.id, { error: r.error, diag: r.diag });
          else send(msg.id, { result: JSON.stringify(r) });
          return;
        }

        case 'scrolling_screenshot': {
          // 截取目标 tab 当前可视区一屏
          const activeTab = await resolveTab(msg);
          const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'png' });
          send(msg.id, { result: JSON.stringify({ dataUrl }) });
          return;
        }

        default:
          send(msg.id, { error: `Unknown action: ${msg.action}` });
      }
    } catch (err) {
      console.error('Bridge processing error:', err);
      if (msg && msg.id) send(msg.id, { error: `Chrome API Error: ${err.message || err}` });
    }
  };

  socket.onclose = () => {
    console.log('MCP Bridge disconnected, retrying in 2s...');
    reconnectTimer = setTimeout(connect, 2000);
  };

  socket.onerror = () => {
    console.error('Socket error');
    socket.close();
  };
}

connect();

chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (!socket || socket.readyState === WebSocket.CLOSED) connect();
  }
});
