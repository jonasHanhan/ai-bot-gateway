export interface AgentDescriptor {
  agentId: string;
  model?: string;
  enabled?: boolean;
  capabilities?: Record<string, boolean>;
  meta?: Record<string, unknown>;
}

export interface AgentRegistry {
  listAgents: () => AgentDescriptor[];
  listEnabledAgents: () => AgentDescriptor[];
  getAgent: (agentId: string) => AgentDescriptor | null;
  getCapabilities: (agentId: string) => Record<string, boolean>;
  agentSupports: (agentId: string, capabilityName: string) => boolean;
  anyAgentSupports: (capabilityName: string) => boolean;
  getDefaultAgentId: () => string | null;
}

function normalizeId(agentId: string | null | undefined): string {
  return String(agentId ?? "").trim();
}

export function createAgentRegistry(agents: AgentDescriptor[], defaultAgentId?: string | null): AgentRegistry {
  const registeredAgents = Array.isArray(agents) ? agents.filter(Boolean) : [];
  const normalizedDefaultAgentId = normalizeId(defaultAgentId);

  function listAgents(): AgentDescriptor[] {
    return [...registeredAgents];
  }

  function listEnabledAgents(): AgentDescriptor[] {
    return registeredAgents.filter((agent) => agent.enabled !== false);
  }

  function getAgent(agentId: string): AgentDescriptor | null {
    const normalized = normalizeId(agentId);
    if (!normalized) {
      return null;
    }
    return registeredAgents.find((agent) => normalizeId(agent.agentId) === normalized) ?? null;
  }

  function getCapabilities(agentId: string): Record<string, boolean> {
    return { ...(getAgent(agentId)?.capabilities ?? {}) };
  }

  function agentSupports(agentId: string, capabilityName: string): boolean {
    return getCapabilities(agentId)[String(capabilityName ?? "").trim()] === true;
  }

  function anyAgentSupports(capabilityName: string): boolean {
    const normalizedCapability = String(capabilityName ?? "").trim();
    if (!normalizedCapability) {
      return false;
    }
    return listEnabledAgents().some((agent) => agent.capabilities?.[normalizedCapability] === true);
  }

  function getDefaultAgentId(): string | null {
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
