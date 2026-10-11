import { open as fsOpen, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  captureProcessScenarioFile,
  projectProcessCliError,
} from "../../../src/application/process/ProcessCli.js";
import {
  ProcessCliInputCleanupFailure,
  ProcessCliInputResources,
  retryPendingProcessCliInputCleanup,
} from "../../../src/application/process/ProcessCliInputResources.js";
import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});
vi.mock("../../../src/process/capture/ProcessHarness.js", () => ({
  captureProcessScenario: vi.fn(() => {
    throw new Error("No target dispatch allowed");
  }),
}));
afterEach(async () => {
  vi.mocked(fsOpen).mockReset();
  vi.mocked(captureProcessScenario).mockClear();
  await retryPendingProcessCliInputCleanup();
});

it("preserves a real failed scenario descriptor and original JSON failure before projection", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-process-cli-close-"),
    "scenario.json",
  );
  await writeFile(path, "{ malformed JSON");
  let allowClose = false;
  let failure: unknown;
  const attempts: object[] = [];
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.mocked(fsOpen).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    if (String(args[0]) !== path) return opened;
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "close").mockImplementation(async () => {
      attempts.push(opened);
      if (!allowClose) throw new Error("synthetic descriptor close blocked");
      await close();
    });
    return opened;
  });
  try {
    failure = await captureProcessScenarioFile(path, {}).then(
      (value) => value,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ cleanupIncomplete: true });
    expect(failure).toBeInstanceOf(ProcessCliInputCleanupFailure);
    if (!(failure instanceof ProcessCliInputCleanupFailure))
      throw new Error("Owner lost");
    expect(failure.inputFailure.owner.handle).toBe(handle);
    expect(handle!.fd).toBeGreaterThanOrEqual(0);
    expect(attempts).toEqual([handle, handle]);
    expect(failure.cause).toBeInstanceOf(AggregateError);
    expect((failure.cause as AggregateError).errors.slice(0, 2)).toMatchObject([
      { _tag: "AnalysisInputError", issues: [{ reason: "invalid_format" }] },
      { message: "synthetic descriptor close blocked" },
    ]);
    expect(projectProcessCliError(failure)).toMatchObject({
      category: "invalid_input",
      code: "cleanup_incomplete",
      message: expect.stringContaining("Descriptor close failed"),
      details: {
        cleanup: "incomplete",
        resources: [path],
        execution_failure: "invalid_request",
      },
    });
    expect(JSON.stringify(failure)).not.toContain("inputFailure");
    expect(JSON.stringify(failure)).not.toContain('"fd"');
    expect(captureProcessScenario).not.toHaveBeenCalled();
    await expect(failure.resources.close()).rejects.toBeInstanceOf(
      ProcessCliInputCleanupFailure,
    );
    expect(attempts).toEqual([handle, handle, handle]);
  } finally {
    allowClose = true;
    if (failure instanceof ProcessCliInputCleanupFailure)
      await failure.resources.close();
    else await handle?.close();
    expect(handle?.fd).toBe(-1);
  }
});

it("reports the original close failure after a confirmed retry without dispatch", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-process-cli-retry-"),
    "scenario.json",
  );
  await writeFile(path, "{ malformed JSON");
  const resources = new ProcessCliInputResources();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let attempts = 0;
  vi.mocked(fsOpen).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    if (String(args[0]) !== path) return opened;
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "close").mockImplementation(async () => {
      if (++attempts === 1) throw new Error("first close failed");
      await close();
    });
    return opened;
  });
  try {
    const failure = await captureProcessScenarioFile(
      path,
      {},
      undefined,
      resources,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessCliInputCleanupFailure);
    expect(failure).toMatchObject({
      cleanupIncomplete: false,
      userMessage: expect.stringContaining(
        "Cleanup was subsequently confirmed",
      ),
    });
    expect(attempts).toBe(2);
    expect(handle!.fd).toBe(-1);
    expect(captureProcessScenario).not.toHaveBeenCalled();
  } finally {
    await resources.close();
  }
});

