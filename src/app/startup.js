export async function startBridgeRuntime({
  codex,
  fs,
  generalChannelCwd,
  platformRegistry,
  maybeCompletePendingRestartNotice,
  turnRecoveryStore,
  safeSendToChannel,
  fetchChannelByRouteId,
  startBackendRuntime,
  setBackendReady,
  getMappedChannelCount,
  startHeartbeatLoop
}) {
  if (typeof setBackendReady === "function") {
    setBackendReady(false);
  }
  if (typeof startBackendRuntime === "function") {
    await startBackendRuntime();
  }
  await codex.start();
  await fs.mkdir(generalChannelCwd, { recursive: true }).catch((error) => {
    console.warn(`failed to ensure general cwd at ${generalChannelCwd}: ${error.message}`);
  });
  const platformStartSummaries = (await platformRegistry?.start?.()) ?? [];
  const readiness = summarizePlatformReadiness(platformRegistry, platformStartSummaries);
  for (const summary of platformStartSummaries) {
    if (summary?.startError) {
      console.error(`${summary.platformId} startup failed: ${summary.startError.message}`);
      continue;
    }

    if (summary?.platformId === "discord") {
      if (summary?.commandRegistrationError) {
        console.error(`slash command registration failed: ${summary.commandRegistrationError.message}`);
        continue;
      }
      if (summary?.commandRegistration?.scope === "guild") {
        console.log(
          `slash commands registered (scope=guild, guild=${summary.commandRegistration.guildId}, count=${summary.commandRegistration.count})`
        );
      } else if (summary?.commandRegistration?.count) {
        console.log(
          `slash commands registered (scope=${summary.commandRegistration.scope}, count=${summary.commandRegistration.count})`
        );
      }
      continue;
    }

    if (summary?.platformId === "feishu" && summary?.started) {
      if (summary?.transport === "long-connection") {
        console.log("feishu transport ready (mode=long-connection)");
      } else if (summary?.transport === "webhook") {
        console.log(`feishu transport ready (mode=webhook, path=${summary.webhookPath ?? "(unknown)"})`);
      }
      const feishuSegmentedStreaming = process.env.FEISHU_SEGMENTED_STREAMING !== "0";
      const configuredFeishuStreamMinChars = Number(process.env.FEISHU_STREAM_MIN_CHARS ?? "");
      const feishuStreamMinChars =
        Number.isFinite(configuredFeishuStreamMinChars) && configuredFeishuStreamMinChars > 0
          ? Math.floor(configuredFeishuStreamMinChars)
          : 80;
      console.log(
        `feishu segmented streaming=${feishuSegmentedStreaming ? "enabled" : "disabled"} (min_chars=${feishuStreamMinChars})`
      );
    }
  }
  await maybeCompletePendingRestartNotice();
  try {
    const recovery = await turnRecoveryStore.reconcilePending({
      fetchChannelByRouteId,
      codex,
      safeSendToChannel
    });
    if (recovery.reconciled > 0) {
      console.log(
        `turn recovery complete (reconciled=${recovery.reconciled}, resumed_known=${recovery.resumedKnown}, missing_thread=${recovery.missingThread}, skipped=${recovery.skipped})`
      );
    }
  } catch (error) {
    console.error(`turn recovery failed: ${error.message}`);
  }
  try {
    const bootstrapSummaries = (await platformRegistry?.bootstrapRoutes?.()) ?? [];
    const bootstrapSummary = bootstrapSummaries.find((summary) => summary?.platformId === "discord");
    if (bootstrapSummary) {
      console.log(
        `channel bootstrap complete (discovered=${bootstrapSummary.discoveredCwds}, created=${bootstrapSummary.createdChannels}, moved=${bootstrapSummary.movedChannels}, pruned=${bootstrapSummary.prunedBindings}, mapped=${getMappedChannelCount()})`
      );
    }
  } catch (error) {
    console.error(`channel bootstrap failed: ${error.message}`);
  }
  startHeartbeatLoop();
  if (typeof setBackendReady === "function") {
    setBackendReady(readiness);
  }
}

function summarizePlatformReadiness(platformRegistry, platformStartSummaries) {
  const enabledPlatforms = platformRegistry?.listEnabledPlatforms?.() ?? [];
  const summariesById = new Map(
    platformStartSummaries
      .filter(Boolean)
      .map((summary) => [String(summary.platformId ?? "").trim(), summary])
      .filter(([platformId]) => platformId)
  );
  const degradedPlatforms = [];

  for (const platform of enabledPlatforms) {
    const platformId = String(platform?.platformId ?? "").trim();
    if (!platformId) {
      continue;
    }

    const summary = summariesById.get(platformId);
    if (!summary) {
      degradedPlatforms.push({
        platformId,
        reason: "missing_start_summary"
      });
      continue;
    }

    if (summary.startError) {
      degradedPlatforms.push({
        platformId,
        reason: "startup_failed",
        message: summary.startError.message
      });
      continue;
    }

    if (summary.started !== true) {
      degradedPlatforms.push({
        platformId,
        reason: "not_started"
      });
    }
  }

  return {
    ready: degradedPlatforms.length === 0,
    degradedPlatforms
  };
}
