import {
  ownedReceiverFixtureControl,
  confirmOwnedReceiverFixtureCleanup,
} from "../../support/process/ownedProcessReceiverFixture.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { OwnedProcessLifetime } from "../../support/process/ownedProcessLifetime.js";
import {
  prepareOwnedProcessController,
  captureOwnedProcessCli,
  connectOwnedProcessReadback,
} from "../../support/process/ownedProcessController.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import * as harness from "../../../src/process/capture/ProcessHarness.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { err } from "../../../src/domain/result.js";

vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, spawn: vi.fn(cp.spawn) };
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it("registers a producer before its first callback and coalesces settlement", async () => {
  const lifetime = new OwnedProcessLifetime();
  const gate = deferred<void>();
  let started = false;
  const primary = new Error("exact producer rejection");
  const task = lifetime.run(async () => {
    started = true;
    await gate.promise;
    throw primary;
  });
  const closing = lifetime.settle();
  expect(lifetime.settle()).toBe(closing);
  expect(started).toBe(false);
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(started).toBe(true);
  expect(settled).toBe(false);
  await expect(lifetime.run(async () => undefined)).rejects.toThrow("closing");
  gate.resolve();
  await expect(task).rejects.toBe(primary);
  await closing;
  expect(lifetime.failures).toEqual([primary]);
});

it.each(["direct", "readback"] as const)(
  "holds %s carrier and scopes until an already-admitted producer settles",
  async (route) => {
    const root = await createTestTempDirectory("rea-producer-lifetime-");
    const readback = await connectOwnedProcessReadback();
    onTestFinished(readback.close);
    const controller = await prepareOwnedProcessController({
      template: "stdin",
      root,
    });
    onTestFinished(controller.dispose);
    const admitted = deferred<void>();
    const gate = deferred<void>();
    const failure = new ProcessCaptureError(
      "authored synthetic deferred failure",
    );
    const capturing = vi
      .spyOn(harness, "captureProcessScenario")
      .mockImplementation(async () => {
        admitted.resolve();
        await gate.promise;
        return err(failure);
      });
    onTestFinished(() => {
      capturing.mockRestore();
    });
    const releasing = vi.spyOn(ProcessCaptureResourceScope.prototype, "close");
    onTestFinished(() => {
      releasing.mockRestore();
    });
    const task =
      route === "direct"
        ? captureOwnedProcessCli(controller)
        : readback.capture(controller);
    // Register rejection observation immediately, leaving the original promise intact.
    void task.catch(() => {});
    await admitted.promise;
    let controllerReleased = false;
    let readbackReleased = false;
    const disposal = controller.dispose();
    expect(controller.dispose()).toBe(disposal);
    void disposal.then(
      () => {
        controllerReleased = true;
      },
      () => {},
    );
    const readbackClose =
      route === "readback" ? readback.close() : Promise.resolve();
    void readbackClose.then(
      () => {
        readbackReleased = true;
      },
      () => {},
    );
    try {
      await Promise.resolve();
      expect(releasing).not.toHaveBeenCalled();
      expect(controllerReleased).toBe(false);
      if (route === "readback") {
        expect(readbackReleased).toBe(false);
        expect(readback.close()).toBe(readbackClose);
      }
      expect(await readFile(controller.data.program, "utf8")).toContain(
        "stdin-byte:",
      );
    } finally {
      gate.resolve();
      await Promise.allSettled([task]);
      await Promise.all([disposal, readbackClose]);
    }
    expect(controllerReleased).toBe(true);
    expect(releasing).toHaveBeenCalled();
    await expect(readFile(controller.data.program)).rejects.toThrow("ENOENT");
    if (route === "readback") await expect(task).rejects.toBe(failure);
    else
      expect(await task).toMatchObject({
        error: "Process command failed",
        message: failure.userMessage,
      });
  },
);

it("settles an admission still in flight without releasing dependencies or dispatching a target", async () => {
  const root = await createTestTempDirectory("rea-producer-admission-");
  const controller = await prepareOwnedProcessController({
    template: "stdin",
    root,
  });
  onTestFinished(controller.dispose);
  const capturing = vi.spyOn(harness, "captureProcessScenario");
  onTestFinished(() => {
    capturing.mockRestore();
  });
  const pending = captureOwnedProcessCli(controller);
  void pending.catch(() => {});
  const disposal = controller.dispose();
  await expect(pending).rejects.toThrow("closing");
  await disposal;
  expect(capturing).not.toHaveBeenCalled();
  await expect(readFile(controller.data.program)).rejects.toThrow("ENOENT");
});

