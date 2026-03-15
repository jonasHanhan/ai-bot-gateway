import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SUPPORTED_ATTACHMENT_EXT_PATTERN =
  "(?:png|jpe?g|webp|gif|bmp|tiff?|svg|mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav|flac|aac|ogg|txt|md|json|csv|log|pdf|zip|tar|gz|tgz|bz2|7z|docx?|xlsx?|pptx?)";

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

export async function maybeSendInferredAttachmentsFromText(tracker, text, context) {
  const {
    attachmentsEnabled,
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText
  } = context;

  if (!attachmentsEnabled || !tracker?.channel || typeof text !== "string" || !text.trim()) {
    return 0;
  }

  const inferred = [...new Set(collectLikelyLocalPathsFromText(text))];
  if (inferred.length === 0) {
    return 0;
  }

  const telemetry = ensureAttachmentTelemetry(tracker);
  telemetry.detected += inferred.length;
  let sentCount = 0;
  for (const imagePath of inferred) {
    const sent = await sendAttachmentForPath(
      tracker,
      imagePath,
      {
        itemType: "imageView",
        announceFailures: false,
        intent: "inferred_text_fallback"
      },
      {
        attachmentMaxBytes,
        attachmentRoots,
        imageCacheDir,
        statusLabelForItemType,
        safeSendToChannel,
        safeSendToChannelPayload,
        truncateStatusText,
        maxAttachmentIssueMessages: 0,
        telemetry
      }
    );
    if (sent) {
      sentCount += 1;
    }
  }
  return sentCount;
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
    new RegExp(
      String.raw`(?:^|[\s([` +
        "`'\"" +
        String.raw`])((?:\/|~\/)[^\s)\]` +
        "`'\"<>" +
        String.raw`\r\n]+\.` +
        SUPPORTED_ATTACHMENT_EXT_PATTERN +
        String.raw`)(?:$|[\s)\]` +
        "`'\"" +
        String.raw`,.!?:;])`,
      "gi"
    );
  let match = mediaPathPattern.exec(text);
  while (match) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      found.add(candidate);
    }
    match = mediaPathPattern.exec(text);
  }

  const relativeMediaPathPattern =
    new RegExp(
      String.raw`(?:^|[\s([` + "`'\"" + String.raw`])((?:(?:\.\.?\/)?[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.` +
        SUPPORTED_ATTACHMENT_EXT_PATTERN +
        String.raw`)(?:$|[\s)\]` + "`'\"" + String.raw`,.!?:;])`,
      "gi"
    );
  match = relativeMediaPathPattern.exec(text);
  while (match) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate && !/^https?:\/\//i.test(candidate)) {
      found.add(candidate);
    }
    match = relativeMediaPathPattern.exec(text);
  }

  const markdownLinkPathPattern = /\]\(([^)]+)\)/g;
  match = markdownLinkPathPattern.exec(text);
  while (match) {
    const raw = String(match[1] ?? "").trim();
    if (!/^https?:\/\//i.test(raw) && new RegExp(`\\.${SUPPORTED_ATTACHMENT_EXT_PATTERN}$`, "i").test(raw)) {
      found.add(raw);
    }
    match = markdownLinkPathPattern.exec(text);
  }

  const bareMediaFilenamePattern =
    new RegExp(
      String.raw`(?:^|[\s([` +
        "`'\"" +
        String.raw`])([A-Za-z0-9._-]+\.` +
        SUPPORTED_ATTACHMENT_EXT_PATTERN +
        String.raw`)(?:$|[\s)\]` +
        "`'\"" +
        String.raw`,.!?:;])`,
      "gi"
    );
  match = bareMediaFilenamePattern.exec(text);
  while (match) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      found.add(candidate);
    }
    match = bareMediaFilenamePattern.exec(text);
  }

  return [...found];
}

