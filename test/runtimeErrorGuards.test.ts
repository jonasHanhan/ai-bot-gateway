import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { isIgnorableDiscordGatewayError, registerRuntimeErrorGuards } from "../src/app/runtimeErrorGuards.js";

describe("runtime error guards", () => {
  test("recognizes ignorable Discord gateway websocket failures", () => {
    expect(
      isIgnorableDiscordGatewayError({
        code: "ECONNRESET",
        host: "gateway.discord.gg",
        message: "Client network socket disconnected before secure TLS connection was established"
      })
    ).toBe(true);

    expect(
      isIgnorableDiscordGatewayError({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
        message: "Hostname/IP does not match certificate's altnames: Host: gateway.discord.gg."
      })
    ).toBe(true);

    expect(
      isIgnorableDiscordGatewayError({
        code: "ECONNRESET",
        host: "api.openai.com",
        message: "Client network socket disconnected before secure TLS connection was established"
      })
    ).toBe(false);
  });

  test("swallows ignorable Discord gateway exceptions but still terminates on unknown errors", async () => {
    const processRef = new EventEmitter() as EventEmitter & {
      exitCode?: number;
      exit: (code: number) => void;
      [key: symbol]: boolean | undefined;
    };
    const exits: number[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    processRef.exit = (code: number) => {
      exits.push(code);
    };

    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (message?: unknown) => {
      warnings.push(String(message ?? ""));
    };
    console.error = (message?: unknown) => {
      errors.push(String(message ?? ""));
    };

    try {
      registerRuntimeErrorGuards({ processRef });
      processRef.emit("uncaughtException", {
        code: "ECONNRESET",
        host: "gateway.discord.gg",
        message: "Client network socket disconnected before secure TLS connection was established"
      });
      processRef.emit("uncaughtException", new Error("boom"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    expect(warnings.some((line) => line.includes("ignoring uncaught Discord gateway websocket error"))).toBe(true);
    expect(errors.some((line) => line.includes("uncaught exception: Error: boom"))).toBe(true);
    expect(exits).toEqual([1]);
  });
});
