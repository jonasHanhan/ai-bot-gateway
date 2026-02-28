import { beforeEach, describe, expect, test } from "bun:test";
import {
  createDebugLog,
  formatInputTextForSetup,
  isDiscordMissingPermissionsError
} from "../src/app/runtimeUtils.js";

describe("runtime utils", () => {
  test("formatInputTextForSetup leaves repo content unchanged", () => {
    const text = "  hello world  ";
    expect(formatInputTextForSetup(text, { mode: "repo" })).toBe("hello world");
  });

  test("formatInputTextForSetup prepends general-channel guidance", () => {
    const formatted = formatInputTextForSetup("hello", { mode: "general" });
    expect(formatted).toContain("[Channel context: #general]");
    expect(formatted).toContain("hello");
  });

  test("isDiscordMissingPermissionsError detects code and message variants", () => {
    expect(isDiscordMissingPermissionsError({ code: 50013 })).toBe(true);
    expect(isDiscordMissingPermissionsError({ rawError: { code: 50013 } })).toBe(true);
    expect(isDiscordMissingPermissionsError({ message: "Missing permissions for this action" })).toBe(true);
    expect(isDiscordMissingPermissionsError({ code: 40001 })).toBe(false);
  });

  describe("createDebugLog", () => {
    let originalConsoleLog: typeof console.log;

    beforeEach(() => {
      originalConsoleLog = console.log;
    });

    test("suppresses logs when debug mode is disabled", () => {
      const lines = [];
      console.log = (...args) => {
        lines.push(args.join(" "));
      };
      const debugLog = createDebugLog(false);
      debugLog("scope", "message", { key: "value" });
      expect(lines).toHaveLength(0);
      console.log = originalConsoleLog;
    });

    test("logs compact JSON details when enabled", () => {
      const lines = [];
      console.log = (...args) => {
        lines.push(args.join(" "));
      };
      const debugLog = createDebugLog(true);
      debugLog("scope", "message", { key: "value" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[debug:scope] message");
      expect(lines[0]).toContain('"key":"value"');
      console.log = originalConsoleLog;
    });
  });
});
