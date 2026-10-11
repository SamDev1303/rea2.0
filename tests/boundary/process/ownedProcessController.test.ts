import {
  ownedReceiverFixtureControl,
  confirmOwnedReceiverFixtureCleanup,
} from "../../support/process/ownedProcessReceiverFixture.js";
import {
  mkdir,
  readFile,
  symlink,
  writeFile,
  link,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import * as harness from "../../../src/process/capture/ProcessHarness.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { parse } from "@babel/parser";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { withRegularFile } from "../../../src/application/RegularFileRead.js";
import type { FileHandle } from "node:fs/promises";
import { prepareOwnedProcessController } from "../../support/process/ownedProcessController.js";
import { describeOwnedProcessTemplate } from "../../support/process/ownedProcessTemplates.mjs";
import type { OwnedProcessSelection } from "../../support/process/ownedProcessTemplates.mjs";
import { validateOwnedProcessControllerData } from "../../support/process/ownedProcessControllerProtocol.mjs";

vi.mock("node:child_process", async (original) => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, spawn: vi.fn(cp.spawn) };
});

const fixture = async () => {
  const root = await createTestTempDirectory("rea-controller-source-only-");
  const controller = await prepareOwnedProcessController({
    template: "stdin",
    root,
  });
  onTestFinished(controller.dispose);
  return { root, controller };
};

const selections: OwnedProcessSelection[] = [
  ...(
    [
      "minimal",
      "complete-report",
      "delete-create",
      "rewrite",
      "stdin",
      "printenv",
      "raw-files",
      "digest-only",
      "sample-limit",
    ] as const
  ).map((template) => ({ template, root: "/owned/root" })),
  { template: "cumulative", root: "/owned/root", shortfall: 1 },
  { template: "symlink", root: "/owned/root", target: "/owned/target" },
  { template: "choices", root: "/owned/root", truncated: true },
  {
    template: "finalization",
    root: "/owned/root",
    mode: "descendant",
    timing: "descendant",
  },
];
it.each(selections)(
  "parses fixed $template source without executing it",
  (selection) => {
    const description = describeOwnedProcessTemplate(
      selection,
      "/reviewed/node",
      "/owned/control/program.mjs",
    );
    expect(() =>
      parse(description.source, { sourceType: "module" }),
    ).not.toThrow();
    expect(description.scenario.executable).toBe("/reviewed/node");
    expect(description.roots).toContain("/owned/root");
  },
);

it("seals a fixed program, empty environment and bounded interaction without launching it", async () => {
  const { root, controller } = await fixture();
  const scenario = await validateOwnedProcessControllerData(controller.data);
  expect(scenario).toMatchObject({
    working_directory: root,
    events: [{ type: "input", at_ms: 1000, data: "\0" }],
  });
  expect(scenario).not.toHaveProperty("environment");
  expect(Object.isFrozen(controller.data.selection)).toBe(true);
  expect(await readFile(controller.data.program, "utf8")).toContain(
    "stdin-byte:",
  );
});

it("rejects generic source, argv, executable and environment selectors", () => {
  for (const field of [
    "source",
    "arguments",
    "executable",
    "environment",
    "PATH",
    "NODE_OPTIONS",
  ])
    expect(() =>
      describeOwnedProcessTemplate(
        {
          template: "stdin",
          root: "/tmp/fixture",
          [field]: "untrusted",
        } as never,
        "node",
        "program.mjs",
      ),
    ).toThrow("Unknown controller selection field");
});

it.each([
  "extra-file",
  "extra-directory",
  "symlink",
  "hardlink",
  "rewritten-program",
  "rebound-directory",
] as const)("rejects %s before maintained-service dispatch", async (mode) => {
  const { root, controller } = await fixture();
  if (mode === "extra-file") await writeFile(join(root, "unexpected"), "data");
  if (mode === "extra-directory") await mkdir(join(root, "unexpected"));
  if (mode === "symlink")
    await symlink(controller.data.program, join(root, "alias"));
  if (mode === "hardlink")
    await link(controller.data.program, join(root, "alias"));
  if (mode === "rewritten-program")
    await writeFile(controller.data.program, "process.exit(0)");
  if (mode === "rebound-directory") {
    await rm(root, { recursive: true });
    await mkdir(root, { mode: 0o700 });
  }
  await expect(
    validateOwnedProcessControllerData(controller.data),
  ).rejects.toThrow();
  if (mode === "hardlink") await rm(join(root, "alias"));
});

it("rejects a symlink root alias and a nonprivate root before any dispatch", async () => {
  const root = await createTestTempDirectory("rea-controller-alias-");
  const parent = await createTestTempDirectory("rea-controller-alias-parent-");
  await symlink(root, join(parent, "alias"));
  await expect(
    prepareOwnedProcessController({
      template: "stdin",
      root: join(parent, "alias"),
    }),
  ).rejects.toThrow("canonical");
  await mkdir(join(root, "public"), { mode: 0o755 });
  await expect(
    prepareOwnedProcessController({
      template: "stdin",
      root: join(root, "public"),
    }),
  ).rejects.toThrow("private");
});

