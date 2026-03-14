export function createPlatformRegistry(platforms) {
  const registeredPlatforms = Array.isArray(platforms) ? platforms.filter(Boolean) : [];

  function listPlatforms() {
    return [...registeredPlatforms];
  }

  function listEnabledPlatforms() {
    return registeredPlatforms.filter((platform) => platform.enabled !== false);
  }

  function getPlatform(platformId) {
    return registeredPlatforms.find((platform) => platform.platformId === platformId) ?? null;
  }

  function getCapabilities(platformId) {
    return { ...(getPlatform(platformId)?.capabilities ?? {}) };
  }

  function platformSupports(platformId, capabilityName) {
    return getCapabilities(platformId)[capabilityName] === true;
  }

  function anyPlatformSupports(capabilityName) {
    return listEnabledPlatforms().some((platform) => platform?.capabilities?.[capabilityName] === true);
  }

  async function fetchChannelByRouteId(routeId) {
    const normalizedRouteId = String(routeId ?? "").trim();
    if (!normalizedRouteId) {
      return null;
    }

    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.canHandleRouteId === "function" && !platform.canHandleRouteId(normalizedRouteId)) {
        continue;
      }
      const channel = await platform.fetchChannelByRouteId?.(normalizedRouteId);
      if (channel) {
        return channel;
      }
    }

    return null;
  }

  async function handleInboundMessage(message) {
    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.handleInboundMessage !== "function") {
        continue;
      }
      await platform.handleInboundMessage(message);
      return true;
    }
    return false;
  }

  async function handleInboundInteraction(interaction) {
    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.handleInboundInteraction !== "function") {
        continue;
      }
      await platform.handleInboundInteraction(interaction);
      return true;
    }
    return false;
  }

  async function start() {
    const summaries = [];
    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.start !== "function") {
        continue;
      }
      try {
        summaries.push(await platform.start());
      } catch (error) {
        summaries.push({
          platformId: platform.platformId,
          started: false,
          startError: error
        });
      }
    }
    return summaries;
  }

  async function bootstrapRoutes(options = {}) {
    const summaries = [];
    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.bootstrapRoutes !== "function") {
        continue;
      }
      const summary = await platform.bootstrapRoutes(options);
      if (summary) {
        summaries.push({ platformId: platform.platformId, ...summary });
      }
    }
    return summaries;
  }

  async function stop() {
    const summaries = [];
    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.stop !== "function") {
        continue;
      }
      summaries.push(await platform.stop());
    }
    return summaries;
  }

  function getHttpEndpoints() {
    const seen = new Set();
    const endpoints = [];

    for (const platform of listEnabledPlatforms()) {
      const platformEndpoints = platform.getHttpEndpoints?.() ?? [];
      for (const endpoint of platformEndpoints) {
        const path = String(endpoint ?? "").trim();
        if (!path || seen.has(path)) {
          continue;
        }
        seen.add(path);
        endpoints.push(path);
      }
    }

    return endpoints;
  }

  async function handleHttpRequest(request, response, options = {}) {
    const method = String(request.method ?? "").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    for (const platform of listEnabledPlatforms()) {
      if (typeof platform.matchesHttpRequest !== "function" || !platform.matchesHttpRequest({ method, pathname })) {
        continue;
      }
      await platform.handleHttpRequest?.(request, response, options);
      return true;
    }

    return false;
  }

  return {
    listPlatforms,
    listEnabledPlatforms,
    getPlatform,
    getCapabilities,
    platformSupports,
    anyPlatformSupports,
    fetchChannelByRouteId,
    handleInboundMessage,
    handleInboundInteraction,
    start,
    stop,
    bootstrapRoutes,
    getHttpEndpoints,
    handleHttpRequest
  };
}
