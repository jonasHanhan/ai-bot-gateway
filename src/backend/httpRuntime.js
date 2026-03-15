import http from "node:http";
import { makeFeishuRouteId } from "../feishu/ids.js";

const HTTP_LISTEN_RETRY_LIMIT = 3;
const HTTP_LISTEN_RETRY_DELAY_MS = 50;

export function createBackendHttpRuntime(deps) {
  const {
    enabled,
    host,
    port,
    processStartedAt,
    activeTurns,
    pendingApprovals,
    getMappedChannelCount,
    getTurnRequestStatus,
    findTurnRequestStatusBySource,
    retryTurnRequest,
    platformRegistry,
    feishuRuntime,
    createServer = http.createServer.bind(http)
  } = deps;

  const httpPlatforms = platformRegistry ?? createLegacyPlatformRegistry(feishuRuntime);

  let server = null;
  let readiness = {
    ready: false,
    degradedPlatforms: []
  };

  async function start() {
    if (!enabled) {
      return;
    }

    // 运行时重载可能重复调用 start()，先关闭旧实例再重新绑定，避免悬挂监听器。
    if (server) {
      console.warn("backend http server already exists; restarting listener");
      await stop();
    }

    let lastError = null;
    for (let attempt = 1; attempt <= HTTP_LISTEN_RETRY_LIMIT; attempt += 1) {
      const nextServer = createHttpServerWithFactory(createServer, handleRequest);
      server = nextServer;
      try {
        await listenOnServer(nextServer, port, host);
        const address = getAddress();
        const resolvedPort = typeof address?.port === "number" ? address.port : port;
        console.log(`backend http listening on http://${host}:${resolvedPort}`);
        return;
      } catch (error) {
        lastError = error;
        console.error(
          `backend http listen attempt ${attempt}/${HTTP_LISTEN_RETRY_LIMIT} failed on ${host}:${port}: ${formatRuntimeError(error)}`
        );
        if (server === nextServer) {
          server = null;
        }
        await closeServer(nextServer);
        if (attempt >= HTTP_LISTEN_RETRY_LIMIT) {
          throw error;
        }
        await delay(HTTP_LISTEN_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError ?? new Error("backend http failed to start");
  }

  async function stop() {
    if (!server) {
      return;
    }
    const current = server;
    server = null;
    await closeServer(current);
  }

  function setReady(nextReady) {
    if (typeof nextReady === "object" && nextReady !== null) {
      readiness = {
        ready: nextReady.ready === true,
        degradedPlatforms: Array.isArray(nextReady.degradedPlatforms) ? [...nextReady.degradedPlatforms] : []
      };
      return;
    }
    readiness = {
      ready: nextReady === true,
      degradedPlatforms: []
    };
  }

  function getAddress() {
    return server?.address?.() ?? null;
  }

  async function handleRequest(request, response) {
    const method = String(request.method ?? "").toUpperCase();
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;

    if (method === "GET" && pathname === "/healthz") {
      writeJson(response, 200, buildStatusPayload({ includeReady: true }));
      return;
    }
    if (method === "GET" && pathname === "/readyz") {
      writeJson(response, readiness.ready ? 200 : 503, buildStatusPayload({ includeReady: true }));
      return;
    }
    if (method === "GET" && pathname === "/") {
      writeJson(response, 200, {
        ok: true,
        service: "codex-chat-bridge",
        ready: readiness.ready,
        endpoints: [
          "/healthz",
          "/readyz",
          "/turns/:request_id",
          "/turns/by-source/:source_message_id",
          "/turns/:request_id/retry",
          ...(httpPlatforms?.getHttpEndpoints?.() ?? [])
        ]
      });
      return;
    }

    if (method === "POST" && pathname.startsWith("/turns/") && pathname.endsWith("/retry")) {
      const requestId = decodeURIComponent(pathname.slice("/turns/".length, -"/retry".length));
      if (!requestId) {
        writeJson(response, 400, { code: 400, msg: "missing request_id" });
        return;
      }
      const status = getTurnRequestStatus?.(requestId) ?? null;
      if (!status) {
        writeJson(response, 404, {
          code: 404,
          msg: "request_id not found",
          requestId
        });
        return;
      }
      const scope = extractRequestScope(request, requestUrl);
      const scopeCheck = validateStatusScope(status, scope);
      if (!scopeCheck.ok) {
        writeJson(response, 403, {
          code: 403,
          msg: "scope mismatch",
          reason: scopeCheck.reason
        });
        return;
      }

      const retryableStates = new Set(["failed", "cancelled", "recovery_unavailable"]);
      if (!retryableStates.has(String(status?.status ?? ""))) {
        writeJson(response, 409, {
          code: 409,
          msg: "request is not in retryable status",
          requestId,
          status: status?.status ?? "unknown"
        });
        return;
      }

      const retryResult = await retryTurnRequest?.({
        requestId,
        requestStatus: status,
        scope
      });

      if (!retryResult?.ok) {
        writeJson(response, 409, {
          code: 409,
          msg: retryResult?.error ?? "retry unavailable",
          requestId,
          status: status?.status ?? "unknown",
          compatibilityMode: scopeCheck.compatibilityMode,
          scopeVerified: scopeCheck.scopeVerified
        });
        return;
      }

      writeJson(response, 202, {
        ok: true,
        requestId,
        retried: true,
        retryRequestId: retryResult.retryRequestId,
        status: "retry_queued",
        scopeVerified: scopeCheck.scopeVerified,
        compatibilityMode: scopeCheck.compatibilityMode
      });
      return;
    }

    if (method === "GET" && pathname.startsWith("/turns/by-source/")) {
      const sourceMessageId = decodeURIComponent(pathname.slice("/turns/by-source/".length));
      if (!sourceMessageId) {
        writeJson(response, 400, { code: 400, msg: "missing source_message_id" });
        return;
      }
      const scope = extractRequestScope(request, requestUrl);
      const status =
        findTurnRequestStatusBySource?.({
          sourceMessageId,
          routeId: scope.routeId,
          platform: scope.platform
        }) ?? null;
      if (!status) {
        writeJson(response, 404, {
          code: 404,
          msg: "source_message_id not found",
          sourceMessageId
        });
        return;
      }
      const scopeCheck = validateStatusScope(status, scope);
      if (!scopeCheck.ok) {
        writeJson(response, 403, {
          code: 403,
          msg: "scope mismatch",
          reason: scopeCheck.reason
        });
        return;
      }
      writeJson(response, 200, {
        ok: true,
        sourceMessageId,
        scopeVerified: scopeCheck.scopeVerified,
        compatibilityMode: scopeCheck.compatibilityMode,
        ...status
      });
      return;
    }

    if (method === "GET" && pathname.startsWith("/turns/")) {
      const requestId = decodeURIComponent(pathname.slice("/turns/".length));
      if (!requestId) {
        writeJson(response, 400, { code: 400, msg: "missing request_id" });
        return;
      }
      const status = getTurnRequestStatus?.(requestId) ?? null;
      if (!status) {
        writeJson(response, 404, {
          code: 404,
          msg: "request_id not found",
          requestId
        });
        return;
      }
      const scope = extractRequestScope(request, requestUrl);
      const scopeCheck = validateStatusScope(status, scope);
      if (!scopeCheck.ok) {
        writeJson(response, 403, {
          code: 403,
          msg: "scope mismatch",
          reason: scopeCheck.reason
        });
        return;
      }
      writeJson(response, 200, {
        ok: true,
        requestId,
        scopeVerified: scopeCheck.scopeVerified,
        compatibilityMode: scopeCheck.compatibilityMode,
        ...status
      });
      return;
    }

    const handledByPlatform = await httpPlatforms?.handleHttpRequest?.(request, response, { ready: readiness.ready });
    if (handledByPlatform) {
      return;
    }

    writeJson(response, 404, { code: 404, msg: "not found" });
  }

  function buildStatusPayload(options = {}) {
    return {
      ok: true,
      ready: options.includeReady ? readiness.ready : undefined,
      startedAt: processStartedAt,
      activeTurns: activeTurns.size,
      pendingApprovals: pendingApprovals.size,
      mappedChannels: getMappedChannelCount(),
      degradedPlatforms: readiness.degradedPlatforms.length > 0 ? [...readiness.degradedPlatforms] : undefined
    };
  }

  return {
    enabled,
    start,
    stop,
    setReady,
    getAddress
  };
}

function createHttpServerWithFactory(createServer, handleRequest) {
  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.error(`backend http request failed for ${request.method ?? "UNKNOWN"} ${request.url ?? "/"}: ${message}`);
      if (response.writableEnded) {
        return;
      }
      if (!response.headersSent) {
        writeJson(response, 500, { code: 500, msg: "internal server error" });
        return;
      }
      response.end();
    });
  });
}

