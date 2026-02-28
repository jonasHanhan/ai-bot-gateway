import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function maybeSendAttachmentsForItem(tracker, item, context) {
  const {
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    attachmentInferFromText,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText,
    maxAttachmentIssueMessages
  } = context;

  if (!attachmentsEnabled || !tracker?.channel || !item || typeof item !== "object") {
    return;
  }
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemType || !attachmentItemTypes.has(itemType)) {
    return;
  }

  const candidates = extractAttachmentCandidates(item, { attachmentInferFromText });
  if (candidates.length === 0) {
    return;
  }
  const telemetry = ensureAttachmentTelemetry(tracker);
  telemetry.detected += candidates.length;

  for (const candidate of candidates) {
    const announceFailures =
      itemType === "imageView" ||
      candidate.intent === "explicit_user_request" ||
      (candidate.intent === "explicit_structured" && isHighConfidencePathReference(candidate.path));
    await sendAttachmentForPath(
      tracker,
      candidate.path,
      {
        itemType,
        itemId: item.id,
        announceFailures,
        intent: candidate.intent
      },
      {
      attachmentMaxBytes,
      attachmentRoots,
      imageCacheDir,
      statusLabelForItemType,
      safeSendToChannel,
      safeSendToChannelPayload,
      truncateStatusText,
      maxAttachmentIssueMessages,
      telemetry
      }
    );
  }
}

export function extractAttachmentCandidates(item, options = {}) {
  const attachmentInferFromText = options.attachmentInferFromText === true;
  const declared = [];
  const addDeclared = (value, source = "path") => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      if ((source === "name" || source === "filename") && !isHighConfidencePathReference(trimmed)) {
        return;
      }
      declared.push(trimmed);
    }
  };

  addDeclared(item?.path, "path");
  addDeclared(item?.file, "file");
  addDeclared(item?.filename, "filename");
  addDeclared(item?.name, "name");
  addDeclared(item?.outputPath, "outputPath");
  addDeclared(item?.artifactPath, "artifactPath");
  if (Array.isArray(item?.paths)) {
    for (const value of item.paths) {
      addDeclared(value, "paths");
    }
  }
  if (Array.isArray(item?.files)) {
    for (const entry of item.files) {
      if (typeof entry === "string") {
        addDeclared(entry, "files");
      } else if (entry && typeof entry === "object") {
        addDeclared(entry.path, "path");
        addDeclared(entry.file, "file");
        addDeclared(entry.name, "name");
        addDeclared(entry.filename, "filename");
      }
    }
  }
  const declaredCandidates = [...new Set(declared)].map((value) => {
    const intent = item?.type === "imageView" ? "explicit_user_request" : "explicit_structured";
    return { path: value, intent };
  });
  // Cutover note: this bridge is migrating toward explicit-only attachment intents.
  // Keep text inference disabled by default and treat it as a temporary fallback path.
  if (!attachmentInferFromText) {
    return declaredCandidates;
  }
  const inferred = extractInferredAttachmentPaths(item);
  // Cutover note: inferred path handling is intentionally conservative:
  // "last-match wins" avoids duplicate uploads from repeated path mentions.
  // Once explicit attachment contracts are fully adopted, remove this fallback branch.
  const inferredLast = inferred.length > 0 ? inferred[inferred.length - 1] : null;
  if (!inferredLast) {
    return declaredCandidates;
  }
  const hasDeclaredMatch = declaredCandidates.some((candidate) => candidate.path === inferredLast);
  if (hasDeclaredMatch) {
    return declaredCandidates;
  }
  return [...declaredCandidates, { path: inferredLast, intent: "inferred_text_fallback" }];
}

function extractInferredAttachmentPaths(item) {
  const inferredPaths = [];
  const pathLikeKeys = new Set(["path", "file", "outputPath", "artifactPath"]);
  const add = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      inferredPaths.push(trimmed);
    }
  };

  for (const candidate of collectLikelyLocalPathsFromText(item.text)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.output)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.aggregatedOutput)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.stdout)) {
    add(candidate);
  }
  for (const candidate of collectLikelyLocalPathsFromText(item.stderr)) {
    add(candidate);
  }

  if (Array.isArray(item.paths)) {
    for (const value of item.paths) {
      add(value);
    }
  }

  if (Array.isArray(item.files)) {
    for (const entry of item.files) {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        add(entry.path);
        add(entry.file);
        add(entry.name);
        add(entry.filename);
      }
    }
  }

  const queue = [{ value: item, depth: 0 }];
  const seen = new Set();
  while (queue.length > 0 && inferredPaths.length < 64) {
    const current = queue.shift();
    if (!current || current.depth > 3) {
      continue;
    }
    const { value, depth } = current;
    if (!value || typeof value !== "object") {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        queue.push({ value: entry, depth: depth + 1 });
      }
      continue;
    }

    for (const [key, entry] of Object.entries(value)) {
      if (pathLikeKeys.has(key) && typeof entry === "string") {
        add(entry);
      }
      if (typeof entry === "string") {
        for (const candidate of collectLikelyLocalPathsFromText(entry)) {
          add(candidate);
        }
      }
      if (entry && typeof entry === "object") {
        queue.push({ value: entry, depth: depth + 1 });
      }
    }
  }

  return [...new Set(inferredPaths)];
}

export function collectLikelyLocalPathsFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }
  const found = new Set();
  const mediaPathPattern =
    /(?:^|[\s([`'"])((?:\/|~\/)[^\s)\]`'"<>\r\n]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg))(?:$|[\s)\]`'",.!?:;])/gi;
  let match = mediaPathPattern.exec(text);
  while (match) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      found.add(candidate);
    }
    match = mediaPathPattern.exec(text);
  }

  const markdownLinkPathPattern = /\]\(((?:\/|~\/)[^)]+)\)/g;
  match = markdownLinkPathPattern.exec(text);
  while (match) {
    const raw = String(match[1] ?? "").trim();
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg)$/i.test(raw)) {
      found.add(raw);
    }
    match = markdownLinkPathPattern.exec(text);
  }

  return [...found];
}

async function sendAttachmentForPath(tracker, filePath, options = {}, context) {
  const { itemType, itemId, announceFailures = false } = options;
  const {
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText,
    maxAttachmentIssueMessages,
    telemetry
  } = context;

  if (!tracker?.channel) {
    return;
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    return;
  }
  const trimmed = filePath.trim();
  if (!isSupportedMediaPath(trimmed)) {
    telemetry.skipped += 1;
    return;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `remote:${trimmed}`,
      `Attachment skipped (remote URL not supported): \`${truncateStatusText(trimmed, 120)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return;
  }

  const resolvedInputPath = path.isAbsolute(trimmed)
    ? trimmed
    : typeof tracker?.cwd === "string" && tracker.cwd
      ? path.resolve(tracker.cwd, trimmed)
      : path.resolve(trimmed);

  let realPath;
  try {
    realPath = await fs.realpath(resolvedInputPath);
  } catch {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `missing:${resolvedInputPath}`,
      `Attachment missing: \`${path.basename(trimmed)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return;
  }

  const allowedRoots = resolveAttachmentRoots(tracker, attachmentRoots, imageCacheDir);
  if (!isPathWithinRoots(realPath, allowedRoots)) {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `blocked:${realPath}`,
      `Attachment blocked (outside allowed roots): \`${path.basename(realPath)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return;
  }

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `unreadable:${realPath}`,
      `Attachment unreadable: \`${path.basename(realPath)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return;
  }
  if (!stats.isFile()) {
    telemetry.skipped += 1;
    return;
  }

  if (stats.size > attachmentMaxBytes) {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `too-large:${realPath}:${stats.size}`,
      `Attachment too large (${formatBytes(stats.size)} > ${formatBytes(attachmentMaxBytes)}): \`${path.basename(realPath)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return;
  }

  const key = itemId ? `${itemId}:${realPath}` : realPath;
  if (tracker.sentAttachmentKeys?.has(key)) {
    telemetry.skipped += 1;
    return;
  }
  tracker.sentAttachmentKeys?.add(key);

  const label = itemType ? statusLabelForItemType(itemType) : "attachment";
  const content = `Attachment (${label}): \`${path.basename(realPath)}\``;
  await safeSendToChannelPayload(tracker.channel, {
    content,
    files: [{ attachment: realPath, name: path.basename(realPath) }]
  });
  telemetry.uploaded += 1;
}

async function maybeSendAttachmentIssue(tracker, key, message, announce, maxMessages, safeSendToChannel) {
  if (!announce || !tracker?.channel) {
    return;
  }
  const issueLimit = Number.isFinite(maxMessages) ? Math.max(0, Math.floor(maxMessages)) : 1;
  const issueCount = Number.isFinite(tracker?.attachmentIssueCount) ? tracker.attachmentIssueCount : 0;
  if (issueCount >= issueLimit) {
    return;
  }
  const normalizedKey = typeof key === "string" ? key : String(key);
  if (tracker.seenAttachmentIssueKeys?.has(normalizedKey)) {
    return;
  }
  tracker.seenAttachmentIssueKeys?.add(normalizedKey);
  tracker.attachmentIssueCount = issueCount + 1;
  await safeSendToChannel(tracker.channel, message);
}

export function isHighConfidencePathReference(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (path.isAbsolute(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return true;
  }
  return trimmed.includes("/") || trimmed.includes("\\");
}

function isSupportedMediaPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg)$/.test(
    normalized
  );
}

function resolveAttachmentRoots(tracker, attachmentRoots, imageCacheDir) {
  const roots = new Set();
  if (typeof tracker?.cwd === "string" && tracker.cwd) {
    roots.add(path.resolve(tracker.cwd));
  }
  if (imageCacheDir) {
    roots.add(path.resolve(imageCacheDir));
  }
  for (const root of attachmentRoots) {
    if (root) {
      roots.add(path.resolve(root));
    }
  }
  if (process.platform !== "win32") {
    roots.add(path.resolve("/tmp"));
  }
  return [...roots];
}

function isPathWithinRoots(targetPath, roots) {
  if (typeof targetPath !== "string" || !targetPath) {
    return false;
  }
  for (const root of roots) {
    if (typeof root !== "string" || !root) {
      continue;
    }
    const relative = path.relative(root, targetPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ensureAttachmentTelemetry(tracker) {
  if (!tracker.attachmentTelemetry || typeof tracker.attachmentTelemetry !== "object") {
    tracker.attachmentTelemetry = {
      detected: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0
    };
  }
  return tracker.attachmentTelemetry;
}
