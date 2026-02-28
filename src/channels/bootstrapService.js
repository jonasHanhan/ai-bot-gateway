export function createBootstrapService(deps) {
  const {
    ChannelType,
    path,
    discord,
    codex,
    config,
    state,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups
  } = deps;

  async function bootstrapChannelMappings(options = {}) {
    const forceRebuild = options.forceRebuild === true;
    const guild = await resolveGuild();
    await guild.channels.fetch();
    let rebuildStats = {
      deletedChannels: 0,
      deletedCategories: 0,
      clearedBindings: 0,
      deletedCwds: []
    };

    if (forceRebuild) {
      rebuildStats = await resetManagedLayout(guild);
      setChannelSetups({});
    }

    await guild.channels.fetch();
    const projectsCategory = await ensureProjectsCategory(guild);
    const cutover = await performCutoverCleanup(guild, projectsCategory.id);

    const discoveredFromTopics = collectChannelSetupsFromGuildTopics(guild);
    const merged = { ...getChannelSetups(), ...discoveredFromTopics };
    const sanitized = {};
    for (const [channelId, setup] of Object.entries(merged)) {
      const channel = guild.channels.cache.get(channelId);
      if (channel?.type === ChannelType.GuildText) {
        sanitized[channelId] = setup;
      }
    }
    setChannelSetups(sanitized);

    let discoveredCwds = [];

    try {
      discoveredCwds = await discoverProjectsFromCodex();
    } catch (error) {
      console.error(`failed to discover projects from codex: ${error.message}`);
    }
    if (forceRebuild && discoveredCwds.length === 0 && rebuildStats.deletedCwds.length > 0) {
      discoveredCwds = rebuildStats.deletedCwds;
    }

    let createdChannels = 0;
    for (const cwd of discoveredCwds) {
      if (!cwd) {
        continue;
      }
      if (findChannelIdByCwd(cwd)) {
        continue;
      }
      let channel = null;
      try {
        channel = await ensureProjectChannel(guild, cwd, projectsCategory.id);
      } catch (error) {
        if (isDiscordMissingPermissionsError(error)) {
          console.error(
            "Discord denied channel creation (Missing Permissions). Grant the bot role `Manage Channels` (or Administrator), then run `!resync`."
          );
          break;
        }
        throw error;
      }
      if (channel) {
        createdChannels += 1;
        const setups = getChannelSetups();
        setups[channel.id] = {
          cwd,
          model: config.defaultModel
        };
      }
    }

    const prunedBindings = await pruneInvalidThreadBindings(guild);

    return {
      discoveredCwds: discoveredCwds.length,
      createdChannels,
      movedChannels: cutover.movedChannels,
      prunedBindings,
      deletedChannels: rebuildStats.deletedChannels,
      deletedCategories: rebuildStats.deletedCategories,
      clearedBindings: rebuildStats.clearedBindings
    };
  }

  async function resolveGuild() {
    const configuredGuildId = process.env.DISCORD_GUILD_ID;
    if (configuredGuildId) {
      const guild = discord.guilds.cache.get(configuredGuildId);
      if (guild) {
        return guild;
      }
      const fetchedGuild = await discord.guilds.fetch(configuredGuildId).catch(() => null);
      if (fetchedGuild) {
        return fetchedGuild;
      }
      const allGuilds = await discord.guilds.fetch().catch(() => new Map());
      const knownGuilds = [...allGuilds.values()].map((g) => `${g.name} (${g.id})`);
      const appId = discord.application?.id;
      throw new Error(
        [
          `DISCORD_GUILD_ID=${configuredGuildId} is not visible to this bot.`,
          knownGuilds.length > 0
            ? `Bot can access: ${knownGuilds.join(", ")}`
            : "Bot is not in any guilds.",
          appId
            ? `Re-invite with guild install + bot scope: https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=274877975552`
            : "Re-invite the bot with guild install and bot scope."
        ].join(" ")
      );
    }

    const guilds = [...discord.guilds.cache.values()];
    if (guilds.length === 1) {
      return guilds[0];
    }

    const fetched = await discord.guilds.fetch().catch(() => new Map());
    if (fetched.size === 1) {
      return [...fetched.values()][0];
    }

    throw new Error("Set DISCORD_GUILD_ID (bot is in multiple guilds).");
  }

  async function ensureProjectsCategory(guild) {
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.type === ChannelType.GuildCategory &&
        channel.name.toLowerCase() === projectsCategoryName.toLowerCase()
      ) {
        return channel;
      }
    }
    return guild.channels.create({
      name: projectsCategoryName,
      type: ChannelType.GuildCategory
    });
  }

  async function resetManagedLayout(guild) {
    await guild.channels.fetch();

    let deletedChannels = 0;
    const touchedCategoryIds = new Set();
    const deletedCwdSet = new Set();

    for (const channel of guild.channels.cache.values()) {
      if (!isManagedChannelForCleanup(channel)) {
        continue;
      }
      const cwd = parseCwdFromTopic(channel.topic);
      if (cwd) {
        deletedCwdSet.add(cwd);
      }
      if (channel.parentId) {
        touchedCategoryIds.add(channel.parentId);
      }
      try {
        await channel.delete("rebuild: delete managed codex channel");
        deletedChannels += 1;
      } catch (error) {
        if (isDiscordMissingPermissionsError(error)) {
          console.error(`Missing permissions deleting managed channel ${channel.id} during rebuild.`);
          continue;
        }
        throw error;
      }
    }

    const snapshot = state.snapshot();
    const bindings = snapshot?.threadBindings ?? {};
    const clearedBindings = Object.keys(bindings).length;
    if (clearedBindings > 0) {
      state.clearAllBindings();
      await state.save();
    }

    await guild.channels.fetch();
    const legacyCategoryBaseNames = new Set([...deletedCwdSet].map((cwd) => makeChannelName(path.basename(cwd) || "repo")));
    const categoriesToDelete = new Set();
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildCategory) {
        continue;
      }
      const lowerName = channel.name.toLowerCase();
      const isProjectsCategory = lowerName === projectsCategoryName.toLowerCase();
      const isTouched = touchedCategoryIds.has(channel.id);
      const isLegacyByName = isLegacyProjectCategoryName(lowerName, legacyCategoryBaseNames);
      if (isProjectsCategory || isTouched || isLegacyByName) {
        categoriesToDelete.add(channel.id);
      }
    }

    let deletedCategories = 0;
    for (const categoryId of categoriesToDelete) {
      const category = guild.channels.cache.get(categoryId);
      if (category?.type !== ChannelType.GuildCategory) {
        continue;
      }
      const hasChildren = [...guild.channels.cache.values()].some((candidate) => candidate.parentId === category.id);
      if (hasChildren) {
        continue;
      }
      try {
        await category.delete("rebuild: delete stale category");
        deletedCategories += 1;
      } catch (error) {
        if (isDiscordMissingPermissionsError(error)) {
          console.error(`Missing permissions deleting category ${category.id} during rebuild.`);
          continue;
        }
        throw error;
      }
    }

    return {
      deletedChannels,
      deletedCategories,
      clearedBindings,
      deletedCwds: [...deletedCwdSet].sort((a, b) => a.localeCompare(b))
    };
  }

  async function discoverProjectsFromCodex() {
    if (config.autoDiscoverProjects === false) {
      return [];
    }

    const cwds = new Set();
    let cursor = undefined;
    let page = 0;

    while (page < 50) {
      const params = { limit: 100, sortKey: "updated_at" };
      if (cursor) {
        params.cursor = cursor;
      }
      const response = await codex.request("thread/list", params);
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        if (typeof row?.cwd === "string" && row.cwd.trim()) {
          cwds.add(path.resolve(row.cwd));
        }
      }
      if (!response?.nextCursor) {
        break;
      }
      cursor = response.nextCursor;
      page += 1;
    }

    return [...cwds].sort((a, b) => a.localeCompare(b));
  }

  function collectChannelSetupsFromGuildTopics(guild) {
    const discovered = {};
    for (const channel of guild.channels.cache.values()) {
      if (!isManagedRepoChannel(channel)) {
        continue;
      }
      const cwd = parseCwdFromTopic(channel.topic);
      if (!cwd) {
        continue;
      }
      discovered[channel.id] = {
        cwd,
        model: findConfiguredModelForCwd(cwd)
      };
    }
    return discovered;
  }

  function findConfiguredModelForCwd(cwd) {
    const resolvedCwd = path.resolve(cwd);
    for (const setup of Object.values(getChannelSetups())) {
      if (setup?.cwd === resolvedCwd && typeof setup?.model === "string") {
        return setup.model;
      }
    }
    for (const setup of Object.values(config.channels)) {
      if (setup?.cwd === resolvedCwd && typeof setup?.model === "string") {
        return setup.model;
      }
    }
    return config.defaultModel;
  }

  async function ensureProjectChannel(guild, cwd, projectsCategoryId) {
    const existing = findGuildChannelByCwd(guild, cwd);
    if (existing) {
      if (existing.parentId !== projectsCategoryId) {
        await existing.setParent(projectsCategoryId, { lockPermissions: false });
      }
      const expectedTopic = topicForCwd(cwd);
      if (existing.topic !== expectedTopic) {
        await existing.setTopic(expectedTopic);
      }
      return existing;
    }

    const baseName = makeChannelName(path.basename(cwd) || "repo");
    const name = uniqueChannelName(guild, baseName);
    const topic = topicForCwd(cwd);

    return guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: projectsCategoryId,
      topic
    });
  }

  function findGuildChannelByCwd(guild, cwd) {
    for (const channel of guild.channels.cache.values()) {
      if (!isManagedRepoChannel(channel)) {
        continue;
      }
      const parsed = parseCwdFromTopic(channel.topic);
      if (parsed === cwd) {
        return channel;
      }
    }
    return null;
  }

  async function performCutoverCleanup(guild, projectsCategoryId) {
    let movedChannels = 0;

    for (const channel of guild.channels.cache.values()) {
      if (!isManagedRepoChannel(channel)) {
        continue;
      }
      if (channel.parentId === projectsCategoryId) {
        continue;
      }
      try {
        await channel.setParent(projectsCategoryId, { lockPermissions: false });
      } catch (error) {
        if (isDiscordMissingPermissionsError(error)) {
          console.error("Missing permissions to move channel into projects category during sync.");
          continue;
        }
        throw error;
      }
      movedChannels += 1;
    }

    return { movedChannels };
  }

  async function pruneInvalidThreadBindings(guild) {
    const snapshot = state.snapshot();
    const bindings = snapshot?.threadBindings ?? {};
    let removed = 0;
    const setups = getChannelSetups();

    for (const [repoChannelId, binding] of Object.entries(bindings)) {
      const channel = guild.channels.cache.get(repoChannelId);
      const valid =
        !!channel &&
        channel.type === ChannelType.GuildText &&
        !!setups[repoChannelId] &&
        (!binding?.cwd || binding.cwd === setups[repoChannelId].cwd);

      if (!valid) {
        state.clearBinding(repoChannelId);
        removed += 1;
      }
    }

    if (removed > 0) {
      await state.save();
    }

    return removed;
  }

  function findChannelIdByCwd(cwd) {
    for (const [channelId, setup] of Object.entries(getChannelSetups())) {
      if (setup?.cwd === cwd) {
        return channelId;
      }
    }
    return null;
  }

  function makeChannelName(input) {
    const cleaned = input
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "");
    return (cleaned || "repo").slice(0, 100);
  }

  function isLegacyProjectCategoryName(categoryNameLower, legacyBaseNames) {
    if (!legacyBaseNames || legacyBaseNames.size === 0) {
      return false;
    }
    for (const base of legacyBaseNames) {
      if (categoryNameLower === base) {
        return true;
      }
      if (!categoryNameLower.startsWith(`${base}-`)) {
        continue;
      }
      const suffix = categoryNameLower.slice(base.length + 1);
      if (/^[0-9]+$/.test(suffix)) {
        return true;
      }
    }
    return false;
  }

  function uniqueChannelName(guild, baseName) {
    let candidate = baseName;
    let index = 2;
    const lowerExisting = new Set(
      [...guild.channels.cache.values()]
        .filter((channel) => channel.type === ChannelType.GuildText)
        .map((channel) => channel.name.toLowerCase())
    );

    while (lowerExisting.has(candidate.toLowerCase())) {
      const suffix = `-${index}`;
      candidate = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
      index += 1;
    }

    return candidate;
  }

  function topicForCwd(cwd) {
    return `${managedChannelTopicPrefix}${cwd}`;
  }

  function parseTaggedTopicValue(topic, prefix) {
    if (typeof topic !== "string" || !topic.trim()) {
      return null;
    }
    for (const rawLine of topic.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line.startsWith(prefix)) {
        continue;
      }
      const value = line.slice(prefix.length).trim();
      return value || null;
    }
    return null;
  }

  function parseCwdFromTopic(topic) {
    const cwd = parseTaggedTopicValue(topic, managedChannelTopicPrefix);
    return cwd ? path.resolve(cwd) : null;
  }

  function parseCodexThreadIdFromTopic(topic) {
    return parseTaggedTopicValue(topic, managedThreadTopicPrefix);
  }

  function isManagedChannelForCleanup(channel) {
    if (channel.type !== ChannelType.GuildText) {
      return false;
    }
    return !!parseCwdFromTopic(channel.topic) || !!parseCodexThreadIdFromTopic(channel.topic);
  }

  function isManagedRepoChannel(channel) {
    if (channel.type !== ChannelType.GuildText) {
      return false;
    }
    return !!parseCwdFromTopic(channel.topic) && !parseCodexThreadIdFromTopic(channel.topic);
  }

  return {
    bootstrapChannelMappings,
    makeChannelName
  };
}