function listenOnServer(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const handleError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      server.off("error", handleError);
      reject(error);
    };

    server.once("error", handleError);
    server.listen(port, host, () => {
      if (settled) {
        return;
      }
      settled = true;
      server.off("error", handleError);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error(`backend http close failed: ${formatRuntimeError(error)}`);
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatRuntimeError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  return String(error ?? "unknown");
}

function extractRequestScope(request, requestUrl) {
  const getHeader = (key) => String(request.headers?.[key] ?? "").trim();
  const getQuery = (key) => String(requestUrl.searchParams.get(key) ?? "").trim();

  const explicitRouteId = getQuery("route_id") || getHeader("x-route-id");
  const requestedPlatform = normalizePlatform(getQuery("platform") || getHeader("x-platform"));
  const discordChannelId =
    getQuery("discord_channel_id") || getHeader("x-discord-channel-id") || getQuery("channel_id") || getHeader("x-channel-id");
  const feishuChatId =
    getQuery("feishu_chat_id") || getHeader("x-feishu-chat-id") || getQuery("chat_id") || getHeader("x-chat-id");

  let routeId = explicitRouteId;
  if (!routeId && feishuChatId) {
    routeId = makeFeishuRouteId(feishuChatId);
  }
  if (!routeId && discordChannelId) {
    routeId = discordChannelId;
  }

  let platform = requestedPlatform;
  if (!platform && routeId) {
    platform = routeId.startsWith("feishu:") ? "feishu" : "discord";
  }

  return {
    platform,
    routeId: routeId || null
  };
}

function validateStatusScope(status, scope) {
  const statusRouteId = String(status?.repoChannelId ?? status?.channelId ?? "").trim() || null;
  const statusPlatform = normalizePlatform(status?.platform);

  if (!scope?.routeId) {
    return {
      ok: true,
      scopeVerified: false,
      compatibilityMode: true,
      reason: "request scope missing"
    };
  }

  if (!statusRouteId) {
    return {
      ok: true,
      scopeVerified: false,
      compatibilityMode: true,
      reason: "status scope missing"
    };
  }

  if (scope.routeId !== statusRouteId) {
    return {
      ok: false,
      scopeVerified: true,
      compatibilityMode: false,
      reason: "route_id does not match"
    };
  }

  if (scope.platform && statusPlatform && scope.platform !== statusPlatform) {
    return {
      ok: false,
      scopeVerified: true,
      compatibilityMode: false,
      reason: "platform does not match"
    };
  }

  return {
    ok: true,
    scopeVerified: true,
    compatibilityMode: false,
    reason: ""
  };
}

function normalizePlatform(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "discord" || normalized === "feishu") {
    return normalized;
  }
  return "";
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function createLegacyPlatformRegistry(feishuRuntime) {
  if (!feishuRuntime?.enabled || !feishuRuntime?.webhookPath) {
    return null;
  }
  return {
    getHttpEndpoints() {
      return [feishuRuntime.webhookPath];
    },
    async handleHttpRequest(request, response, options = {}) {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== feishuRuntime.webhookPath) {
        return false;
      }
      await feishuRuntime.handleHttpRequest(request, response, options);
      return true;
    }
  };
}
