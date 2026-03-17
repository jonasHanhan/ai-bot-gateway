import { describe, expect, test } from "bun:test";
import {
  parseRuntimeNumericConfig,
  parseTurnRecoveryConfig,
  runtimeConfigSchema
} from "../src/config/runtimeConfigSchema.js";

describe("runtime config schema", () => {
  test("exposes turn recovery defaults and limits", () => {
    expect(runtimeConfigSchema.turnRecovery.defaults.requestStatusTtlMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(runtimeConfigSchema.turnRecovery.defaults.requestStatusMaxRecords).toBe(5000);
    expect(runtimeConfigSchema.turnRecovery.defaults.requestStatusMaxPerThread).toBe(300);
    expect(runtimeConfigSchema.turnRecovery.defaults.notifyEnabled).toBe(true);
    expect(runtimeConfigSchema.turnRecovery.limits.requestStatusTtlMs.min).toBe(60_000);
    expect(runtimeConfigSchema.turnRecovery.limits.requestStatusMaxRecords.min).toBe(100);
    expect(runtimeConfigSchema.turnRecovery.limits.requestStatusMaxPerThread.min).toBe(1);
  });

  test("exposes numeric defaults and limits", () => {
    expect(runtimeConfigSchema.numeric.defaults.discordMessageChunkLimit).toBe(1900);
    expect(runtimeConfigSchema.numeric.defaults.feishuMessageChunkLimit).toBe(8000);
    expect(runtimeConfigSchema.numeric.defaults.attachmentMaxBytes).toBe(8 * 1024 * 1024);
    expect(runtimeConfigSchema.numeric.defaults.heartbeatIntervalMs).toBe(30_000);
    expect(runtimeConfigSchema.numeric.defaults.backendHttpPort).toBe(8788);
    expect(runtimeConfigSchema.numeric.defaults.feishuPort).toBe(8788);
    expect(runtimeConfigSchema.numeric.limits.discordMessageChunkLimit.min).toBe(200);
    expect(runtimeConfigSchema.numeric.limits.attachmentIssueLimitPerTurn.min).toBe(0);
    expect(runtimeConfigSchema.numeric.limits.heartbeatIntervalMs.min).toBe(5_000);
  });

  test("parses runtime numeric env values", () => {
    const result = parseRuntimeNumericConfig({
      DISCORD_MAX_IMAGES_PER_MESSAGE: "8",
      DISCORD_MESSAGE_CHUNK_LIMIT: "1800",
      FEISHU_MESSAGE_CHUNK_LIMIT: "7000",
      DISCORD_ATTACHMENT_MAX_BYTES: "1048576",
      DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN: "0",
      DISCORD_HEARTBEAT_INTERVAL_MS: "45000",
      FEISHU_STREAM_MIN_CHARS: "120",
      BACKEND_HTTP_PORT: "9999",
      FEISHU_PORT: "7777"
    });

    expect(result).toEqual({
      maxImagesPerMessage: 8,
      discordMessageChunkLimit: 1800,
      feishuMessageChunkLimit: 7000,
      attachmentMaxBytes: 1048576,
      attachmentIssueLimitPerTurn: 0,
      heartbeatIntervalMs: 45000,
      feishuStreamMinChars: 120,
      backendHttpPort: 9999,
      feishuPort: 7777
    });
  });

  test("falls back to numeric defaults for invalid values", () => {
    const result = parseRuntimeNumericConfig({
      DISCORD_MAX_IMAGES_PER_MESSAGE: "-1",
      DISCORD_MAX_MESSAGE_LENGTH: "199",
      FEISHU_MESSAGE_CHUNK_LIMIT: "0",
      DISCORD_ATTACHMENT_MAX_BYTES: "-1",
      DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN: "-1",
      DISCORD_HEARTBEAT_INTERVAL_MS: "4999",
      FEISHU_STREAM_MIN_CHARS: "0",
      BACKEND_HTTP_PORT: "0",
      FEISHU_PORT: "-1"
    });

    expect(result).toEqual({
      maxImagesPerMessage: 4,
      discordMessageChunkLimit: 1900,
      feishuMessageChunkLimit: 8000,
      attachmentMaxBytes: 8 * 1024 * 1024,
      attachmentIssueLimitPerTurn: 1,
      heartbeatIntervalMs: 30_000,
      feishuStreamMinChars: 80,
      backendHttpPort: 8788,
      feishuPort: 8788
    });
  });

  test("parses valid turn recovery env values", () => {
    const result = parseTurnRecoveryConfig({
      TURN_REQUEST_STATUS_TTL_MS: "259200000",
      TURN_REQUEST_STATUS_MAX_RECORDS: "8888",
      TURN_REQUEST_STATUS_MAX_PER_THREAD: "123",
      TURN_RECOVERY_NOTIFY: "0"
    });

    expect(result).toEqual({
      requestStatusTtlMs: 259200000,
      requestStatusMaxRecords: 8888,
      requestStatusMaxPerThread: 123,
      notifyEnabled: false
    });
  });

  test("falls back and clamps invalid turn recovery env values", () => {
    const result = parseTurnRecoveryConfig({
      TURN_REQUEST_STATUS_TTL_MS: "1",
      TURN_REQUEST_STATUS_MAX_RECORDS: "0",
      TURN_REQUEST_STATUS_MAX_PER_THREAD: "-9"
    });

    expect(result.requestStatusTtlMs).toBe(60_000);
    expect(result.requestStatusMaxRecords).toBe(5000);
    expect(result.requestStatusMaxPerThread).toBe(300);
    expect(result.notifyEnabled).toBe(true);
  });
});
