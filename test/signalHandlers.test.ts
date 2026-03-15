import { describe, expect, test } from "bun:test";
import { registerShutdownSignals } from "../src/app/signalHandlers.js";

describe("signal handlers", () => {
  test("registers process signal and fatal error handlers", () => {
    const originalOn = process.on.bind(process);
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const calls: number[] = [];
    const errorLines: string[] = [];
    const warnLines: string[] = [];

    console.error = (...args) => {
      errorLines.push(args.join(" "));
    };
    console.warn = (...args) => {
      warnLines.push(args.join(" "));
    };

    process.on = ((event: string, listener: (...args: unknown[]) => void) => {
      handlers.set(event, listener);
      return process;
    }) as typeof process.on;

    try {
      registerShutdownSignals((exitCode: number) => {
        calls.push(exitCode);
      });
      handlers.get("SIGINT")?.();
      handlers.get("SIGTERM")?.();
      handlers.get("unhandledRejection")?.(new Error("rejection boom"), Promise.resolve());
      handlers.get("unhandledRejection")?.(Object.assign(new Error("abort"), { name: "AbortError" }), Promise.resolve());
      handlers.get("unhandledRejection")?.(
        Object.assign(new Error("Client network socket disconnected before secure TLS connection was established"), {
          code: "ECONNRESET",
          host: "gateway.discord.gg"
        }),
        Promise.resolve()
      );
      handlers.get("uncaughtException")?.(new Error("exception boom"));
      handlers.get("uncaughtException")?.(
        Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: gateway.discord.gg."), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID"
        })
      );
    } finally {
      process.on = originalOn;
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("unhandledRejection")).toBe(true);
    expect(handlers.has("uncaughtException")).toBe(true);
    expect(calls).toEqual([0, 0, 1, 1]);
    expect(errorLines.some((line) => line.includes("[process] unhandledRejection: Error: rejection boom"))).toBe(true);
    expect(errorLines.some((line) => line.includes("[process] uncaughtException: Error: exception boom"))).toBe(true);
    expect(warnLines.some((line) => line.includes("ignoring Discord gateway unhandledRejection"))).toBe(true);
    expect(warnLines.some((line) => line.includes("ignoring Discord gateway uncaughtException"))).toBe(true);
  });
});
