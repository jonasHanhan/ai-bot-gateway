import { describe, expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { isGeneralChannel, resolveRepoContext } from "../src/channels/context.js";

describe("channels context", () => {
  test("treats configured #general as read-only context", () => {
    const context = resolveRepoContext(
      {
        channelId: "general-1",
        channel: { id: "general-1", name: "general", type: ChannelType.GuildText }
      },
      {
        channelSetups: {},
        config: { defaultModel: "gpt-5.3-codex", sandboxMode: "workspace-write" },
        generalChannel: { id: "general-1", name: "general", cwd: "/tmp/general-cwd" }
      }
    );

    expect(context).toEqual({
      repoChannelId: "general-1",
      setup: {
        cwd: "/tmp/general-cwd",
        resolvedModel: "gpt-5.3-codex",
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    });
  });

  test("treats managed repo channel as writable repo context", () => {
    const context = resolveRepoContext(
      {
        channelId: "repo-1",
        channel: { id: "repo-1", name: "my-repo", type: ChannelType.GuildText }
      },
      {
        channelSetups: {
          "repo-1": {
            cwd: "/tmp/repo-1",
            model: "gpt-5.3-codex"
          }
        },
        config: { defaultModel: "gpt-5.3-codex", sandboxMode: "workspace-write" },
        generalChannel: { id: "general-1", name: "general", cwd: "/tmp/general-cwd" }
      }
    );

    expect(context?.setup.allowFileWrites).toBe(true);
    expect(context?.setup.sandboxMode).toBe("workspace-write");
    expect(context?.setup.mode).toBe("repo");
  });

  test("matches general channel by fallback name when id is absent", () => {
    const matched = isGeneralChannel(
      { id: "other-id", name: "GENERAL", type: ChannelType.GuildText },
      { name: "general" }
    );
    expect(matched).toBe(true);
  });

  test("resolves model from configured agent when channel has agentId", () => {
    const context = resolveRepoContext(
      {
        channelId: "repo-1",
        channel: { id: "repo-1", name: "my-repo", type: ChannelType.GuildText }
      },
      {
        channelSetups: {
          "repo-1": {
            cwd: "/tmp/repo-1",
            agentId: "codex"
          }
        },
        config: {
          defaultModel: "gpt-5.3-codex",
          sandboxMode: "workspace-write",
          defaultAgent: "codex",
          agents: {
            codex: { model: "gpt-5.4-codex" }
          }
        },
        generalChannel: { id: "general-1", name: "general", cwd: "/tmp/general-cwd" }
      }
    );

    expect(context?.setup.model).toBeUndefined();
    expect(context?.setup.resolvedModel).toBe("gpt-5.4-codex");
  });
});
