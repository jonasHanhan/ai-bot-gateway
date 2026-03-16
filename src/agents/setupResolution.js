import { createAgentRegistry } from "./agentRegistry.js";

function normalizeId(value) {
  return String(value ?? "").trim();
}

function toAgentDescriptors(configAgents) {
  if (Array.isArray(configAgents)) {
    return configAgents.filter((agent) => agent && typeof agent === "object");
  }

  if (!configAgents || typeof configAgents !== "object") {
    return [];
  }

  return Object.entries(configAgents).map(([agentId, value]) => {
    const source = value && typeof value === "object" ? value : {};
    return {
      agentId,
      model: typeof source.model === "string" ? source.model : undefined,
      enabled: typeof source.enabled === "boolean" ? source.enabled : undefined,
      capabilities: source.capabilities,
      meta: source.meta
    };
  });
}

export function resolveSetupAgentAndModel(setup, config) {
  const registry = createAgentRegistry(
    toAgentDescriptors(config?.agents),
    normalizeId(config?.defaultAgent) || null
  );

  const explicitAgentId = normalizeId(setup?.agentId);
  const resolvedAgentId = explicitAgentId || registry.getDefaultAgentId() || null;
  const explicitModel = typeof setup?.model === "string" && setup.model.trim().length > 0 ? setup.model.trim() : null;

  if (explicitModel) {
    return {
      resolvedAgentId,
      resolvedModel: explicitModel
    };
  }

  const agentModel = resolvedAgentId ? registry.getAgent(resolvedAgentId)?.model : null;
  const defaultModel = typeof config?.defaultModel === "string" ? config.defaultModel : null;

  return {
    resolvedAgentId,
    resolvedModel: String(agentModel ?? defaultModel ?? "").trim() || null
  };
}

export function setupSupportsCapability(setup, config, capabilityName, fallback = true) {
  const normalizedCapability = normalizeId(capabilityName);
  if (!normalizedCapability) {
    return fallback;
  }

  const descriptors = toAgentDescriptors(config?.agents);
  if (descriptors.length === 0) {
    return fallback;
  }

  const { resolvedAgentId } = resolveSetupAgentAndModel(setup, config);
  if (!resolvedAgentId) {
    return fallback;
  }

  const registry = createAgentRegistry(descriptors, normalizeId(config?.defaultAgent) || null);
  const capabilities = registry.getCapabilities(resolvedAgentId);
  if (!(normalizedCapability in capabilities)) {
    return fallback;
  }

  return capabilities[normalizedCapability] === true;
}

export function getActiveAgentId(setup, config) {
  const explicitAgentId = normalizeId(setup?.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }

  const resolvedAgentId = normalizeId(setup?.resolvedAgentId);
  if (resolvedAgentId) {
    return resolvedAgentId;
  }

  const defaultAgentId = normalizeId(config?.defaultAgent);
  return defaultAgentId || null;
}

export function setupSupportsImageInput(setup, config, fallback = true) {
  return setupSupportsCapability(setup, config, "supportsImageInput", fallback);
}
