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
    el('bridgeValue').textContent = `运行中 :${data.httpPort || 48766}`;
    setDot('extDot', data.connected ? 'on' : 'off');
    el('extValue').textContent = data.connected ? '已连接' : '未连接';
    await renderSessions(Array.isArray(data.sessions) ? data.sessions : []);
  } catch (e) {
    setDot('bridgeDot', 'off');
    el('bridgeValue').textContent = '未运行';
    setDot('extDot', 'idle');
    el('extValue').textContent = '—';
    await renderSessions([]);
  }
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

async function renderSessions(sessions) {
  el('sessionCount').textContent = String(sessions.length);
  const list = el('sessionList');
  list.innerHTML = '';
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '无近期活跃会话';
    list.appendChild(empty);
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
    const mode = document.createElement('span');
    mode.className = 'session-mode' + (s.mode === 'primary' ? ' primary' : '');
    mode.textContent = s.mode === 'primary' ? '主' : '代理';
    const pid = document.createElement('span');
    pid.className = 'session-pid';
    pid.textContent = s.pid ? `pid ${s.pid}` : '';
    head.appendChild(dot);
    head.appendChild(badge);
    head.appendChild(mode);
    head.appendChild(pid);
    item.appendChild(head);

    // 操作行:工具 → 目标标签页标题(tabId 已展示在上面 head 行末尾)
    const opRow = document.createElement('div');
    opRow.className = 'session-op';
    let tabDesc;
    if (s.lastTabId != null) {
      const title = s.lastTabTitle || await tabTitleOf(s.lastTabId);
      tabDesc = title || `标签页 #${s.lastTabId}`;
    } else {
      tabDesc = s.lastTool ? '活动标签页' : '暂无操作';
    }
    opRow.textContent = s.lastTool ? `${s.lastTool} → ${tabDesc}` : tabDesc;
    item.appendChild(opRow);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    const activeDesc = s.idleMs != null ? `最近操作 ${fmtDuration(s.idleMs)}前` : '尚未操作';
    meta.textContent = `接入 ${fmtDuration(s.uptimeMs)} · ${activeDesc} · ${s.calls} 次调用`;
    item.appendChild(meta);

    list.appendChild(item);
  }
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

refreshBridgeStatus();
startAutoRefresh();