it("keeps the fixed template denied through public MCP and leaves its mutation marker absent", async () => {
  const root = await createTestTempDirectory("rea-controller-public-denial-");
  const controller = await prepareOwnedProcessController({
    template: "choices",
    root,
    truncated: false,
  });
  onTestFinished(controller.dispose);
  const dispatch = vi
    .spyOn(harness, "captureProcessScenario")
    .mockRejectedValue(new Error("Public dispatch is forbidden"));
  onTestFinished(() => dispatch.mockRestore());
  let providers = 0;
  const session = createTestBinarySession(() => {
    providers++;
    throw new Error("No provider may execute");
  });
  onTestFinished(async () => {
    const result = await session.close();
    if (!result.ok) throw result.error;
  });
  const server = createServer(
    { kind: "session", session },
    { environment: {}, logger: silentLogger },
  );
  onTestFinished(() => server.close());
  const client = new Client({ name: "controller-public-denial", version: "1" });
  onTestFinished(() => client.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: "capture_process_scenario",
    arguments: await validateOwnedProcessControllerData(controller.data),
  });
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain("capability_unavailable");
  expect(providers).toBe(0);
  expect(dispatch).not.toHaveBeenCalled();
  await expect(readFile(join(root, "state"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps typed cleanup failure and its exact owner when an owned readback capture is aborted", async () => {
  const { connectOwnedProcessReadback } =
    await import("../../support/process/ownedProcessController.js");
  const { ProcessCaptureError } =
    await import("../../../src/process/capture/ProcessCaptureError.js");
  const { err } = await import("../../../src/domain/result.js");
  const { controller } = await fixture();
  const readback = await connectOwnedProcessReadback();
  onTestFinished(readback.close);
  const aborted = new AbortController();
  aborted.abort(new Error("authored abort reason"));
  const original = new ProcessCaptureError("exact cleanup failure", {
    reason: "cleanup_incomplete",
    cleanupResources: ["owned_process_group"],
  });
  const capture = vi
    .spyOn(harness, "captureProcessScenario")
    .mockResolvedValueOnce(err(original));
  try {
    await expect(readback.capture(controller, aborted.signal)).rejects.toBe(
      original,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(original.cleanupResources).toEqual(["owned_process_group"]);
  } finally {
    capture.mockRestore();
  }
});

it("preserves typed cancellation observations while retaining the authored cancellation message", async () => {
  const { connectOwnedProcessReadback } =
    await import("../../support/process/ownedProcessController.js");
  const { ProcessCaptureError } =
    await import("../../../src/process/capture/ProcessCaptureError.js");
  const { err } = await import("../../../src/domain/result.js");
  const { controller } = await fixture();
  const readback = await connectOwnedProcessReadback();
  onTestFinished(readback.close);
  const aborted = new AbortController();
  aborted.abort(new Error("authored abort reason"));
  const original = new ProcessCaptureError("capture cancelled", {
    reason: "cancelled",
    userCategory: "cancelled",
    executionFailure: "observed cancellation",
  });
  const capture = vi
    .spyOn(harness, "captureProcessScenario")
    .mockResolvedValueOnce(err(original));
  try {
    const failure = await readback
      .capture(controller, aborted.signal)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessCaptureError);
    expect(failure).toMatchObject({
      message: "authored abort reason",
      reason: "cancelled",
      executionFailure: "observed cancellation",
      cleanupIncomplete: false,
    });
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      original,
      aborted.signal.reason,
    ]);
  } finally {
    capture.mockRestore();
  }
});

it.each(["failed-result", "unexpected-rejection"] as const)(
  "closes each readback capture before delivering a %s and retains failed release",
  async (mode) => {
    const { connectOwnedProcessReadback } =
      await import("../../support/process/ownedProcessController.js");
    const { ProcessCaptureError } =
      await import("../../../src/process/capture/ProcessCaptureError.js");
    const {
      ProcessCaptureResourceScope,
      ProcessCaptureLifecycleCleanupFailure,
    } = await import("../../../src/process/capture/ProcessCaptureLifecycle.js");
    const { err } = await import("../../../src/domain/result.js");
    const { controller } = await fixture();
    const readback = await connectOwnedProcessReadback();
    onTestFinished(readback.close);
    const original = new ProcessCaptureError("original capture failure");
    const capture = vi.spyOn(harness, "captureProcessScenario");
    if (mode === "failed-result") capture.mockResolvedValueOnce(err(original));
    else capture.mockRejectedValueOnce(original);
    const close = vi
      .spyOn(ProcessCaptureResourceScope.prototype, "close")
      .mockRejectedValueOnce(new Error("readback close failed"));
    try {
      const failure = await readback
        .capture(controller)
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ProcessCaptureLifecycleCleanupFailure);
      expect(close).toHaveBeenCalledTimes(1);
      const retained = failure as InstanceType<
        typeof ProcessCaptureLifecycleCleanupFailure
      >;
      expect(retained.primaryFailure).toBe(original);
      expect(retained.cleanupCause).toMatchObject({
        message: "readback close failed",
      });
      expect(retained.resources).toBe(capture.mock.calls[0]![7]);
    } finally {
      capture.mockRestore();
      close.mockRestore();
    }
  },
);

