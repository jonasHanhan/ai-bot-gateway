import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapabilitiesCommand } from "../src/cli/commands/capabilities.js";

const ENV_KEYS = ["DISCORD_BOT_TOKEN", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_TRANSPORT"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("cli capabilities command", () => {
  test("returns configured platform and agent capabilities", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-capabilities-"));
    try {
      await fs.mkdir(path.join(cwd, "config"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "config", "channels.json"),
        JSON.stringify(
          {
            defaultModel: "gpt-5.3-codex",
            defaultAgent: "codex-default",
            agents: {
              "codex-default": {
                model: "gpt-5.3-codex",
                enabled: true,
                capabilities: {
                  supportsImageInput: true
                }
              },
              "codex-lite": {
                enabled: false,
                capabilities: {
                  supportsImageInput: false
                }
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );

      process.env.DISCORD_BOT_TOKEN = "discord-token";
      process.env.FEISHU_APP_ID = "feishu-app";
      process.env.FEISHU_APP_SECRET = "feishu-secret";
      process.env.FEISHU_TRANSPORT = "long-connection";

      const result = await runCapabilitiesCommand([], { cwd, now: new Date() });
      expect(result.ok).toBe(true);
      expect(result.message).toBe("capabilities: ok");
      expect(result.details?.platformCount).toBe(2);
      expect(result.details?.agentCount).toBe(2);

      const platforms = (result.details?.platforms as Array<{ platformId: string; capabilities: Record<string, boolean> }>) ?? [];
      const agents = (result.details?.agents as Array<{ agentId: string; isDefault: boolean; enabled: boolean }>) ?? [];

      expect(platforms.find((entry) => entry.platformId === "discord")?.capabilities.supportsAutoDiscovery).toBe(true);
      expect(platforms.find((entry) => entry.platformId === "feishu")?.capabilities.supportsWebhookIngress).toBe(false);

      expect(agents.find((entry) => entry.agentId === "codex-default")?.isDefault).toBe(true);
      expect(agents.find((entry) => entry.agentId === "codex-lite")?.enabled).toBe(false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects unexpected arguments", async () => {
    const result = await runCapabilitiesCommand(["--json"], { cwd: process.cwd(), now: new Date() });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown argument");
  });

  test("supports --compact output mode", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-capabilities-"));
    try {
      await fs.mkdir(path.join(cwd, "config"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "config", "channels.json"),
        JSON.stringify(
          {
            defaultModel: "gpt-5.3-codex",
            defaultAgent: "codex-default",
            agents: {
              "codex-default": {
                enabled: true
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );

      process.env.DISCORD_BOT_TOKEN = "discord-token";
      const result = await runCapabilitiesCommand(["--compact"], { cwd, now: new Date() });

      expect(result.ok).toBe(true);
      expect(result.details?.compact).toBe(true);
      const compactRows = (result.details?.compactRows as string[]) ?? [];
      expect(compactRows.some((line) => line.startsWith("platforms:"))).toBe(true);
      expect(compactRows.some((line) => line.includes("discord"))).toBe(true);
      expect(compactRows.some((line) => line.includes("codex-default"))).toBe(true);
      expect(compactRows.some((line) => line.includes("image:INHERIT"))).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
