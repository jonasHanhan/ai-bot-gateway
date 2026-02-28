import path from "node:path";

export function createAttachmentInputBuilder(deps) {
  const { fs, imageCacheDir, maxImagesPerMessage, discordToken, fetch, formatInputTextForSetup, logger } = deps;

  function collectImageAttachments(message) {
    if (!message?.attachments?.size) {
      return [];
    }
    const all = [...message.attachments.values()];
    return all.filter((attachment) => isImageAttachment(attachment)).slice(0, Math.max(0, maxImagesPerMessage));
  }

  async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
    const inputItems = [];
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed) {
      inputItems.push({ type: "text", text: formatInputTextForSetup(trimmed, setup) });
    }

    const localImages = await downloadImageAttachments(imageAttachments, message.id);
    inputItems.push(...localImages);
    return inputItems;
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

  return {
    collectImageAttachments,
    buildTurnInputFromMessage
  };
}