it("closes client before server before session and continues after independent failures", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { EvidenceMcpServer } =
    await import("../../../src/server/EvidenceMcpServer.js");
  const { BinarySession } =
    await import("../../../src/application/binary/BinarySession.js");
  const actualClient = Client.prototype.close;
  const actualServer = EvidenceMcpServer.prototype.close;
  const actualSession = BinarySession.prototype.close;
  const gate = deferred<void>();
  const entered = deferred<void>();
  const events: string[] = [];
  const primary = new Error("owned client close failed after release");
  let fail = true;
  const clientClose = vi
    .spyOn(Client.prototype, "close")
    .mockImplementation(async function (this: InstanceType<typeof Client>) {
      events.push("client-start");
      entered.resolve();
      await gate.promise;
      await actualClient.call(this);
      events.push("client-settled");
      if (fail) throw primary;
    });
  onTestFinished(() => {
    clientClose.mockRestore();
  });
  const serverClose = vi
    .spyOn(EvidenceMcpServer.prototype, "close")
    .mockImplementation(async function (
      this: InstanceType<typeof EvidenceMcpServer>,
    ) {
      events.push("server");
      await actualServer.call(this);
    });
  onTestFinished(() => {
    serverClose.mockRestore();
  });
  const sessionClose = vi
    .spyOn(BinarySession.prototype, "close")
    .mockImplementation(async function (
      this: InstanceType<typeof BinarySession>,
    ) {
      events.push("session");
      return actualSession.call(this);
    });
  onTestFinished(() => {
    sessionClose.mockRestore();
  });
  const readback = await connectOwnedProcessReadback();
  onTestFinished(readback.close);
  const closing = readback.close();
  void closing.catch(() => {});
  try {
    await entered.promise;
    expect(events).toEqual(["client-start"]);
  } finally {
    gate.resolve();
  }
  await expect(closing).rejects.toBeInstanceOf(AggregateError);
  expect(events.indexOf("server")).toBeGreaterThan(
    events.indexOf("client-settled"),
  );
  expect(events.indexOf("session")).toBeGreaterThan(events.indexOf("server"));
  fail = false;
  await readback.close();
});

it("retains the receiver carrier until the exact owned child emits close", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const cp = await import("node:child_process");
  const { spawnOwnedProcessCli } =
    await import("../../support/process/ownedProcessController.js");
  const pipe = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, pipe, ownedReceiverFixtureControl()],
    kill: vi.fn(() => true),
  });
  const spawning = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ReturnType<typeof cp.spawn>);
  onTestFinished(() => {
    spawning.mockRestore();
  });
  const root = await createTestTempDirectory("rea-receiver-lifetime-");
  const controller = await prepareOwnedProcessController({
    template: "stdin",
    root,
  });
  onTestFinished(controller.dispose);
  let disposing: Promise<void> | undefined;
  try {
    expect(await spawnOwnedProcessCli(controller)).toBe(child);
    let released = false;
    disposing = controller.dispose();
    void disposing.then(
      () => {
        released = true;
      },
      () => {},
    );
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(released).toBe(false);
    expect(await readFile(controller.data.program, "utf8")).toContain(
      "stdin-byte:",
    );
  } finally {
    confirmOwnedReceiverFixtureCleanup(
      child as unknown as import("node:child_process").ChildProcess,
    );
    child.emit("close", 130, null);
    pipe.destroy();
    await disposing;
  }
  await expect(readFile(controller.data.program)).rejects.toThrow("ENOENT");
});

it.each([
  ["capture", "controller"],
  ["capture", "readback"],
  ["response", "controller"],
  ["response", "readback"],
] as const)(
  "refuses %s dispatch when %s shutdown starts during actual claim validation",
  async (route, shutdown) => {
    const root = await createTestTempDirectory("rea-readback-claim-");
    const readback = await connectOwnedProcessReadback();
    onTestFinished(readback.close);
    const controller = await prepareOwnedProcessController({
      template: "stdin",
      root,
    });
    onTestFinished(controller.dispose);
    const validating = deferred<void>();
    const gate = deferred<void>();
    const original = controller.validation.withFile.bind(controller.validation);
    controller.validation.withFile = async (...args) => {
      validating.resolve();
      await gate.promise;
      return original(...args);
    };
    const capturing = vi
      .spyOn(harness, "captureProcessScenario")
      .mockResolvedValue(
        err(new ProcessCaptureError("inert dispatch sentinel")),
      );
    onTestFinished(() => {
      capturing.mockRestore();
    });
    const task =
      route === "capture"
        ? readback.capture(controller)
        : readback.captureResponse(controller);
    void task.catch(() => {});
    await validating.promise;
    const closing =
      shutdown === "controller" ? controller.dispose() : readback.close();
    void closing.catch(() => {});
    try {
      gate.resolve();
      await expect(task).rejects.toThrow("closing");
    } finally {
      gate.resolve();
      await Promise.allSettled([task]);
      await closing;
    }
    expect(capturing).not.toHaveBeenCalled();
  },
);

