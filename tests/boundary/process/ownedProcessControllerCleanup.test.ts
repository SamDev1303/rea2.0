import {
  open,
  writeFile,
  realpath,
  chmod,
  mkdtemp,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ownedFileIdentity } from "../../support/process/ownedProcessControllerProtocol.mjs";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: vi.fn(fs.open),
    realpath: vi.fn(fs.realpath),
    chmod: vi.fn(fs.chmod),
    mkdtemp: vi.fn(fs.mkdtemp),
    rmdir: vi.fn(fs.rmdir),
  };
});

it("retains a real controller hashing handle and its original failure after close fails", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const path = join(
    await createTestTempDirectory("rea-controller-close-"),
    "seed",
  );
  await writeFile(path, "fixture");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let allowClose = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "read").mockRejectedValue(
      new Error("controller hash read failed"),
    );
    vi.spyOn(opened, "close").mockImplementation(async () => {
      if (!allowClose) throw new Error("controller close failed");
      await close();
    });
    return opened;
  });
  let failure: unknown;
  try {
    failure = await ownedFileIdentity(path).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      name: "OwnedProcessControllerCleanupFailure",
    });
    const retained = failure as Error & {
      owner: { handle: object };
      resources: { close(): Promise<void> };
    };
    expect(retained.owner.handle).toBe(handle);
    expect(handle!.fd).toBeGreaterThanOrEqual(0);
    expect(retained.cause).toBeInstanceOf(AggregateError);
    expect((retained.cause as AggregateError).errors).toMatchObject([
      { message: "controller hash read failed" },
      { message: "controller close failed" },
    ]);
    expect(JSON.stringify(retained)).not.toContain('"fd"');
    await expect(retained.resources.close()).rejects.toBeInstanceOf(Error);
  } finally {
    allowClose = true;
    if (
      failure !== null &&
      typeof failure === "object" &&
      "resources" in failure
    )
      await (failure.resources as { close(): Promise<void> }).close();
    else await handle?.close();
    vi.mocked(open).mockReset();
    expect(handle!.fd).toBe(-1);
  }
});

it("waits for an admitted controller read before closing and refuses later acquisition", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(open).mockImplementation(fs.open);
  const { OwnedProcessControllerResources } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  const resources = new OwnedProcessControllerResources();
  const path = join(
    await createTestTempDirectory("rea-controller-drain-"),
    "seed",
  );
  await writeFile(path, "fixture");
  let release: (() => void) | undefined;
  let admitted: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const reading = resources.withFile(path, 0, async (opened) => {
    handle = opened;
    admitted!();
    await hold;
    return "completed";
  });
  await entered;
  let closed = false;
  const first = resources.close().then(() => {
    closed = true;
  });
  const second = resources.close();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(handle!.fd).toBeGreaterThanOrEqual(0);
  await expect(resources.withFile(path, 0, async () => "late")).rejects.toThrow(
    "scope is closed",
  );
  release!();
  expect(await reading).toBe("completed");
  await Promise.all([first, second]);
  expect(handle!.fd).toBe(-1);
  vi.mocked(open).mockReset();
});

it("gives cleanup failure precedence over expected receiver cancellation", async () => {
  const { ownedProcessReceiverExitCode } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  expect(
    ownedProcessReceiverExitCode(
      { error: "Process command failed", code: "cleanup_incomplete" },
      true,
      false,
    ),
  ).toBe(1);
  expect(
    ownedProcessReceiverExitCode(
      { error: "Process command failed", code: "cancelled" },
      true,
      true,
    ),
  ).toBe(1);
  expect(
    ownedProcessReceiverExitCode(
      { error: "Process command failed", code: "cancelled" },
      true,
      false,
    ),
  ).toBe(130);
  expect(
    ownedProcessReceiverExitCode(
      { predicate_type: "rea.process-capture" },
      false,
      false,
    ),
  ).toBe(0);
});

