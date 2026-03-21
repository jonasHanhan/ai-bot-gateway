import path from "node:path";

const DEFAULT_FILE_PREVIEW_MAX_BYTES = 16 * 1024;
const DEFAULT_FILE_PREVIEW_MAX_CHARS = 4000;

export function createAttachmentInputBuilder(deps) {
  const {
    fs,
    imageCacheDir,
    maxImagesPerMessage,
    discordToken,
    fetch,
    formatInputTextForSetup,
    logger,
    filePreviewMaxBytes = DEFAULT_FILE_PREVIEW_MAX_BYTES,
    filePreviewMaxChars = DEFAULT_FILE_PREVIEW_MAX_CHARS
  } = deps;

  function collectImageAttachments(message) {
    if (!message?.attachments?.size) {
      return [];
    }
    const all = [...message.attachments.values()];
    return all.filter((attachment) => isImageAttachment(attachment)).slice(0, Math.max(0, maxImagesPerMessage));
  }

  async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
    const inputItems = [];
    const normalizedAttachments = normalizeAttachments(imageAttachments);
    const fileAttachments = collectFileAttachments(normalizedAttachments);
    const combinedText = await buildCombinedInputText(text, fileAttachments);
    if (combinedText) {
      inputItems.push({ type: "text", text: formatInputTextForSetup(combinedText, setup) });
    }

    const localImages = await downloadImageAttachments(collectImageLikeAttachments(normalizedAttachments), message.id);
    inputItems.push(...localImages);
    return inputItems;
  }

  function normalizeAttachments(attachments) {
    if (!Array.isArray(attachments)) {
      return [];
    }
    return attachments.filter((attachment) => attachment && typeof attachment === "object");
  }

  function collectImageLikeAttachments(attachments) {
    return attachments.filter((attachment) => isImageAttachment(attachment));
  }

  function collectFileAttachments(attachments) {
    return attachments
      .filter((attachment) => !isImageAttachment(attachment))
      .map((attachment) => normalizeFileAttachment(attachment))
      .filter((attachment) => attachment !== null);
  }

  function normalizeFileAttachment(attachment) {
    const filePath = resolveLocalImagePath(attachment);
    if (!filePath) {
      return null;
    }
    const name =
      typeof attachment?.name === "string" && attachment.name.trim()
        ? attachment.name.trim()
        : path.basename(filePath);
    const contentType = typeof attachment?.contentType === "string" ? attachment.contentType.trim() : "";
    const sizeBytes =
      Number.isFinite(Number(attachment?.sizeBytes)) && Number(attachment.sizeBytes) >= 0
        ? Number(attachment.sizeBytes)
        : null;
    return {
      path: filePath,
      name,
      contentType,
      sizeBytes
    };
  }

  async function buildCombinedInputText(text, fileAttachments) {
    const parts = [];
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed) {
      parts.push(trimmed);
    }
    const fileContext = await buildFileAttachmentContext(fileAttachments);
    if (fileContext) {
      parts.push(fileContext);
    }
    return parts.join("\n\n").trim();
  }

  async function buildFileAttachmentContext(fileAttachments) {
    if (!Array.isArray(fileAttachments) || fileAttachments.length === 0) {
      return "";
    }
    const lines = [
      "[Attached files from chat]",
      "The user sent file attachment(s). Use the metadata, preview, and local paths below:"
    ];
    for (const attachment of fileAttachments) {
      const metadata = await enrichFileAttachmentMetadata(attachment);
      lines.push("- file");
      lines.push(`  path: ${metadata.path}`);
      if (metadata.name) {
        lines.push(`  name: ${metadata.name}`);
      }
      if (metadata.extension) {
        lines.push(`  extension: ${metadata.extension}`);
      }
      if (metadata.contentType) {
        lines.push(`  content-type: ${metadata.contentType}`);
      }
      if (metadata.sizeBytes !== null) {
        lines.push(`  size-bytes: ${metadata.sizeBytes}`);
      }
      if (metadata.previewStatus) {
        lines.push(`  preview-status: ${metadata.previewStatus}`);
      }
      if (metadata.previewText) {
        lines.push("  preview:");
        lines.push("  ```text");
        lines.push(indentMultilineText(metadata.previewText, "  "));
        lines.push("  ```");
      }
    }
    return lines.join("\n");
  }

  async function enrichFileAttachmentMetadata(attachment) {
    const extension = path.extname(attachment.path).toLowerCase();
    let sizeBytes = attachment.sizeBytes;
    if (sizeBytes === null) {
      try {
        const stats = await fs.stat(attachment.path);
        if (stats?.isFile?.()) {
          sizeBytes = stats.size;
        }
      } catch (error) {
        logger?.warn?.(`failed to stat attachment ${attachment.path}: ${error.message}`);
      }
    }

    let previewStatus = "";
    let previewText = "";
    if (isTextPreviewCandidate(attachment, extension)) {
      try {
        const preview = await readTextPreview(attachment.path, sizeBytes);
        previewStatus = preview.status;
        previewText = preview.text;
      } catch (error) {
        previewStatus = `preview-read-failed (${error.message})`;
      }
    } else {
      previewStatus = "skipped (non-text attachment)";
    }

    return {
      ...attachment,
      extension,
      sizeBytes,
      previewStatus,
      previewText
    };
  }

  function isTextPreviewCandidate(attachment, extension) {
    const normalizedContentType = String(attachment.contentType ?? "").toLowerCase();
    if (normalizedContentType.startsWith("text/")) {
      return true;
    }
    if (
      normalizedContentType.includes("json") ||
      normalizedContentType.includes("xml") ||
      normalizedContentType.includes("yaml") ||
      normalizedContentType.includes("javascript")
    ) {
      return true;
    }
    return TEXT_PREVIEW_EXTENSIONS.has(extension);
  }

  async function readTextPreview(filePath, knownSizeBytes) {
    const buffer = await fs.readFile(filePath);
    const sizeBytes = Number.isFinite(Number(knownSizeBytes)) ? Number(knownSizeBytes) : buffer.length;
    const truncatedByBytes = buffer.length > filePreviewMaxBytes;
    const previewBuffer = truncatedByBytes ? buffer.subarray(0, filePreviewMaxBytes) : buffer;
    const decodedText = previewBuffer.toString("utf8");
    const normalizedDecodedText = normalizePreviewText(decodedText);
    const previewText = truncatePreviewText(decodedText);
    if (!previewText.trim()) {
      return {
        status: "empty-text-preview",
        text: ""
      };
    }
    if (truncatedByBytes || previewText.length < normalizedDecodedText.length || sizeBytes > filePreviewMaxBytes) {
      return {
        status: `truncated (${Math.min(sizeBytes, filePreviewMaxBytes)}/${sizeBytes} bytes shown)`,
        text: previewText
      };
    }
    return {
      status: `complete (${sizeBytes} bytes)`,
      text: previewText
    };
  }

  function truncatePreviewText(text) {
    const normalized = normalizePreviewText(text);
    if (normalized.length <= filePreviewMaxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(1, filePreviewMaxChars - 1))}…`;
  }

  function normalizePreviewText(text) {
    return String(text ?? "").replace(/\0/g, "").trim();
  }

  function indentMultilineText(text, prefix) {
    return String(text ?? "")
      .split(/\r?\n/)
      .map((line) => `${prefix}${line}`)
      .join("\n");
  }

  async function downloadImageAttachments(attachments, messageId) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
      return [];
    }
    await fs.mkdir(imageCacheDir, { recursive: true });
    const images = [];

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const downloaded = await downloadImageAttachment(attachment, messageId, index + 1);
      if (downloaded) {
        images.push(downloaded);
        continue;
      }
      if (typeof attachment?.url === "string" && attachment.url) {
        images.push({ type: "image", url: attachment.url });
      }
    }

    return images;
  }

  async function downloadImageAttachment(attachment, messageId, ordinal) {
    const localPath = resolveLocalImagePath(attachment);
    if (localPath) {
      return { type: "localImage", path: localPath };
    }

    const sourceUrls = [attachment?.proxyURL, attachment?.url]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (sourceUrls.length === 0) {
      return null;
    }

    try {
      const bytes = await fetchDiscordAttachmentBytes(sourceUrls);
      if (bytes.length === 0) {
        return null;
      }
      const extension = guessImageExtension(attachment);
      const fileName = `${Date.now()}-${messageId}-${ordinal}${extension}`;
      const filePath = path.join(imageCacheDir, fileName);
      await fs.writeFile(filePath, bytes);
      return { type: "localImage", path: filePath };
    } catch (error) {
      logger?.warn?.(`failed to download Discord image attachment ${attachment?.id ?? "unknown"}: ${error.message}`);
      return null;
    }
  }

  async function fetchDiscordAttachmentBytes(sourceUrls) {
    const seen = new Set();
    const urls = [];
    for (const sourceUrl of sourceUrls) {
      if (!seen.has(sourceUrl)) {
        seen.add(sourceUrl);
        urls.push(sourceUrl);
      }
    }

    const authHeaders = discordToken ? { Authorization: `Bot ${discordToken}` } : null;
    const attempts = [];
    for (const sourceUrl of urls) {
      attempts.push({ sourceUrl, headers: authHeaders });
      attempts.push({ sourceUrl, headers: null });
    }

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await fetch(attempt.sourceUrl, {
          headers: attempt.headers ?? undefined
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("attachment download failed");
  }

  function isImageAttachment(attachment) {
    if (!attachment) {
      return false;
    }
    if (String(attachment.kind ?? "").trim().toLowerCase() === "image") {
      return true;
    }
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    if (contentType.startsWith("image/")) {
      return true;
    }
    const name = String(attachment.name ?? "").toLowerCase();
    return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(name);
  }

  function guessImageExtension(attachment) {
    const byName = path.extname(String(attachment?.name ?? "")).toLowerCase();
    if (byName && byName.length <= 10) {
      return byName;
    }
    const contentType = String(attachment?.contentType ?? "").toLowerCase();
    const known = {
      "image/jpeg": ".jpg",
      "image/jpg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/bmp": ".bmp",
      "image/tiff": ".tif",
      "image/svg+xml": ".svg"
    };
    return known[contentType] ?? ".png";
  }

  function resolveLocalImagePath(attachment) {
    if (!attachment || typeof attachment !== "object") {
      return "";
    }
    const localPath = typeof attachment.path === "string" ? attachment.path.trim() : "";
    return localPath ? path.resolve(localPath) : "";
  }

  return {
    collectImageAttachments,
    buildTurnInputFromMessage
  };
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".csv",
  ".tsv",
  ".log",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".toml",
  ".lock",
  ".gitignore",
  ".dockerfile"
]);
