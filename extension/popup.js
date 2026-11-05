/**
 * Browser Link Tool - Popup Controller
 * 面板:连接状态 / 活跃会话列表(谁在操作哪个 tab)/ 快捷操作
 * 状态与会话走 HTTP :48766/health;复制走 chrome tabs API
 */

const HEALTH_URL = 'http://127.0.0.1:48766/health';

const el = (id) => document.getElementById(id);

function setDot(id, state) {
  const dot = el(id);
  dot.classList.remove('on', 'off', 'idle');
  dot.classList.add(state);
}

async function refreshBridgeStatus() {
  try {
    const res = await fetch(HEALTH_URL, { cache: 'no-store' });
    const data = await res.json();
    setDot('bridgeDot', 'on');
    el('bridgeValue').textContent = `运行中 :${data.httpPort || 48766}` + (data.mode === 'daemon' ? ' · 常驻' : '');
    // 按本浏览器 id 在已连浏览器清单里查"本浏览器"是否连上
    const browsers = Array.isArray(data.browsers) ? data.browsers : [];
    const { browserId } = await chrome.storage.local.get('browserId');
    const me = browsers.find(b => b.id === browserId);
    const mine = !!me;
    if (me && document.activeElement !== el('aliasInput')) el('aliasInput').placeholder = me.name;
    setDot('extDot', mine ? 'on' : 'off');
    el('extValue').textContent = (mine ? '已连接' : '未连接') + (browsers && browsers.length > 1 ? ` · 共 ${browsers.length} 个浏览器` : '');
    const line = el('browsersLine');
    if (browsers && browsers.length > 1) {
      line.hidden = false;
      line.textContent = '在线: ' + browsers.map(b => `${b.name}${b.id === browserId ? '(本)' : ''}${b.focused ? '·焦点' : ''}`).join(' / ');
    } else line.hidden = true;
    renderVersion(data, me);
    await renderSessions(Array.isArray(data.sessions) ? data.sessions : []);
  } catch (e) {
    setDot('bridgeDot', 'off');
    el('bridgeValue').textContent = '未运行';
    setDot('extDot', 'idle');
    el('extValue').textContent = '—';
    el('browsersLine').hidden = true;
    setDot('versionDot', 'idle');
    el('versionValue').textContent = '—';
    el('versionWarn').hidden = true;
    await renderSessions([]);
  }
}

// 版本行:一眼看出"扩展和桥是不是同一代"。不一致时红字直说该干什么(多半是忘了重载扩展)。
function renderVersion(data, me) {
  const extV = chrome.runtime.getManifest().version;
  const bridgeV = data.version || '?';
  const valueEl = el('versionValue');
  const warnEl = el('versionWarn');
  // 本浏览器还没连上 daemon 时,daemon 侧没有它的判定结果,只能比版本号
  const state = me ? (me.versionState || 'unknown') : (extV === bridgeV ? 'ok' : 'version-mismatch');
  const detail = me ? me.versionDetail : null;
  valueEl.textContent = `扩展 v${extV} ↔ 桥 v${bridgeV}`;
  if (state === 'ok') {
    setDot('versionDot', 'on');
    valueEl.classList.remove('warn');
    warnEl.hidden = true;
  } else {
    setDot('versionDot', 'off');
    valueEl.classList.add('warn');
    warnEl.hidden = false;
    warnEl.textContent = detail || (state === 'stale-code'
      ? '扩展源码已改动,但当前实例是改动前加载的,请重载扩展'
      : `扩展 v${extV} 与桥 v${bridgeV} 不一致,请重载扩展`);
  }
}

