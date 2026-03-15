import { describe, expect, test } from "bun:test";
import { resolveFeishuContext } from "../src/feishu/context.js";
import { makeFeishuRouteId } from "../src/feishu/ids.js";

describe("feishu context", () => {
  test("resolves mapped repo chat as writable context", () => {
    const routeId = makeFeishuRouteId("oc_repo_1");
    const context = resolveFeishuContext(
      {
        channelId: routeId
      },
      {
        channelSetups: {
          [routeId]: {
            cwd: "/tmp/repo",
            model: "gpt-5.3-codex"
          }
        },
        config: {
          defaultModel: "gpt-5.3-codex",
          sandboxMode: "workspace-write"
        },
        generalChat: {
          id: "oc_general",
          cwd: "/tmp/general"
        }
      }
    );

    expect(context).toEqual({
      repoChannelId: routeId,
      setup: {
        cwd: "/tmp/repo",
        model: "gpt-5.3-codex",
        bindingKind: "repo",
        mode: "repo",
        sandboxMode: "workspace-write",
        allowFileWrites: true
      }
    });
  });

  test("resolves configured general chat as read-only context", () => {
    const routeId = makeFeishuRouteId("oc_general");
    const context = resolveFeishuContext(
      {
        channelId: routeId
      },
      {
        channelSetups: {},
        config: {
          defaultModel: "gpt-5.3-codex",
          sandboxMode: "workspace-write"
        },
        generalChat: {
          id: "oc_general",
          cwd: "/tmp/general"
        }
      }
    );

    expect(context).toEqual({
      repoChannelId: routeId,
      setup: {
        cwd: "/tmp/general",
        model: "gpt-5.3-codex",
        bindingKind: "general",
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    });
  });

  test("resolves unbound chat as read-only context when unbound mode is open", () => {
    const routeId = makeFeishuRouteId("oc_unbound");
    const context = resolveFeishuContext(
      {
        channelId: routeId
      },
      {
        channelSetups: {},
        config: {
          defaultModel: "gpt-5.3-codex",
          sandboxMode: "workspace-write"
        },
        generalChat: {
          id: "oc_general",
          cwd: "/tmp/general"
        },
        unboundChat: {
          mode: "open",
          cwd: "/tmp/open-feishu"
        }
      }
    );

    expect(context).toEqual({
      repoChannelId: routeId,
      setup: {
        cwd: "/tmp/open-feishu",
        model: "gpt-5.3-codex",
        bindingKind: "unbound-open",
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    });
  });
});
