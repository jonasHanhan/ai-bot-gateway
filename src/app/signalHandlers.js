import process from "node:process";
import { isIgnorableDiscordGatewayError } from "./runtimeErrorGuards.js";

export function registerShutdownSignals(shutdown) {
  process.on("SIGINT", () => {
    void shutdown?.(0);
  });
  process.on("SIGTERM", () => {
    void shutdown?.(0);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[process] unhandledRejection: ${formatProcessError(reason)}`);
    if (isIgnorableDiscordGatewayError(reason)) {
      console.warn(`[process] ignoring Discord gateway unhandledRejection: ${String(reason?.message ?? reason)}`);
      return;
    }
    if (!shouldGracefullyShutdownForRejection(reason)) {
      return;
    }
    void shutdown?.(1);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[process] uncaughtException: ${formatProcessError(error)}`);
    if (isIgnorableDiscordGatewayError(error)) {
      console.warn(`[process] ignoring Discord gateway uncaughtException: ${String(error?.message ?? error)}`);
      return;
    }
    void shutdown?.(1);
  });
}

function shouldGracefullyShutdownForRejection(reason) {
  if (!(reason instanceof Error)) {
    return false;
  }

  // Abort 类 rejection 常见于取消/关闭流程，只记录，不再触发新的退出链路。
  return String(reason?.name ?? "") !== "AbortError" && String(reason?.code ?? "") !== "ABORT_ERR";
}

function formatProcessError(error) {
  if (error instanceof Error) {
    const lines = [error.stack || `${error.name}: ${error.message}`];
    const errorCode = String(error?.code ?? "").trim();
    if (errorCode) {
      lines.push(`code=${errorCode}`);
    }
    if (error.cause !== undefined) {
      lines.push(`cause=${formatProcessError(error.cause)}`);
    }
    return lines.join("\n");
  }

  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error ?? "unknown");
}
