import { isBenignCodexStderrLine } from "./runtimeUtils.js";

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
    console.error(`[codex] ${line}`);
  });
  codex.on("notification", (event) => {
    void handleNotification(event).catch((error) => {
      console.error(`notification handler failed (${event?.method ?? "unknown"}): ${error.message}`);
    });
  });
  codex.on("serverRequest", (request) => {
    void handleServerRequest(request).catch((error) => {
      console.error(`server request handler failed (${request?.method ?? "unknown"}): ${error.message}`);
    });
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
    void handleMessage(message).catch((error) => {
      console.error(`message handler failed in channel ${message.channelId}: ${error.message}`);
    });
  });
  discord.on("channelCreate", (channel) => {
    void handleChannelCreate(channel).catch((error) => {
      console.error(`channelCreate handler failed for ${channel?.id ?? "unknown"}: ${error.message}`);
    });
  });
  discord.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction).catch((error) => {
      console.error(`interaction handler failed: ${error.message}`);
    });
  });
}