it("retains completed receiver output and every shutdown failure in a typed projection", async () => {
  const { OwnedProcessReceiverShutdownFailure } =
    await import("../../support/process/ownedProcessControllerResources.mjs");
  const result = {
    predicate_type: "rea.process-capture",
    normalized_result: { retained: "capture" },
  };
  const one = new Error("input close failed");
  const two = new Error("capture close failed");
  const failure = new OwnedProcessReceiverShutdownFailure(
    { result, primaryFailure: undefined },
    [one, two],
  );
  expect(failure.outcome.result).toBe(result);
  expect((failure.cause as AggregateError).errors).toEqual([one, two]);
  expect(failure.project()).toMatchObject({
    code: "cleanup_incomplete",
    details: { cleanup: "incomplete", original_output: result },
  });
  expect(JSON.stringify(failure)).not.toContain("normalized_result");
});

it.each(["realpath", "chmod"] as const)(
  "owns carrier cleanup before failing %s setup",
  async (step) => {
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const root = await createTestTempDirectory("rea-carrier-setup-");
    const failure = new Error(`carrier ${step} failed`);
    let carrier: string | undefined;
    vi.mocked(mkdtemp).mockImplementation(async (...args) => {
      const path = await fs.mkdtemp(...args);
      carrier = String(path);
      return path;
    });
    vi.mocked(realpath).mockImplementation(async (...args) => {
      if (
        step === "realpath" &&
        String(args[0]).includes("rea-owned-process-controller-")
      )
        throw failure;
      return fs.realpath(...args);
    });
    vi.mocked(chmod).mockImplementation(async (...args) => {
      if (
        step === "chmod" &&
        String(args[0]).includes("rea-owned-process-controller-")
      )
        throw failure;
      return fs.chmod(...args);
    });
    try {
      const { prepareOwnedProcessController } =
        await import("../../support/process/ownedProcessController.js");
      await expect(
        prepareOwnedProcessController({ template: "minimal", root }),
      ).rejects.toBe(failure);
      expect(carrier).toBeDefined();
      await expect(fs.lstat(carrier!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.mocked(mkdtemp).mockImplementation(fs.mkdtemp);
      vi.mocked(realpath).mockImplementation(fs.realpath);
      vi.mocked(chmod).mockImplementation(fs.chmod);
      if (carrier) await fs.rm(carrier, { recursive: true, force: true });
    }
  },
);

it("retains the exact carrier after setup and repeated directory-close failures", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await createTestTempDirectory("rea-carrier-retry-");
  const primary = new Error("carrier chmod failed");
  const cleanup = [new Error("rmdir one"), new Error("rmdir two")];
  let index = 0;
  let allowed = false;
  vi.mocked(chmod).mockImplementation(async (...args) => {
    if (String(args[0]).includes("rea-owned-process-controller-"))
      throw primary;
    return fs.chmod(...args);
  });
  vi.mocked(rmdir).mockImplementation(async (...args) => {
    if (!allowed && String(args[0]).includes("rea-owned-process-controller-"))
      throw cleanup[index++];
    return fs.rmdir(...args);
  });
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  let failure: unknown;
  try {
    const { prepareOwnedProcessController } =
      await import("../../support/process/ownedProcessController.js");
    const { OwnedProcessCarrierCleanupFailure } =
      await import("../../support/process/ownedProcessControllerResources.mjs");
    failure = await prepareOwnedProcessController({
      template: "minimal",
      root,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OwnedProcessCarrierCleanupFailure);
    if (!(failure instanceof OwnedProcessCarrierCleanupFailure))
      throw new Error("Carrier owner lost");
    expect(tree(failure.cause)).toContain(primary);
    expect(tree(failure.cause)).toContain(cleanup[0]);
    expect((await fs.lstat(failure.carrier.path)).isDirectory()).toBe(true);
    const { retryPendingOwnedProcessCarrierCleanup } =
      await import("../../support/process/ownedProcessControllerResources.mjs");
    const retried = await retryPendingOwnedProcessCarrierCleanup().catch(
      (cause: unknown) => cause,
    );
    expect(tree(retried)).toContain(primary);
    for (const cause of cleanup) expect(tree(retried)).toContain(cause);
    allowed = true;
    await failure.carrier.close();
    await expect(fs.lstat(failure.carrier.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    allowed = true;
    vi.mocked(chmod).mockImplementation(fs.chmod);
    vi.mocked(rmdir).mockImplementation(fs.rmdir);
    const { retryPendingOwnedProcessCarrierCleanup } =
      await import("../../support/process/ownedProcessControllerResources.mjs");
    await retryPendingOwnedProcessCarrierCleanup();
  }
});
