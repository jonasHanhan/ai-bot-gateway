import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentInputBuilder } from "../src/attachments/inputBuilder.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      tempDirs.delete(dir);
    })
  );
});

describe("attachment input builder", () => {
  test("includes rich metadata and preview for text file attachments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-text-"));
    tempDirs.add(tempDir);
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf8");

    const builder = createAttachmentInputBuilder({
      fs,
      imageCacheDir: tempDir,
      maxImagesPerMessage: 4,
      discordToken: "",
      fetch: globalThis.fetch,
      formatInputTextForSetup: (text: string) => text,
      logger: console
    });

    const inputItems = await builder.buildTurnInputFromMessage(
      { id: "msg-1" },
      "please inspect the file",
      [
        {
          kind: "file",
          path: filePath,
          name: "notes.txt",
          contentType: "text/plain"
        }
      ],
      null
    );

    expect(inputItems).toHaveLength(1);
    expect(inputItems[0]?.type).toBe("text");
    const text = String(inputItems[0]?.text ?? "");
    expect(text).toContain("please inspect the file");
    expect(text).toContain("[Attached files from chat]");
    expect(text).toContain(`path: ${filePath}`);
    expect(text).toContain("name: notes.txt");
    expect(text).toContain("extension: .txt");
    expect(text).toContain("content-type: text/plain");
    expect(text).toContain("size-bytes:");
    expect(text).toContain("preview-status: complete");
    expect(text).toContain("line one");
    expect(text).toContain("line two");
  });

  test("skips preview body for binary attachments while keeping metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-preview-bin-"));
    tempDirs.add(tempDir);
    const filePath = path.join(tempDir, "archive.zip");
    await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));

    const builder = createAttachmentInputBuilder({
      fs,
      imageCacheDir: tempDir,
      maxImagesPerMessage: 4,
      discordToken: "",
      fetch: globalThis.fetch,
      formatInputTextForSetup: (text: string) => text,
      logger: console
    });

    const inputItems = await builder.buildTurnInputFromMessage(
      { id: "msg-2" },
      "",
      [
        {
          kind: "file",
          path: filePath,
          name: "archive.zip",
          contentType: "application/zip"
        }
      ],
      null
    );

    expect(inputItems).toHaveLength(1);
    const text = String(inputItems[0]?.text ?? "");
    expect(text).toContain(`path: ${filePath}`);
    expect(text).toContain("name: archive.zip");
    expect(text).toContain("content-type: application/zip");
    expect(text).toContain("preview-status: skipped (non-text attachment)");
    expect(text).not.toContain("preview:\n");
  });
});
