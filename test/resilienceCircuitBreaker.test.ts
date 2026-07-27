import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../src/resilience/CircuitBreaker.js";
import { CircuitOpenError } from "../src/errors.js";

function fakeLogger() {
  const events: unknown[] = [];
  return { warn: (e: unknown) => events.push(e), events };
}

describe("resilience/CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses documented config defaults", () => {
    const logger = fakeLogger();
    const cb = new CircuitBreaker({}, logger);
    expect(cb.getState()).toEqual(
      expect.objectContaining({ state: "CLOSED", failureCount: 0 }),
    );
  });

  it("stays CLOSED and calls hit the network until failureThreshold is reached", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 10_000, halfOpenProbeTimeoutMs: 1000 }, fakeLogger());
    const fail = () => Promise.reject(new Error("boom"));

    await expect(cb.execute(fail)).rejects.toThrow("boom");
    await expect(cb.execute(fail)).rejects.toThrow("boom");
    expect(cb.getState().state).toBe("CLOSED");
  });

  it("opens after failureThreshold consecutive failures and fails fast without hitting the network", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, openDurationMs: 10_000, halfOpenProbeTimeoutMs: 1000 }, fakeLogger());
    const fn = vi.fn(() => Promise.reject(new Error("boom")));

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fn)).rejects.toThrow("boom");
    }
    expect(cb.getState().state).toBe("OPEN");
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).toHaveBeenCalledTimes(3); // not invoked again — failed fast
  });

  it("allows exactly one HALF_OPEN probe after openDurationMs; success closes the circuit", async () => {
    const logger = fakeLogger();
    const cb = new CircuitBreaker(
      { failureThreshold: 2, successThreshold: 1, openDurationMs: 5000, halfOpenProbeTimeoutMs: 1000 },
      logger,
    );
    const fail = () => Promise.reject(new Error("boom"));
    await expect(cb.execute(fail)).rejects.toThrow();
    await expect(cb.execute(fail)).rejects.toThrow();
    expect(cb.getState().state).toBe("OPEN");

    vi.advanceTimersByTime(5000);

    const probe = vi.fn(() => Promise.resolve("ok"));
    await expect(cb.execute(probe)).resolves.toBe("ok");
    expect(cb.getState().state).toBe("CLOSED");
    expect(cb.getState().failureCount).toBe(0);

    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: "circuit_state_change", from: "CLOSED", to: "OPEN" }),
    );
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: "circuit_state_change", from: "OPEN", to: "HALF_OPEN" }),
    );
    expect(logger.events).toContainEqual(
      expect.objectContaining({ event: "circuit_state_change", from: "HALF_OPEN", to: "CLOSED" }),
    );
  });

  it("resets the open timer when the HALF_OPEN probe fails", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 5000, halfOpenProbeTimeoutMs: 1000 }, fakeLogger());
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow();
    expect(cb.getState().state).toBe("OPEN");

    vi.advanceTimersByTime(5000);
    await expect(cb.execute(() => Promise.reject(new Error("probe failed")))).rejects.toThrow("probe failed");
    expect(cb.getState().state).toBe("OPEN");

    // Circuit stays fast-failing until openDurationMs elapses again from this failure.
    await expect(cb.execute(() => Promise.resolve("should not run"))).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("requires successThreshold consecutive HALF_OPEN successes before closing (default 1)", async () => {
    const cb = new CircuitBreaker(
      { failureThreshold: 1, successThreshold: 2, openDurationMs: 1000, halfOpenProbeTimeoutMs: 1000 },
      fakeLogger(),
    );
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow();
    vi.advanceTimersByTime(1000);

    await expect(cb.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(cb.getState().state).toBe("HALF_OPEN");

    await expect(cb.execute(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(cb.getState().state).toBe("CLOSED");
  });

  it("rejects concurrent calls during HALF_OPEN while a probe is already in flight", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000, halfOpenProbeTimeoutMs: 5000 }, fakeLogger());
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow();
    vi.advanceTimersByTime(1000);

    let resolveProbe!: (v: string) => void;
    const slowProbe = () => new Promise<string>((resolve) => { resolveProbe = resolve; });

    const probePromise = cb.execute(slowProbe);
    const concurrentPromise = cb.execute(() => Promise.resolve("should not run"));

    await expect(concurrentPromise).rejects.toBeInstanceOf(CircuitOpenError);

    resolveProbe("ok");
    await expect(probePromise).resolves.toBe("ok");
    expect(cb.getState().state).toBe("CLOSED");
  });

  it("emits state-change events shaped { event, from, to, at }", async () => {
    const logger = fakeLogger();
    const cb = new CircuitBreaker({ failureThreshold: 1, openDurationMs: 1000, halfOpenProbeTimeoutMs: 1000 }, logger);
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow();

    expect(logger.events.length).toBe(1);
    const event = logger.events[0] as Record<string, unknown>;
    expect(event).toMatchObject({ event: "circuit_state_change", from: "CLOSED", to: "OPEN" });
    expect(typeof event.at).toBe("number");
  });
});
