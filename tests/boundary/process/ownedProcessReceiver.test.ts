import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { assertOwnedReceiverEnvironment } from "../../support/process/ownedProcessReceiverEnvironment.mjs";
import {
  registerOwnedReceiver,
  stopOwnedReceiver,
  hasPendingOwnedReceiver,
  waitOwnedReceiverReady,
  retryPendingOwnedProcessReceivers,
} from "../../support/process/ownedProcessReceiver.js";
import {
  ownedReceiverFixtureControl,
  confirmOwnedReceiverFixtureCleanup,
} from "../../support/process/ownedProcessReceiverFixture.js";

const fixture = async () => {
  const control = ownedReceiverFixtureControl();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, null, control],
    kill: vi.fn(() => true),
  });
  const owned = child as unknown as ChildProcess;
  const owner = {};
  const failures: unknown[] = [];
  const settled = registerOwnedReceiver(owned, owner, (cause) =>
    failures.push(cause),
  );
  await waitOwnedReceiverReady(owned);
  return { child, owned, settled, failures, control };
};

it("admits only the exact Darwin runtime entry in an otherwise empty receiver environment", () => {
  expect(() => assertOwnedReceiverEnvironment({}, "linux")).not.toThrow();
  expect(() => assertOwnedReceiverEnvironment({}, "darwin")).not.toThrow();
  expect(() =>
    assertOwnedReceiverEnvironment(
      { __CF_USER_TEXT_ENCODING: "owned-runtime" },
      "darwin",
    ),
  ).not.toThrow();
  for (const name of [
    "NODE_OPTIONS",
    "PATH",
    "OWNED_FAKE_KEY",
    "__CF_USER_TEXT_ENCODING_EXTRA",
  ]) {
    expect(() =>
      assertOwnedReceiverEnvironment({ [name]: "inert" }, "darwin"),
    ).toThrow("undeclared");
  }
  expect(() =>
    assertOwnedReceiverEnvironment(
      { __CF_USER_TEXT_ENCODING: "inert" },
      "linux",
    ),
  ).toThrow("undeclared");
  expect(() =>
    assertOwnedReceiverEnvironment(
      { TMPDIR: "/owned-runtime" },
      "darwin",
      "/owned-runtime",
    ),
  ).not.toThrow();
  expect(() =>
    assertOwnedReceiverEnvironment(
      { TMPDIR: "/not-selected" },
      "darwin",
      "/owned-runtime",
    ),
  ).toThrow("undeclared");
  expect(() =>
    assertOwnedReceiverEnvironment(
      { TMPDIR: "/owned-runtime" },
      "linux",
      "/owned-runtime",
    ),
  ).toThrow("undeclared");
});

it("lets the exact receiver settle cooperatively and coalesces overlapping shutdown", async () => {
  const { child, owned, settled } = await fixture();
  const stopping = stopOwnedReceiver(owned);
  expect(stopOwnedReceiver(owned)).toBe(stopping);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(hasPendingOwnedReceiver(owned)).toBe(true);
  confirmOwnedReceiverFixtureCleanup(owned);
  child.emit("close", 130, null);
  await Promise.all([settled, stopping]);
  expect(hasPendingOwnedReceiver(owned)).toBe(false);
  expect(child.listenerCount("error")).toBe(0);
});

it("retains refused signals and permits exact later cooperative retry", async () => {
  const { child, owned, settled } = await fixture();
  child.kill.mockReturnValue(false);
  await expect(stopOwnedReceiver(owned)).rejects.toThrow("incomplete");
  expect(hasPendingOwnedReceiver(owned)).toBe(true);
  expect(child.listenerCount("error")).toBe(1);
  child.kill.mockReturnValue(true);
  const retry = stopOwnedReceiver(owned);
  confirmOwnedReceiverFixtureCleanup(owned);
  child.emit("close", 130, null);
  await Promise.all([retry, settled]);
  expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGTERM"]]);
});

it.each(["closed", "unresponsive"] as const)(
  "bounds %s escalation but retains whole owner graph",
  async (mode) => {
    const { child, owned, settled } = await fixture();
    vi.useFakeTimers();
    const stopping = stopOwnedReceiver(owned);
    void stopping.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(9999);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      if (mode === "closed") child.emit("close", null, "SIGKILL");
      else await vi.advanceTimersByTimeAsync(2000);
      if (mode === "closed") await settled;
      await expect(stopping).rejects.toThrow("incomplete");
      expect(hasPendingOwnedReceiver(owned)).toBe(true);
      await expect(retryPendingOwnedProcessReceivers()).rejects.toThrow(
        "retained",
      );
      expect(child.listenerCount("error")).toBe(mode === "closed" ? 0 : 1);
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally {
      child.emit("close", null, "SIGKILL");
      vi.useRealTimers();
    }
  },
);

