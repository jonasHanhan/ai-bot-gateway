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
    expect(sentBodies[1]?.msgType).toBe("file");
    expect(sentBodies[1]?.content).toContain("file_uploaded_svg");
  });
});
