import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";

const WS_PROXY_PATCHED = Symbol.for("agent-gateway.ws-proxy-patched");

export function patchWsModuleForProxy(options = {}) {
  const {
    proxyUrl,
    requireFn = createRequire(import.meta.url),
    createAgent = (url) => new HttpsProxyAgent(url)
  } = options;

  const normalizedProxyUrl = String(proxyUrl ?? "").trim();
  if (!normalizedProxyUrl) {
    return { patched: false, reason: "missing_proxy_url" };
  }

  let wsModule;
  try {
    wsModule = requireFn("ws");
  } catch {
    return { patched: false, reason: "missing_ws_module" };
  }
  const OriginalWebSocket = wsModule?.WebSocket;
  if (typeof OriginalWebSocket !== "function") {
    return { patched: false, reason: "missing_websocket_constructor" };
  }

  if (OriginalWebSocket[WS_PROXY_PATCHED]) {
    return { patched: false, reason: "already_patched" };
  }

  const proxyAgent = createAgent(normalizedProxyUrl);

  class ProxyAwareWebSocket extends OriginalWebSocket {
    constructor(address, protocols, socketOptions = {}) {
      const nextSocketOptions = { ...socketOptions };
      if (!("agent" in nextSocketOptions) || nextSocketOptions.agent == null) {
        nextSocketOptions.agent = proxyAgent;
      }
      super(address, protocols, nextSocketOptions);
    }
  }

  Object.defineProperty(ProxyAwareWebSocket, WS_PROXY_PATCHED, {
    value: true
  });

  wsModule.WebSocket = ProxyAwareWebSocket;

  return {
    patched: true,
    reason: "patched",
    proxyAgent
  };
}
