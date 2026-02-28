import { describe, expect, test } from "bun:test";
import {
  buildTurnRenderPlan,
  normalizeRenderVerbosity,
  redactLocalPathsForDiscord,
  sendChunkedToChannel,
  splitForDiscord,
  truncateForDiscordMessage
} from "../src/render/messageRenderer.js";

describe("message renderer", () => {
  test("normalizes verbosity to user by default", () => {
    expect(normalizeRenderVerbosity(undefined)).toBe("user");
    expect(normalizeRenderVerbosity("OPS")).toBe("ops");
    expect(normalizeRenderVerbosity("debug")).toBe("debug");
    expect(normalizeRenderVerbosity("nope")).toBe("user");
  });

  test("builds render plan and gates diff blocks by verbosity", () => {
    const userPlan = buildTurnRenderPlan({
      summaryText: "Done",
      diffBlock: "changed files",
      verbosity: "user"
    });
    expect(userPlan.primaryMessage).toBe("Done");
    expect(userPlan.statusMessages).toEqual([]);

    const opsPlan = buildTurnRenderPlan({
      summaryText: "Done",
      diffBlock: "changed files",
      verbosity: "ops"
    });
    expect(opsPlan.statusMessages).toEqual(["changed files"]);
  });

  test("truncates long discord messages with suffix", () => {
    const text = "x".repeat(2000);
    const truncated = truncateForDiscordMessage(text, 50);
    expect(truncated.length).toBeLessThanOrEqual(50);
    expect(truncated.endsWith("...[truncated]")).toBe(true);
    expect(truncateForDiscordMessage(123 as unknown as string)).toBe("");
  });

  test("splits long text into chunked messages", () => {
    const chunks = splitForDiscord("abcdefghij", 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
  });

  test("redacts local absolute paths in markdown links and plain text", () => {
    const redacted = redactLocalPathsForDiscord(
      "See ![img](/tmp/screenshots/shot.png) and /Users/me/repo/file.txt"
    );
    expect(redacted).toContain("](shot.png)");
    expect(redacted).toContain("file.txt");
    expect(redacted).not.toContain("/Users/me/repo/file.txt");
  });

  test("sendChunkedToChannel sends each split chunk", async () => {
    const sent: string[] = [];
    await sendChunkedToChannel({ id: "chan-1" }, "abcdef", async (_channel, chunk) => {
      sent.push(chunk);
      return null;
    }, 2);
    expect(sent).toEqual(["ab", "cd", "ef"]);
  });
});
