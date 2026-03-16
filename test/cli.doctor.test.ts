import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDoctorCommand } from "../src/cli/commands/doctor.js";

const ENV_KEYS = [
  "DISCORD_BOT_TOKEN",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_TRANSPORT",
  "DISCORD_ATTACHMENT_ROOTS",
  "DISCORD_GENERAL_CWD"
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

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

describe("cli doctor command", () => {
  test("fails when defaultAgent is missing from agents", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-doctor-"));
    try {
      await fs.mkdir(path.join(cwd, "config"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "config", "channels.json"),
        JSON.stringify(
          {
            defaultAgent: "missing-agent",
            agents: {
              "codex-default": {
                enabled: true,
                capabilities: {
                  supportsImageInput: true
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

      const result = await runDoctorCommand([], { cwd, now: new Date() });
      expect(result.ok).toBe(false);
      const failures = (result.details?.failures as string[]) ?? [];
      expect(failures.some((line) => line.includes("defaultAgent 'missing-agent'"))).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("passes adapter integrity checks with valid agent config", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-doctor-"));
    try {
      await fs.mkdir(path.join(cwd, "config"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "config", "channels.json"),
        JSON.stringify(
          {
            defaultAgent: "codex-default",
            agents: {
              "codex-default": {
                enabled: true,
                capabilities: {
                  supportsImageInput: true
                }
              }
            },
            channels: {
              "123456789012345678": {
                cwd: "/tmp",
                agentId: "codex-default"
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );
      process.env.DISCORD_BOT_TOKEN = "discord-token";

      const result = await runDoctorCommand([], { cwd, now: new Date() });
      expect(result.ok).toBe(true);

      const checks = (result.details?.checks as Array<{ name: string; ok: boolean }>) ?? [];
      expect(checks.find((check) => check.name === "default_agent_valid")?.ok).toBe(true);
      expect(checks.find((check) => check.name === "platform_adapters_registered")?.ok).toBe(true);
      expect(checks.find((check) => check.name === "platform_capabilities_complete")?.ok).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test("fails when channel references an unknown agent", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-doctor-"));
    try {
      await fs.mkdir(path.join(cwd, "config"), { recursive: true });
      await fs.writeFile(
        path.join(cwd, "config", "channels.json"),
        JSON.stringify(
          {
            defaultAgent: "codex-default",
            agents: {
              "codex-default": {
                enabled: true,
                capabilities: {
                  supportsImageInput: true
                }
              }
            },
            channels: {
              "123456789012345678": {
                cwd: "/tmp",
                agentId: "ghost-agent"
              }
            }
          },
          null,
          2
        ),
        "utf8"
      );
      process.env.DISCORD_BOT_TOKEN = "discord-token";

      const result = await runDoctorCommand([], { cwd, now: new Date() });
      expect(result.ok).toBe(false);
      const failures = (result.details?.failures as string[]) ?? [];
      expect(failures.some((line) => line.includes("Unknown channel agent references"))).toBe(true);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