it("closes all reached MCP owners after connection setup fails and retains close failure for retry", async () => {
  const primary = new Error("synthetic connect failed");
  const cleanup = new Error("synthetic server close failed");
  const session = createTestBinarySession(() => {
    throw new Error("No provider execution");
  });
  onTestFinished(async () => {
    const result = await session.close();
    if (!result.ok) throw result.error;
  });
  const closeSession = vi.spyOn(session, "close");
  let allowClose = false;
  const server = {
    connect: vi.fn(async () => {
      throw primary;
    }),
    close: vi.fn(async () => {
      if (!allowClose) throw cleanup;
    }),
  };
  const sessionModule = await import("../../fixtures/binarySession.js");
  const serverModule = await import("../../../src/server/createServer.js");
  const sessionFactory = vi
    .spyOn(sessionModule, "createTestBinarySession")
    .mockReturnValue(session);
  const serverFactory = vi
    .spyOn(serverModule, "createServer")
    .mockReturnValue(server as unknown as ReturnType<typeof createServer>);
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  try {
    const {
      connectOwnedProcessReadback,
      retryPendingOwnedProcessReadbackSetup,
    } = await import("../../support/process/ownedProcessController.js");
    const failure = await connectOwnedProcessReadback().catch(
      (cause: unknown) => cause,
    );
    expect(tree(failure)).toContain(primary);
    expect(tree(failure)).toContain(cleanup);
    expect(closeSession).toHaveBeenCalledOnce();
    allowClose = true;
    await retryPendingOwnedProcessReadbackSetup();
    expect(server.close).toHaveBeenCalledTimes(2);
  } finally {
    allowClose = true;
    try {
      const { retryPendingOwnedProcessReadbackSetup } =
        await import("../../support/process/ownedProcessController.js");
      await retryPendingOwnedProcessReadbackSetup();
    } finally {
      sessionFactory.mockRestore();
      serverFactory.mockRestore();
    }
  }
});

it("closes the exact spawned receiver when private-pipe setup fails before return", async () => {
  const { EventEmitter } = await import("node:events");
  const childProcess = await import("node:child_process");
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, null, ownedReceiverFixtureControl()],
    kill: vi.fn(() => {
      queueMicrotask(() => {
        confirmOwnedReceiverFixtureCleanup(
          child as unknown as import("node:child_process").ChildProcess,
        );
        child.emit("close", 130, null);
      });
      return true;
    }),
  });
  const spawning = vi
    .spyOn(childProcess, "spawn")
    .mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);
  const { controller } = await fixture();
  try {
    const { spawnOwnedProcessCli, retryPendingOwnedProcessReceivers } =
      await import("../../support/process/ownedProcessController.js");
    await expect(spawnOwnedProcessCli(controller)).rejects.toThrow(
      "Missing private controller pipe",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawning).toHaveBeenCalledOnce();
    expect(spawning.mock.calls[0]?.[2]).toMatchObject({ env: {} });
    await retryPendingOwnedProcessReceivers();
    expect(child.kill).toHaveBeenCalledTimes(1);
  } finally {
    spawning.mockRestore();
  }
});

it("retains the unreturned receiver and all actual kill retry failures", async () => {
  const { EventEmitter } = await import("node:events");
  const cp = await import("node:child_process");
  const faults = [new Error("kill one"), new Error("kill two")];
  let allowed = false;
  let index = 0;
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, null, ownedReceiverFixtureControl()],
    kill: vi.fn(() => {
      if (!allowed) throw faults[index++];
      queueMicrotask(() => {
        confirmOwnedReceiverFixtureCleanup(
          child as unknown as import("node:child_process").ChildProcess,
        );
        child.emit("close", 130, null);
      });
      return true;
    }),
  });
  const spawning = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ReturnType<typeof cp.spawn>);
  const { controller } = await fixture();
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  const { spawnOwnedProcessCli, retryPendingOwnedProcessReceivers } =
    await import("../../support/process/ownedProcessController.js");
  try {
    const first = await spawnOwnedProcessCli(controller).catch(
      (cause: unknown) => cause,
    );
    expect(tree(first)).toContain(faults[0]);
    expect(
      tree(first).some(
        (x) =>
          x instanceof Error && x.message === "Missing private controller pipe",
      ),
    ).toBe(true);
    const second = await retryPendingOwnedProcessReceivers().catch(
      (cause: unknown) => cause,
    );
    for (const fault of faults) expect(tree(second)).toContain(fault);
    expect(
      tree(second).some(
        (x) =>
          x instanceof Error && x.message === "Missing private controller pipe",
      ),
    ).toBe(true);
  } finally {
    allowed = true;
    await retryPendingOwnedProcessReceivers();
    spawning.mockRestore();
  }
});

