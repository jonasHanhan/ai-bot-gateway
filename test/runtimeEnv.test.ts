import { afterEach, describe, expect, test } from "bun:test";
import { loadRuntimeEnv } from "../src/config/runtimeEnv.js";

const ENV_KEYS = [
  "CHANNEL_CONFIG_PATH",
  "STATE_PATH",
  "CODEX_BIN",
  "CODEX_HOME",
  "WORKSPACE_ROOT",
  "PROJECTS_ROOT",
  "DISCORD_REPO_ROOT",
  "DISCORD_GENERAL_CHANNEL_ID",
  "DISCORD_GENERAL_CHANNEL_NAME",
  "DISCORD_GENERAL_CWD",
  "DISCORD_IMAGE_CACHE_DIR",
  "DISCORD_MAX_IMAGES_PER_MESSAGE",
  "DISCORD_MESSAGE_CHUNK_LIMIT",
  "DISCORD_MAX_MESSAGE_LENGTH",
  "DISCORD_ATTACHMENT_MAX_BYTES",
  "DISCORD_ATTACHMENT_ROOTS",
  "DISCORD_ATTACHMENT_INFER_FROM_TEXT",
  "DISCORD_ENABLE_ATTACHMENTS",
  "DISCORD_ATTACHMENT_ITEM_TYPES",
  "DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN",
  "DISCORD_RENDER_VERBOSITY",
  "DISCORD_STRIP_ANSI_OUTPUT",
  "DISCORD_HEARTBEAT_PATH",
  "DISCORD_RESTART_REQUEST_PATH",
  "DISCORD_RESTART_ACK_PATH",
  "DISCORD_RESTART_NOTICE_PATH",
  "DISCORD_INFLIGHT_RECOVERY_PATH",
  "TURN_REQUEST_STATUS_TTL_MS",
  "TURN_REQUEST_STATUS_MAX_RECORDS",
  "TURN_REQUEST_STATUS_MAX_PER_THREAD",
  "TURN_RECOVERY_NOTIFY",
  "DISCORD_EXIT_ON_RESTART_ACK",
  "DISCORD_HEARTBEAT_INTERVAL_MS",
  "DISCORD_DEBUG_LOGGING",
  "DISCORD_PROJECTS_CATEGORY_NAME",
  "DISCORD_LEGACY_CATEGORY_NAME",
  "CODEX_EXTRA_WRITABLE_ROOTS",
  "FEISHU_MESSAGE_CHUNK_LIMIT",
  "FEISHU_SEGMENTED_STREAMING",
  "FEISHU_STREAM_MIN_CHARS",
  "FEISHU_UNBOUND_CHAT_MODE",
  "FEISHU_UNBOUND_CHAT_CWD"
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
    process.env.WORKSPACE_ROOT = ".";
    process.env.DISCORD_GENERAL_CHANNEL_NAME = "GENERAL";
    process.env.DISCORD_MAX_IMAGES_PER_MESSAGE = "7";
    process.env.DISCORD_MESSAGE_CHUNK_LIMIT = "1850";
    process.env.DISCORD_ATTACHMENT_MAX_BYTES = "1024";
    process.env.DISCORD_ATTACHMENT_ROOTS = "./one:./two";
    process.env.DISCORD_ATTACHMENT_INFER_FROM_TEXT = "1";
    process.env.DISCORD_ENABLE_ATTACHMENTS = "0";
    process.env.DISCORD_ATTACHMENT_ITEM_TYPES = "imageView,commandExecution";
    process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN = "2";
    process.env.DISCORD_RENDER_VERBOSITY = "ops";
    process.env.DISCORD_STRIP_ANSI_OUTPUT = "1";
    process.env.DISCORD_HEARTBEAT_INTERVAL_MS = "15000";
    process.env.DISCORD_DEBUG_LOGGING = "1";
    process.env.DISCORD_PROJECTS_CATEGORY_NAME = "custom-projects";
    process.env.CODEX_EXTRA_WRITABLE_ROOTS = "./tmp-a:./tmp-b";
    process.env.TURN_REQUEST_STATUS_TTL_MS = "123456";
    process.env.TURN_REQUEST_STATUS_MAX_RECORDS = "2222";
    process.env.TURN_REQUEST_STATUS_MAX_PER_THREAD = "33";
    process.env.TURN_RECOVERY_NOTIFY = "0";
    process.env.FEISHU_MESSAGE_CHUNK_LIMIT = "8000";

    const env = loadRuntimeEnv();

    expect(env.configPath.endsWith("config/custom.json")).toBe(true);
    expect(env.statePath.endsWith("data/custom-state.json")).toBe(true);
    expect(env.codexBin).toBe("/usr/local/bin/codex");
    expect(env.codexHomeEnv).toBe("/tmp/codex-home");
    expect(env.repoRootPath).toBe(process.cwd());
    expect(env.generalChannelName).toBe("general");
    expect(env.maxImagesPerMessage).toBe(7);
    expect(env.discordMessageChunkLimit).toBe(1850);
    expect(env.feishuMessageChunkLimit).toBe(8000);
    expect(env.attachmentMaxBytes).toBe(1024);
    expect(env.attachmentRoots).toHaveLength(2);
    expect(env.attachmentInferFromText).toBe(true);
    expect(env.attachmentsEnabled).toBe(false);
    expect([...env.attachmentItemTypes]).toEqual(["imageView", "commandExecution"]);
    expect(env.attachmentIssueLimitPerTurn).toBe(2);
    expect(env.renderVerbosity).toBe("ops");
    expect(env.stripAnsiForDiscord).toBe(true);
    expect(env.heartbeatIntervalMs).toBe(15000);
    expect(env.debugLoggingEnabled).toBe(true);
    expect(env.projectsCategoryName).toBe("custom-projects");
    expect(env.extraWritableRoots).toHaveLength(2);
    expect(env.turnRecovery.requestStatusTtlMs).toBe(123456);
    expect(env.turnRecovery.requestStatusMaxRecords).toBe(2222);
    expect(env.turnRecovery.requestStatusMaxPerThread).toBe(33);
    expect(env.turnRecovery.notifyEnabled).toBe(false);
  });

  test("falls back to safe defaults for invalid numeric values", () => {
    process.env.DISCORD_MAX_IMAGES_PER_MESSAGE = "-1";
    process.env.DISCORD_MESSAGE_CHUNK_LIMIT = "-1";
    process.env.DISCORD_ATTACHMENT_MAX_BYTES = "0";
    process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN = "-1";
    process.env.DISCORD_HEARTBEAT_INTERVAL_MS = "1000";
    process.env.TURN_REQUEST_STATUS_TTL_MS = "0";
    process.env.TURN_REQUEST_STATUS_MAX_RECORDS = "-1";
    process.env.TURN_REQUEST_STATUS_MAX_PER_THREAD = "0";

    const env = loadRuntimeEnv();

    expect(env.maxImagesPerMessage).toBe(4);
    expect(env.discordMessageChunkLimit).toBe(1900);
    expect(env.feishuMessageChunkLimit).toBe(8000);
    expect(env.attachmentMaxBytes).toBe(8 * 1024 * 1024);
    expect(env.attachmentIssueLimitPerTurn).toBe(1);
    expect(env.heartbeatIntervalMs).toBe(30000);
    expect(env.turnRecovery.requestStatusTtlMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(env.turnRecovery.requestStatusMaxRecords).toBe(5000);
    expect(env.turnRecovery.requestStatusMaxPerThread).toBe(300);
    expect(env.turnRecovery.notifyEnabled).toBe(true);
  });

  test("defaults Feishu unbound chat mode to open", () => {
    const env = loadRuntimeEnv();

    expect(env.feishuUnboundChatMode).toBe("open");
  });

  test("uses WORKSPACE_ROOT as the default Feishu unbound cwd", () => {
    process.env.WORKSPACE_ROOT = "/tmp/shared-projects-root";
    delete process.env.FEISHU_UNBOUND_CHAT_CWD;

    const env = loadRuntimeEnv();

    expect(env.repoRootPath).toBe("/tmp/shared-projects-root");
    expect(env.feishuUnboundChatCwd).toBe("/tmp/shared-projects-root");
  });

  test("accepts PROJECTS_ROOT as a legacy alias", () => {
    delete process.env.WORKSPACE_ROOT;
    delete process.env.DISCORD_REPO_ROOT;
    delete process.env.FEISHU_UNBOUND_CHAT_CWD;
    process.env.PROJECTS_ROOT = "/tmp/legacy-projects-root";

    const env = loadRuntimeEnv();

    expect(env.repoRootPath).toBe("/tmp/legacy-projects-root");
    expect(env.feishuUnboundChatCwd).toBe("/tmp/legacy-projects-root");
  });

  test("normalizes Feishu unbound chat mode and cwd", () => {
    process.env.FEISHU_UNBOUND_CHAT_MODE = "all";
    process.env.FEISHU_UNBOUND_CHAT_CWD = "/tmp/feishu-open";

    const env = loadRuntimeEnv();

    expect(env.feishuUnboundChatMode).toBe("open");
    expect(env.feishuUnboundChatCwd).toBe("/tmp/feishu-open");
  });

  test("keeps strict Feishu unbound mode when explicitly configured", () => {
    process.env.FEISHU_UNBOUND_CHAT_MODE = "strict";

    const env = loadRuntimeEnv();

    expect(env.feishuUnboundChatMode).toBe("strict");
  });

  test("defaults Feishu segmented streaming to disabled", () => {
    delete process.env.FEISHU_SEGMENTED_STREAMING;
    process.env.FEISHU_STREAM_MIN_CHARS = "120";

    const env = loadRuntimeEnv();

    expect(env.feishuSegmentedStreaming).toBe(false);
    expect(env.feishuStreamMinChars).toBe(120);
  });

  test("supports enabling Feishu segmented streaming", () => {
    process.env.FEISHU_SEGMENTED_STREAMING = "1";
    process.env.FEISHU_STREAM_MIN_CHARS = "120";

    const env = loadRuntimeEnv();

    expect(env.feishuSegmentedStreaming).toBe(true);
    expect(env.feishuStreamMinChars).toBe(120);
  });
});