it("waits for an admitted scenario read while closing and refuses later reads", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-process-cli-inflight-"),
    "scenario.json",
  );
  await writeFile(path, "{ malformed JSON");
  const resources = new ProcessCliInputResources();
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(fsOpen).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    if (String(args[0]) !== path) return opened;
    const read = opened.read.bind(opened);
    vi.spyOn(opened, "read").mockImplementation(
      async (...readArgs: Parameters<typeof opened.read>) => {
        began();
        await gate;
        return read(...readArgs);
      },
    );
    return opened;
  });
  const operation = captureProcessScenarioFile(path, {}, undefined, resources);
  await started;
  let closed = false;
  const closing = resources.close().then(() => {
    closed = true;
  });
  try {
    await expect(resources.run(() => Promise.resolve("late"))).rejects.toThrow(
      "Artifact resource scope is closed",
    );
    expect(closed).toBe(false);
    release();
    expect(await operation).toMatchObject({ category: "invalid_input" });
    await closing;
    expect(closed).toBe(true);
    expect(captureProcessScenario).not.toHaveBeenCalled();
  } finally {
    release();
    await operation;
    await resources.close();
  }
});

it("stops a valid scenario before target dispatch when its descriptor cannot close", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-process-cli-valid-close-"),
    "scenario.json",
  );
  await writeFile(
    path,
    JSON.stringify({ executable: process.execPath, args: [] }),
  );
  let allow = false;
  let failure: unknown;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.mocked(fsOpen).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    if (String(args[0]) !== path) return opened;
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "close").mockImplementation(async () => {
      if (!allow) throw new Error("valid input descriptor still owned");
      await close();
    });
    return opened;
  });
  try {
    failure = await captureProcessScenarioFile(path, {}).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProcessCliInputCleanupFailure);
    expect(projectProcessCliError(failure)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [path] },
    });
    expect(captureProcessScenario).not.toHaveBeenCalled();
  } finally {
    allow = true;
    if (failure instanceof ProcessCliInputCleanupFailure)
      await failure.resources.close();
    else await handle?.close();
  }
});

it("preserves distinct actual failure objects through every input-close retry", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-input-retry-causes-"),
    "scenario.json",
  );
  await writeFile(path, "{ malformed JSON");
  const faults = [
    new Error("initial close"),
    new Error("first retry"),
    new Error("second retry"),
    new Error("third retry"),
  ];
  let allowClose = false;
  let index = 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.mocked(fsOpen).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    if (String(args[0]) !== path) return opened;
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "close").mockImplementation(async () => {
      if (!allowClose) throw faults[index++];
      await close();
    });
    return opened;
  });
  const tree = (value: unknown): unknown[] =>
    value instanceof AggregateError
      ? [value, ...value.errors.flatMap(tree)]
      : value instanceof Error && value.cause !== undefined
        ? [value, ...tree(value.cause)]
        : [value];
  let failure: unknown;
  try {
    failure = await captureProcessScenarioFile(path, {}).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProcessCliInputCleanupFailure);
    if (!(failure instanceof ProcessCliInputCleanupFailure))
      throw new Error("Owner missing");
    expect(tree(failure.cause)).toContain(faults[0]);
    expect(tree(failure.cause)).toContain(faults[1]);
    const two = await failure.resources
      .close()
      .catch((cause: unknown) => cause);
    const three = await failure.resources
      .close()
      .catch((cause: unknown) => cause);
    expect(two).toBeInstanceOf(ProcessCliInputCleanupFailure);
    expect(three).toBeInstanceOf(ProcessCliInputCleanupFailure);
    for (const fault of faults)
      expect(tree((three as Error).cause)).toContain(fault);
    expect(projectProcessCliError(three)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [path] },
    });
    expect(captureProcessScenario).not.toHaveBeenCalled();
  } finally {
    allowClose = true;
    if (failure instanceof ProcessCliInputCleanupFailure)
      await failure.resources.close();
    else await handle?.close();
    expect(handle?.fd).toBe(-1);
  }
});
