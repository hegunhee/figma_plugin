const WS_URL = 'ws://localhost:3055';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

const statusDot = document.getElementById('status-dot') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setConnected(connected: boolean, message?: string) {
  statusDot.className = 'dot ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = message ?? (connected ? 'MCP 서버 연결됨' : '연결 끊김');
}

function addLog(text: string, direction: 'in' | 'out' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = 'log-line ' + direction;
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent = `${time} ${direction === 'in' ? '←' : direction === 'out' ? '→' : '·'} ${text}`;
  logEl.prepend(el);
  if (logEl.children.length > 80) {
    logEl.lastChild?.remove();
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setConnected(true);
    addLog('MCP 서버 연결됨', 'info');
    // Request file info to display
    sendToPlugin('get_file_info', {}, '__init__');
  };

  ws.onclose = () => {
    setConnected(false, `재연결 중... (${++reconnectAttempts}회)`);
    addLog(`연결 끊김, 3초 후 재시도`, 'info');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setConnected(false, 'MCP 서버 없음 (포트 3055)');
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        requestId: string;
        payload?: Record<string, unknown>;
      };
      const shortId = msg.requestId?.slice(0, 8) ?? '?';
      addLog(`${msg.type} [${shortId}]`, 'in');
      // Forward to Figma main thread
      parent.postMessage({ pluginMessage: msg }, '*');
    } catch (e) {
      addLog(`파싱 오류: ${e}`, 'info');
    }
  };
}

// ─── Plugin ↔ WS Bridge ───────────────────────────────────────────────────────

function sendToPlugin(type: string, payload: Record<string, unknown>, requestId: string) {
  parent.postMessage({ pluginMessage: { type, payload, requestId } }, '*');
}

// Receive responses from Figma main thread → forward to WS server
window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as
    | { type?: string; requestId?: string; data?: unknown; error?: string }
    | undefined;
  if (!msg) return;

  // Handle init response (show file name in UI)
  if (msg.requestId === '__init__' && msg.data) {
    const info = msg.data as { fileName?: string };
    if (info.fileName) fileNameEl.textContent = info.fileName;
    return;
  }

  // Forward all other responses to WS server
  if (ws?.readyState === WebSocket.OPEN) {
    const shortId = msg.requestId?.slice(0, 8) ?? '?';
    addLog(`response [${shortId}]${msg.error ? ' ERROR' : ''}`, 'out');
    ws.send(JSON.stringify(msg));
  }
};

// ─── Manual test buttons ──────────────────────────────────────────────────────

(window as unknown as Record<string, unknown>).testSelection = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_selection', { maxDepth: 3 }, id);
  addLog(`get_selection [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testComments = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_comments', {}, id);
  addLog(`get_comments [${id.slice(5, 13)}]`, 'out');
};

(window as unknown as Record<string, unknown>).testStyles = () => {
  const id = 'test-' + Date.now();
  sendToPlugin('get_styles', {}, id);
  addLog(`get_styles [${id.slice(5, 13)}]`, 'out');
};

// ─── Init ─────────────────────────────────────────────────────────────────────
connect();
