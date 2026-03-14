import { describe, expect, test } from "bun:test";
import { createDiscordPlatform } from "../src/platforms/discordPlatform.js";

describe("discord platform", () => {
  test("destroys the client and skips bootstrap after startup failure", async () => {
    const calls: string[] = [];
    let destroyed = 0;
    const discord = {
      application: {
        fetch: async () => {
          calls.push("application.fetch");
        }
      },
      channels: {
        fetch: async () => {
          calls.push("channels.fetch");
          return { id: "123" };
        }
      },
      async login() {
        calls.push("login");
      },
      destroy() {
        destroyed += 1;
      }
    };

    const platform = createDiscordPlatform({
      discord,
      discordToken: "token",
      waitForDiscordReady: async () => {
        calls.push("waitForDiscordReady");
        throw new Error("tls mismatch");
      },
      runtime: {
        handleMessage: async () => {
          calls.push("handleMessage");
        },
        handleInteraction: async () => {
          calls.push("handleInteraction");
        },
        registerSlashCommands: async () => {
          calls.push("registerSlashCommands");
          return { scope: "guild", count: 1 };
        }
      },
      bootstrapChannelMappings: async () => {
        calls.push("bootstrapChannelMappings");
        return { discoveredCwds: 1 };
      }
    });

    const summary = await platform.start();

    expect(summary.platformId).toBe("discord");
    expect(summary.started).toBe(false);
    expect(String(summary.startError?.message ?? "")).toBe("tls mismatch");
    expect(destroyed).toBe(1);
    expect(await platform.fetchChannelByRouteId("123")).toBeNull();
    await platform.handleInboundMessage({ id: "m1" });
    await platform.handleInboundInteraction({ id: "i1" });
    expect(await platform.bootstrapRoutes()).toBeNull();
    expect(calls).toEqual(["login", "application.fetch", "waitForDiscordReady"]);
  });

  test("starts successfully and serves runtime operations once ready", async () => {
    const calls: string[] = [];
    const discord = {
      application: {
        fetch: async () => {
          calls.push("application.fetch");
        }
      },
      channels: {
        fetch: async (routeId: string) => {
          calls.push(`channels.fetch:${routeId}`);
          return { id: routeId };
        }
      },
      async login(token: string) {
        calls.push(`login:${token}`);
      },
      destroy() {
        calls.push("destroy");
      }
    };

    const platform = createDiscordPlatform({
      discord,
      discordToken: "token",
      waitForDiscordReady: async () => {
        calls.push("waitForDiscordReady");
      },
      runtime: {
        handleMessage: async (message: { id: string }) => {
          calls.push(`handleMessage:${message.id}`);
        },
        handleInteraction: async (interaction: { id: string }) => {
          calls.push(`handleInteraction:${interaction.id}`);
        },
        registerSlashCommands: async () => {
          calls.push("registerSlashCommands");
          return { scope: "guild", count: 1, guildId: "g1" };
        }
      },
      bootstrapChannelMappings: async () => {
        calls.push("bootstrapChannelMappings");
        return { discoveredCwds: 2 };
      }
    });

    const summary = await platform.start();

    expect(summary).toEqual({
      platformId: "discord",
      started: true,
      commandRegistration: { scope: "guild", count: 1, guildId: "g1" },
      commandRegistrationError: null
    });
    expect(await platform.fetchChannelByRouteId("123")).toEqual({ id: "123" });
    await platform.handleInboundMessage({ id: "m1" });
    await platform.handleInboundInteraction({ id: "i1" });
    expect(await platform.bootstrapRoutes()).toEqual({ discoveredCwds: 2 });
    expect(await platform.stop()).toEqual({ platformId: "discord", stopped: true });
    expect(calls).toEqual([
      "login:token",
      "application.fetch",
      "waitForDiscordReady",
      "registerSlashCommands",
      "channels.fetch:123",
      "handleMessage:m1",
      "handleInteraction:i1",
      "bootstrapChannelMappings",
      "destroy"
    ]);
  });

  test("times out startup and degrades cleanly when ready never arrives", async () => {
    let destroyed = 0;
    const discord = {
      application: {
        fetch: async () => {}
      },
      channels: {
        fetch: async () => ({ id: "123" })
      },
      async login() {},
      destroy() {
        destroyed += 1;
      }
    };

    const platform = createDiscordPlatform({
      discord,
      discordToken: "token",
      startTimeoutMs: 5,
      waitForDiscordReady: async () => {
        await new Promise(() => {});
      },
      runtime: {
        handleMessage: async () => {},
        handleInteraction: async () => {},
        registerSlashCommands: async () => ({ scope: "guild", count: 1 })
      },
      bootstrapChannelMappings: async () => ({ discoveredCwds: 1 })
    });

    const summary = await platform.start();

    expect(summary.started).toBe(false);
    expect(String(summary.startError?.message ?? "")).toBe("discord startup timed out");
    expect(destroyed).toBe(1);
    expect(await platform.bootstrapRoutes()).toBeNull();
  });
});
