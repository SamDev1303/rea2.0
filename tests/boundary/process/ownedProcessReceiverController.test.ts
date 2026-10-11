import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import * as cp from "node:child_process";
import {
  prepareOwnedProcessController,
  spawnOwnedProcessCli,
  settleOwnedProcessCliReceiver,
  retryPendingOwnedProcessControllers,
} from "../../support/process/ownedProcessController.js";
import { OwnedProcessCarrier } from "../../support/process/ownedProcessControllerResources.mjs";
import {
  ownedReceiverFixtureControl,
  confirmOwnedReceiverFixtureCleanup,
} from "../../support/process/ownedProcessReceiverFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error("No real fixture child may spawn");
    }),
  };
});
const tree = (value: unknown): unknown[] =>
  value instanceof AggregateError
    ? [value, ...value.errors.flatMap(tree)]
    : value instanceof Error && value.cause !== undefined
      ? [value, ...tree(value.cause)]
      : [value];
const controllerFixture = async () => {
  const root = await createTestTempDirectory("rea-receiver-controller-");
  return prepareOwnedProcessController({ template: "stdin", root });
};

it("retains the enclosing controller after automatic forced close before explicit disposal", async () => {
  const controller = await controllerFixture();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, new PassThrough(), ownedReceiverFixtureControl()],
    kill: vi.fn(() => true),
  });
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  vi.useFakeTimers();
  try {
    await spawnOwnedProcessCli(controller);
    await vi.advanceTimersByTimeAsync(30000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(10000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
    child.emit("close", 0, null);
    await expect(retryPendingOwnedProcessControllers()).rejects.toThrow(
      "retained",
    );
    const failure = await controller.dispose().catch((cause: unknown) => cause);
    expect(tree(failure)).toContainEqual({ code: 0, signal: null });
    expect(await readFile(controller.data.program, "utf8")).toContain(
      "stdin-byte:",
    );
    await expect(controller.dispose()).rejects.toThrow("incomplete");
  } finally {
    child.emit("close", 0, null);
    spawn.mockRestore();
    vi.useRealTimers();
    // This child is an inert EventEmitter: no OS process ever existed. Delete only
    // this test's authored files after proving the controller refused cleanup.
    await rm(controller.data.control_root, { recursive: true, force: true });
  }
});

it("retains an asynchronous private-pipe failure despite confirmed cooperative close", async () => {
  const controller = await controllerFixture();
  onTestFinished(controller.dispose);
  const pipe = new PassThrough();
  const primary = new Error("exact async FD3 operation failure");
  const cleanup = new Error("exact independent carrier removal failure");
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, pipe, ownedReceiverFixtureControl()],
    kill: vi.fn(() => {
      queueMicrotask(() => {
        confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
        child.emit("close", 130, null);
      });
      return true;
    }),
  });
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  onTestFinished(() => {
    spawn.mockRestore();
  });
  await spawnOwnedProcessCli(controller);
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  pipe.emit("error", primary);
  await closed;
  const actualClose = OwnedProcessCarrier.prototype.close;
  let allow = false;
  const removal = vi
    .spyOn(OwnedProcessCarrier.prototype, "close")
    .mockImplementation(async function (this: OwnedProcessCarrier) {
      if (!allow && this.path === controller.data.control_root) throw cleanup;
      return actualClose.call(this);
    });
  try {
    const failure = await controller.dispose().catch((cause: unknown) => cause);
    expect(tree(failure)).toContain(primary);
    expect(tree(failure)).toContain(cleanup);
  } finally {
    allow = true;
    await controller.dispose();
    removal.mockRestore();
  }
});

it("waits for early receiver readiness before cooperative startup cancellation", async () => {
  const controller = await controllerFixture();
  onTestFinished(controller.dispose);
  const control = new PassThrough();
  let started!: () => void;
  const spawned = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signalled!: () => void;
  const signalling = new Promise<void>((resolve) => {
    signalled = resolve;
  });
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, new PassThrough(), control],
    kill: vi.fn(() => {
      signalled();
      return true;
    }),
  });
  const spawn = vi.spyOn(cp, "spawn").mockImplementation(() => {
    started();
    return child as unknown as ChildProcess;
  });
  onTestFinished(() => {
    spawn.mockRestore();
  });
  const pending = spawnOwnedProcessCli(controller);
  void pending.catch(() => {});
  await spawned;
  const disposal = controller.dispose();
  void disposal.catch(() => {});
  try {
    expect(child.kill).not.toHaveBeenCalled();
    control.write('{"type":"ready"}\n');
    await signalling;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  } finally {
    confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
    child.emit("close", 130, null);
    await Promise.allSettled([pending]);
    await disposal;
  }
});

