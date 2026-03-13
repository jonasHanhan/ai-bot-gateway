export function createCommandRouter(deps) {
  const {
    ChannelType,
    isGeneralChannel,
    fs,
    path,
    execFileAsync,
    repoRootPath,
    managedChannelTopicPrefix,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    config,
    state,
    codex,
    pendingApprovals,
    makeChannelName,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    getQueue,
    findActiveTurnByRepoChannel,
    requestSelfRestartFromDiscord,
    findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision,
    safeReply,
    getChannelSetups,
    setChannelSetups,
    getPlatformRegistry
  } = deps;

  async function handleCommand(message, content, context) {
    const [commandRaw, ...restParts] = content.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "!help") {
      await safeReply(message, getHelpText({ platformId: inferPlatformId(message) }));
      return;
    }

    if (command === "!ask") {
      const imageAttachments = collectImageAttachments(message);
      if (!rest && imageAttachments.length === 0) {
        await safeReply(message, "Usage: `!ask <prompt>`");
        return;
      }
      const inputItems = await buildTurnInputFromMessage(message, rest, imageAttachments, context.setup);
      if (inputItems.length === 0) {
        await safeReply(message, "No usable text or image attachment found for `!ask`.");
        return;
      }
      enqueuePrompt(context.repoChannelId, {
        inputItems,
        message,
        setup: context.setup,
        repoChannelId: context.repoChannelId
      });
      return;
    }

    if (command === "!setpath") {
      await handleSetPathCommand(message, rest, context);
      return;
    }

    if (command === "!status") {
      const queue = getQueue(context.repoChannelId);
      const binding = state.getBinding(context.repoChannelId);
      const codexThreadId = binding?.codexThreadId ?? null;
      const activeTurn = findActiveTurnByRepoChannel(context.repoChannelId);
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      await safeReply(
        message,
        [
          `cwd: \`${context.setup.cwd}\``,
          `model: \`${context.setup.model ?? config.defaultModel}\`${context.setup.model ? " (channel override)" : " (default)"}`,
          `mode: ${modeLabel}`,
          `approval policy: \`${config.approvalPolicy}\``,
          `sandbox mode: \`${sandboxMode}\``,
          `file writes: ${fileWrites}`,
          `codex thread: ${codexThreadId ? `\`${codexThreadId}\`` : "none"}`,
          `queue depth: ${queue.jobs.length}`,
          `active turn: ${activeTurn ? "yes" : "no"}`
        ].join("\n")
      );
      return;
    }

    if (command === "!new") {
      state.clearBinding(context.repoChannelId);
      await state.save();
      await safeReply(message, "Cleared Codex thread binding for this channel. Next prompt starts a new Codex thread.");
      return;
    }

    if (command === "!restart") {
      await requestSelfRestartFromDiscord(message, rest || "manual restart requested from Discord command");
      return;
    }

    if (command === "!interrupt") {
      const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
      if (!threadId) {
        await safeReply(message, "No Codex thread is bound to this channel yet.");
        return;
      }
      try {
        await codex.request("turn/interrupt", { threadId });
        await safeReply(message, "Interrupt requested.");
      } catch (error) {
        await safeReply(message, `Interrupt failed: ${error.message}`);
      }
      return;
    }

    if (command === "!where") {
      const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
      const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
      const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
      const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
      const lines = [
        `codex bin: \`${codexBin}\``,
        `CODEX_HOME: \`${codexHomeEnv ?? "(unset; codex default path)"}\``,
        `state file: \`${statePath}\``,
        `channel config: \`${configPath}\``,
        `channel mode: \`${modeLabel}\``,
        `channel cwd: \`${context.setup.cwd}\``,
        `channel model: \`${context.setup.model ?? config.defaultModel}\`${context.setup.model ? " (channel override)" : " (default)"}`,
        `repo channel: \`${context.repoChannelId}\``,
        `approval policy: \`${config.approvalPolicy}\``,
        `sandbox mode: \`${sandboxMode}\``,
        `file writes: \`${fileWrites}\``,
        `codex thread: ${threadId ? `\`${threadId}\`` : "none"}`
      ];
      await safeReply(message, lines.join("\n"));
      return;
    }

    if (command === "!setmodel") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!setmodel` is only available in repo channels.");
        return;
      }
      const nextModel = String(rest ?? "").trim();
      if (!nextModel) {
        await safeReply(message, "Usage: `!setmodel <model>`");
        return;
      }

      const existingSetup = getChannelSetups()[message.channelId];
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }

      const nextSetup = {
        ...existingSetup,
        model: nextModel
      };
      await persistChannelSetupToConfig(fs, path, configPath, message.channelId, nextSetup);

      const nextSetups = { ...getChannelSetups() };
      nextSetups[message.channelId] = nextSetup;
      setChannelSetups(nextSetups);

      await safeReply(message, `Set this channel model override to \`${nextModel}\`.`);
      return;
    }

    if (command === "!clearmodel") {
      if (context.setup.mode === "general") {
        await safeReply(message, "`!clearmodel` is only available in repo channels.");
        return;
      }

      const existingSetup = getChannelSetups()[message.channelId];
      if (!existingSetup?.cwd) {
        await safeReply(message, "This channel is not bound to a repo path.");
        return;
      }
      if (typeof existingSetup.model !== "string") {
        await safeReply(message, `This channel already uses the default model \`${config.defaultModel}\`.`);
        return;
      }

      const nextSetup = {
        ...existingSetup
      };
      delete nextSetup.model;
      await persistChannelSetupToConfig(fs, path, configPath, message.channelId, nextSetup);

      const nextSetups = { ...getChannelSetups() };
      nextSetups[message.channelId] = nextSetup;
      setChannelSetups(nextSetups);

      await safeReply(message, `Cleared this channel model override. It will now use the default model \`${config.defaultModel}\`.`);
      return;
    }

    if (command === "!approve" || command === "!decline" || command === "!cancel") {
      let token = rest;
      if (!token) {
        token = findLatestPendingApprovalTokenForChannel(message.channelId);
        if (!token) {
          await safeReply(message, `No pending approvals in this channel. Usage: \`${command} <id>\``);
          return;
        }
      }
      const approval = pendingApprovals.get(token);
      if (!approval) {
        await safeReply(message, `No pending approval with id \`${token}\`.`);
        return;
      }
      if (approval.repoChannelId !== message.channelId) {
        await safeReply(message, "That approval belongs to a different channel.");
        return;
      }
      const decision = command === "!approve" ? "accept" : command === "!cancel" ? "cancel" : "decline";
      const result = await applyApprovalDecision(token, decision, `<@${message.author.id}>`);
      if (!result.ok) {
        await safeReply(message, `Failed to send approval response: ${result.error}`);
        return;
      }
      await safeReply(message, `${decision} sent for approval \`${token}\`.`);
      return;
    }

    await safeReply(message, "Unknown command. Use `!help`.");
  }

  async function runManagedRouteCommand(message, options = {}) {
    const { forceRebuild = false } = options;
    const registry = resolvePlatformRegistry();
    if (!registry?.anyPlatformSupports?.("supportsAutoDiscovery")) {
      await safeReply(message, "No configured platform currently supports managed route sync.");
      return;
    }

    try {
      const summaries = await registry.bootstrapRoutes({ forceRebuild });
      const primary = summaries.find((summary) => summary?.platformId === "discord") ?? summaries[0] ?? null;
      if (!primary) {
        await safeReply(message, "No managed route changes were needed.");
        return;
      }
      await safeReply(message, formatManagedRouteSummary(primary, Object.keys(getChannelSetups()).length, forceRebuild));
    } catch (error) {
      await safeReply(message, `${forceRebuild ? "Rebuild" : "Resync"} failed: ${error.message}`);
    }
  }

  function getHelpText(options = {}) {
    const platformId = String(options.platformId ?? "discord").trim().toLowerCase() || "discord";
    const registry = resolvePlatformRegistry();
    const prefix = platformId === "feishu" ? "/" : "!";
    const capabilities = registry?.getCapabilities?.(platformId) ?? {};
    const supportsSlashCommands = capabilities.supportsSlashCommands === true;
    const supportsButtons = capabilities.supportsButtons === true;
    const supportsRepoBootstrap = capabilities.supportsRepoBootstrap === true;
    const supportsAutoDiscovery = registry?.anyPlatformSupports?.("supportsAutoDiscovery") ?? platformId === "discord";
    const isDiscordPlatform = platformId === "discord";

    const lines = [
      supportsSlashCommands ? "Commands (use `!command` or `/command`):" : `Commands (use \`${prefix}command\`):`
    ];

    if (supportsRepoBootstrap) {
      lines.push(`\`${prefix}initrepo [force]\` create/bind repo for this channel using channel name`);
    }
    if (isDiscordPlatform) {
      lines.push(`\`${prefix}mkchannel <name>\` create a new text channel`);
      lines.push(
        `\`${prefix}mkrepo <name>\` create a new text channel and bind a new project directory under DISCORD_REPO_ROOT`
      );
      lines.push(`\`${prefix}mkbind <name> <absolute-path>\` create a new text channel and bind it to a repo/path`);
      lines.push(`\`${prefix}bind <absolute-path>\` bind this channel to an existing repo/path`);
      lines.push(`\`${prefix}rebind <absolute-path>\` rebind this channel to a different existing repo/path`);
      lines.push(`\`${prefix}unbind\` remove repo binding from this channel`);
      lines.push(`\`${prefix}setmodel <model>\` set an explicit model override for this channel`);
      lines.push(`\`${prefix}clearmodel\` remove this channel's explicit model override and use the default model`);
    }
    lines.push(`\`${prefix}setpath <abs-path>\` bind this chat to an existing repo path`);
    lines.push(`\`${prefix}ask <prompt>\` send prompt in this repo channel`);
    lines.push(`\`${prefix}status\` show queue/thread status for this channel`);
    lines.push(`\`${prefix}new\` reset Codex thread binding for this channel`);
    lines.push(`\`${prefix}restart [reason]\` request host-managed restart and confirm when back`);
    lines.push(`\`${prefix}interrupt\` interrupt current turn in this channel`);
    lines.push(`\`${prefix}where\` show bot runtime paths and binding details`);
    lines.push(`\`${prefix}approve [id]\` approve the latest (or specified) pending request`);
    lines.push(`\`${prefix}decline [id]\` decline the latest (or specified) pending request`);
    lines.push(`\`${prefix}cancel [id]\` cancel the latest (or specified) pending request`);
    if (supportsAutoDiscovery) {
      lines.push(`\`${prefix}resync\` non-destructive sync with managed project routes`);
      lines.push(`\`${prefix}rebuild\` destructive rebuild of managed project routes`);
    }
    if (supportsButtons) {
      lines.push("Tip: use the Approve/Decline/Cancel buttons on approval messages");
    }
    lines.push("Model: one chat route = one persistent Codex thread");
    lines.push("Also supported in #general-style chats: plain chat and commands (read-only, no file writes)");

    if (!supportsRepoBootstrap && platformId === "feishu") {
      lines.push("Feishu repo chat bindings are config-driven via `config/channels.json` keys like `feishu:oc_xxx`.");
    }
    if (platformId === "feishu") {
      lines.push("Group chats default to command messages or messages that @mention the bot.");
    }

    return lines.join("\n");
  }

  function isCommandSupportedForPlatform(commandName, platformId) {
    const normalizedCommandName = String(commandName ?? "").trim().toLowerCase();
    const normalizedPlatformId = String(platformId ?? "").trim().toLowerCase();
    const registry = resolvePlatformRegistry();
    if (!registry) {
      return normalizedPlatformId !== "feishu" || !DISCORD_ONLY_COMMANDS.has(normalizedCommandName);
    }

    if (normalizedCommandName === "initrepo") {
      return registry.platformSupports?.(normalizedPlatformId, "supportsRepoBootstrap") ?? false;
    }
    if (normalizedCommandName === "resync" || normalizedCommandName === "rebuild") {
      return registry.anyPlatformSupports?.("supportsAutoDiscovery") ?? false;
    }
    if (DISCORD_ONLY_COMMANDS.has(normalizedCommandName)) {
      return normalizedPlatformId === "discord";
    }
    return true;
  }

  function resolvePlatformRegistry() {
    return typeof getPlatformRegistry === "function" ? getPlatformRegistry() : null;
  }

  function inferPlatformId(message) {
    return String(message?.platform ?? "discord").trim().toLowerCase() || "discord";
  }

  async function handleInitRepoCommand(message, rest) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, "`!initrepo` is only available in server text channels.");
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, "`!initrepo` is disabled in #general (read-only channel).");
      return;
    }
    if (!repoRootPath) {
      await safeReply(message, "Set `DISCORD_REPO_ROOT` in `.env` before using `!initrepo`.");
      return;
    }

    const force = rest.toLowerCase() === "force";
    const repoName = makeChannelName(message.channel.name);
    const repoPath = path.join(repoRootPath, repoName);
    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];

    if (existingSetup && existingSetup.cwd !== repoPath && !force) {
      await safeReply(
        message,
        `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!initrepo force\` to rebind.`
      );
      return;
    }

    await fs.mkdir(repoRootPath, { recursive: true });
    const repoExists = await pathExists(fs, repoPath);
    if (repoExists && !force && (!existingSetup || existingSetup.cwd !== repoPath)) {
      await safeReply(
        message,
        `Repo path already exists: \`${repoPath}\`. Rename channel or run \`!initrepo force\`.`
      );
      return;
    }

    await fs.mkdir(repoPath, { recursive: true });
    await initializeRepoPath(repoPath);

    await bindChannelToPath(message.channel, message.channelId, repoPath);

    await safeReply(
      message,
      `Initialized repo \`${repoName}\` at \`${repoPath}\` and bound this channel.`
    );
  }

  async function handleSetPathCommand(message, rest, context = null) {
    const routeId = String(message?.channelId ?? "").trim();
    if (!routeId) {
      await safeReply(message, "Unable to determine the current chat route.");
      return;
    }

    const rawPath = String(rest ?? "").trim();
    if (!rawPath) {
      await safeReply(message, "Usage: `!setpath /absolute/path/to/repo`");
      return;
    }

    const targetPath = path.resolve(rawPath);
    let stats = null;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      await safeReply(message, `Path does not exist: \`${targetPath}\``);
      return;
    }
    if (typeof stats?.isDirectory === "function" && !stats.isDirectory()) {
      await safeReply(message, `Path is not a directory: \`${targetPath}\``);
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[routeId] ?? null;
    if (existingSetup?.cwd === targetPath) {
      await safeReply(message, `This chat is already bound to \`${targetPath}\`.`);
      return;
    }

    const nextSetup = {
      cwd: targetPath,
      model:
        existingSetup?.model ??
        config.channels?.[routeId]?.model ??
        context?.setup?.model ??
        config.defaultModel
    };

    await persistChannelSetupToConfig(fs, path, configPath, routeId, nextSetup);

    const nextSetups = {
      ...channelSetups,
      [routeId]: nextSetup
    };
    setChannelSetups(nextSetups);

    if (config.channels && typeof config.channels === "object") {
      config.channels[routeId] = { ...nextSetup };
    }

    state.clearBinding(routeId);
    await state.save();

    if (
      message?.channel?.type === ChannelType.GuildText &&
      typeof message?.channel?.setTopic === "function" &&
      managedChannelTopicPrefix
    ) {
      const nextTopic = upsertTopicTag(message.channel.topic, managedChannelTopicPrefix, targetPath);
      if (nextTopic !== message.channel.topic) {
        await message.channel.setTopic(nextTopic).catch((error) => {
          console.warn(`failed setting channel topic for ${routeId}: ${error.message}`);
        });
      }
    }

    await safeReply(
      message,
      [
        `Bound this chat to \`${targetPath}\`.`,
        "Cleared the existing Codex thread binding.",
        "Next prompt will start a new Codex thread in the new working path."
      ].join("\n")
    );
  }

  async function handleBindCommand(message, rest, options = {}) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, `\`${options.rebind ? "!rebind" : "!bind"}\` is only available in server text channels.`);
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, `\`${options.rebind ? "!rebind" : "!bind"}\` is disabled in #general (read-only channel).`);
      return;
    }

    const targetPath = String(rest ?? "").trim();
    if (!targetPath) {
      await safeReply(message, `Usage: \`${options.rebind ? "!rebind" : "!bind"} <absolute-path>\``);
      return;
    }
    if (!path.isAbsolute(targetPath)) {
      await safeReply(message, "Provide an absolute path, for example `/Users/jonashan/openclaw-web`.");
      return;
    }

    const repoPath = path.resolve(targetPath);
    const stats = await fs.stat(repoPath).catch(() => null);
    if (!stats?.isDirectory()) {
      await safeReply(message, `Path does not exist or is not a directory: \`${repoPath}\``);
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];
    if (existingSetup?.cwd === repoPath) {
      await safeReply(message, `This channel is already bound to \`${repoPath}\`.`);
      return;
    }
    if (existingSetup && !options.rebind) {
      await safeReply(
        message,
        `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!rebind ${repoPath}\` to switch.`
      );
      return;
    }

    await bindChannelToPath(message.channel, message.channelId, repoPath, {
      ...(typeof existingSetup?.model === "string" ? { model: existingSetup.model } : {})
    });

    await safeReply(
      message,
      `${options.rebind ? "Rebound" : "Bound"} this channel to \`${repoPath}\`. Next prompt starts a fresh Codex thread.`
    );
  }

  async function handleMakeChannelCommand(message, rest, options = {}) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(
        message,
        `\`${options.bindPath ? "!mkbind" : options.initRepo ? "!mkrepo" : "!mkchannel"}\` is only available in server text channels.`
      );
      return;
    }

    const parsed = parseMakeChannelArgs(rest, path, {
      requirePath: Boolean(options.bindPath),
      initRepo: Boolean(options.initRepo)
    });
    if (!parsed.ok) {
      await safeReply(message, parsed.error);
      return;
    }

    const guild = message.guild;
    if (!guild) {
      await safeReply(message, "This command only works inside a Discord server.");
      return;
    }

    await guild.channels.fetch().catch(() => null);
    const baseName = makeChannelName(parsed.channelName);
    const channelName = uniqueGuildTextChannelName(guild, baseName, ChannelType.GuildText);
    const parent = message.channel.parentId ?? undefined;
    const repoPath = options.initRepo && repoRootPath ? path.join(repoRootPath, channelName) : null;

    if (options.bindPath) {
      const stats = await fs.stat(parsed.bindPath).catch(() => null);
      if (!stats?.isDirectory()) {
        await safeReply(message, `Path does not exist or is not a directory: \`${parsed.bindPath}\``);
        return;
      }
    }

    if (options.initRepo) {
      if (!repoRootPath) {
        await safeReply(message, "Set `DISCORD_REPO_ROOT` in `.env` before using `!mkrepo`.");
        return;
      }
      await fs.mkdir(repoRootPath, { recursive: true });
      if (await pathExists(fs, repoPath)) {
        await safeReply(
          message,
          `Repo path already exists: \`${repoPath}\`. Choose a different channel name or use \`!mkchannel\` + \`!bind\`.`
        );
        return;
      }
    }

    let createdChannel;
    try {
      createdChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        ...(parent ? { parent } : {})
      });
    } catch (error) {
      await safeReply(message, `Failed to create channel: ${error.message}`);
      return;
    }

    if (options.initRepo) {
      try {
        await fs.mkdir(repoPath, { recursive: true });
        await bindChannelToPath(createdChannel, createdChannel.id, repoPath);
        await safeReply(
          message,
          `Created channel <#${createdChannel.id}> and bound it to new project path \`${repoPath}\`.`
        );
      } catch (error) {
        await safeReply(
          message,
          `Created channel <#${createdChannel.id}>, but project path setup failed: ${error.message}`
        );
      }
      return;
    }

    if (!options.bindPath) {
      await safeReply(message, `Created channel <#${createdChannel.id}>.`);
      return;
    }

    try {
      await bindChannelToPath(createdChannel, createdChannel.id, parsed.bindPath);
      await safeReply(message, `Created channel <#${createdChannel.id}> and bound it to \`${parsed.bindPath}\`.`);
    } catch (error) {
      await safeReply(
        message,
        `Created channel <#${createdChannel.id}>, but binding failed: ${error.message}`
      );
    }
  }

  async function handleUnbindCommand(message) {
    if (message.channel.type !== ChannelType.GuildText) {
      await safeReply(message, "`!unbind` is only available in server text channels.");
      return;
    }
    if (isGeneralChannel(message.channel)) {
      await safeReply(message, "`!unbind` is disabled in #general (read-only channel).");
      return;
    }

    const channelSetups = getChannelSetups();
    const existingSetup = channelSetups[message.channelId];
    if (!existingSetup) {
      await safeReply(message, "This channel is not bound to a repo path.");
      return;
    }

    const nextSetups = { ...channelSetups };
    delete nextSetups[message.channelId];
    await removeChannelSetupFromConfig(fs, path, configPath, message.channelId);
    setChannelSetups(nextSetups);
    state.clearBinding(message.channelId);
    await state.save();

    const nextTopic = removeTopicTag(message.channel.topic, managedChannelTopicPrefix);
    if (nextTopic !== message.channel.topic) {
      await message.channel.setTopic(nextTopic).catch((error) => {
        console.warn(`failed clearing channel topic for ${message.channelId}: ${error.message}`);
      });
    }

    await safeReply(
      message,
      `Unbound this channel from \`${existingSetup.cwd}\`. Plain messages will stop routing here until you bind it again.`
    );
  }

  async function bindChannelToPath(channel, channelId, repoPath, options = {}) {
    const nextSetup = {
      cwd: repoPath,
      ...(typeof options.model === "string" ? { model: options.model } : {})
    };

    await persistChannelSetupToConfig(fs, path, configPath, channelId, nextSetup);

    const nextSetups = { ...getChannelSetups() };
    nextSetups[channelId] = nextSetup;
    setChannelSetups(nextSetups);
    state.clearBinding(channelId);
    await state.save();

    const nextTopic = upsertTopicTag(channel.topic, managedChannelTopicPrefix, repoPath);
    if (nextTopic !== channel.topic && typeof channel.setTopic === "function") {
      await channel.setTopic(nextTopic).catch((error) => {
        console.warn(`failed setting channel topic for ${channelId}: ${error.message}`);
      });
    }
  }

  async function initializeRepoPath(repoPath) {
    await execFileAsync("git", ["-C", repoPath, "init"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
  }

  return {
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand
  };
}

function formatManagedRouteSummary(summary, mappedCount, forceRebuild) {
  if (forceRebuild) {
    return `Rebuilt channels. nuked_channels=${summary.deletedChannels}, nuked_categories=${summary.deletedCategories}, cleared_bindings=${summary.clearedBindings}, discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
  }
  return `Resynced channels. discovered=${summary.discoveredCwds}, created=${summary.createdChannels}, moved=${summary.movedChannels}, pruned=${summary.prunedBindings}, mapped=${mappedCount}`;
}

const DISCORD_ONLY_COMMANDS = new Set([
  "mkchannel",
  "mkrepo",
  "mkbind",
  "bind",
  "rebind",
  "unbind",
  "setmodel",
  "clearmodel"
]);

function upsertTopicTag(topic, prefix, value) {
  const safeValue = String(value ?? "").trim();
  if (!safeValue) {
    return typeof topic === "string" ? topic : "";
  }
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  const kept = lines.filter((line) => !line.startsWith(prefix));
  kept.push(`${prefix}${safeValue}`);
  return kept.join("\n").trim();
}

function removeTopicTag(topic, prefix) {
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  return lines.filter((line) => !line.startsWith(prefix)).join("\n").trim();
}

function parseMakeChannelArgs(rest, pathModule, options = {}) {
  const requirePath = options.requirePath === true;
  const initRepo = options.initRepo === true;
  const text = String(rest ?? "").trim();
  if (!text) {
    return {
      ok: false,
      error: requirePath
        ? "Usage: `!mkbind <channel-name> <absolute-path>`"
        : initRepo
          ? "Usage: `!mkrepo <channel-name>`"
        : "Usage: `!mkchannel <channel-name>`"
    };
  }

  if (!requirePath) {
    return { ok: true, channelName: text };
  }

  const parts = text.split(/\s+/);
  let pathStart = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (pathModule.isAbsolute(parts[index])) {
      pathStart = index;
      break;
    }
  }
  if (pathStart <= 0) {
    return {
      ok: false,
      error: "Usage: `!mkbind <channel-name> <absolute-path>`"
    };
  }

  const channelName = parts.slice(0, pathStart).join(" ").trim();
  const bindPath = pathModule.resolve(parts.slice(pathStart).join(" ").trim());
  if (!channelName) {
    return {
      ok: false,
      error: "Usage: `!mkbind <channel-name> <absolute-path>`"
    };
  }

  return {
    ok: true,
    channelName,
    bindPath
  };
}

function uniqueGuildTextChannelName(guild, baseName, textChannelType) {
  let candidate = baseName;
  let index = 2;
  const lowerExisting = new Set(
    [...guild.channels.cache.values()]
      .filter((channel) => channel.type === textChannelType)
      .map((channel) => channel.name.toLowerCase())
  );

  while (lowerExisting.has(candidate.toLowerCase())) {
    const suffix = `-${index}`;
    candidate = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
    index += 1;
  }

  return candidate;
}

async function pathExists(fsModule, targetPath) {
  try {
    await fsModule.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function persistChannelSetupToConfig(fsModule, pathModule, targetConfigPath, channelId, setup) {
  const document = await readConfigDocument(fsModule, targetConfigPath);
  const channels =
    document && typeof document.channels === "object" && document.channels !== null && !Array.isArray(document.channels)
      ? { ...document.channels }
      : {};

  channels[channelId] = {
    cwd: setup.cwd,
    ...(typeof setup.model === "string" ? { model: setup.model } : {})
  };

  document.channels = channels;
  await writeConfigDocument(fsModule, pathModule, targetConfigPath, document);
}

async function removeChannelSetupFromConfig(fsModule, pathModule, targetConfigPath, channelId) {
  const document = await readConfigDocument(fsModule, targetConfigPath);
  const channels =
    document && typeof document.channels === "object" && document.channels !== null && !Array.isArray(document.channels)
      ? { ...document.channels }
      : {};

  delete channels[channelId];
  document.channels = channels;
  await writeConfigDocument(fsModule, pathModule, targetConfigPath, document);
}

async function readConfigDocument(fsModule, targetConfigPath) {
  try {
    const raw = await fsModule.readFile(targetConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Channel config is not valid JSON: ${targetConfigPath}`);
    }
    throw error;
  }
}

async function writeConfigDocument(fsModule, pathModule, targetConfigPath, document) {
  await fsModule.mkdir(pathModule.dirname(targetConfigPath), { recursive: true });
  await fsModule.writeFile(targetConfigPath, JSON.stringify(document, null, 2), "utf8");
}