it.each([
  [1, null],
  [65, null],
  [null, "SIGTERM"],
  [null, "SIGKILL"],
] as const)(
  "retains unconfirmed exact close code %s / signal %s",
  async (code, signal) => {
    const { child, owned, settled } = await fixture();
    child.emit("close", code, signal);
    await settled;
    expect(hasPendingOwnedReceiver(owned)).toBe(true);
    const failure = await stopOwnedReceiver(owned).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: { code, signal } }),
      ]),
    );
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it("accepts ordinary diagnostic exit1 only with exact private completed-cleanup receipt", async () => {
  const { child, owned, settled } = await fixture();
  confirmOwnedReceiverFixtureCleanup(owned);
  child.emit("close", 1, null);
  await settled;
  await stopOwnedReceiver(owned);
  expect(hasPendingOwnedReceiver(owned)).toBe(false);
});

it("keeps early cancellation and actual deferred stdout callback inside the signal lease", async () => {
  const { withOwnedProcessReceiverSignals, writeOwnedProcessReceiverOutput } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  const signals = new EventEmitter();
  const abort = new AbortController();
  let complete!: (cause?: Error | null) => void;
  const output = Object.assign(new EventEmitter(), {
    write: vi.fn((_text: string, callback: typeof complete) => {
      complete = callback;
      return false;
    }),
  });
  let dispatched = false;
  let returned = false;
  const operation = withOwnedProcessReceiverSignals(
    signals,
    () => abort.abort(new Error("early cancellation")),
    async () => {
      signals.emit("SIGTERM");
      if (!abort.signal.aborted) dispatched = true;
      await writeOwnedProcessReceiverOutput(output, "bounded diagnostic\n");
      returned = true;
      return 130;
    },
  );
  expect(dispatched).toBe(false);
  expect(returned).toBe(false);
  expect(signals.listenerCount("SIGTERM")).toBe(1);
  signals.emit("SIGTERM");
  complete();
  expect(await operation).toBe(130);
  expect(returned).toBe(true);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

it.each([
  ["duplicate readiness", '{"type":"ready"}\n'],
  ["cleanup refusal", '{"type":"cleanup","complete":false}\n'],
  ["unexpected field", '{"type":"cleanup","complete":true,"grant":true}\n'],
  ["malformed frame", "invalid\n"],
  ["oversized frame", "x".repeat(1025)],
  ["partial frame", '{"type":"cleanup"'],
] as const)(
  "retains the exact owner after %s control input",
  async (_case, frame) => {
    const { child, owned, settled, failures, control } = await fixture();
    control.write(frame);
    // A later valid frame cannot repair an invalid transition or over-budget channel.
    confirmOwnedReceiverFixtureCleanup(owned);
    child.emit("close", 1, null);
    await settled;
    expect(hasPendingOwnedReceiver(owned)).toBe(true);
    expect(failures.length).toBeGreaterThan(0);
    await expect(stopOwnedReceiver(owned)).rejects.toThrow("retained");
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it("preserves the exact control error after otherwise successful cleanup", async () => {
  const { child, owned, settled, failures, control } = await fixture();
  const cause = new Error("owned private socket failed");
  control.emit("error", cause);
  confirmOwnedReceiverFixtureCleanup(owned);
  child.emit("close", 0, null);
  await settled;
  const failure = await stopOwnedReceiver(owned).catch(
    (error: unknown) => error,
  );
  expect((failure as AggregateError).errors).toContain(cause);
  expect(failures).toContain(cause);
  expect(hasPendingOwnedReceiver(owned)).toBe(true);
});

it("awaits output failure and releases signal listeners only after the exact callback error", async () => {
  const { withOwnedProcessReceiverSignals, writeOwnedProcessReceiverOutput } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  const signals = new EventEmitter();
  let complete!: (cause?: Error | null) => void;
  const output = Object.assign(new EventEmitter(), {
    write: vi.fn((_text: string, callback: typeof complete) => {
      complete = callback;
      return false;
    }),
  });
  const cause = new Error("owned stdout callback failure");
  const operation = withOwnedProcessReceiverSignals(
    signals,
    () => {},
    () => writeOwnedProcessReceiverOutput(output, "diagnostic\n"),
  );
  const rejected = expect(operation).rejects.toBe(cause);
  expect(signals.listenerCount("SIGTERM")).toBe(1);
  complete(cause);
  await rejected;
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(output.listenerCount("error")).toBe(0);
});

it.each(["cleanup-before-ready", "missing-channel"] as const)(
  "rejects %s without releasing the owner",
  async (mode) => {
    const control = mode === "missing-channel" ? null : new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, null, control],
      kill: vi.fn(() => true),
    });
    const owned = child as unknown as ChildProcess;
    const failures: unknown[] = [];
    const settled = registerOwnedReceiver(owned, {}, (cause) =>
      failures.push(cause),
    );
    const readiness = expect(waitOwnedReceiverReady(owned)).rejects.toThrow();
    control?.write('{"type":"cleanup","complete":true}\n');
    await readiness;
    child.emit("close", 0, null);
    await settled;
    expect(failures.length).toBeGreaterThan(0);
    expect(hasPendingOwnedReceiver(owned)).toBe(true);
    await expect(stopOwnedReceiver(owned)).rejects.toThrow("retained");
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it.each(["duplicate-cleanup", "trailing-frame"] as const)(
  "rejects %s after a cleanup receipt without releasing the owner",
  async (mode) => {
    const { child, owned, settled, control } = await fixture();
    confirmOwnedReceiverFixtureCleanup(owned);
    if (mode === "duplicate-cleanup") confirmOwnedReceiverFixtureCleanup(owned);
    else control.write("trailing");
    child.emit("close", 0, null);
    await settled;
    expect(hasPendingOwnedReceiver(owned)).toBe(true);
    await expect(stopOwnedReceiver(owned)).rejects.toThrow("retained");
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it("joins a deferred write callback after a preceding stream error within the signal lease", async () => {
  const { withOwnedProcessReceiverSignals, writeOwnedProcessReceiverOutput } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  const signals = new EventEmitter();
  let complete!: (cause?: Error | null) => void;
  const output = Object.assign(new EventEmitter(), {
    write: vi.fn((_text: string, callback: typeof complete) => {
      complete = callback;
      return false;
    }),
  });
  const cause = new Error("stream error precedes actual callback");
  let settled = false;
  const operation = withOwnedProcessReceiverSignals(
    signals,
    () => {},
    () => writeOwnedProcessReceiverOutput(output, "diagnostic\n"),
  );
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  output.emit("error", cause);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
  } finally {
    complete();
    await expect(operation).rejects.toBe(cause);
  }
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

it("waits for natural close after complete private cleanup without signalling the finished lease", async () => {
  const { child, owned, settled } = await fixture();
  confirmOwnedReceiverFixtureCleanup(owned);
  const stopping = stopOwnedReceiver(owned);
  try {
    expect(child.kill).not.toHaveBeenCalled();
  } finally {
    child.emit("close", 0, null);
    await Promise.all([settled, stopping]);
  }
  expect(hasPendingOwnedReceiver(owned)).toBe(false);
});

it("keeps receiver cancellation installed after completed output until actual process exit", async () => {
  const {
    installOwnedProcessReceiverExitSignals,
    withOwnedProcessReceiverSignals,
  } = await import("../../support/process/ownedProcessControllerResources.mjs");
  const signals = new EventEmitter();
  const cancel = vi.fn();
  installOwnedProcessReceiverExitSignals(signals, cancel);
  await withOwnedProcessReceiverSignals(signals, cancel, async () => {});
  // Parent receipt delivery and signal delivery can race after the inner lease completes.
  expect(signals.listenerCount("SIGTERM")).toBe(1);
  signals.emit("SIGTERM");
  expect(cancel).toHaveBeenCalledOnce();
  signals.emit("exit", 0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

it("preserves distinct stream and callback failures after actual write settlement", async () => {
  const { writeOwnedProcessReceiverOutput } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  let complete!: (cause?: Error | null) => void;
  const output = Object.assign(new EventEmitter(), {
    write: vi.fn((_text: string, callback: typeof complete) => {
      complete = callback;
      return false;
    }),
  });
  const streamFailure = new Error("stream failure");
  const callbackFailure = new Error("write callback failure");
  const write = writeOwnedProcessReceiverOutput(output, "diagnostic\n");
  output.emit("error", streamFailure);
  complete(callbackFailure);
  const failure = await write.catch((cause: unknown) => cause);
  expect((failure as AggregateError).errors).toEqual([
    streamFailure,
    callbackFailure,
  ]);
  expect(output.listenerCount("error")).toBe(0);
});

it("treats malformed and ready frames within one chunk as absorbing invalid state", async () => {
  vi.useFakeTimers();
  const control = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, null, control],
    kill: vi.fn(() => true),
  });
  const owned = child as unknown as ChildProcess;
  const settled = registerOwnedReceiver(owned, {}, () => {});
  const readiness = expect(waitOwnedReceiverReady(owned)).rejects.toThrow();
  control.write('invalid\n{"type":"ready"}\n');
  await readiness;
  const stopping = stopOwnedReceiver(owned);
  void stopping.catch(() => {});
  try {
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  } finally {
    child.emit("close", null, "SIGKILL");
    await settled;
    await expect(stopping).rejects.toThrow("incomplete");
    vi.useRealTimers();
  }
  expect(hasPendingOwnedReceiver(owned)).toBe(true);
});
