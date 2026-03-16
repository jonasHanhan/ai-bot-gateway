import { describe, expect, test } from "bun:test";
import { createAgentRegistry } from "../src/agents/agentRegistry";

describe("agentRegistry", () => {
  test("returns default agent id with fallback", () => {
    const registry = createAgentRegistry([
      { agentId: "codex", enabled: true },
      { agentId: "claude", enabled: false }
    ]);

    expect(registry.getDefaultAgentId()).toBe("codex");
  });

  test("uses explicit default agent id when exists", () => {
    const registry = createAgentRegistry(
      [
        { agentId: "codex", enabled: true },
        { agentId: "claude", enabled: true }
      ],
      "claude"
    );

    expect(registry.getDefaultAgentId()).toBe("claude");
  });

  test("falls back when explicit default agent is disabled", () => {
    const registry = createAgentRegistry(
      [
        { agentId: "codex", enabled: true },
        { agentId: "claude", enabled: false }
      ],
      "claude"
    );

    expect(registry.getDefaultAgentId()).toBe("codex");
  });

  test("supports capability checks", () => {
    const registry = createAgentRegistry([
      {
        agentId: "codex",
        enabled: true,
        capabilities: {
          supportsImageInput: true,
          supportsInteractiveApprovals: false
        }
      }
    ]);

    expect(registry.agentSupports("codex", "supportsImageInput")).toBe(true);
    expect(registry.agentSupports("codex", "supportsInteractiveApprovals")).toBe(false);
    expect(registry.anyAgentSupports("supportsImageInput")).toBe(true);
    expect(registry.anyAgentSupports("supportsStructuredToolCalls")).toBe(false);
  });
});
