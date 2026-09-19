// Arthas Console WebSocket hook —— 必须 document_start / MAIN world 注入
// 目标:在不写死域名、不影响非 Arthas 页面的前提下,精准识别并接管 Arthas 终端的 WebSocket 隧道。
//
// 原理:document_start 时 DOM 尚未构建,无法靠页面内容判断,故对所有页面都包装 window.WebSocket
// (仅透明包一层,不改变原生行为),再靠"连接自身的行为特征"识别真正的 Arthas 隧道:
//   Arthas 终端协议(见 tunnel bundle):
//     发命令: ws.send(JSON.stringify({action:"read"|"resize", ...}))   ← 强特征
//     收输出: ws.onmessage -> event.data 为终端字节流
// 只有命中特征的连接才记录输出、暴露 __arthasSend__;其余连接原样透传,对页面零影响。
(function () {
  if (window.__arthasWsHookInstalled__) return;
  window.__arthasWsHookInstalled__ = true;

  window.__arthasWsBuffer__ = [];   // 累积输出:{ t: 时间戳, d: 字符串 }
  window.__arthasWs__ = null;       // 命中特征的 Arthas 隧道连接

  const MAX_CHUNKS = 5000;

  // ── 特征判定 ──
  // URL 辅助特征:含 arthas,或 Arthas 默认隧道端口 8563/7777 且路径像 ws
  function urlLooksArthas(url) {
    try {
      const u = String(url || '');
      if (/arthas/i.test(u)) return true;
      if (/:(8563|7777)(\/|$|\?)/.test(u) && /\/(ws|tunnel|arthas)/i.test(u)) return true;
      return false;
    } catch (e) { return false; }
  }
  // 发送内容强特征:Arthas 命令帧 {action:"read"/"resize"/"init"...}
  function sendLooksArthas(data) {
    try {
      if (typeof data !== 'string') return false;
      if (data.length > 4096) return false;
      if (data.indexOf('"action"') === -1) return false;
      const o = JSON.parse(data);
      return o && typeof o.action === 'string' &&
        ['read', 'resize', 'init', 'auth', 'close'].includes(o.action);
    } catch (e) { return false; }
  }

  const record = (data) => {
    let s = null;
    if (typeof data === 'string') s = data;
    else if (data instanceof ArrayBuffer) { try { s = new TextDecoder().decode(data); } catch (e) {} }
    else if (data && data.buffer instanceof ArrayBuffer) { try { s = new TextDecoder().decode(data); } catch (e) {} }
    if (s == null) return;
    const buf = window.__arthasWsBuffer__;
    buf.push({ t: Date.now(), d: s });
    if (buf.length > MAX_CHUNKS) buf.splice(0, buf.length - MAX_CHUNKS);
  };

  // 认定某连接为 Arthas 隧道:开始记录其输出、设为当前活动连接
  function adopt(ws) {
    if (ws.__arthasAdopted__) return;
    ws.__arthasAdopted__ = true;
    window.__arthasWs__ = ws;
    try { ws.addEventListener('message', (e) => { if (window.__arthasWs__ === ws) record(e.data); }); } catch (err) {}
  }

  const NativeWS = window.WebSocket;
  const nativeSend = NativeWS.prototype.send;

  function WrappedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    ws.__arthasUrl__ = url;
    // URL 已像 Arthas → 直接认定(建连早期就能捕获首屏输出)
    if (urlLooksArthas(url)) adopt(ws);
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  WrappedWS.CONNECTING = NativeWS.CONNECTING;
  WrappedWS.OPEN = NativeWS.OPEN;
  WrappedWS.CLOSING = NativeWS.CLOSING;
  WrappedWS.CLOSED = NativeWS.CLOSED;
  try { window.WebSocket = WrappedWS; } catch (e) {}

  // 包装 send:任何连接一旦发出 Arthas 命令帧,就认定为隧道(兜住 URL 不含特征的情况)
  try {
    NativeWS.prototype.send = function (data) {
      try { if (!this.__arthasAdopted__ && sendLooksArthas(data)) adopt(this); } catch (e) {}
      return nativeSend.apply(this, arguments);
    };
  } catch (e) {}

  // 发送 keystrokes(命令需自带 \r)
  window.__arthasSend__ = function (data) {
    const ws = window.__arthasWs__;
    if (!ws || ws.readyState !== 1) return { ok: false, reason: 'ws not open', readyState: ws ? ws.readyState : null };
    ws.send(JSON.stringify({ action: 'read', data: data }));
    return { ok: true };
  };
})();
