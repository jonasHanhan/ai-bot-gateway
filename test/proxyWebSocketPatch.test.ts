import { describe, expect, test } from "bun:test";
import { patchWsModuleForProxy } from "../src/app/proxyWebSocketPatch.js";

describe("proxy websocket patch", () => {
  test("injects a proxy agent into ws.WebSocket when none is provided", () => {
    const calls: Array<{ address: string; protocols: string[]; options: Record<string, unknown> }> = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;

      constructor(address: string, protocols: string[], options: Record<string, unknown>) {
        calls.push({ address, protocols, options });
      }
    }

    const wsModule = {
      WebSocket: FakeWebSocket
    };
    const fakeAgent = { id: "proxy-agent" };

    const result = patchWsModuleForProxy({
      proxyUrl: "http://127.0.0.1:7890",
      requireFn: () => wsModule,
      createAgent: () => fakeAgent
    });

    expect(result.patched).toBe(true);

    const PatchedWebSocket = wsModule.WebSocket as typeof FakeWebSocket;
    new PatchedWebSocket("wss://gateway.discord.gg", [], { handshakeTimeout: 10_000 });

    expect(calls).toEqual([
      {
        address: "wss://gateway.discord.gg",
        protocols: [],
        options: {
          handshakeTimeout: 10_000,
          agent: fakeAgent
        }
      }
    ]);
  });

  test("does not override an explicit ws agent", () => {
    const calls: Array<Record<string, unknown>> = [];
    class FakeWebSocket {
      constructor(_address: string, _protocols: string[], options: Record<string, unknown>) {
        calls.push(options);
      }
    }

    const wsModule = {
      WebSocket: FakeWebSocket
    };
    const explicitAgent = { id: "explicit-agent" };

    patchWsModuleForProxy({
      proxyUrl: "http://127.0.0.1:7890",
      requireFn: () => wsModule,
      createAgent: () => ({ id: "proxy-agent" })
    });

    const PatchedWebSocket = wsModule.WebSocket as typeof FakeWebSocket;
    new PatchedWebSocket("wss://gateway.discord.gg", [], { agent: explicitAgent });

    expect(calls).toEqual([{ agent: explicitAgent }]);
  });

  test("is a no-op when no proxy url is configured", () => {
    const wsModule = {
      WebSocket: class FakeWebSocket {}
    };

    const result = patchWsModuleForProxy({
      proxyUrl: "",
      requireFn: () => wsModule
    });

    expect(result).toEqual({
      patched: false,
      reason: "missing_proxy_url"
    });
    expect(typeof wsModule.WebSocket).toBe("function");
  });
});
