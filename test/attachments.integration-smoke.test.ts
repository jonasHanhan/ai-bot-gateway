import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maybeSendAttachmentsForItem, maybeSendInferredAttachmentsFromText } from "../src/attachments/service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("attachments integration smoke", () => {
  test("uploads one outbound image for an explicit imageView item", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const imagePath = path.join(realTmpDir, "capture-latest.png");
    await fs.writeFile(imagePath, "fake-image-bytes");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const issueMessages: string[] = [];
    const tracker = {
      channel: { id: "channel-1" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      { type: "imageView", id: "item-1", path: imagePath },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["imageView"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: false,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async (_channel: unknown, text: string) => {
          issueMessages.push(text);
          return null;
        },
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(issueMessages).toEqual([]);
    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("capture-latest.png");
    expect(Array.isArray(sentPayloads[0]?.files)).toBe(true);
  });

  test("sends basename non-image files for explicit imageView items", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const jsonPath = path.join(realTmpDir, "package.json");
    await fs.writeFile(jsonPath, '{"name":"demo"}');

    const sentPayloads: Array<Record<string, unknown>> = [];
    const issueMessages: string[] = [];
    const tracker = {
      channel: { id: "channel-1b" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      { type: "imageView", id: "item-1b", path: "package.json" },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["imageView"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: false,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async (_channel: unknown, text: string) => {
          issueMessages.push(text);
          return null;
        },
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(issueMessages).toEqual([]);
    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("package.json");
  });

  test("inferred text fallback uploads only the last referenced media path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const one = path.join(realTmpDir, "one.png");
    const two = path.join(realTmpDir, "two.png");
    await fs.writeFile(one, "one");
    await fs.writeFile(two, "two");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-2" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      {
        type: "commandExecution",
        id: "item-2",
        text: `generated ${one} and then finalized ${two}`
      },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["commandExecution"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: true,
        statusLabelForItemType: () => "command",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("two.png");
    expect(String(sentPayloads[0]?.content ?? "")).not.toContain("one.png");
  });

  test("uploads inline data-url images from structured tool output", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-inline-attach-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-inline" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };
    const dataUrl = `data:image/png;base64,${Buffer.from("inline-image-bytes").toString("base64")}`;

    await maybeSendAttachmentsForItem(
      tracker,
      {
        type: "mcpToolCall",
        id: "item-inline",
        output: [
          { type: "input_text", text: "Took a screenshot of the full current page." },
          { type: "input_image", image_url: dataUrl }
        ]
      },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["mcpToolCall"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        attachmentInferFromText: false,
        statusLabelForItemType: () => "browser tool",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 1
      }
    );

    expect(sentPayloads.length).toBe(1);
    const files = sentPayloads[0]?.files;
    expect(Array.isArray(files)).toBe(true);
    const firstFile = Array.isArray(files) ? files[0] : null;
    expect(String(firstFile?.name ?? "")).toMatch(/^inline-[a-f0-9]{24}\.png$/);
    expect(await fs.readFile(String(firstFile?.attachment ?? ""), "utf8")).toBe("inline-image-bytes");
  });

  test("suppresses attachment issue notices when max issue messages is zero", async () => {
    const issueMessages: string[] = [];
    const tracker = {
      channel: { id: "channel-3" },
      cwd: "/tmp",
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    await maybeSendAttachmentsForItem(
      tracker,
      { type: "imageView", id: "item-3", path: "https://example.com/image.png" },
      {
        attachmentsEnabled: true,
        attachmentItemTypes: new Set(["imageView"]),
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: ["/tmp"],
        imageCacheDir: "/tmp",
        attachmentInferFromText: false,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async (_channel: unknown, text: string) => {
          issueMessages.push(text);
          return null;
        },
        safeSendToChannelPayload: async () => null,
        truncateStatusText: (text: string) => text,
        maxAttachmentIssueMessages: 0
      }
    );

    expect(issueMessages).toEqual([]);
  });

  test("summary inferred attachments send all unique referenced relative image paths", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-summary-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const screenshotsDir = path.join(realTmpDir, "screenshots");
    await fs.mkdir(screenshotsDir, { recursive: true });
    await fs.writeFile(path.join(screenshotsDir, "after_tap.png"), "a");
    await fs.writeFile(path.join(screenshotsDir, "home.png"), "b");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-4" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    const sentCount = await maybeSendInferredAttachmentsFromText(
      tracker,
      [
        "I found screenshots:",
        "- screenshots/after_tap.png",
        "- screenshots/home.png",
        "- screenshots/after_tap.png"
      ].join("\n"),
      {
        attachmentsEnabled: true,
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text
      }
    );

    expect(sentCount).toBe(2);
    expect(sentPayloads.length).toBe(2);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("after_tap.png");
    expect(String(sentPayloads[1]?.content ?? "")).toContain("home.png");
  });

  test("summary inferred attachments resolve filename-only image mention to unique file under cwd", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-filename-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const screenshotsDir = path.join(realTmpDir, "walkie-talkie", "screenshots");
    await fs.mkdir(screenshotsDir, { recursive: true });
    await fs.writeFile(path.join(screenshotsDir, "home-brand-theme-fresh-4.png"), "img");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-5" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    const sentCount = await maybeSendInferredAttachmentsFromText(
      tracker,
      "can you send me home-brand-theme-fresh-4.png",
      {
        attachmentsEnabled: true,
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text
      }
    );

    expect(sentCount).toBe(1);
    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("home-brand-theme-fresh-4.png");
  });

  test("summary inferred attachments send markdown-linked text file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-attach-text-"));
    tempDirs.push(tmpDir);
    const realTmpDir = await fs.realpath(tmpDir);
    const notePath = path.join(realTmpDir, "attachment-test.txt");
    await fs.writeFile(notePath, "hello attachment");

    const sentPayloads: Array<Record<string, unknown>> = [];
    const tracker = {
      channel: { id: "channel-6" },
      cwd: realTmpDir,
      sentAttachmentKeys: new Set<string>(),
      seenAttachmentIssueKeys: new Set<string>(),
      attachmentIssueCount: 0
    };

    const sentCount = await maybeSendInferredAttachmentsFromText(
      tracker,
      `Please send this file: [attachment-test.txt](${notePath})`,
      {
        attachmentsEnabled: true,
        attachmentMaxBytes: 8 * 1024 * 1024,
        attachmentRoots: [realTmpDir],
        imageCacheDir: realTmpDir,
        statusLabelForItemType: () => "image view",
        safeSendToChannel: async () => null,
        safeSendToChannelPayload: async (_channel: unknown, payload: Record<string, unknown>) => {
          sentPayloads.push(payload);
          return null;
        },
        truncateStatusText: (text: string) => text
      }
    );

    expect(sentCount).toBe(1);
    expect(sentPayloads.length).toBe(1);
    expect(String(sentPayloads[0]?.content ?? "")).toContain("attachment-test.txt");
    expect(Array.isArray(sentPayloads[0]?.files)).toBe(true);
  });
});
