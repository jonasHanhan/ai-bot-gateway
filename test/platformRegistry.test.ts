import { describe, expect, test } from "bun:test";
import { createPlatformRegistry } from "../src/platforms/platformRegistry.js";

interface FakeHttpResponse {
  statusCode: number;
  body: string;
  writeHead(statusCode: number, headers?: Record<string, string>): void;
  end(body: string): void;
}

describe("platform registry", () => {
  test("resolves route targets and webhooks through enabled platforms", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    const registry = createPlatformRegistry([
      {
        platformId: "discord",
        enabled: true,
        canHandleRouteId: (routeId: string) => !routeId.includes(":"),
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, platform: "discord" }),
        handleInboundMessage: async (message: unknown) => {
          calls.push({ type: "message", payload: message });
        },
        handleInboundInteraction: async (interaction: unknown) => {
          calls.push({ type: "interaction", payload: interaction });
        }
      },
      {
        platformId: "feishu",
        enabled: true,
        canHandleRouteId: (routeId: string) => routeId.startsWith("feishu:"),
        fetchChannelByRouteId: async (routeId: string) => ({ id: routeId, platform: "feishu" }),
        getHttpEndpoints: () => ["/feishu/events"],
        matchesHttpRequest: ({ pathname }: { pathname: string }) => pathname === "/feishu/events",
        handleHttpRequest: async (_request: Request, response: FakeHttpResponse, context: unknown) => {
          calls.push({ type: "webhook", payload: context });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        }
      }
    ]);

    expect(await registry.fetchChannelByRouteId("123")).toEqual({ id: "123", platform: "discord" });
    expect(await registry.fetchChannelByRouteId("feishu:oc_1")).toEqual({ id: "feishu:oc_1", platform: "feishu" });
    expect(registry.getHttpEndpoints()).toEqual(["/feishu/events"]);

    await registry.handleInboundMessage({ id: "m1" });
    await registry.handleInboundInteraction({ id: "i1" });

    const response: FakeHttpResponse = {
      statusCode: 0,
      body: "",
      writeHead(statusCode: number) {
        this.statusCode = statusCode;
      },
      end(body: string) {
        this.body = body;
      }
    };
    const handled = await registry.handleHttpRequest(
      new Request("http://127.0.0.1/feishu/events", { method: "POST" }),
      response,
      { ready: true }
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ ok: true }));
    expect(calls).toEqual([
      { type: "message", payload: { id: "m1" } },
      { type: "interaction", payload: { id: "i1" } },
      { type: "webhook", payload: { ready: true } }
    ]);
  });

  test("starts and bootstraps only enabled platforms", async () => {
    const calls: string[] = [];
    const registry = createPlatformRegistry([
      {
        platformId: "discord",
        enabled: true,
        async start() {
          calls.push("start:discord");
          return { platformId: "discord", started: true };
        },
        async bootstrapRoutes() {
          calls.push("bootstrap:discord");
          return { discoveredCwds: 2 };
        },
        async stop() {
          calls.push("stop:discord");
          return { stopped: true };
        }
      },
      {
        platformId: "telegram",
        enabled: false,
        async start() {
          return { platformId: "telegram", started: true };
        },
        async bootstrapRoutes() {
          return { discoveredCwds: 9 };
        }
      }
    ]);

    expect(await registry.start()).toEqual([{ platformId: "discord", started: true }]);
    expect(await registry.bootstrapRoutes()).toEqual([{ platformId: "discord", discoveredCwds: 2 }]);
    expect(await registry.stop()).toEqual([{ stopped: true }]);
    expect(registry.getPlatform("telegram")?.enabled).toBe(false);
    expect(calls).toEqual(["start:discord", "bootstrap:discord", "stop:discord"]);
  });

  test("continues startup when one enabled platform throws", async () => {
    const calls: string[] = [];
    const registry = createPlatformRegistry([
      {
        platformId: "discord",
        enabled: true,
        async start() {
          calls.push("start:discord");
          throw new Error("discord tls boom");
        }
      },
      {
        platformId: "feishu",
        enabled: true,
        async start() {
          calls.push("start:feishu");
          return { platformId: "feishu", started: true };
        }
      }
    ]);

    const summaries = await registry.start();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.platformId).toBe("discord");
    expect(summaries[0]?.started).toBe(false);
    expect(String(summaries[0]?.startError?.message ?? "")).toBe("discord tls boom");
    expect(summaries[1]).toEqual({ platformId: "feishu", started: true });
    expect(calls).toEqual(["start:discord", "start:feishu"]);
  });
});
