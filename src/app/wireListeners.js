import { isBenignCodexStderrLine, isMissingRolloutPathError } from "./runtimeUtils.js";

function runDetached(label, action) {
  void Promise.resolve()
    .then(action)
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "unknown");
      console.error(`${label}: ${message}`);
    });
}

export function wireBridgeListeners({
  codex,
  discord,
  handleNotification,
  handleServerRequest,
  handleChannelCreate,
  handleMessage,
  handleInteraction
}) {
  codex.on("stderr", (line) => {
    if (isBenignCodexStderrLine(line)) {
      return;
    }
    if (isMissingRolloutPathError(line)) {
      // 缺失 rollout path 不是致命错误，只记录警告
      console.warn(`[codex] Ignoring missing rollout path error: ${line}`);
      return;
    }
    console.error(`[codex] ${line}`);
  });
  codex.on("notification", (event) => {
    runDetached(`notification handler failed for ${event?.method ?? "unknown"}`, () => handleNotification(event));
  });
  codex.on("serverRequest", (request) => {
    runDetached(`serverRequest handler failed for ${request?.method ?? "unknown"}`, () => handleServerRequest(request));
  });
  codex.on("exit", ({ code, signal }) => {
    console.error(`codex app-server exited (code=${code}, signal=${signal ?? "none"})`);
  });
  codex.on("error", (error) => {
    console.error(`codex app-server error: ${error.message}`);
  });

  discord.on("clientReady", () => {
    console.log(`Discord connected as ${discord.user?.tag}`);
  });
  discord.on("error", (error) => {
    console.error(`discord client error: ${error.message}`);
  });
  discord.on("shardError", (error, shardId) => {
    console.error(`discord shard error (shard=${shardId}): ${error.message}`);
  });

  discord.on("messageCreate", (message) => {
    runDetached(`message handler failed in channel ${message.channelId}`, () => handleMessage(message));
  });
  discord.on("channelCreate", (channel) => {
    runDetached(`channelCreate handler failed for ${channel?.id ?? "unknown"}`, () => handleChannelCreate(channel));
  });
  discord.on("interactionCreate", (interaction) => {
    runDetached("interaction handler failed", () => handleInteraction(interaction));
  });
}
