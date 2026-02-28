export function formatInputTextForSetup(text, setup) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (setup?.mode !== "general") {
    return trimmed;
  }
  return [
    "[Channel context: #general]",
    "Treat this channel as informational Q&A and general conversation.",
    "Do not assume repo work, file edits, or tool/command execution unless explicitly requested.",
    "Ignore local cwd/repo context unless the user explicitly asks for it.",
    "",
    trimmed
  ].join("\n");
}

export function waitForDiscordReady(client) {
  if (client.isReady()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    client.once("clientReady", () => resolve());
  });
}

export function isDiscordMissingPermissionsError(error) {
  return (
    Number(error?.code) === 50013 ||
    Number(error?.rawError?.code) === 50013 ||
    String(error?.message ?? "").toLowerCase().includes("missing permissions")
  );
}

export function createDebugLog(debugLoggingEnabled) {
  return function debugLog(scope, message, details) {
    if (!debugLoggingEnabled) {
      return;
    }
    if (details === undefined) {
      console.log(`[debug:${scope}] ${message}`);
      return;
    }
    let serialized;
    try {
      serialized = JSON.stringify(details);
    } catch {
      serialized = String(details);
    }
    const trimmed = serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized;
    console.log(`[debug:${scope}] ${message} ${trimmed}`);
  };
}
