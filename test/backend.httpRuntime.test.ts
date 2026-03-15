import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createBackendHttpRuntime } from "../src/backend/httpRuntime.js";

const runtimes = [];
const fakeServers = new Map<number, FakeHttpServer>();
const originalFetch = globalThis.fetch;
let nextFakePort = 41000;

class FakeHttpServer {
  constructor(handler, controller) {
    this.handler = handler;
    this.controller = controller;
    this.onceListeners = new Map();
    this.addressInfo = null;
  }

  once(event, listener) {
    const listeners = this.onceListeners.get(event) ?? new Set();
    listeners.add(listener);
    this.onceListeners.set(event, listeners);
    return this;
  }

  off(event, listener) {
    this.onceListeners.get(event)?.delete(listener);
    return this;
  }

  listen(requestedPort, host, callback) {
    const attempt = this.controller.recordListenAttempt();
    if (attempt <= this.controller.failListenAttempts) {
      queueMicrotask(() => {
        this.emitOnce(
          "error",
          Object.assign(new Error(`Failed to start server. Is port ${requestedPort} in use?`), {
            code: "EADDRINUSE",
            syscall: "listen",
            errno: 0
          })
        );
      });
      return this;
    }

    const port = requestedPort || nextFakePort++;
    this.addressInfo = {
      address: host || "127.0.0.1",
      family: "IPv4",
      port
    };
    fakeServers.set(port, this);
    queueMicrotask(() => {
      callback?.();
    });
    return this;
  }

  close(callback) {
    if (this.addressInfo?.port) {
      fakeServers.delete(this.addressInfo.port);
    }
    this.addressInfo = null;
    queueMicrotask(() => {
      callback?.();
    });
    return this;
  }

  address() {
    return this.addressInfo;
  }

  async dispatch(url, init = {}) {
    const request = {
      method: String(init.method ?? "GET"),
      url: `${url.pathname}${url.search}`,
      headers: normalizeHeaders(init.headers),
      body: init.body
    };
    let statusCode = 200;
    let body = "";
    const headers = {};
    const response = {
      headersSent: false,
      writableEnded: false,
      writeHead(nextStatusCode, nextHeaders = {}) {
        statusCode = nextStatusCode;
        Object.assign(headers, nextHeaders);
        response.headersSent = true;
        return response;
      },
      end(chunk = "") {
        body += typeof chunk === "string" ? chunk : String(chunk ?? "");
        response.writableEnded = true;
        return response;
      }
    };

    await this.handler(request, response);
    await Promise.resolve();

    return new Response(body, {
      status: statusCode,
      headers
    });
  }

  emitOnce(event, payload) {
    const listeners = [...(this.onceListeners.get(event) ?? [])];
    this.onceListeners.delete(event);
    for (const listener of listeners) {
      listener(payload);
    }
  }
}

function createFakeHttpEnvironment(options = {}) {
  let listenAttempts = 0;
  let serverCount = 0;

  return {
    createServer(handler) {
      serverCount += 1;
      return new FakeHttpServer(handler, {
        failListenAttempts: options.failListenAttempts ?? 0,
        recordListenAttempt() {
          listenAttempts += 1;
          return listenAttempts;
        }
      });
    },
    get listenAttempts() {
      return listenAttempts;
    },
    get serverCount() {
      return serverCount;
    }
  };
}

function normalizeHeaders(input) {
  if (!input) {
    return {};
  }
  if (input instanceof Headers) {
    return Object.fromEntries(input.entries());
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map(([key, value]) => [key, String(value)]));
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

function getFreePort() {
  return nextFakePort++;
}

function createTestRuntime(deps, options = {}) {
  const httpEnvironment = createFakeHttpEnvironment(options);
  const runtime = createBackendHttpRuntime({
    ...deps,
    createServer: httpEnvironment.createServer
  });
  runtimes.push(runtime);
  return { runtime, httpEnvironment };
}

async function fakeFetch(url, init) {
  const parsed = new URL(String(url));
  const port = Number(parsed.port);
  const server = fakeServers.get(port);
  if (!server) {
    throw new Error(`No fake server registered for ${parsed.href}`);
  }
  return server.dispatch(parsed, init);
}

beforeAll(() => {
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fakeServers.clear();
});

afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop();
    await runtime?.stop?.();
  }
  fakeServers.clear();
});

