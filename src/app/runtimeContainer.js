const RUNTIME_REF_KEYS = [
  "runtimeOps",
  "discordRuntime",
  "backendRuntime",
  "feishuRuntime",
  "platformRegistry",
  "notificationRuntime",
  "serverRequestRuntime",
  "shutdown",
  "turnRunner"
];

const RuntimePhase = {
  BOOTSTRAPPING: "bootstrapping",
  RUNTIMES_ATTACHED: "runtimes_attached",
  READY: "ready",
  SHUTTING_DOWN: "shutting_down"
};

const PHASE_TRANSITIONS = {
  [RuntimePhase.BOOTSTRAPPING]: new Set([RuntimePhase.RUNTIMES_ATTACHED, RuntimePhase.SHUTTING_DOWN]),
  [RuntimePhase.RUNTIMES_ATTACHED]: new Set([RuntimePhase.READY, RuntimePhase.SHUTTING_DOWN]),
  [RuntimePhase.READY]: new Set([RuntimePhase.SHUTTING_DOWN]),
  [RuntimePhase.SHUTTING_DOWN]: new Set([])
};

function createEmptyRefs() {
  return Object.fromEntries(RUNTIME_REF_KEYS.map((key) => [key, null]));
}

function assertKnownRefKey(name) {
  const normalizedName = String(name ?? "").trim();
  if (!RUNTIME_REF_KEYS.includes(normalizedName)) {
    throw new Error(`[RuntimeContainer] Unknown runtime ref '${normalizedName}'.`);
  }
  return normalizedName;
}

export function createRuntimeContainer() {
  const refs = createEmptyRefs();
  let phase = RuntimePhase.BOOTSTRAPPING;

  function getPhase() {
    return phase;
  }

  function transitionTo(nextPhase) {
    const normalizedNextPhase = String(nextPhase ?? "").trim();
    const allowedTransitions = PHASE_TRANSITIONS[phase] ?? new Set();
    if (!allowedTransitions.has(normalizedNextPhase)) {
      throw new Error(
        `[RuntimeContainer] Invalid phase transition ${phase} -> ${normalizedNextPhase}.`
      );
    }
    phase = normalizedNextPhase;
  }

  function setRef(name, value) {
    const key = assertKnownRefKey(name);
    if (value == null) {
      throw new Error(`[RuntimeContainer] Ref '${key}' cannot be set to null/undefined.`);
    }
    refs[key] = value;
    return value;
  }

  function getRef(name) {
    const key = assertKnownRefKey(name);
    return refs[key];
  }

  function requireRef(name) {
    const key = assertKnownRefKey(name);
    const value = refs[key];
    if (value == null) {
      throw new Error(
        `[RuntimeContainer] Ref '${key}' accessed before initialization (phase=${phase}).`
      );
    }
    return value;
  }

  function assertInitialized(requiredRefs) {
    const missing = (Array.isArray(requiredRefs) ? requiredRefs : [])
      .map((name) => assertKnownRefKey(name))
      .filter((key) => refs[key] == null);
    if (missing.length > 0) {
      throw new Error(
        `[RuntimeContainer] Missing initialized refs (${missing.join(", ")}) at phase=${phase}.`
      );
    }
  }

  function snapshot() {
    return {
      phase,
      initializedRefs: RUNTIME_REF_KEYS.filter((key) => refs[key] != null)
    };
  }

  return {
    RuntimePhase,
    getPhase,
    transitionTo,
    setRef,
    getRef,
    requireRef,
    assertInitialized,
    snapshot
  };
}

