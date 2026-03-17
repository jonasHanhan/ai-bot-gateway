const TURN_RECOVERY_DEFAULTS = {
  requestStatusTtlMs: 3 * 24 * 60 * 60 * 1000,
  requestStatusMaxRecords: 5000,
  requestStatusMaxPerThread: 300,
  notifyEnabled: true
};

const RUNTIME_NUMERIC_DEFAULTS = {
  maxImagesPerMessage: 4,
  discordMessageChunkLimit: 1900,
  feishuMessageChunkLimit: 8000,
  attachmentMaxBytes: 8 * 1024 * 1024,
  attachmentIssueLimitPerTurn: 1,
  heartbeatIntervalMs: 30_000,
  feishuStreamMinChars: 80,
  backendHttpPort: 8788,
  feishuPort: 8788
};

const RUNTIME_NUMERIC_LIMITS = {
  maxImagesPerMessage: { min: 1 },
  discordMessageChunkLimit: { min: 200 },
  feishuMessageChunkLimit: { min: 200 },
  attachmentMaxBytes: { min: 1 },
  attachmentIssueLimitPerTurn: { min: 0 },
  heartbeatIntervalMs: { min: 5_000 },
  feishuStreamMinChars: { min: 1 },
  backendHttpPort: { min: 1 },
  feishuPort: { min: 1 }
};

const TURN_RECOVERY_LIMITS = {
  requestStatusTtlMs: {
    min: 60_000
  },
  requestStatusMaxRecords: {
    min: 100
  },
  requestStatusMaxPerThread: {
    min: 1
  }
};

function parseBoundedInt(rawValue, fallback, min) {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(min, Math.floor(parsed));
}

function parseMinOrFallbackInt(rawValue, fallback, min) {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  return floored >= min ? floored : fallback;
}

function parseNonNegativeInt(rawValue, fallback, min = 0) {
  const parsed = Number(rawValue ?? "");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.max(min, Math.floor(parsed));
}

export function parseRuntimeNumericConfig(env = process.env) {
  const backendPortRaw = env.BACKEND_HTTP_PORT ?? env.FEISHU_PORT ?? "";
  const feishuPortRaw = env.FEISHU_PORT ?? "";

  return {
    maxImagesPerMessage: parseBoundedInt(
      env.DISCORD_MAX_IMAGES_PER_MESSAGE,
      RUNTIME_NUMERIC_DEFAULTS.maxImagesPerMessage,
      RUNTIME_NUMERIC_LIMITS.maxImagesPerMessage.min
    ),
    discordMessageChunkLimit: parseMinOrFallbackInt(
      env.DISCORD_MESSAGE_CHUNK_LIMIT ?? env.DISCORD_MAX_MESSAGE_LENGTH,
      RUNTIME_NUMERIC_DEFAULTS.discordMessageChunkLimit,
      RUNTIME_NUMERIC_LIMITS.discordMessageChunkLimit.min
    ),
    feishuMessageChunkLimit: parseMinOrFallbackInt(
      env.FEISHU_MESSAGE_CHUNK_LIMIT,
      RUNTIME_NUMERIC_DEFAULTS.feishuMessageChunkLimit,
      RUNTIME_NUMERIC_LIMITS.feishuMessageChunkLimit.min
    ),
    attachmentMaxBytes: parseBoundedInt(
      env.DISCORD_ATTACHMENT_MAX_BYTES,
      RUNTIME_NUMERIC_DEFAULTS.attachmentMaxBytes,
      RUNTIME_NUMERIC_LIMITS.attachmentMaxBytes.min
    ),
    attachmentIssueLimitPerTurn: parseNonNegativeInt(
      env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN,
      RUNTIME_NUMERIC_DEFAULTS.attachmentIssueLimitPerTurn,
      RUNTIME_NUMERIC_LIMITS.attachmentIssueLimitPerTurn.min
    ),
    heartbeatIntervalMs: parseMinOrFallbackInt(
      env.DISCORD_HEARTBEAT_INTERVAL_MS,
      RUNTIME_NUMERIC_DEFAULTS.heartbeatIntervalMs,
      RUNTIME_NUMERIC_LIMITS.heartbeatIntervalMs.min
    ),
    feishuStreamMinChars: parseBoundedInt(
      env.FEISHU_STREAM_MIN_CHARS,
      RUNTIME_NUMERIC_DEFAULTS.feishuStreamMinChars,
      RUNTIME_NUMERIC_LIMITS.feishuStreamMinChars.min
    ),
    backendHttpPort: parseBoundedInt(
      backendPortRaw,
      RUNTIME_NUMERIC_DEFAULTS.backendHttpPort,
      RUNTIME_NUMERIC_LIMITS.backendHttpPort.min
    ),
    feishuPort: parseBoundedInt(
      feishuPortRaw,
      RUNTIME_NUMERIC_DEFAULTS.feishuPort,
      RUNTIME_NUMERIC_LIMITS.feishuPort.min
    )
  };
}

export function parseTurnRecoveryConfig(env = process.env) {
  return {
    requestStatusTtlMs: parseBoundedInt(
      env.TURN_REQUEST_STATUS_TTL_MS,
      TURN_RECOVERY_DEFAULTS.requestStatusTtlMs,
      TURN_RECOVERY_LIMITS.requestStatusTtlMs.min
    ),
    requestStatusMaxRecords: parseBoundedInt(
      env.TURN_REQUEST_STATUS_MAX_RECORDS,
      TURN_RECOVERY_DEFAULTS.requestStatusMaxRecords,
      TURN_RECOVERY_LIMITS.requestStatusMaxRecords.min
    ),
    requestStatusMaxPerThread: parseBoundedInt(
      env.TURN_REQUEST_STATUS_MAX_PER_THREAD,
      TURN_RECOVERY_DEFAULTS.requestStatusMaxPerThread,
      TURN_RECOVERY_LIMITS.requestStatusMaxPerThread.min
    ),
    notifyEnabled: env.TURN_RECOVERY_NOTIFY !== "0"
  };
}

export const runtimeConfigSchema = {
  numeric: {
    defaults: RUNTIME_NUMERIC_DEFAULTS,
    limits: RUNTIME_NUMERIC_LIMITS
  },
  turnRecovery: {
    defaults: TURN_RECOVERY_DEFAULTS,
    limits: TURN_RECOVERY_LIMITS
  }
};