describe("backend http runtime", () => {
  test("serves health and readiness endpoints", async () => {
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map([["thread-1", {}]]),
      pendingApprovals: new Map([["0001", {}]]),
      getMappedChannelCount: () => 3,
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await fetch(`${baseUrl}/healthz`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      ready: false,
      startedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: 1,
      pendingApprovals: 1,
      mappedChannels: 3
    });

    const readyBefore = await fetch(`${baseUrl}/readyz`);
    expect(readyBefore.status).toBe(503);

    runtime.setReady(true);
    const readyAfter = await fetch(`${baseUrl}/readyz`);
    expect(readyAfter.status).toBe(200);
    expect((await readyAfter.json()).ready).toBe(true);
  });

  test("reports degraded platforms in readiness payloads", async () => {
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 1,
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    runtime.setReady({
      ready: false,
      degradedPlatforms: [
        {
          platformId: "discord",
          reason: "startup_failed",
          message: "discord startup timed out"
        }
      ]
    });

    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      ready: false,
      startedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: 0,
      pendingApprovals: 0,
      mappedChannels: 1,
      degradedPlatforms: [
        {
          platformId: "discord",
          reason: "startup_failed",
          message: "discord startup timed out"
        }
      ]
    });

    const ready = await fetch(`${baseUrl}/readyz`);
    expect(ready.status).toBe(503);
  });

  test("delegates Feishu webhook requests to the Feishu runtime", async () => {
    const calls = [];
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      feishuRuntime: {
        enabled: true,
        webhookPath: "/feishu/events",
        async handleHttpRequest(_request, response, context) {
          calls.push(context);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: 0, delegated: true }));
        }
      }
    });
    await runtime.start();
    runtime.setReady(true);
    const address = runtime.getAddress();

    const response = await fetch(`http://127.0.0.1:${address.port}/feishu/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, delegated: true });
    expect(calls).toEqual([{ ready: true }]);
  });

  test("returns 500 and logs when request handling throws", async () => {
    const originalConsoleError = console.error;
    const errorLog: string[] = [];
    console.error = (...args) => {
      errorLog.push(args.join(" "));
    };

    try {
      const { runtime } = createTestRuntime({
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        processStartedAt: "2026-03-13T00:00:00.000Z",
        activeTurns: new Map(),
        pendingApprovals: new Map(),
        getMappedChannelCount: () => 0,
        platformRegistry: {
          async handleHttpRequest() {
            throw new Error("platform boom");
          }
        },
        feishuRuntime: { enabled: false }
      });
      await runtime.start();
      const address = runtime.getAddress();

      const response = await fetch(`http://127.0.0.1:${address.port}/platform/fail`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: 500, msg: "internal server error" });
      expect(errorLog.some((line) => line.includes("backend http request failed for GET /platform/fail: platform boom"))).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("serves turn request status endpoint", async () => {
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      getTurnRequestStatus: (requestId: string) => {
        if (requestId !== "req-1") {
          return null;
        }
        return {
          requestId,
          platform: "discord",
          status: "processing",
          repoChannelId: "channel-1"
        };
      },
      findTurnRequestStatusBySource: ({ sourceMessageId, routeId }: { sourceMessageId: string; routeId?: string }) => {
        if (sourceMessageId !== "m-1") {
          return null;
        }
        if (routeId && routeId !== "channel-1") {
          return null;
        }
        return {
          requestId: "req-1",
          sourceMessageId: "m-1",
          platform: "discord",
          status: "processing",
          repoChannelId: "channel-1"
        };
      },
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const found = await fetch(`${baseUrl}/turns/req-1?platform=discord&route_id=channel-1`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      ok: true,
      requestId: "req-1",
      scopeVerified: true,
      compatibilityMode: false,
      platform: "discord",
      status: "processing",
      repoChannelId: "channel-1"
    });

    const mismatch = await fetch(`${baseUrl}/turns/req-1?platform=discord&route_id=channel-2`);
    expect(mismatch.status).toBe(403);

    const bySource = await fetch(`${baseUrl}/turns/by-source/m-1?platform=discord&route_id=channel-1`);
    expect(bySource.status).toBe(200);
    expect((await bySource.json()).requestId).toBe("req-1");

    const missing = await fetch(`${baseUrl}/turns/req-missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      code: 404,
      msg: "request_id not found",
      requestId: "req-missing"
    });
  });

  test("allows legacy request records without route scope metadata", async () => {
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      getTurnRequestStatus: (requestId: string) => {
        if (requestId !== "legacy-1") {
          return null;
        }
        return {
          requestId,
          status: "done"
        };
      },
      findTurnRequestStatusBySource: ({ sourceMessageId }: { sourceMessageId: string }) => {
        if (sourceMessageId !== "legacy-message") {
          return null;
        }
        return {
          requestId: "legacy-1",
          sourceMessageId,
          status: "done"
        };
      },
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const byRequest = await fetch(`${baseUrl}/turns/legacy-1?platform=discord&route_id=channel-1`);
    expect(byRequest.status).toBe(200);
    const byRequestPayload = await byRequest.json();
    expect(byRequestPayload.scopeVerified).toBe(false);
    expect(byRequestPayload.compatibilityMode).toBe(true);

    const bySource = await fetch(
      `${baseUrl}/turns/by-source/legacy-message?platform=feishu&route_id=feishu%3Aoc_legacy`
    );
    expect(bySource.status).toBe(200);
    const bySourcePayload = await bySource.json();
    expect(bySourcePayload.scopeVerified).toBe(false);
    expect(bySourcePayload.compatibilityMode).toBe(true);
  });

  test("queues retry for retryable request with matching scope", async () => {
    const retryCalls: Array<{ requestId: string }> = [];
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      getTurnRequestStatus: (requestId: string) => {
        if (requestId !== "req-retry") {
          return null;
        }
        return {
          requestId,
          platform: "discord",
          status: "failed",
          repoChannelId: "channel-1",
          sourceMessageId: "msg-1"
        };
      },
      retryTurnRequest: async ({ requestId }: { requestId: string }) => {
        retryCalls.push({ requestId });
        return { ok: true, retryRequestId: "req-retry-2" };
      },
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/turns/req-retry/retry?platform=discord&route_id=channel-1`, {
      method: "POST"
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      requestId: "req-retry",
      retried: true,
      retryRequestId: "req-retry-2",
      status: "retry_queued",
      scopeVerified: true,
      compatibilityMode: false
    });
    expect(retryCalls).toEqual([{ requestId: "req-retry" }]);
  });

  test("rejects retry when request status is not retryable", async () => {
    const { runtime } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      getTurnRequestStatus: (requestId: string) =>
        requestId === "req-done"
          ? {
              requestId,
              status: "done",
              platform: "discord",
              repoChannelId: "channel-1"
            }
          : null,
      feishuRuntime: { enabled: false }
    });
    await runtime.start();
    const address = runtime.getAddress();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/turns/req-done/retry?platform=discord&route_id=channel-1`, {
      method: "POST"
    });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe(409);
    expect(payload.msg).toContain("not in retryable status");
  });

  test("restarts listener when start is called twice", async () => {
    const { runtime, httpEnvironment } = createTestRuntime({
      enabled: true,
      host: "127.0.0.1",
      port: getFreePort(),
      processStartedAt: "2026-03-13T00:00:00.000Z",
      activeTurns: new Map(),
      pendingApprovals: new Map(),
      getMappedChannelCount: () => 0,
      feishuRuntime: { enabled: false }
    });

    await runtime.start();
    const firstAddress = runtime.getAddress();
    await runtime.start();
    const secondAddress = runtime.getAddress();

    expect(firstAddress?.port).toBe(secondAddress?.port);
    expect(httpEnvironment.serverCount).toBe(2);
    const response = await fetch(`http://127.0.0.1:${secondAddress.port}/healthz`);
    expect(response.status).toBe(200);
  });

  test("retries listener startup when the port is temporarily busy", async () => {
    const originalConsoleError = console.error;
    const errorLines: string[] = [];
    console.error = (...args) => {
      errorLines.push(args.join(" "));
    };

    try {
      const { runtime, httpEnvironment } = createTestRuntime(
        {
          enabled: true,
          host: "127.0.0.1",
          port: getFreePort(),
          processStartedAt: "2026-03-13T00:00:00.000Z",
          activeTurns: new Map(),
          pendingApprovals: new Map(),
          getMappedChannelCount: () => 0,
          feishuRuntime: { enabled: false }
        },
        { failListenAttempts: 1 }
      );

      await runtime.start();
      const address = runtime.getAddress();
      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

      expect(response.status).toBe(200);
      expect(httpEnvironment.listenAttempts).toBe(2);
      expect(errorLines.some((line) => line.includes("backend http listen attempt 1/3 failed"))).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
