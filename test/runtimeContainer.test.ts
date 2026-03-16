import { describe, expect, test } from "bun:test";
import { createRuntimeContainer } from "../src/app/runtimeContainer.js";

describe("runtime container", () => {
  test("starts in bootstrapping phase with no initialized refs", () => {
    const container = createRuntimeContainer();
    expect(container.getPhase()).toBe(container.RuntimePhase.BOOTSTRAPPING);
    expect(container.snapshot()).toEqual({
      phase: container.RuntimePhase.BOOTSTRAPPING,
      initializedRefs: []
    });
  });

  test("supports set/get/require for known refs", () => {
    const container = createRuntimeContainer();
    const runtimeOps = { startHeartbeatLoop() {} };
    container.setRef("runtimeOps", runtimeOps);

    expect(container.getRef("runtimeOps")).toBe(runtimeOps);
    expect(container.requireRef("runtimeOps")).toBe(runtimeOps);
    expect(container.snapshot()).toEqual({
      phase: container.RuntimePhase.BOOTSTRAPPING,
      initializedRefs: ["runtimeOps"]
    });
  });

  test("throws for unknown ref keys and null assignments", () => {
    const container = createRuntimeContainer();

    expect(() => container.getRef("unknownRef")).toThrow("Unknown runtime ref");
    expect(() => container.requireRef("unknownRef")).toThrow("Unknown runtime ref");
    expect(() => container.setRef("runtimeOps", null)).toThrow("cannot be set to null/undefined");
    expect(() => container.requireRef("runtimeOps")).toThrow("accessed before initialization");
  });

  test("assertInitialized reports missing refs", () => {
    const container = createRuntimeContainer();
    container.setRef("runtimeOps", { id: "ops" });

    expect(() => container.assertInitialized(["runtimeOps"])).not.toThrow();
    expect(() => container.assertInitialized(["runtimeOps", "turnRunner"]))
      .toThrow("Missing initialized refs (turnRunner)");
  });

  test("enforces phase transition state machine", () => {
    const container = createRuntimeContainer();

    expect(() => container.transitionTo(container.RuntimePhase.READY)).toThrow("Invalid phase transition");
    container.transitionTo(container.RuntimePhase.RUNTIMES_ATTACHED);
    expect(container.getPhase()).toBe(container.RuntimePhase.RUNTIMES_ATTACHED);

    container.transitionTo(container.RuntimePhase.READY);
    expect(container.getPhase()).toBe(container.RuntimePhase.READY);

    container.transitionTo(container.RuntimePhase.SHUTTING_DOWN);
    expect(container.getPhase()).toBe(container.RuntimePhase.SHUTTING_DOWN);
    expect(() => container.transitionTo(container.RuntimePhase.READY)).toThrow("Invalid phase transition");
  });
});

