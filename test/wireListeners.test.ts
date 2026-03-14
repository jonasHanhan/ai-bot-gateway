import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { wireBridgeListeners } from "../src/app/wireListeners.js";

describe("wire listeners", () => {
  test("catches notification and server request handler rejections", async () => {
    const codex = new EventEmitter();
    const discord = new EventEmitter() as EventEmitter & { user?: { tag: string } };
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown, ...args: unknown[]) => {
      errors.push([message, ...args].map((entry) => String(entry ?? "")).join(" "));
    };

    try {
      wireBridgeListeners({
        codex,
        discord,
        handleNotification: async () => {
          throw new Error("notification boom");
        },
        handleServerRequest: async () => {
          throw new Error("server request boom");
        },
        handleChannelCreate: async () => {},
        handleMessage: async () => {},
        handleInteraction: async () => {}
      });

      codex.emit("notification", { method: "item/agentMessage/delta" });
      codex.emit("serverRequest", { method: "commandExecution/requestApproval" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }

    expect(errors.some((line) => line.includes("notification handler failed (item/agentMessage/delta): notification boom"))).toBe(true);
    expect(
      errors.some((line) =>
        line.includes("server request handler failed (commandExecution/requestApproval): server request boom")
      )
    ).toBe(true);
  });
});
