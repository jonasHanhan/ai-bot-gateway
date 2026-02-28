import { afterEach, describe, expect, test } from "bun:test";
import { loadRuntimeEnv } from "../src/config/runtimeEnv.js";

const ENV_KEYS = [
  "CHANNEL_CONFIG_PATH",
  "STATE_PATH",
  "CODEX_BIN",
  "CODEX_HOME",
  "DISCORD_REPO_ROOT",
  "DISCORD_GENERAL_CHANNEL_ID",
  "DISCORD_GENERAL_CHANNEL_NAME",
  "DISCORD_GENERAL_CWD",
  "DISCORD_IMAGE_CACHE_DIR",
  "DISCORD_MAX_IMAGES_PER_MESSAGE",
  "DISCORD_ATTACHMENT_MAX_BYTES",
  "DISCORD_ATTACHMENT_ROOTS",
  "DISCORD_ATTACHMENT_INFER_FROM_TEXT",
  "DISCORD_ENABLE_ATTACHMENTS",
  "DISCORD_ATTACHMENT_ITEM_TYPES",
  "DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN",
  "DISCORD_RENDER_VERBOSITY",
  "DISCORD_HEARTBEAT_PATH",
  "DISCORD_RESTART_REQUEST_PATH",
  "DISCORD_RESTART_ACK_PATH",
  "DISCORD_RESTART_NOTICE_PATH",
  "DISCORD_INFLIGHT_RECOVERY_PATH",
  "DISCORD_EXIT_ON_RESTART_ACK",
  "DISCORD_HEARTBEAT_INTERVAL_MS",
  "DISCORD_DEBUG_LOGGING",
  "DISCORD_PROJECTS_CATEGORY_NAME",
  "DISCORD_LEGACY_CATEGORY_NAME",
  "CODEX_EXTRA_WRITABLE_ROOTS"
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

describe("runtime env", () => {
  test("loads explicit environment overrides", () => {
    process.env.CHANNEL_CONFIG_PATH = "config/custom.json";
    process.env.STATE_PATH = "data/custom-state.json";
    process.env.CODEX_BIN = "/usr/local/bin/codex";
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.DISCORD_REPO_ROOT = ".";
    process.env.DISCORD_GENERAL_CHANNEL_NAME = "GENERAL";
    process.env.DISCORD_MAX_IMAGES_PER_MESSAGE = "7";
    process.env.DISCORD_ATTACHMENT_MAX_BYTES = "1024";
    process.env.DISCORD_ATTACHMENT_ROOTS = "./one:./two";
    process.env.DISCORD_ATTACHMENT_INFER_FROM_TEXT = "1";
    process.env.DISCORD_ENABLE_ATTACHMENTS = "0";
    process.env.DISCORD_ATTACHMENT_ITEM_TYPES = "imageView,commandExecution";
    process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN = "2";
    process.env.DISCORD_RENDER_VERBOSITY = "ops";
    process.env.DISCORD_HEARTBEAT_INTERVAL_MS = "15000";
    process.env.DISCORD_DEBUG_LOGGING = "1";
    process.env.DISCORD_PROJECTS_CATEGORY_NAME = "custom-projects";
    process.env.CODEX_EXTRA_WRITABLE_ROOTS = "./tmp-a:./tmp-b";

    const env = loadRuntimeEnv();

    expect(env.configPath.endsWith("config/custom.json")).toBe(true);
    expect(env.statePath.endsWith("data/custom-state.json")).toBe(true);
    expect(env.codexBin).toBe("/usr/local/bin/codex");
    expect(env.codexHomeEnv).toBe("/tmp/codex-home");
    expect(env.generalChannelName).toBe("general");
    expect(env.maxImagesPerMessage).toBe(7);
    expect(env.attachmentMaxBytes).toBe(1024);
    expect(env.attachmentRoots).toHaveLength(2);
    expect(env.attachmentInferFromText).toBe(true);
    expect(env.attachmentsEnabled).toBe(false);
    expect([...env.attachmentItemTypes]).toEqual(["imageView", "commandExecution"]);
    expect(env.attachmentIssueLimitPerTurn).toBe(2);
    expect(env.renderVerbosity).toBe("ops");
    expect(env.heartbeatIntervalMs).toBe(15000);
    expect(env.debugLoggingEnabled).toBe(true);
    expect(env.projectsCategoryName).toBe("custom-projects");
    expect(env.extraWritableRoots).toHaveLength(2);
  });

  test("falls back to safe defaults for invalid numeric values", () => {
    process.env.DISCORD_MAX_IMAGES_PER_MESSAGE = "-1";
    process.env.DISCORD_ATTACHMENT_MAX_BYTES = "0";
    process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN = "-1";
    process.env.DISCORD_HEARTBEAT_INTERVAL_MS = "1000";

    const env = loadRuntimeEnv();

    expect(env.maxImagesPerMessage).toBe(4);
    expect(env.attachmentMaxBytes).toBe(8 * 1024 * 1024);
    expect(env.attachmentIssueLimitPerTurn).toBe(1);
    expect(env.heartbeatIntervalMs).toBe(30000);
  });
});
