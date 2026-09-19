/**
 * Browser Link Tool - Popup Controller
 * 信息+控制一体面板：连接状态 / 当前生效 tab / 全部 tab 列表可切换 / 快捷操作
 * tab 数据直接走 chrome API；bridge 存活状态走 HTTP :48766/health
 */

const HEALTH_URL = 'http://127.0.0.1:48766/health';
const LOCKED_TAB_KEY = 'lockedTabId';

const el = (id) => document.getElementById(id);

async function getLockedTabId() {
  try {
    const o = await chrome.storage.local.get(LOCKED_TAB_KEY);
    const v = o && o[LOCKED_TAB_KEY];
    return typeof v === 'number' ? v : null;
  } catch (e) { return null; }
}

async function setLockedTabId(id) {
  try {
    if (id == null) await chrome.storage.local.remove(LOCKED_TAB_KEY);
    else await chrome.storage.local.set({ [LOCKED_TAB_KEY]: id });
  } catch (e) {}
}

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
    el('modeValue').textContent = data.mode === 'primary' ? '主实例 (primary)' : (data.mode || '—');
  } catch (e) {
    setDot('bridgeDot', 'off');
    el('bridgeValue').textContent = '未运行';
    setDot('extDot', 'idle');
    el('extValue').textContent = '—';
    el('modeValue').textContent = '—';
  }
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0) tabs = await chrome.tabs.query({ active: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

function renderActiveTab(tab, isLocked) {
  const badge = el('lockBadge');
  const toggle = el('lockToggle');
  if (!tab) {
    el('activeTabTitle').textContent = isLocked ? '锁定的标签页已关闭' : '无活动标签页';
    el('activeTabUrl').textContent = '—';
    el('activeTabId').textContent = '';
    badge.hidden = true;
    toggle.classList.remove('on');
    return;
  }
  el('activeTabTitle').textContent = tab.title || '(无标题)';
  el('activeTabUrl').textContent = tab.url || '';
  el('activeTabId').textContent = `tabId: ${tab.id}`;
  badge.hidden = !isLocked;
  toggle.classList.toggle('on', !!isLocked);
}

async function renderTabList(lockedId) {
  const tabs = await chrome.tabs.query({});
  el('tabCount').textContent = String(tabs.length);
  const list = el('tabList');
  list.innerHTML = '';

  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.active ? ' active' : '') + (tab.id === lockedId ? ' locked' : '');
    item.title = tab.url || '';

    if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) {
      const img = document.createElement('img');
      img.className = 'tab-fav';
      img.src = tab.favIconUrl;
      img.onerror = () => { img.replaceWith(makeFallback()); };
      item.appendChild(img);
    } else {
      item.appendChild(makeFallback());
    }

    const body = document.createElement('div');
    body.className = 'tab-item-body';
    const t = document.createElement('div');
    t.className = 'tab-item-title';
    t.textContent = tab.title || '(无标题)';
    const m = document.createElement('div');
    m.className = 'tab-item-meta';
    m.textContent = hostOf(tab.url);
    body.appendChild(t);
    body.appendChild(m);
    item.appendChild(body);

    const idSpan = document.createElement('span');
    idSpan.className = 'tab-item-id';
    idSpan.textContent = '#' + tab.id;
    item.appendChild(idSpan);

    item.addEventListener('click', async () => {
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
      await refreshAll();
    });

    list.appendChild(item);
  }
}

function makeFallback() {
  const d = document.createElement('div');
  d.className = 'tab-fav-fallback';
  return d;
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return url || ''; }
}

function toast(text) {
  const t = el('toast');
  const prev = t.textContent;
  t.textContent = text;
  t.classList.add('flash');
  setTimeout(() => { t.classList.remove('flash'); t.textContent = prev; }, 1600);
}

async function refreshAll() {
  const lockedId = await getLockedTabId();
  let effectiveTab = null;
  let isLocked = false;
  if (lockedId != null) {
    try {
      effectiveTab = await chrome.tabs.get(lockedId);
      isLocked = true;
    } catch (e) {
      // 锁定 tab 已关闭 → 清锁,回退活动 tab
      await setLockedTabId(null);
      isLocked = false;
    }
  }
  if (!effectiveTab) effectiveTab = await getActiveTab();
  renderActiveTab(effectiveTab, isLocked);
  await Promise.all([refreshBridgeStatus(), renderTabList(isLocked ? lockedId : null)]);
}

// --- Events ---
el('refreshBtn').addEventListener('click', () => { refreshAll(); toast('已刷新'); });

el('lockToggle').addEventListener('click', async () => {
  const lockedId = await getLockedTabId();
  if (lockedId != null) {
    await setLockedTabId(null);
    toast('已解锁,恢复跟随活动标签页');
  } else {
    const active = await getActiveTab();
    if (!active) { toast('无活动标签页可锁定'); return; }
    await setLockedTabId(active.id);
    toast(`已锁定 #${active.id},切换标签页不再影响`);
  }
  await refreshAll();
});

el('copyBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const text = `tabId: ${tab.id}\ntitle: ${tab.title}\nurl: ${tab.url}`;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制当前 Tab 信息');
  } catch (e) {
    toast('复制失败');
  }
});

refreshAll();
