import "dotenv/config";
import process from "node:process";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { patchWsModuleForProxy } from "../src/app/proxyWebSocketPatch.js";

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "";

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  const websocketPatch = patchWsModuleForProxy({ proxyUrl });

  console.log(`[startup] proxy enabled: ${proxyUrl}`);
  if (websocketPatch.patched) {
    console.log("[startup] ws proxy patch enabled");
  }
}

await import("../src/index.js");