const observedReceiverFixture = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const pipe = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdio: [null, stdout, stderr, pipe, ownedReceiverFixtureControl()],
    kill: vi.fn(() => {
      queueMicrotask(() => {
        confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
        child.emit("close", 130, null);
      });
      return true;
    }),
  });
  return { child, stdout, stderr, pipe };
};

it("registers controller-authored output observers and drains both streams before dispatch", async () => {
  const controller = await controllerFixture();
  const { child, stdout, stderr, pipe } = observedReceiverFixture();
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  let observerEntered = false;
  let out = "";
  let progress = "";
  const end = vi.spyOn(pipe, "end").mockImplementation(() => {
    expect(observerEntered).toBe(true);
    expect(stdout.readableFlowing).toBe(true);
    expect(stderr.readableFlowing).toBe(true);
    stdout.write("literal owned result");
    stderr.write("literal owned progress");
    return pipe;
  });
  try {
    await spawnOwnedProcessCli(controller, (receiver) => {
      observerEntered = true;
      expect(end).not.toHaveBeenCalled();
      receiver.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      receiver.stderr!.on("data", (chunk: Buffer) => {
        progress += chunk.toString();
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(out).toBe("literal owned result");
    expect(progress).toBe("literal owned progress");
  } finally {
    confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
    child.emit("close", 0, null);
    await controller.dispose();
    spawn.mockRestore();
    end.mockRestore();
  }
});

it("retains observer failure through shutdown and drains pipes without target dispatch", async () => {
  const controller = await controllerFixture();
  const { child, stdout, stderr, pipe } = observedReceiverFixture();
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  const end = vi.spyOn(pipe, "end");
  const primary = new Error("controller observer failed");
  const cleanup = new Error("independent carrier cleanup failed");
  const originalClose = OwnedProcessCarrier.prototype.close;
  const close = vi
    .spyOn(OwnedProcessCarrier.prototype, "close")
    .mockRejectedValue(cleanup);
  try {
    await expect(
      spawnOwnedProcessCli(controller, () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(end).not.toHaveBeenCalled();
    expect(stdout.readableFlowing).toBe(true);
    expect(stderr.readableFlowing).toBe(true);
    const failure = await controller.dispose().catch((cause: unknown) => cause);
    expect(tree(failure)).toContain(primary);
    expect(tree(failure)).toContain(cleanup);
  } finally {
    close.mockImplementation(originalClose);
    await controller.dispose();
    close.mockRestore();
    spawn.mockRestore();
    end.mockRestore();
  }
});

it("rechecks shutdown requested synchronously by the observer before dispatch", async () => {
  const controller = await controllerFixture();
  const { child, pipe } = observedReceiverFixture();
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  const end = vi.spyOn(pipe, "end");
  let disposal!: Promise<void>;
  try {
    await expect(
      spawnOwnedProcessCli(controller, () => {
        disposal = controller.dispose();
        void disposal.catch(() => {});
      }),
    ).rejects.toThrow("closing");
    expect(end).not.toHaveBeenCalled();
    await disposal;
  } finally {
    confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
    child.emit("close", 130, null);
    await controller.dispose();
    spawn.mockRestore();
    end.mockRestore();
  }
});

it("routes observation teardown through cooperative ownership before awaiting receiver close", async () => {
  const controller = await controllerFixture();
  const { child } = observedReceiverFixture();
  Object.assign(child, { exitCode: null, signalCode: null });
  child.kill.mockImplementation((signal?: string | number) => {
    queueMicrotask(() => {
      if (signal === "SIGKILL") child.emit("close", null, "SIGKILL");
      else {
        confirmOwnedReceiverFixtureCleanup(child as unknown as ChildProcess);
        child.emit("close", 130, null);
      }
    });
    return true;
  });
  const spawn = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ChildProcess);
  let closed!: Promise<void>;
  await spawnOwnedProcessCli(controller, (receiver) => {
    closed = new Promise((resolve, reject) => {
      receiver.once("error", reject);
      receiver.once("close", () => resolve());
    });
    void closed.catch(() => {});
  });
  const teardown = () => settleOwnedProcessCliReceiver(controller, closed);
  try {
    await teardown();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  } finally {
    const cleanup = await controller.dispose().catch((cause: unknown) => cause);
    if (cleanup !== undefined) {
      // Only an inert EventEmitter can remain here; no OS receiver/target was spawned.
      // Remove authored disk evidence without claiming the uncertain owner became clean.
      await rm(controller.data.control_root, { recursive: true, force: true });
    }
    spawn.mockRestore();
  }
});
