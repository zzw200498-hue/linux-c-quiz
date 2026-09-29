import type { HostToWeb, WebToHost } from '../shared/types';

/** acquireVsCodeApi 每个 Webview 只能调用一次，统一从这里取 */
const api = acquireVsCodeApi();

export function post(msg: WebToHost): void {
  api.postMessage(msg);
}

export function onHostMessage(handler: (msg: HostToWeb) => void): () => void {
  const h = (e: MessageEvent<HostToWeb>) => handler(e.data);
  window.addEventListener('message', h);
  return () => window.removeEventListener('message', h);
}

export default api;
