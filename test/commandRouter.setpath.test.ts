import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createCommandRouter } from "../src/commands/router.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("command router setpath", () => {
  test("persists a route binding and clears the old thread when setpath is used", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-setpath-"));
    tempDirs.push(tempDir);

    const repoPath = path.join(tempDir, "repo");
    const configPath = path.join(tempDir, "channels.json");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          autoDiscoverProjects: true,
          channels: {
            "discord-1": {
              cwd: "/tmp/existing-discord-repo",
              model: "gpt-5.3-codex"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const replies: string[] = [];
    const clearedBindings: string[] = [];
    let saveCalls = 0;
    let channelSetups: Record<string, { cwd: string; model?: string }> = {};

    const router = createCommandRouter({
      ChannelType: { GuildText: 0 },
      isGeneralChannel: () => false,
      fs,
      path,
      execFileAsync: async () => {},
      repoRootPath: "/tmp/repos",
      managedChannelTopicPrefix: "codex-cwd:",
      codexBin: "codex",
      codexHomeEnv: null,
      statePath: path.join(tempDir, "state.json"),
      configPath,
      config: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        defaultModel: "gpt-5.3-codex",
        channels: {}
      },
      state: {
        getBinding: () => null,
        clearBinding(routeId: string) {
          clearedBindings.push(routeId);
        },
        save: async () => {
          saveCalls += 1;
        }
      },
      codex: { request: async () => {} },
      pendingApprovals: new Map(),
      makeChannelName: (value: string) => value,
      collectImageAttachments: () => [],
      buildTurnInputFromMessage: async () => [],
      enqueuePrompt: () => {},
      getQueue: () => ({ jobs: [] }),
      findActiveTurnByRepoChannel: () => null,
      requestSelfRestartFromDiscord: async () => {},
      findLatestPendingApprovalTokenForChannel: () => null,
      applyApprovalDecision: async () => ({ ok: true }),
      safeReply: async (_message: unknown, content: string) => {
        replies.push(content);
      },
      getChannelSetups: () => channelSetups,
      setChannelSetups: (nextSetups: typeof channelSetups) => {
        channelSetups = nextSetups;
      },
      getPlatformRegistry: () => null
    });

    await router.handleCommand(
      {
        channelId: "feishu:oc_1",
        platform: "feishu",
        channel: { id: "feishu:oc_1", chatId: "oc_1" },
        author: { id: "user-1" }
      },
      `!setpath ${repoPath}`,
      null
    );

    expect(channelSetups).toEqual({
      "feishu:oc_1": {
        cwd: repoPath
      }
    });
    expect(clearedBindings).toEqual(["feishu:oc_1"]);
    expect(saveCalls).toBe(1);
    expect(replies[0]).toContain(`Bound this chat to \`${repoPath}\`.`);

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(persisted.channels["discord-1"]).toEqual({
      cwd: "/tmp/existing-discord-repo",
      model: "gpt-5.3-codex"
    });
    expect(persisted.channels["feishu:oc_1"]).toEqual({
      cwd: repoPath
    });
  });

  test("preserves explicit model override when setpath rebinds a route", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-setpath-model-"));
    tempDirs.push(tempDir);

    const oldRepoPath = path.join(tempDir, "old-repo");
    const newRepoPath = path.join(tempDir, "new-repo");
    const configPath = path.join(tempDir, "channels.json");
    await fs.mkdir(oldRepoPath, { recursive: true });
    await fs.mkdir(newRepoPath, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          channels: {
            "feishu:oc_1": {
              cwd: oldRepoPath,
              model: "claude-3.7-sonnet"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const replies: string[] = [];
    const clearedBindings: string[] = [];
    let saveCalls = 0;
    let channelSetups: Record<string, { cwd: string; model?: string }> = {
      "feishu:oc_1": {
        cwd: oldRepoPath,
        model: "claude-3.7-sonnet"
      }
    };

    const router = createCommandRouter({
      ChannelType: { GuildText: 0 },
      isGeneralChannel: () => false,
      fs,
      path,
      execFileAsync: async () => {},
      repoRootPath: "/tmp/repos",
      managedChannelTopicPrefix: "codex-cwd:",
      codexBin: "codex",
      codexHomeEnv: null,
      statePath: path.join(tempDir, "state.json"),
      configPath,
      config: {
        approvalPolicy: "never",
        sandboxMode: "workspace-write",
        defaultModel: "gpt-5.3-codex",
        channels: {
          "feishu:oc_1": {
            cwd: oldRepoPath,
            model: "claude-3.7-sonnet"
          }
        }
      },
      state: {
        getBinding: () => null,
        clearBinding(routeId: string) {
          clearedBindings.push(routeId);
        },
        save: async () => {
          saveCalls += 1;
        }
      },
      codex: { request: async () => {} },
      pendingApprovals: new Map(),
      makeChannelName: (value: string) => value,
      collectImageAttachments: () => [],
      buildTurnInputFromMessage: async () => [],
      enqueuePrompt: () => {},
      getQueue: () => ({ jobs: [] }),
      findActiveTurnByRepoChannel: () => null,
      requestSelfRestartFromDiscord: async () => {},
      findLatestPendingApprovalTokenForChannel: () => null,
      applyApprovalDecision: async () => ({ ok: true }),
      safeReply: async (_message: unknown, content: string) => {
        replies.push(content);
      },
      getChannelSetups: () => channelSetups,
      setChannelSetups: (nextSetups: typeof channelSetups) => {
        channelSetups = nextSetups;
      },
      getPlatformRegistry: () => null
    });

    await router.handleCommand(
      {
        channelId: "feishu:oc_1",
        platform: "feishu",
        channel: { id: "feishu:oc_1", chatId: "oc_1" },
        author: { id: "user-1" }
      },
      `!setpath ${newRepoPath}`,
      null
    );

    expect(channelSetups).toEqual({
      "feishu:oc_1": {
        cwd: newRepoPath,
        model: "claude-3.7-sonnet"
      }
    });
    expect(clearedBindings).toEqual(["feishu:oc_1"]);
    expect(saveCalls).toBe(1);
    expect(replies[0]).toContain("Bound this chat to `" + newRepoPath + "`.");

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(persisted.channels["feishu:oc_1"]).toEqual({
      cwd: newRepoPath,
      model: "claude-3.7-sonnet"
    });
  });
});
