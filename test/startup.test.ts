import { describe, expect, test } from "bun:test";
import { startBridgeRuntime } from "../src/app/startup.js";

describe("startup runtime", () => {
  test("marks backend unready when an enabled platform fails startup", async () => {
    const readyUpdates = [];

    await startBridgeRuntime({
      codex: {
        async start() {}
      },
      fs: {
        async mkdir() {}
      },
      generalChannelCwd: "/tmp/general",
      platformRegistry: {
        listEnabledPlatforms: () => [{ platformId: "discord" }, { platformId: "feishu" }],
        async start() {
          return [
            {
              platformId: "discord",
              started: false,
              startError: new Error("discord startup timed out")
            },
            {
              platformId: "feishu",
              started: true,
              transport: "long-connection"
            }
          ];
        },
        async bootstrapRoutes() {
          return [];
        }
      },
      maybeCompletePendingRestartNotice: async () => {},
      turnRecoveryStore: {
        async reconcilePending() {
          return {
            reconciled: 0,
            resumedKnown: 0,
            missingThread: 0,
            skipped: 0
          };
        }
      },
      safeSendToChannel: async () => null,
      fetchChannelByRouteId: async () => null,
      startBackendRuntime: async () => {},
      setBackendReady: (value) => {
        readyUpdates.push(value);
      },
      getMappedChannelCount: () => 0,
      startHeartbeatLoop: () => {}
    });

    expect(readyUpdates).toEqual([
      false,
      {
        ready: false,
        degradedPlatforms: [
          {
            platformId: "discord",
            reason: "startup_failed",
            message: "discord startup timed out"
          }
        ]
      }
    ]);
  });
});
