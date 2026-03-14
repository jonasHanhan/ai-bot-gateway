export function createDiscordPlatform(deps) {
  const {
    discord,
    discordToken,
    waitForDiscordReady,
    runtime,
    bootstrapChannelMappings,
    startTimeoutMs = 10_000
  } = deps;
  const enabled = Boolean(discordToken);
  let startAttempted = false;
  let started = false;
  let startError = null;

  function isAvailable() {
    return enabled && started && !startError;
  }

  function resetClient() {
    try {
      discord.destroy();
    } catch {}
  }

  return {
    platformId: "discord",
    enabled,
    capabilities: {
      supportsPlainMessages: true,
      supportsSlashCommands: true,
      supportsButtons: true,
      supportsAttachments: true,
      supportsRepoBootstrap: true,
      supportsAutoDiscovery: true,
      supportsWebhookIngress: false
    },
    canHandleRouteId(routeId) {
      const normalizedRouteId = String(routeId ?? "").trim();
      return normalizedRouteId.length > 0 && !normalizedRouteId.includes(":");
    },
    async fetchChannelByRouteId(routeId) {
      if (!isAvailable() || !this.canHandleRouteId(routeId)) {
        return null;
      }
      return await discord.channels.fetch(routeId).catch(() => null);
    },
    async handleInboundMessage(message) {
      if (!isAvailable()) {
        return;
      }
      await runtime.handleMessage(message);
    },
    async handleInboundInteraction(interaction) {
      if (!isAvailable()) {
        return;
      }
      await runtime.handleInteraction(interaction);
    },
    async start() {
      if (!enabled) {
        return {
          platformId: "discord",
          started: false,
          commandRegistration: null,
          commandRegistrationError: null
        };
      }

      startAttempted = true;
      started = false;
      startError = null;

      try {
        await withTimeout(
          (async () => {
            await discord.login(discordToken);
            await discord.application?.fetch().catch(() => null);
            await waitForDiscordReady(discord);
          })(),
          startTimeoutMs,
          "discord startup timed out"
        );

        let commandRegistration = null;
        let commandRegistrationError = null;
        if (typeof runtime.registerSlashCommands === "function") {
          try {
            commandRegistration = await runtime.registerSlashCommands();
          } catch (error) {
            commandRegistrationError = error;
          }
        }
        started = true;

        return {
          platformId: "discord",
          started: true,
          commandRegistration,
          commandRegistrationError
        };
      } catch (error) {
        startError = error;
        started = false;
        resetClient();
        return {
          platformId: "discord",
          started: false,
          startError: error,
          commandRegistration: null,
          commandRegistrationError: null
        };
      }
    },
    async bootstrapRoutes(options = {}) {
      if (!enabled || !started || startError || typeof bootstrapChannelMappings !== "function") {
        return null;
      }
      return await bootstrapChannelMappings(options);
    },
    async stop() {
      if (!startAttempted) {
        return { platformId: "discord", stopped: false };
      }
      started = false;
      resetClient();
      return { platformId: "discord", stopped: true };
    }
  };
}

async function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }

  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
