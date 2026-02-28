export function createDiscordRuntime(deps) {
  const {
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    bootstrapChannelMappings,
    shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    handleCommand,
    handleInitRepoCommand,
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision,
    safeReply,
    MessageFlags
  } = deps;

  async function handleMessage(message) {
    if (message.author.bot) {
      return;
    }

    const rawContent = message.content.trim();
    if (!isAllowedUser(message.author.id)) {
      console.warn(`ignoring message from filtered user ${message.author.id} in channel ${message.channelId}`);
      return;
    }

    const imageAttachments = collectImageAttachments(message);
    if (!rawContent && imageAttachments.length === 0) {
      return;
    }

    const content = normalizeIncomingContent(rawContent, discord.user?.id);
    if (!content && imageAttachments.length === 0) {
      return;
    }

    if (content.toLowerCase() === "!resync") {
      const result = await bootstrapChannelMappings();
      await safeReply(
        message,
        `Resynced channels. discovered=${result.discoveredCwds}, created=${result.createdChannels}, moved=${result.movedChannels}, pruned=${result.prunedBindings}, mapped=${Object.keys(getChannelSetups()).length}`
      );
      return;
    }

    if (content.toLowerCase() === "!rebuild") {
      const result = await bootstrapChannelMappings({ forceRebuild: true });
      await safeReply(
        message,
        `Rebuilt channels. nuked_channels=${result.deletedChannels}, nuked_categories=${result.deletedCategories}, cleared_bindings=${result.clearedBindings}, discovered=${result.discoveredCwds}, created=${result.createdChannels}, moved=${result.movedChannels}, pruned=${result.prunedBindings}, mapped=${Object.keys(getChannelSetups()).length}`
      );
      return;
    }

    const context = resolveRepoContext(message, {
      channelSetups: getChannelSetups(),
      config,
      generalChannel: {
        id: generalChannelId,
        name: generalChannelName,
        cwd: generalChannelCwd
      }
    });
    if (content.startsWith("!")) {
      const [commandRaw, ...restParts] = content.split(/\s+/);
      const command = commandRaw.toLowerCase();
      const rest = restParts.join(" ").trim();

      if (command === "!initrepo") {
        await handleInitRepoCommand(message, rest);
        return;
      }
    }

    if (!context) {
      return;
    }

    if (content.startsWith("!")) {
      await handleCommand(message, content, context);
      return;
    }

    if (shouldHandleAsSelfRestartRequest(content)) {
      await requestSelfRestartFromDiscord(message, content);
      return;
    }

    const inputItems = await buildTurnInputFromMessage(message, content, imageAttachments, context.setup);
    if (inputItems.length === 0) {
      return;
    }
    enqueuePrompt(context.repoChannelId, {
      inputItems,
      message,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
  }

  async function handleInteraction(interaction) {
    if (!interaction.isButton()) {
      return;
    }
    const parsed = parseApprovalButtonCustomId(interaction.customId, approvalButtonPrefix);
    if (!parsed) {
      return;
    }

    if (!isAllowedUser(interaction.user.id)) {
      await interaction.reply({
        content: "You are not allowed to approve requests for this bot.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const approval = pendingApprovals.get(parsed.token);
    if (!approval) {
      await interaction.reply({ content: "That approval is already resolved.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (approval.repoChannelId !== interaction.channelId) {
      await interaction.reply({
        content: "That approval belongs to a different channel.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const result = await applyApprovalDecision(parsed.token, parsed.decision, `<@${interaction.user.id}>`);
    if (!result.ok) {
      await interaction.reply({
        content: `Failed to send approval response: ${result.error}`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await interaction.reply({
      content: `${parsed.decision} sent for approval \`${parsed.token}\`.`,
      flags: MessageFlags.Ephemeral
    });
  }

  function isAllowedUser(userId) {
    if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
      return true;
    }
    return config.allowedUserIds.includes(userId);
  }

  return {
    handleMessage,
    handleInteraction
  };
}

function normalizeIncomingContent(content, botUserId) {
  if (!content) {
    return "";
  }
  if (!botUserId) {
    return content.trim();
  }
  const mentionPrefix = new RegExp(`^<@!?${botUserId}>\\s*`);
  return content.replace(mentionPrefix, "").trim();
}
