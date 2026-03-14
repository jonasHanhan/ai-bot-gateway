import "dotenv/config";
import process from "node:process";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  "";

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));

  console.log(`[startup] proxy enabled: ${proxyUrl}`);
}

await import("../src/index.js");