// 本浏览器名(别名):后台按 browserAlias 变化自动重发 hello,daemon 侧立即更新
async function initAlias() {
  const { browserId, browserAlias } = await chrome.storage.local.get(['browserId', 'browserAlias']);
  const input = el('aliasInput');
  input.value = browserAlias || '';
  input.placeholder = browserId ? `默认 ${browserId}` : '未连接过';
  if (browserId) input.parentElement.title += `\nid: ${browserId}`;
  const save = async () => {
    const v = input.value.trim();
    // 每次现读存储比较:用 initAlias 时的快照比,改过一次后再改回原值会被误判为"没变"
    const { browserAlias: cur } = await chrome.storage.local.get('browserAlias');
    if (v === (cur || '')) return;
    if (v) await chrome.storage.local.set({ browserAlias: v });
    else await chrome.storage.local.remove('browserAlias');
    toast(v ? `已改名为 ${v}` : '已恢复默认名');
    setTimeout(refreshBridgeStatus, 300);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', save);
}

function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function clientBadgeClass(client) {
  const c = String(client || '').toLowerCase();
  if (c.includes('claude')) return 'badge-claude';
  if (c.includes('gemini')) return 'badge-gemini';
  if (c.includes('codex')) return 'badge-codex';
  return 'badge-unknown';
}

async function tabTitleOf(tabId) {
  if (tabId == null) return null;
  try { const t = await chrome.tabs.get(tabId); return t ? (t.title || t.url || `#${tabId}`) : null; }
  catch (e) { return null; }
}

async function renderSessions(all) {
  // 只列真正调用过浏览器工具的会话:每个 agent 会话一启动就挂 client 发心跳,没用过浏览器的不算「在用」,折叠成计数
  const sessions = all.filter(s => s.calls > 0);
  const idleCount = all.length - sessions.length;
  el('sessionCount').textContent = String(sessions.length);
  const list = el('sessionList');
  list.innerHTML = '';
  const idleLine = () => {
    if (!idleCount) return;
    const idle = document.createElement('div');
    idle.className = 'session-idle-line';
    idle.textContent = `另有 ${idleCount} 个已连接但未调用过浏览器的会话`;
    idle.title = all.filter(s => !(s.calls > 0))
      .map(s => [s.client || '未知客户端', s.project, s.pid ? `pid ${s.pid}` : ''].filter(Boolean).join(' · ')).join('\n');
    list.appendChild(idle);
  };
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '暂无会话在使用浏览器';
    list.appendChild(empty);
    idleLine();
    return;
  }
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const head = document.createElement('div');
    head.className = 'session-head';
    // 活跃状态点:绿=近期有调用,灰=连着但空闲
    const dot = document.createElement('span');
    dot.className = 'session-dot ' + (s.active ? 'active' : 'idle');
    dot.title = s.active ? '活跃(近期有操作)' : '在线空闲';
    const badge = document.createElement('span');
    badge.className = 'client-badge ' + clientBadgeClass(s.client);
    badge.textContent = s.client && s.client !== 'unknown' ? s.client : '未知客户端';
    // 宿主(IDE/终端)来自进程链;MCP 握手原始 clientInfo 放悬停提示,便于核对识别是否准确
    if (s.clientInfo) badge.title = `MCP clientInfo: ${s.clientInfo}`;
    const where = document.createElement('span');
    where.className = 'session-where';
    where.textContent = [s.host ? `@${s.host}` : '', s.project || ''].filter(Boolean).join(' · ');
    if (s.project) where.title = `项目目录: ${s.project}`;
    const pid = document.createElement('span');
    pid.className = 'session-pid';
    pid.textContent = s.pid ? `pid ${s.pid}` : '';
    head.appendChild(dot);
    head.appendChild(badge);
    if (where.textContent) head.appendChild(where);
    head.appendChild(pid);
    item.appendChild(head);

    // 操作行:工具 → 目标标签页标题(tabId 已展示在上面 head 行末尾)
    const opRow = document.createElement('div');
    opRow.className = 'session-op';
    let tabDesc;
    if (s.lastTabId != null) {
      // 多浏览器时 tabId 可能属于别的浏览器,不能拿本浏览器的 tabs API 反查
      const title = s.lastTabTitle || (s.lastBrowser ? null : await tabTitleOf(s.lastTabId));
      tabDesc = title || `标签页 #${s.lastTabId}`;
    } else {
      tabDesc = s.lastTool ? '活动标签页' : '暂无操作';
    }
    if (s.lastBrowser) tabDesc = `[${s.lastBrowser}] ${tabDesc}`;
    opRow.textContent = s.lastTool ? `${s.lastTool} → ${tabDesc}` : tabDesc;
    item.appendChild(opRow);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const activeDesc = s.idleMs != null ? `最近操作 ${fmtDuration(s.idleMs)}前` : '尚未操作';
    meta.textContent = `接入 ${fmtDuration(s.uptimeMs)} · ${activeDesc} · ${s.calls} 次调用`;
    item.appendChild(meta);

    list.appendChild(item);
  }
  idleLine();
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0) tabs = await chrome.tabs.query({ active: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

function toast(text) {
  const t = el('toast');
  const prev = t.textContent;
  t.textContent = text;
  t.classList.add('flash');
  setTimeout(() => { t.classList.remove('flash'); t.textContent = prev; }, 1600);
}

// --- Events ---
el('installToggle').addEventListener('click', () => {
  const panel = el('installPanel');
  panel.hidden = !panel.hidden;
  el('installToggle').setAttribute('aria-expanded', String(!panel.hidden));
});
// 就地小标签:页脚 toast 离安装面板太远,展开后看不到
function cmdTip(code, text, ok) {
  const item = code.parentElement;
  item.querySelector('.copy-tip')?.remove();
  const tip = document.createElement('span');
  tip.className = 'copy-tip' + (ok ? '' : ' fail');
  tip.textContent = text;
  item.appendChild(tip);
  setTimeout(() => tip.classList.add('out'), 1200);
  setTimeout(() => tip.remove(), 1500);
}
document.querySelectorAll('.install-cmd').forEach((code) => {
  code.addEventListener('click', async () => {
    // 先全选,让用户看到复制的是哪段;剪贴板失败时也能直接 Cmd/Ctrl+C
    window.getSelection().selectAllChildren(code);
    try {
      await navigator.clipboard.writeText(code.textContent);
      cmdTip(code, '✓ 已复制', true);
    } catch (e) {
      cmdTip(code, '复制失败,请按 Cmd/Ctrl+C', false);
    }
  });
});

el('refreshBtn').addEventListener('click', () => { refreshBridgeStatus(); toast('已刷新'); });

el('copyBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) { toast('无活动标签页'); return; }
  const text = `tabId: ${tab.id}\ntitle: ${tab.title}\nurl: ${tab.url}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制当前 Tab 信息');
  } catch (e) {
    toast('复制失败');
  }
});

// --- 自动刷新:popup 打开期间每 3 秒刷新一次;页面隐藏时暂停,恢复时立即刷新 ---
let autoTimer = null;
function startAutoRefresh() {
  if (autoTimer) return;
  autoTimer = setInterval(refreshBridgeStatus, 3000);
}
function stopAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else { refreshBridgeStatus(); startAutoRefresh(); }
});

initAlias();
refreshBridgeStatus();
startAutoRefresh();