it("detaches failed kill listeners before a retry emits error", async () => {
  const { EventEmitter } = await import("node:events");
  const cp = await import("node:child_process");
  const initial = new Error("kill throws");
  const retry = new Error("retry emits error");
  let phase = 0;
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, null, null, ownedReceiverFixtureControl()],
    kill: vi.fn(() => {
      if (phase === 0) throw initial;
      if (phase === 1) queueMicrotask(() => child.emit("error", retry));
      else
        queueMicrotask(() => {
          confirmOwnedReceiverFixtureCleanup(
            child as unknown as import("node:child_process").ChildProcess,
          );
          child.emit("close", 130, null);
        });
      return true;
    }),
  });
  const spawning = vi
    .spyOn(cp, "spawn")
    .mockReturnValue(child as unknown as ReturnType<typeof cp.spawn>);
  const { controller } = await fixture();
  const { spawnOwnedProcessCli, retryPendingOwnedProcessReceivers } =
    await import("../../support/process/ownedProcessController.js");
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  try {
    const first = await spawnOwnedProcessCli(controller).catch(
      (cause: unknown) => cause,
    );
    expect(tree(first)).toContain(initial);
    const firstListeners = child.listenerCount("error");
    phase = 1;
    const second = await retryPendingOwnedProcessReceivers().catch(
      (cause: unknown) => cause,
    );
    expect(tree(second)).toContain(initial);
    expect(tree(second)).toContain(retry);
    // The one standing owner listener remains; per-attempt listeners are gone.
    expect(firstListeners).toBe(1);
    expect(child.listenerCount("error")).toBe(1);
  } finally {
    phase = 2;
    await retryPendingOwnedProcessReceivers();
    expect(child.listenerCount("error")).toBe(0);
    spawning.mockRestore();
  }
});

it("retains the enclosing carrier when subordinate controller disposal fails", async () => {
  const { controller } = await fixture();
  const primary = new Error("authored input read failed");
  const faults = Array.from(
    { length: 4 },
    (_, index) => new Error(`descriptor close ${index}`),
  );
  let allowed = false;
  let attempt = 0;
  let handle: FileHandle | undefined;
  await controller.inputs
    .run(() =>
      withRegularFile(controller.data.program, async (opened) => {
        handle = opened;
        const close = opened.close.bind(opened);
        vi.spyOn(opened, "close").mockImplementation(async () => {
          if (!allowed) throw faults[attempt++];
          await close();
        });
        throw primary;
      }),
    )
    .catch(() => {});
  const controllerModule =
    await import("../../support/process/ownedProcessController.js");
  const recovery = (controllerModule as unknown as Record<string, unknown>)
    .retryPendingOwnedProcessControllers;
  const tree = (value: unknown): unknown[] =>
    value instanceof AggregateError
      ? [value, ...value.errors.flatMap(tree)]
      : value instanceof Error && value.cause !== undefined
        ? [value, ...tree(value.cause)]
        : [value];
  try {
    const first = await controller.dispose().catch((cause: unknown) => cause);
    expect(tree(first)).toContain(primary);
    for (const fault of faults.slice(0, 3))
      expect(tree(first)).toContain(fault);
    expect(handle!.fd).toBeGreaterThanOrEqual(0);
    expect(await readFile(controller.data.program, "utf8")).toContain(
      "stdin-byte:",
    );
    expect(
      recovery,
      "the exact enclosing controller has a strong global recovery route",
    ).toBeTypeOf("function");
    const retry = recovery as () => Promise<void>;
    const second = await retry().catch((cause: unknown) => cause);
    expect(tree(second)).toContain(primary);
    for (const fault of faults) expect(tree(second)).toContain(fault);
    expect(handle!.fd).toBeGreaterThanOrEqual(0);
    expect(await readFile(controller.data.program, "utf8")).toContain(
      "stdin-byte:",
    );
    allowed = true;
    await retry();
    await expect(readFile(controller.data.program)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(controller.data.control_root, "scenario.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await retry();
  } finally {
    allowed = true;
    await controller.dispose();
    if (handle !== undefined) expect(handle.fd).toBe(-1);
  }
});
