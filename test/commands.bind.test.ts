import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { isGeneralChannel } from "../src/channels/context.js";
import { createCommandRouter } from "../src/commands/router.js";

const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function createRouterHarness(initialSetups = {}, configDocument = null, options = {}) {
  let channelSetups = { ...initialSetups };
  const replies = [];
  const execCalls = [];
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-router-"));
  tempDirs.push(cwd);
  const configPath = path.join(cwd, "channels.json");
  if (configDocument) {
    await fs.writeFile(configPath, JSON.stringify(configDocument, null, 2), "utf8");
  }
  const state = {
    cleared: [],
    saveCount: 0,
    clearBinding(channelId) {
      this.cleared.push(channelId);
    },
    async save() {
      this.saveCount += 1;
    }
  };

  const router = createCommandRouter({
    ChannelType,
    isGeneralChannel,
    fs,
    path,
    execFileAsync: async (...args) => {
      execCalls.push(args);
      return { stdout: "", stderr: "" };
    },
    repoRootPath: options.repoRootPath ?? null,
    managedChannelTopicPrefix: "codex-cwd:",
    codexBin: "codex",
    codexHomeEnv: "",
    statePath: "/tmp/state.json",
    configPath,
    config: {
      defaultModel: "gpt-5.3-codex",
      sandboxMode: "workspace-write",
      approvalPolicy: "never"
    },
    state,
    codex: { request: async () => ({}) },
    pendingApprovals: new Map(),
    makeChannelName: (input) => input,
    collectImageAttachments: () => [],
    buildTurnInputFromMessage: async () => [],
    enqueuePrompt: () => {},
    getQueue: () => ({ jobs: [] }),
    findActiveTurnByRepoChannel: () => null,
    requestSelfRestartFromDiscord: async () => {},
    findLatestPendingApprovalTokenForChannel: () => null,
    applyApprovalDecision: async () => ({ ok: true }),
    safeReply: async (_message, text) => {
      replies.push(String(text));
      return { id: `reply-${replies.length}` };
    },
    getChannelSetups: () => channelSetups,
    setChannelSetups: (nextSetups) => {
      channelSetups = nextSetups;
    }
  });

  return {
    router,
    replies,
    state,
    execCalls,
    configPath,
    getChannelSetups: () => channelSetups
  };
}

function createMessage(channelOverrides = {}) {
  const channel = {
    id: "channel-1",
    name: "repo-room",
    type: ChannelType.GuildText,
    parentId: null,
    topic: "team notes",
    async setTopic(nextTopic) {
      this.topic = nextTopic;
    },
    ...channelOverrides
  };

  return {
    channelId: channel.id,
    channel,
    guild: channel.guild ?? null
  };
}

function createGuild(existingChannels = []) {
  const cache = new Map(existingChannels.map((channel) => [channel.id, channel]));
  const createdChannels = [];
  let nextId = 1;

  const guild = {
    channels: {
      cache,
      async fetch() {
        return cache;
      },
      async create(payload) {
        const channel = {
          id: `created-${nextId}`,
          name: payload.name,
          type: payload.type,
          parentId: payload.parent ?? null,
          topic: "",
          async setTopic(nextTopic) {
            this.topic = nextTopic;
          }
        };
        nextId += 1;
        cache.set(channel.id, channel);
        createdChannels.push(channel);
        return channel;
      }
    }
  };

  return {
    guild,
    createdChannels
  };
}

