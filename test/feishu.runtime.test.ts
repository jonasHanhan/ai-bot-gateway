import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFeishuRuntime } from "../src/feishu/runtime.js";
import { makeFeishuRouteId } from "../src/feishu/ids.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("feishu runtime", () => {
  test("does not raise unhandled rejection when event dedupe path is missing", async () => {
    const replies: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      replies.push(body.content ?? "");
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_no_dedupe_path" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await runtime.handleEventPayload({
        header: {
          event_id: "evt-no-dedupe-path-1",
          event_type: "im.message.receive_v1"
        },
        event: {
          sender: {
            sender_id: { open_id: "ou_no_dedupe_path_1" },
            sender_type: "user"
          },
          message: {
            message_id: "om_no_dedupe_path_1",
            chat_id: "oc_no_dedupe_path_1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "/where" }),
            mentions: []
          }
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      runtime.stop();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(replies.length).toBe(1);
    expect(unhandledRejections).toEqual([]);
  });

  test("returns identifiers for /where before a chat is bound", async () => {
    const replies: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      replies.push(body.content ?? "");
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_where" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-where-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_where_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_where_1",
          chat_id: "oc_where_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/where" }),
          mentions: []
        }
      }
    });

    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("platform: `feishu`");
    expect(replies[0]).toContain("chat_id: `oc_where_1`");
    expect(replies[0]).toContain("route_id: `feishu:oc_where_1`");
    expect(replies[0]).toContain("sender_open_id: `ou_where_1`");
    expect(replies[0]).toContain("binding: none");
  });

  test("returns default workspace details for /where when unbound chats are open", async () => {
    const replies: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      replies.push(body.content ?? "");
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_where_open" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false,
        feishuUnboundChatMode: "open",
        feishuUnboundChatCwd: "/tmp/open-feishu"
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-where-open-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_where_open_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_where_open_1",
          chat_id: "oc_where_open_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "/where" }),
          mentions: []
        }
      }
    });

    expect(replies.length).toBe(1);
    expect(replies[0]).toContain("binding: `unbound-open`");
    expect(replies[0]).toContain("cwd: `/tmp/open-feishu`");
    expect(replies[0]).toContain("sandbox mode: `workspace-write`");
    expect(replies[0]).toContain("file writes: `enabled`");
  });

  test("routes /status commands through the shared command handler", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const routeId = makeFeishuRouteId("oc_repo_1");
    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "verify-token",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async (message: { reply: (text: string) => Promise<unknown> }, content: string, context: unknown) => {
        calls.push({ type: "command", payload: { content, context } });
        await message.reply(`handled ${content}`);
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      token: "verify-token",
      header: {
        event_id: "evt-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_1",
          chat_id: "oc_repo_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/status" }),
          mentions: []
        }
      }
    });

    expect(calls).toEqual([
      {
        type: "command",
        payload: {
          content: "!status",
          context: {
            repoChannelId: routeId,
            setup: {
              cwd: "/tmp/repo",
              model: "gpt-5.3-codex",
              bindingKind: "repo",
              mode: "repo",
              sandboxMode: "workspace-write",
              allowFileWrites: true
            }
          }
        }
      }
    ]);
  });

  test("queues plain text prompts for mapped chats", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_2");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_2" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-two",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-2",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_2" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_2",
          chat_id: "oc_repo_2",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "请帮我看一下这个仓库" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "请帮我看一下这个仓库"
      }
    ]);
  });

  test("adds Feishu attachment guidance for attachment-send requests", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_attachment_1");
    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "verify-token",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      token: "verify-token",
      header: {
        event_id: "evt-attach-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_attach_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_attach_1",
          chat_id: "oc_repo_attachment_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: "把这个文件以附件的形式发给我 /Volumes/data/workspace/n8n/content/ai-hotspot-digests/2026-03-19/gemini-3-pro-preview/00-今日AI热点速读.md"
          }),
          mentions: []
        }
      }
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.repoChannelId).toBe(routeId);
    expect(jobs[0]?.promptText).toContain("[Platform context: Feishu chat]");
    expect(jobs[0]?.promptText).toContain("do not claim attachments are unsupported");
    expect(jobs[0]?.promptText).toContain("/Volumes/data/workspace/n8n/content/ai-hotspot-digests/2026-03-19/gemini-3-pro-preview/00-今日AI热点速读.md");
  });

  test("queues post rich-text prompts for mapped chats", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_post_1");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_post_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-post",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-post-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_post_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_post_1",
          chat_id: "oc_repo_post_1",
          chat_type: "group",
          message_type: "post",
          content: JSON.stringify({
            zh_cn: {
              title: "现在的工作流有几个问题",
              content: [
                [{ tag: "text", text: "1. 微信发布的内容有重复" }],
                [{ tag: "text", text: "2. 小红书发布失败是因为字数超过了1000字的限制" }]
              ]
            }
          }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "现在的工作流有几个问题\n1. 微信发布的内容有重复\n2. 小红书发布失败是因为字数超过了1000字的限制"
      }
    ]);
  });

  test("expands bare numeric replies using the latest numbered bot message", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_quick_reply_1");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_reply_${Math.random().toString(36).slice(2, 8)}` } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-quick-reply",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId(routeId);
    await channel?.send([
      "可以，我来查。",
      "你要我查哪一项？直接回数字就行：",
      "",
      "1) `terminal.airflow.eu.org` 现在是否恢复",
      "2) Cloudflare Tunnel 是否在线",
      "3) 本地 `ttyd`（65534 端口）是否在监听",
      "4) 三项都查（我推荐）"
    ].join("\n"));

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-quick-reply-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_quick_reply_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_quick_reply_1",
          chat_id: "oc_repo_quick_reply_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "4" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "选择第4项：三项都查（我推荐）"
      }
    ]);
  });

  test("treats absolute-path text starting with slash as a prompt instead of an unknown command", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_path_1");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_path_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-path",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {
        throw new Error("path-like prompt should not route through handleCommand");
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-path-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_path_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_path_1",
          chat_id: "oc_repo_path_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/Volumes/data 1/ 如何 改名 /Volumes/data/" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "/Volumes/data 1/ 如何 改名 /Volumes/data/"
      }
    ]);
  });

  test("treats unrecognized bang-prefixed text as a prompt", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_bang_1");
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_bang_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-bang",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {
        throw new Error("bang-prefixed prompt should not route through handleCommand");
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-bang-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_bang_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_bang_1",
          chat_id: "oc_repo_bang_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "!Volumes/data 1/ 如何 改名 /Volumes/data/" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "!Volumes/data 1/ 如何 改名 /Volumes/data/"
      }
    ]);
  });

  test("queues plain text prompts for unbound group chats when open mode is enabled", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_reply_open_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false,
        feishuUnboundChatMode: "open",
        feishuUnboundChatCwd: "/tmp/open-group"
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-open-group-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_open_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_open_group_1",
          chat_id: "oc_open_group_1",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "请直接开始分析这个目录" }),
          mentions: []
        }
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: "feishu:oc_open_group_1",
        promptText: "请直接开始分析这个目录"
      }
    ]);
  });

  test("starts long-connection transport and routes sdk events through the same prompt pipeline", async () => {
    const jobs: Array<{ repoChannelId: string; promptText: string }> = [];
    const routeId = makeFeishuRouteId("oc_repo_long_1");
    const calls: Array<{ type: string; payload: unknown }> = [];
    let registeredHandles: Record<string, (event: unknown) => Promise<void>> = {};

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-long",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string) => [{ type: "text", text }],
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text: string }> }) => {
          jobs.push({ repoChannelId, promptText: job.inputItems[0]?.text ?? "" });
        }
      },
      safeReply: async () => null,
      feishuSdk: {
        LoggerLevel: { warn: 2 },
        defaultHttpInstance: { defaults: {} },
        EventDispatcher: class {
          register(handles: Record<string, (event: unknown) => Promise<void>>) {
            registeredHandles = handles;
            return this;
          }
        },
        WSClient: class {
          constructor(options: unknown) {
            calls.push({ type: "ws-client", payload: options });
          }

          async start({ eventDispatcher }: { eventDispatcher: unknown }) {
            calls.push({ type: "ws-start", payload: eventDispatcher });
          }

          close() {
            calls.push({ type: "ws-close", payload: null });
          }
        }
      }
    });

    const summary = await runtime.start();
    expect(summary).toEqual({
      started: true,
      transport: "long-connection"
    });
    expect(runtime.transport).toBe("long-connection");
    expect(runtime.webhookPath).toBe("");
    expect(calls).toHaveLength(2);
    expect(typeof registeredHandles["im.message.receive_v1"]).toBe("function");
    expect(typeof registeredHandles["im.chat.member.bot.added_v1"]).toBe("function");

    await registeredHandles["im.message.receive_v1"]({
      sender: {
        sender_id: { open_id: "ou_user_long_1" },
        sender_type: "user"
      },
      message: {
        message_id: "om_in_long_1",
        chat_id: "oc_repo_long_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "帮我看下这个变更" }),
        mentions: []
      }
    });

    expect(jobs).toEqual([
      {
        repoChannelId: routeId,
        promptText: "帮我看下这个变更"
      }
    ]);
  });

  test("sends an onboarding message when the bot is added to a Feishu group", async () => {
    const replies: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      replies.push(body.content ?? "");
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_bot_added_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: true,
        feishuUnboundChatMode: "open",
        feishuUnboundChatCwd: "/tmp/open-welcome"
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-bot-added-1",
        event_type: "im.chat.member.bot.added_v1"
      },
      event: {
        chat_id: "oc_bot_added_1",
        operator_id: {
          open_id: "ou_inviter_1"
        }
      }
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Bridge is ready in this Feishu chat.");
    expect(replies[0]).toContain("default Feishu workspace");
    expect(replies[0]).toContain("cwd: `/tmp/open-welcome`");
    expect(replies[0]).toContain("Use `/ask <prompt>` or `@bot <prompt>` in group chats.");
  });

  test("routes /setpath in an unbound chat through the shared setpath handler", async () => {
    const calls: Array<{ type: string; payload: unknown }> = [];
    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      handleSetPathCommand: async (message: { channelId: string }, rest: string) => {
        calls.push({ type: "setpath", payload: { routeId: message.channelId, rest } });
      },
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-setpath-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_3" },
          sender_type: "user"
        },
        message: {
          message_id: "om_setpath_1",
          chat_id: "oc_setpath_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/setpath /tmp/another-repo" }),
          mentions: []
        }
      }
    });

    expect(calls).toEqual([
      {
        type: "setpath",
        payload: {
          routeId: "feishu:oc_setpath_1",
          rest: "/tmp/another-repo"
        }
      }
    ]);
  });

  test("queues image prompts for mapped chats by downloading the Feishu resource into a local image input", async () => {
    const jobs: Array<{ repoChannelId: string; imagePaths: string[] }> = [];
    const routeId = makeFeishuRouteId("oc_repo_image_1");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-image-test-"));

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages/om_in_image_1/resources/img_resource_1?type=image")) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: tempDir,
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-image",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (_message: unknown, text: string, imageAttachments: Array<{ path: string }>) => [
          { type: "text", text },
          ...imageAttachments.map((attachment) => ({ type: "localImage", path: attachment.path }))
        ].filter((item) => item.type !== "text" || item.text),
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ path?: string }> }) => {
          jobs.push({
            repoChannelId,
            imagePaths: job.inputItems.map((item) => item.path).filter(Boolean) as string[]
          });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-image-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_image_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_image_1",
          chat_id: "oc_repo_image_1",
          chat_type: "p2p",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_resource_1" }),
          mentions: []
        }
      }
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.repoChannelId).toBe(routeId);
    expect(jobs[0]?.imagePaths).toHaveLength(1);
    const imagePath = jobs[0]?.imagePaths[0] ?? "";
    expect(imagePath.startsWith(tempDir)).toBe(true);
    expect(await fs.readFile(imagePath)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("queues file prompts for mapped chats by downloading the Feishu resource into a local file attachment", async () => {
    const jobs: Array<{ repoChannelId: string; filePaths: string[]; contentTypes: string[] }> = [];
    const routeId = makeFeishuRouteId("oc_repo_file_1");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-file-test-"));

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages/om_in_file_1/resources/file_resource_1?type=file")) {
        return new Response(Buffer.from("hello from feishu"), {
          status: 200,
          headers: { "content-type": "text/plain" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: tempDir,
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({
        [routeId]: {
          cwd: "/tmp/repo-file",
          model: "gpt-5.3-codex"
        }
      }),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async (
          _message: unknown,
          text: string,
          attachments: Array<{ path: string; contentType?: string }>
        ) => [
          { type: "text", text },
          ...attachments.map((attachment) => ({
            type: "text",
            text: `${attachment.path}|${attachment.contentType ?? ""}`
          }))
        ].filter((item) => item.text),
        enqueuePrompt: (repoChannelId: string, job: { inputItems: Array<{ text?: string }> }) => {
          const attachmentTexts = job.inputItems.map((item) => item.text).filter(Boolean) as string[];
          const fileEntries = attachmentTexts.filter((entry) => entry.includes(tempDir));
          jobs.push({
            repoChannelId,
            filePaths: fileEntries.map((entry) => entry.split("|")[0] ?? ""),
            contentTypes: fileEntries.map((entry) => entry.split("|")[1] ?? "")
          });
        }
      },
      safeReply: async () => null
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-file-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user_file_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_in_file_1",
          chat_id: "oc_repo_file_1",
          chat_type: "p2p",
          message_type: "file",
          content: JSON.stringify({ file_key: "file_resource_1", file_name: "notes.txt" }),
          mentions: []
        }
      }
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.repoChannelId).toBe(routeId);
    expect(jobs[0]?.filePaths).toHaveLength(1);
    const filePath = jobs[0]?.filePaths[0] ?? "";
    expect(filePath.startsWith(tempDir)).toBe(true);
    expect(jobs[0]?.contentTypes).toEqual(["text/plain"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("hello from feishu");
  });

  test("supports Feishu thread replies and reactions on sent messages", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const method = String(init?.method ?? "GET");
      const body = String(init?.body ?? "");
      requests.push({ url, method, body });
      if (url.includes("/reactions")) {
        return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_native_${requests.length}` } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: "/tmp/feishu-native-actions",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_native_actions_1");
    expect(channel).toBeTruthy();

    const sent = await channel.send("hello");
    expect(sent?.id).toBeTruthy();
    await sent.react({ emojiType: "DONE" });
    await channel.replyToMessage(sent.id, "thread follow-up");

    expect(requests.some((request) => request.url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id"))).toBe(true);
    expect(requests.some((request) => request.url.includes(`/open-apis/im/v1/messages/${sent.id}/reactions`))).toBe(true);
    expect(requests.some((request) => request.url.includes(`/open-apis/im/v1/messages/${sent.id}/reply`))).toBe(true);
  });

  test("uploads outbound image attachments for Feishu channels", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-outbound-image-"));
    const imagePath = path.join(tempDir, "rendered.png");
    await fs.writeFile(imagePath, Buffer.from([5, 6, 7, 8]));

    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/open-apis/im/v1/images")) {
        return new Response(JSON.stringify({ code: 0, data: { image_key: "img_uploaded_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_out_${sentBodies.length}` } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: tempDir,
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_1");
    expect(channel).toBeTruthy();
    await channel.send({
      content: "Attachment (image view): `rendered.png`",
      files: [{ attachment: imagePath, name: "rendered.png" }]
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.msgType).toBe("text");
    expect(sentBodies[0]?.content).toContain("rendered.png");
    expect(sentBodies[1]?.msgType).toBe("image");
    expect(sentBodies[1]?.content).toContain("img_uploaded_1");
  });

  test("renders markdown summaries as Feishu interactive cards", async () => {
    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_markdown_card_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_markdown_1");
    expect(channel).toBeTruthy();
    await channel.send("**系统**\n- CPU 正常\n- 内存正常");

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]?.msgType).toBe("interactive");
    const card = JSON.parse(String(sentBodies[0]?.content ?? "{}"));
    expect(card?.header?.title?.tag).toBe("plain_text");
    expect(card?.elements?.[0]?.tag).toBe("markdown");
    expect(card?.elements?.[0]?.content).toContain("**系统**");
    expect(card?.elements?.[0]?.content).toContain("- CPU 正常");
  });

  test("renders markdown replies with payload.content as Feishu interactive cards", async () => {
    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id") || url.includes("/reply")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_markdown_${sentBodies.length}` } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_markdown_payload_1");
    expect(channel).toBeTruthy();
    await channel.send({
      content: "**磁盘**\n- `/Volumes/data` 偏高",
      files: [{ attachment: "/tmp/does-not-exist", name: "missing.txt" }]
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.msgType).toBe("interactive");
    const card = JSON.parse(String(sentBodies[0]?.content ?? "{}"));
    expect(card?.elements?.[0]?.tag).toBe("markdown");
    expect(card?.elements?.[0]?.content).toContain("**磁盘**");
    expect(sentBodies[1]?.msgType).toBe("text");
    expect(sentBodies[1]?.content).toContain("Unsupported outbound attachments on Feishu");
  });

  test("uploads outbound file attachments for Feishu channels", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-outbound-file-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, Buffer.from("hello from codex"));

    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/open-apis/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_uploaded_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_file_${sentBodies.length}` } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: tempDir,
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_file_1");
    expect(channel).toBeTruthy();
    await channel.send({
      content: "Attachment (command execution): `notes.txt`",
      files: [{ attachment: filePath, name: "notes.txt" }]
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.msgType).toBe("text");
    expect(sentBodies[0]?.content).toContain("notes.txt");
    expect(sentBodies[1]?.msgType).toBe("file");
    expect(sentBodies[1]?.content).toContain("file_uploaded_1");
  });

  test("uploads svg attachments as Feishu files instead of image messages", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-outbound-svg-"));
    const filePath = path.join(tempDir, "generated-image.svg");
    await fs.writeFile(filePath, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");

    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/open-apis/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_uploaded_svg" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/open-apis/im/v1/images")) {
        throw new Error("svg should not go through image upload");
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: `om_svg_${sentBodies.length}` } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        imageCacheDir: tempDir,
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_svg_1");
    expect(channel).toBeTruthy();
    await channel.send({
      content: "Attachment (image view): `generated-image.svg`",
      files: [{ attachment: filePath, name: "generated-image.svg" }]
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0]?.msgType).toBe("text");
    expect(sentBodies[0]?.content).toContain("generated-image.svg");
  });

  test("strips ANSI escape sequences from outbound Feishu text", async () => {
    const sentBodies: Array<{ msgType?: string; content?: string }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        sentBodies.push({ msgType: body.msg_type, content: body.content });
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_out_ansi_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_ansi_1");
    expect(channel).toBeTruthy();
    await channel.send("```ansi\\n\\u001b[32m+12\\u001b[0m\\n\\u001b[31m-3\\u001b[0m\\n```");

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]?.msgType).toBe("interactive");
    const card = JSON.parse(String(sentBodies[0]?.content ?? "{}"));
    const markdown = String(card?.elements?.[0]?.content ?? "");
    expect(markdown).not.toContain("\\u001b");
    expect(markdown).toContain("+12");
    expect(markdown).toContain("-3");
    expect(markdown).not.toContain("[32m");
    expect(markdown).not.toContain("[31m");
  });

  test("marks outbound Feishu messages as non-editable", async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_outbound_edit_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url} ${(init?.method ?? "GET").toString()}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuTransport: "long-connection",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async () => null
    });

    const channel = await runtime.fetchChannelByRouteId("feishu:oc_outbound_edit_1");
    expect(channel).toBeTruthy();
    expect(channel?.supportsMessageEdits).toBe(false);

    const sentMessage = await channel?.send("hello");
    expect(sentMessage?.supportsEdits).toBe(false);
    await expect(sentMessage?.edit("updated")).rejects.toThrow("Feishu message editing is not supported");
  });

  test("invites current app bot into target chat via /joinbot", async () => {
    const invitedChats: Array<{ url: string; body: { id_list?: string[] } }> = [];
    const replies: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/chats/") && url.includes("/members?member_id_type=app_id")) {
        invitedChats.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}"))
        });
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages/") && url.includes("/reply")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const content = JSON.parse(String(body.content ?? "{}"));
        replies.push(String(content.text ?? ""));
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_joinbot_reply_1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-joinbot-1",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_joinbot_1" },
          sender_type: "user"
        },
        message: {
          message_id: "om_joinbot_1",
          chat_id: "oc_source_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/joinbot oc_target_1" }),
          mentions: []
        }
      }
    });

    expect(invitedChats).toHaveLength(1);
    expect(invitedChats[0]?.url).toContain("/open-apis/im/v1/chats/oc_target_1/members?member_id_type=app_id");
    expect(invitedChats[0]?.body.id_list).toEqual(["cli_test"]);
    expect(replies[0]).toContain("chat_id: `oc_target_1`");
    expect(replies[0]).toContain("bot_app_id: `cli_test`");
  });

  test("parses route-id argument for /joinbot", async () => {
    const invitedUrls: string[] = [];

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tenant_access_token/internal")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/chats/") && url.includes("/members?member_id_type=app_id")) {
        invitedUrls.push(url);
        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/open-apis/im/v1/messages/") && url.includes("/reply")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "om_joinbot_reply_2" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const runtime = createFeishuRuntime({
      config: {
        defaultModel: "gpt-5.3-codex",
        sandboxMode: "workspace-write",
        allowedFeishuUserIds: []
      },
      runtimeEnv: {
        feishuEnabled: true,
        feishuAppId: "cli_test",
        feishuAppSecret: "secret",
        feishuVerificationToken: "",
        feishuPort: 8788,
        feishuHost: "127.0.0.1",
        feishuWebhookPath: "/feishu/events",
        feishuGeneralChatId: "",
        feishuGeneralCwd: "/tmp/general",
        feishuRequireMentionInGroup: false
      },
      getChannelSetups: () => ({}),
      runManagedRouteCommand: async () => {},
      getHelpText: () => "help text",
      isCommandSupportedForPlatform: () => false,
      handleCommand: async () => {},
      runtimeAdapters: {
        buildTurnInputFromMessage: async () => [],
        enqueuePrompt: () => {}
      },
      safeReply: async (message: { reply: (text: string) => Promise<unknown> }, content: string) => await message.reply(content)
    });

    await runtime.handleEventPayload({
      header: {
        event_id: "evt-joinbot-2",
        event_type: "im.message.receive_v1"
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_joinbot_2" },
          sender_type: "user"
        },
        message: {
          message_id: "om_joinbot_2",
          chat_id: "oc_source_2",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "/joinbot feishu:oc_target_2" }),
          mentions: []
        }
      }
    });

    expect(invitedUrls).toHaveLength(1);
    expect(invitedUrls[0]).toContain("/open-apis/im/v1/chats/oc_target_2/members?member_id_type=app_id");
  });
});
