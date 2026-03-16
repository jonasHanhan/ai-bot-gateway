export function normalizeRecognizedCommandText(text, commandNames) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("!")) {
    return "";
  }

  return isRecognizedCommandText(normalized, commandNames) ? normalized : "";
}

export function normalizeRecognizedSlashCommandText(text, commandNames) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    return normalized;
  }

  return isRecognizedCommandText(normalized, commandNames) ? `!${normalized.slice(1).trim()}` : normalized;
}

function isRecognizedCommandText(text, commandNames) {
  const normalized = String(text ?? "").trim();
  const commandToken = normalized.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!commandToken) {
    return false;
  }

  return commandNames.has(commandToken);
}