describe("bind commands", () => {
  test("binds an existing absolute path to the current channel", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-bind-"));
    tempDirs.push(dir);
    const { router, replies, state, getChannelSetups, configPath } = await createRouterHarness();
    const message = createMessage();

    await router.handleBindCommand(message, dir);

    expect(getChannelSetups()).toEqual({
      "channel-1": {
        cwd: dir
      }
    });
    expect(state.cleared).toEqual(["channel-1"]);
    expect(state.saveCount).toBe(1);
    expect(message.channel.topic).toContain(`codex-cwd:${dir}`);
    expect(replies.at(-1)).toContain(`Bound this channel to \`${dir}\``);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      channels: {
        "channel-1": {
          cwd: dir
        }
      }
    });
  });

  test("rejects relative bind paths", async () => {
    const { router, replies, getChannelSetups } = await createRouterHarness();

    await router.handleBindCommand(createMessage(), "./relative/path");

    expect(getChannelSetups()).toEqual({});
    expect(replies.at(-1)).toContain("Provide an absolute path");
  });

  test("requires rebind when a channel already has a different path", async () => {
    const existingDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-bind-existing-"));
    const newDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-bind-new-"));
    tempDirs.push(existingDir, newDir);
    const { router, replies, getChannelSetups } = await createRouterHarness({
      "channel-1": { cwd: existingDir, model: "gpt-5.3-codex" }
    });

    await router.handleBindCommand(createMessage(), newDir);

    expect(getChannelSetups()["channel-1"].cwd).toBe(existingDir);
    expect(replies.at(-1)).toContain("Use `!rebind");
  });

  test("rebind switches the channel to a new existing path", async () => {
    const existingDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-rebind-existing-"));
    const newDir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-rebind-new-"));
    tempDirs.push(existingDir, newDir);
    const { router, replies, state, getChannelSetups, configPath } = await createRouterHarness(
      {
        "channel-1": { cwd: existingDir, model: "gpt-5.3-codex" }
      },
      {
        autoDiscoverProjects: false,
        channels: {
          "channel-1": { cwd: existingDir, model: "gpt-5.3-codex" }
        }
      }
    );

    await router.handleBindCommand(createMessage(), newDir, { rebind: true });

    expect(getChannelSetups()["channel-1"].cwd).toBe(newDir);
    expect(state.cleared).toEqual(["channel-1"]);
    expect(replies.at(-1)).toContain(`Rebound this channel to \`${newDir}\``);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      autoDiscoverProjects: false,
      channels: {
        "channel-1": {
          cwd: newDir,
          model: "gpt-5.3-codex"
        }
      }
    });
  });

  test("unbind removes the channel mapping and topic tag", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-unbind-"));
    tempDirs.push(dir);
    const { router, replies, state, getChannelSetups, configPath } = await createRouterHarness(
      {
        "channel-1": { cwd: dir, model: "gpt-5.3-codex" }
      },
      {
        defaultModel: "gpt-5.3-codex",
        channels: {
          "channel-1": { cwd: dir, model: "gpt-5.3-codex" }
        }
      }
    );
    const message = createMessage({
      topic: `team notes\ncodex-cwd:${dir}`
    });

    await router.handleUnbindCommand(message);

    expect(getChannelSetups()).toEqual({});
    expect(state.cleared).toEqual(["channel-1"]);
    expect(state.saveCount).toBe(1);
    expect(message.channel.topic).toBe("team notes");
    expect(replies.at(-1)).toContain(`Unbound this channel from \`${dir}\``);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      defaultModel: "gpt-5.3-codex",
      channels: {}
    });
  });

  test("setmodel persists an explicit model override for a bound channel", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-setmodel-"));
    tempDirs.push(dir);
    const { router, replies, getChannelSetups, configPath } = await createRouterHarness(
      {
        "channel-1": { cwd: dir }
      },
      {
        autoDiscoverProjects: false,
        channels: {
          "channel-1": { cwd: dir }
        }
      }
    );
    const message = createMessage();
    const context = {
      repoChannelId: "channel-1",
      setup: {
        cwd: dir,
        mode: "repo"
      }
    };

    await router.handleCommand(message, "!setmodel gpt-5.4-codex", context);

    expect(getChannelSetups()).toEqual({
      "channel-1": {
        cwd: dir,
        model: "gpt-5.4-codex"
      }
    });
    expect(replies.at(-1)).toContain("Set this channel model override to `gpt-5.4-codex`.");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      autoDiscoverProjects: false,
      channels: {
        "channel-1": {
          cwd: dir,
          model: "gpt-5.4-codex"
        }
      }
    });
  });

  test("clearmodel removes an explicit model override and falls back to default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-clearmodel-"));
    tempDirs.push(dir);
    const { router, replies, getChannelSetups, configPath } = await createRouterHarness(
      {
        "channel-1": { cwd: dir, model: "gpt-5.4-codex" }
      },
      {
        autoDiscoverProjects: false,
        channels: {
          "channel-1": { cwd: dir, model: "gpt-5.4-codex" }
        }
      }
    );
    const message = createMessage();
    const context = {
      repoChannelId: "channel-1",
      setup: {
        cwd: dir,
        mode: "repo",
        model: "gpt-5.4-codex"
      }
    };

    await router.handleCommand(message, "!clearmodel", context);

    expect(getChannelSetups()).toEqual({
      "channel-1": {
        cwd: dir
      }
    });
    expect(replies.at(-1)).toContain("Cleared this channel model override.");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      autoDiscoverProjects: false,
      channels: {
        "channel-1": {
          cwd: dir
        }
      }
    });
  });

  test("mkchannel creates a new text channel under the same parent and avoids name collisions", async () => {
    const { router, replies } = await createRouterHarness();
    const { guild, createdChannels } = createGuild([
      {
        id: "existing-1",
        name: "new-project",
        type: ChannelType.GuildText
      }
    ]);
    const message = createMessage({
      guild,
      parentId: "category-1"
    });

    await router.handleMakeChannelCommand(message, "new-project");

    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].name).toBe("new-project-2");
    expect(createdChannels[0].parentId).toBe("category-1");
    expect(replies.at(-1)).toBe("Created channel <#created-1>.");
  });

  test("mkbind creates a new text channel and persists the binding", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-mkbind-"));
    tempDirs.push(dir);
    const { router, replies, state, getChannelSetups, configPath } = await createRouterHarness(
      {},
      {
        autoDiscoverProjects: false,
        channels: {}
      }
    );
    const { guild, createdChannels } = createGuild();
    const message = createMessage({
      guild,
      parentId: "category-1"
    });

    await router.handleMakeChannelCommand(message, `web ${dir}`, { bindPath: true });

    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].name).toBe("web");
    expect(createdChannels[0].parentId).toBe("category-1");
    expect(createdChannels[0].topic).toContain(`codex-cwd:${dir}`);
    expect(getChannelSetups()).toEqual({
      "created-1": {
        cwd: dir
      }
    });
    expect(state.cleared).toEqual(["created-1"]);
    expect(state.saveCount).toBe(1);
    expect(replies.at(-1)).toContain(`Created channel <#created-1> and bound it to \`${dir}\`.`);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      autoDiscoverProjects: false,
      channels: {
        "created-1": {
          cwd: dir
        }
      }
    });
  });

  test("mkrepo creates a new text channel, creates a project directory under repo root, and persists the binding", async () => {
    const repoRootPath = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-mkrepo-root-"));
    tempDirs.push(repoRootPath);
    const { router, replies, state, execCalls, getChannelSetups, configPath } = await createRouterHarness(
      {},
      {
        autoDiscoverProjects: false,
        channels: {}
      },
      { repoRootPath }
    );
    const { guild, createdChannels } = createGuild();
    const message = createMessage({
      guild,
      parentId: "category-1"
    });

    await router.handleMakeChannelCommand(message, "fresh-project", { initRepo: true });

    const repoPath = path.join(repoRootPath, "fresh-project");
    expect(createdChannels).toHaveLength(1);
    expect(createdChannels[0].name).toBe("fresh-project");
    expect(createdChannels[0].topic).toContain(`codex-cwd:${repoPath}`);
    expect(await fs.stat(repoPath)).toBeDefined();
    expect(execCalls).toEqual([]);
    expect(getChannelSetups()).toEqual({
      "created-1": {
        cwd: repoPath
      }
    });
    expect(state.cleared).toEqual(["created-1"]);
    expect(state.saveCount).toBe(1);
    expect(replies.at(-1)).toContain(`Created channel <#created-1> and bound it to new project path \`${repoPath}\`.`);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      autoDiscoverProjects: false,
      channels: {
        "created-1": {
          cwd: repoPath
        }
      }
    });
  });
});
