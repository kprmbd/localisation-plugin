// UI → sandbox fetch bridge.
// Figma plugin iframes run with a "null" origin; the APIs we call (the
// Cloudflare Worker fronting Copy Studio, and Lokalise) reject that at the CORS
// layer. Routing fetch through code.ts (which runs in the plugin process, no
// CORS) is the reliable path. The sandbox has `networkAccess` allowlisting in
// manifest.json.

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>; // lower-cased keys
}

export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const pending = new Map<string, (r: HttpResult) => void>();
let listenerInstalled = false;

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data?.pluginMessage;
    if (!msg || msg.t !== 'http-result') return;
    const resolve = pending.get(msg.requestId);
    if (!resolve) return;
    pending.delete(msg.requestId);
    resolve({ ok: msg.ok, status: msg.status, body: msg.body, headers: msg.headers ?? {} });
  });
}

export function sandboxFetch(url: string, init: HttpInit = {}): Promise<HttpResult> {
  installListener();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return new Promise(resolve => {
    pending.set(requestId, resolve);
    parent.postMessage({
      pluginMessage: {
        t: 'http',
        requestId,
        url,
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
      },
    }, '*');
  });
}
