export function normalizeFinalSummaryText(text) {
  let normalized = collapseAdjacentDuplicateParagraphs(text);
  normalized = collapseConsecutiveDuplicateLines(normalized);
  normalized = collapseExactRepeatedBody(normalized);
  normalized = collapseRepeatedShortParagraphSet(normalized);
  return normalized;
}

function collapseAdjacentDuplicateParagraphs(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return source;
  }
  const paragraphs = source.split(/\n{2,}/);
  const deduped = [];
  for (const paragraph of paragraphs) {
    const normalized = paragraph.trim();
    if (!normalized) {
      continue;
    }
    const previous = deduped.length > 0 ? deduped[deduped.length - 1].trim() : "";
    if (previous && previous === normalized) {
      continue;
    }
    deduped.push(paragraph);
  }
  return deduped.join("\n\n");
}

function collapseConsecutiveDuplicateLines(text) {
  const source = typeof text === "string" ? text : "";
  if (!source) {
    return source;
  }
  const lines = source.split("\n");
  const deduped = [];
  for (const line of lines) {
    const normalized = line.trim();
    const previous = deduped.length > 0 ? deduped[deduped.length - 1].trim() : "";
    if (normalized && normalized === previous) {
      continue;
    }
    deduped.push(line);
  }
  return deduped.join("\n");
}

function collapseExactRepeatedBody(text) {
  const source = typeof text === "string" ? text : "";
  const trimmed = source.trim();
  if (!trimmed || trimmed.length > 400) {
    return source;
  }
  if (trimmed.length % 2 !== 0) {
    return source;
  }
  const half = trimmed.length / 2;
  const left = trimmed.slice(0, half).trim();
  const right = trimmed.slice(half).trim();
  if (!left || left !== right) {
    return source;
  }
  return left;
}

function collapseRepeatedShortParagraphSet(text) {
  const source = typeof text === "string" ? text : "";
  const paragraphs = source
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (paragraphs.length <= 1) {
    return source;
  }
  const first = paragraphs[0];
  if (!first || first.length > 160) {
    return source;
  }
  for (const paragraph of paragraphs) {
    if (paragraph !== first) {
      return source;
    }
  }
  return first;
}
