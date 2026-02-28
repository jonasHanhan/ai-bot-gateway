import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config/loadConfig.js";

const ENV_KEYS = ["DISCORD_ALLOWED_USER_IDS", "CODEX_APPROVAL_POLICY", "CODEX_SANDBOX_MODE"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function writeJsonTempFile(payload: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bridge-load-config-"));
  const filePath = path.join(dir, "channels.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("loadConfig", () => {
  test("returns defaults when config file is missing", async () => {
    const missingPath = path.join(os.tmpdir(), `dc-bridge-missing-${Date.now()}.json`);
    const config = await loadConfig(missingPath, { defaultModel: "gpt-default", defaultEffort: "medium" });
    expect(config.channels).toEqual({});
    expect(config.defaultModel).toBe("gpt-default");
    expect(config.defaultEffort).toBe("medium");
    expect(config.approvalPolicy).toBe("never");
    expect(config.sandboxMode).toBe("workspace-write");
    expect(config.autoDiscoverProjects).toBe(true);
  });

  test("normalizes channel mappings and trims default model/effort", async () => {
    delete process.env.DISCORD_ALLOWED_USER_IDS;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX_MODE;
    const configPath = writeJsonTempFile({
      channels: {
        chanA: "./repo-a",
        chanB: { cwd: "./repo-b", model: "gpt-alt" }
      },
      defaultModel: " gpt-custom ",
      defaultEffort: "high",
      allowedUserIds: ["user-1", 2, "user-2"],
      autoDiscoverProjects: false
    });
    const config = await loadConfig(configPath);
    expect(config.channels).toEqual({
      chanA: { cwd: path.resolve("./repo-a") },
      chanB: { cwd: path.resolve("./repo-b"), model: "gpt-alt" }
    });
    expect(config.defaultModel).toBe("gpt-custom");
    expect(config.defaultEffort).toBe("high");
    expect(config.allowedUserIds).toEqual(["user-1", "user-2"]);
    expect(config.autoDiscoverProjects).toBe(false);
  });

  test("throws for invalid channel mapping", async () => {
    const configPath = writeJsonTempFile({
      channels: { bad: { nope: true } }
    });
    await expect(loadConfig(configPath)).rejects.toThrow("must map to a cwd string or { cwd, model? } object");
  });

  test("uses env DISCORD_ALLOWED_USER_IDS when set", async () => {
    process.env.DISCORD_ALLOWED_USER_IDS = "a,b , c";
    const configPath = writeJsonTempFile({
      allowedUserIds: ["from-config"]
    });
    const config = await loadConfig(configPath);
    expect(config.allowedUserIds).toEqual(["a", "b", "c"]);
  });

  test("rejects empty DISCORD_ALLOWED_USER_IDS", async () => {
    process.env.DISCORD_ALLOWED_USER_IDS = " ,  ";
    const configPath = writeJsonTempFile({});
    await expect(loadConfig(configPath)).rejects.toThrow("DISCORD_ALLOWED_USER_IDS is set but empty");
  });

  test("warns when only placeholder allowed user id is present", async () => {
    delete process.env.DISCORD_ALLOWED_USER_IDS;
    const originalWarn = console.warn;
    const warns: string[] = [];
    console.warn = (message?: unknown) => {
      warns.push(String(message ?? ""));
    };
    const configPath = writeJsonTempFile({
      allowedUserIds: ["123456789012345678"]
    });
    try {
      const config = await loadConfig(configPath);
      expect(config.allowedUserIds).toEqual([]);
      expect(warns.some((line) => line.includes("placeholder allowedUserIds"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("validates approval policy and sandbox mode values", async () => {
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_SANDBOX_MODE;
    const validPath = writeJsonTempFile({
      approvalPolicy: "on-request",
      sandboxMode: "read-only"
    });
    const valid = await loadConfig(validPath);
    expect(valid.approvalPolicy).toBe("on-request");
    expect(valid.sandboxMode).toBe("read-only");

    const invalidPolicyPath = writeJsonTempFile({
      approvalPolicy: "bad-value"
    });
    await expect(loadConfig(invalidPolicyPath)).rejects.toThrow("Invalid approval policy");

    const invalidSandboxPath = writeJsonTempFile({
      sandboxMode: "bad-mode"
    });
    await expect(loadConfig(invalidSandboxPath)).rejects.toThrow("Invalid sandbox mode");
  });

  test("env approval/sandbox values override config values", async () => {
    process.env.CODEX_APPROVAL_POLICY = "untrusted";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    const configPath = writeJsonTempFile({
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      defaultEffort: "invalid-effort"
    });
    const config = await loadConfig(configPath, { defaultEffort: "low" });
    expect(config.approvalPolicy).toBe("untrusted");
    expect(config.sandboxMode).toBe("danger-full-access");
    expect(config.defaultEffort).toBe("low");
  });
});