it.each(["capture", "response"] as const)(
  "retains exact %s producer failure alongside independent cleanup failures",
  async (route) => {
    const root = await createTestTempDirectory("rea-readback-primary-");
    const readback = await connectOwnedProcessReadback();
    onTestFinished(readback.close);
    const controller = await prepareOwnedProcessController({
      template: "stdin",
      root,
    });
    onTestFinished(controller.dispose);
    const primary = new ProcessCaptureError("exact returned producer failure");
    const clientFailure = new Error("exact owned client cleanup fault");
    const controllerFailure = new Error("exact controller cleanup fault");
    const capturing = vi
      .spyOn(harness, "captureProcessScenario")
      .mockResolvedValue(err(primary));
    onTestFinished(() => {
      capturing.mockRestore();
    });
    if (route === "capture")
      await expect(readback.capture(controller)).rejects.toBe(primary);
    else
      expect(await readback.captureResponse(controller)).toMatchObject({
        isError: true,
      });
    let allowed = false;
    const actualClientClose = readback.client.close.bind(readback.client);
    readback.client.close = async () => {
      if (!allowed) throw clientFailure;
      await actualClientClose();
    };
    const actualValidationClose = controller.validation.close.bind(
      controller.validation,
    );
    controller.validation.close = async () => {
      if (!allowed) throw controllerFailure;
      await actualValidationClose();
    };
    const tree = (value: unknown): unknown[] =>
      value instanceof AggregateError
        ? [value, ...value.errors.flatMap(tree)]
        : value instanceof Error && value.cause !== undefined
          ? [value, ...tree(value.cause)]
          : [value];
    try {
      const readbackFailure = await readback
        .close()
        .catch((cause: unknown) => cause);
      expect(tree(readbackFailure)).toContain(primary);
      expect(tree(readbackFailure)).toContain(clientFailure);
      const carrierFailure = await controller
        .dispose()
        .catch((cause: unknown) => cause);
      expect(tree(carrierFailure)).toContain(primary);
      expect(tree(carrierFailure)).toContain(controllerFailure);
      expect(await readFile(controller.data.program, "utf8")).toContain(
        "stdin-byte:",
      );
    } finally {
      allowed = true;
      await readback.close();
      await controller.dispose();
    }
  },
);

it.each(["direct", "receiver"] as const)(
  "rechecks %s dispatch after claim is already awaiting validation",
  async (route) => {
    const cp = await import("node:child_process");
    const { spawnOwnedProcessCli } =
      await import("../../support/process/ownedProcessController.js");
    const root = await createTestTempDirectory("rea-shared-admission-");
    const controller = await prepareOwnedProcessController({
      template: "stdin",
      root,
    });
    onTestFinished(controller.dispose);
    const validating = deferred<void>();
    const gate = deferred<void>();
    const original = controller.validation.withFile.bind(controller.validation);
    controller.validation.withFile = async (...args) => {
      validating.resolve();
      await gate.promise;
      return original(...args);
    };
    const capturing = vi
      .spyOn(harness, "captureProcessScenario")
      .mockResolvedValue(
        err(new ProcessCaptureError("inert dispatch sentinel")),
      );
    onTestFinished(() => {
      capturing.mockRestore();
    });
    const spawning = vi.spyOn(cp, "spawn").mockImplementation(() => {
      throw new Error("inert spawn sentinel");
    });
    onTestFinished(() => {
      spawning.mockRestore();
    });
    const task =
      route === "direct"
        ? captureOwnedProcessCli(controller)
        : spawnOwnedProcessCli(controller);
    void task.catch(() => {});
    await validating.promise;
    const closing = controller.dispose();
    void closing.catch(() => {});
    try {
      gate.resolve();
      await expect(task).rejects.toThrow("closing");
    } finally {
      gate.resolve();
      await Promise.allSettled([task]);
      await closing;
    }
    expect(capturing).not.toHaveBeenCalled();
    expect(spawning).not.toHaveBeenCalled();
  },
);
