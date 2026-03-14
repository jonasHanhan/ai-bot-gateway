import process from "node:process";

const REGISTERED_FLAG = Symbol.for("codex-discord-bridge.runtime-error-guards");

export function isIgnorableDiscordGatewayError(error) {
  const message = String(error?.message ?? "");
  const code = String(error?.code ?? "");
  const host = String(error?.host ?? "");
  const stack = String(error?.stack ?? "");
  const mentionsDiscordGateway = host === "gateway.discord.gg" || message.includes("gateway.discord.gg") || stack.includes("gateway.discord.gg");

  if (!mentionsDiscordGateway) {
    return false;
  }

  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return true;
  }

  return code === "ECONNRESET" && message.includes("Client network socket disconnected before secure TLS connection was established");
}

export function registerRuntimeErrorGuards({ processRef = process, shutdown } = {}) {
  if (processRef[REGISTERED_FLAG]) {
    return;
  }
  processRef[REGISTERED_FLAG] = true;

  processRef.on("uncaughtException", (error) => {
    if (isIgnorableDiscordGatewayError(error)) {
      console.warn(`ignoring uncaught Discord gateway websocket error: ${error.message}`);
      return;
    }
    console.error(`uncaught exception: ${error?.stack ?? error?.message ?? String(error)}`);
    terminateProcess({ processRef, shutdown });
  });

  processRef.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason ?? "Unhandled promise rejection"));
    if (isIgnorableDiscordGatewayError(error)) {
      console.warn(`ignoring unhandled Discord gateway rejection: ${error.message}`);
      return;
    }
    console.error(`unhandled rejection: ${error.stack ?? error.message}`);
    terminateProcess({ processRef, shutdown });
  });
}

function terminateProcess({ processRef, shutdown }) {
  if (typeof shutdown === "function") {
    void shutdown(1);
    return;
  }

  processRef.exitCode = 1;
  processRef.exit?.(1);
}
