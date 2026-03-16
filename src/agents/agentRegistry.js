function normalizeId(agentId) {
  return String(agentId ?? "").trim();
}

export function createAgentRegistry(agents, defaultAgentId = null) {
  const registeredAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const normalizedDefaultAgentId = normalizeId(defaultAgentId);

  function listAgents() {
    return [...registeredAgents];
  }

  function listEnabledAgents() {
    return registeredAgents.filter((agent) => agent.enabled !== false);
  }

  function getAgent(agentId) {
    const normalized = normalizeId(agentId);
    if (!normalized) {
      return null;
    }
    return registeredAgents.find((agent) => normalizeId(agent.agentId) === normalized) ?? null;
  }

  function getCapabilities(agentId) {
    return { ...(getAgent(agentId)?.capabilities ?? {}) };
  }

  function agentSupports(agentId, capabilityName) {
    return getCapabilities(agentId)[String(capabilityName ?? "").trim()] === true;
  }

  function anyAgentSupports(capabilityName) {
    const normalizedCapability = String(capabilityName ?? "").trim();
    if (!normalizedCapability) {
      return false;
    }
    return listEnabledAgents().some((agent) => agent.capabilities?.[normalizedCapability] === true);
  }

  function getDefaultAgentId() {
    if (normalizedDefaultAgentId) {
      const defaultAgent = getAgent(normalizedDefaultAgentId);
      if (defaultAgent && defaultAgent.enabled !== false) {
        return normalizedDefaultAgentId;
      }
    }
    return listEnabledAgents()[0]?.agentId ?? null;
  }

  return {
    listAgents,
    listEnabledAgents,
    getAgent,
    getCapabilities,
    agentSupports,
    anyAgentSupports,
    getDefaultAgentId
  };
}
