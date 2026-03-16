import { describe, expect, test } from "bun:test";
import { buildCommandTextFromInteraction, buildSlashCommandPayloads, syncSlashCommands } from "../src/commands/slashCommands.js";

function createOptions(values: Record<string, unknown> = {}) {
  return {
    getString(name: string) {
      const value = values[name];
      return typeof value === "string" ? value : null;
    },
    getBoolean(name: string) {
      const value = values[name];
      return typeof value === "boolean" ? value : null;
    }
  };
}

describe("slash commands", () => {
  test("builds the expected command set", () => {
    const payloads = buildSlashCommandPayloads();
    const names = payloads.map((payload) => payload.name);

    expect(names).toEqual([
      "help",
      "ask",
      "status",
      "new",
      "restart",
      "interrupt",
      "where",
      "agents",
      "setpath",
      "approve",
      "decline",
      "cancel",
      "initrepo",
      "resync",
      "rebuild"
    ]);
  });

  test("maps slash interactions back to the existing !command text", () => {
    expect(buildCommandTextFromInteraction({ commandName: "status", options: createOptions() })).toBe("!status");
    expect(buildCommandTextFromInteraction({ commandName: "ask", options: createOptions({ prompt: "ship it" }) })).toBe(
      "!ask ship it"
    );
    expect(buildCommandTextFromInteraction({ commandName: "approve", options: createOptions({ id: "0007" }) })).toBe(
      "!approve 0007"
    );
    expect(
      buildCommandTextFromInteraction({ commandName: "setpath", options: createOptions({ path: "/tmp/repo-one" }) })
    ).toBe("!setpath /tmp/repo-one");
    expect(buildCommandTextFromInteraction({ commandName: "agents", options: createOptions() })).toBe("!agents");
    expect(buildCommandTextFromInteraction({ commandName: "initrepo", options: createOptions({ force: true }) })).toBe(
      "!initrepo force"
    );
  });

  test("prefers guild registration when a guild can be resolved", async () => {
    const calls: Array<{ target: string; count: number }> = [];
    const discord = {
      application: {
        commands: {
          set: async (payloads: Array<unknown>) => {
            calls.push({ target: "global", count: payloads.length });
          }
        }
      }
    };
    const guild = {
      id: "guild-1",
      commands: {
        set: async (payloads: Array<unknown>) => {
          calls.push({ target: "guild", count: payloads.length });
        }
      }
    };

    const summary = await syncSlashCommands({
      discord,
      resolveGuild: async () => guild,
      logger: { warn() {} }
    });

    expect(summary).toEqual({
      scope: "guild",
      guildId: "guild-1",
      count: 15
    });
    expect(calls).toEqual([{ target: "guild", count: 15 }]);
  });
});