async function sendAttachmentForPath(tracker, filePath, options = {}, context) {
  const { itemType, announceFailures = false } = options;
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
    return false;
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    return false;
  }
  const trimmed = filePath.trim();
  if (!isSupportedMediaPath(trimmed)) {
    telemetry.skipped += 1;
    return false;
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
    return false;
  }

  const allowedRoots = resolveAttachmentRoots(tracker, attachmentRoots, imageCacheDir);
  const resolvedInputPath = await resolveCandidatePath(trimmed, tracker, allowedRoots);
  if (!resolvedInputPath) {
    telemetry.failed += 1;
    await maybeSendAttachmentIssue(
      tracker,
      `missing:${trimmed}`,
      `Attachment missing: \`${path.basename(trimmed)}\``,
      announceFailures,
      maxAttachmentIssueMessages,
      safeSendToChannel
    );
    return false;
  }

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
    return false;
  }

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
    return false;
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
    return false;
  }
  if (!stats.isFile()) {
    telemetry.skipped += 1;
    return false;
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
    return false;
  }

  const key = realPath;
  if (tracker.sentAttachmentKeys?.has(key)) {
    telemetry.skipped += 1;
    return false;
  }
  tracker.sentAttachmentKeys?.add(key);

  const label = itemType ? statusLabelForItemType(itemType) : "attachment";
  const content = `Attachment (${label}): \`${path.basename(realPath)}\``;
  await safeSendToChannelPayload(tracker.channel, {
    content,
    files: [{ attachment: realPath, name: path.basename(realPath) }]
  });
  telemetry.uploaded += 1;
  return true;
}

async function resolveCandidatePath(trimmed, tracker, allowedRoots) {
  if (!trimmed) {
    return null;
  }

  const expanded = expandUserPath(trimmed);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  if (isHighConfidencePathReference(expanded)) {
    if (typeof tracker?.cwd === "string" && tracker.cwd) {
      return path.resolve(tracker.cwd, expanded);
    }
    return path.resolve(expanded);
  }

  const roots = [];
  if (typeof tracker?.cwd === "string" && tracker.cwd) {
    roots.push(path.resolve(tracker.cwd));
  }
  for (const root of allowedRoots) {
    if (!roots.includes(root)) {
      roots.push(root);
    }
  }
  const uniqueMatch = await findUniqueFileByBasename(roots, expanded, { maxMatches: 2, maxEntries: 25000 });
  if (uniqueMatch) {
    return uniqueMatch;
  }

  if (typeof tracker?.cwd === "string" && tracker.cwd) {
    return path.resolve(tracker.cwd, expanded);
  }
  return path.resolve(expanded);
}

function expandUserPath(inputPath) {
  if (typeof inputPath !== "string") {
    return "";
  }
  if (inputPath.startsWith("~/")) {
    const home = process.env.HOME || "";
    if (home) {
      return path.join(home, inputPath.slice(2));
    }
  }
  return inputPath;
}

async function findUniqueFileByBasename(roots, basename, options = {}) {
  if (!Array.isArray(roots) || !basename) {
    return null;
  }
  const maxMatches = Number.isFinite(options.maxMatches) ? Math.max(1, Math.floor(options.maxMatches)) : 2;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(100, Math.floor(options.maxEntries)) : 25000;
  const queue = [];
  const visited = new Set();
  const matches = [];
  let scanned = 0;

  for (const root of roots) {
    if (typeof root !== "string" || !root) {
      continue;
    }
    const resolvedRoot = path.resolve(root);
    if (visited.has(resolvedRoot)) {
      continue;
    }
    visited.add(resolvedRoot);
    queue.push(resolvedRoot);
  }

  while (queue.length > 0 && scanned < maxEntries && matches.length < maxMatches) {
    const currentDir = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > maxEntries || matches.length >= maxMatches) {
        break;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        const resolvedDir = path.resolve(fullPath);
        if (!visited.has(resolvedDir)) {
          visited.add(resolvedDir);
          queue.push(resolvedDir);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === basename) {
        matches.push(fullPath);
        if (matches.length >= maxMatches) {
          break;
        }
      }
    }
  }

  if (matches.length !== 1) {
    return null;
  }
  return matches[0];
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
  return new RegExp(`\\.${SUPPORTED_ATTACHMENT_EXT_PATTERN}$`, "i").test(normalized);
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
