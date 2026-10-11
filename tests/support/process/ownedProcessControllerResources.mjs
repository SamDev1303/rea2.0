import {
  open,
  mkdtemp,
  lstat,
  realpath,
  chmod,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { ArtifactResourceScope } from "../../../dist/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../../dist/filesystem/OwnedFileHandle.js";

const pending = new Set();

/** The exact descriptor and both outcomes survive failed hashing cleanup. */
export class OwnedProcessControllerCleanupFailure extends Error {
  #owner;
  #resources;
  get owner() {
    return this.#owner;
  }
  get resources() {
    return this.#resources;
  }
  constructor(owner, resources, primary, cleanup) {
    super("Controller descriptor cleanup remains incomplete", {
      cause: new AggregateError(
        primary === undefined ? [cleanup] : [primary, cleanup],
        "Controller read and close outcomes",
      ),
    });
    this.name = "OwnedProcessControllerCleanupFailure";
    this.#owner = owner;
    this.#resources = resources;
  }
}

/** Established before carrier hashing; no source or command authority is conferred. */
export class OwnedProcessControllerResources {
  #scope = new ArtifactResourceScope();
  #failures = [];
  withFile(path, flags, read) {
    return this.#scope.run(async () => {
      const owner = new OwnedFileHandle(await open(path, flags));
      let value;
      let primary;
      let failed = false;
      try {
        value = await read(owner.handle);
      } catch (cause) {
        failed = true;
        primary = cause;
      }
      const released = await this.#scope.release({
        kind: "file-handle",
        resource: path,
        handle: owner,
      });
      if (released.kind === "failed") {
        this.#failures.push(...(failed ? [primary] : []), released.cause);
        pending.add(this);
        throw new OwnedProcessControllerCleanupFailure(
          owner,
          this,
          failed ? primary : undefined,
          released.cause,
        );
      }
      if (failed) throw primary;
      return value;
    });
  }
  async close() {
    try {
      await this.#scope.close();
      pending.delete(this);
    } catch (cause) {
      this.#failures.push(cause);
      pending.add(this);
      throw new AggregateError(
        [...this.#failures],
        "Controller descriptor cleanup attempts remain incomplete",
      );
    }
  }
}

/** Explicit retry keeps unreturned/default acquisition scopes recoverable. */
export async function retryPendingOwnedProcessControllerCleanup() {
  const outcomes = await Promise.allSettled(
    [...pending].map((scope) => scope.close()),
  );
  const failures = outcomes
    .filter((value) => value.status === "rejected")
    .map((value) => value.reason);
  if (failures.length)
    throw new AggregateError(
      failures,
      "Controller descriptor cleanup remains incomplete",
    );
}

/** Cleanup failure wins over the otherwise expected cancellation status. */
export function ownedProcessReceiverExitCode(result, aborted, shutdownFailed) {
  if (
    shutdownFailed ||
    result?.code === "cleanup_incomplete" ||
    result?.details?.cleanup === "incomplete"
  )
    return 1;
  if (aborted) return 130;
  return result?.error === "Process command failed" ? 1 : 0;
}

/** Receiver shutdown retains the completed document and every independent failure. */
export class OwnedProcessReceiverShutdownFailure extends Error {
  #outcome;
  #failures;
  get outcome() {
    return this.#outcome;
  }
  get failures() {
    return this.#failures;
  }
  constructor(outcome, failures) {
    super("Owned CLI receiver cleanup remains incomplete", {
      cause: new AggregateError(
        outcome.primaryFailure === undefined
          ? failures
          : [outcome.primaryFailure, ...failures],
        "Receiver operation and shutdown outcomes",
      ),
    });
    this.#outcome = outcome;
    this.#failures = failures;
  }
  project() {
    const original = this.#outcome.result;
    return {
      error: "Process command failed",
      category: original?.category ?? "execution_failure",
      code: "cleanup_incomplete",
      message: this.message,
      details: {
        ...original?.details,
        cleanup: "incomplete",
        resources: ["owned_cli_receiver_shutdown"],
        original_output: original ?? null,
        shutdown_failures: this.#failures.map((cause) =>
          cause instanceof Error ? cause.message : String(cause),
        ),
      },
    };
  }
}

const pendingCarriers = new Set();
/** Created carrier ownership is recorded before metadata/canonicalisation can fail. */
export class OwnedProcessCarrier {
  #primary;
  #identity;
  #closed = false;
  #validation;
  #failures = [];
  #closing;
  constructor(path) {
    this.path = path;
    pendingCarriers.add(this);
  }
  static async create(parent) {
    const path = await mkdtemp(join(parent, "rea-owned-process-controller-"));
    const carrier = new OwnedProcessCarrier(path);
    try {
      carrier.#identity = await lstat(path);
      if (
        !carrier.#identity.isDirectory() ||
        carrier.#identity.isSymbolicLink() ||
        carrier.#identity.uid !== process.getuid()
      )
        throw new Error("Carrier ownership is not verified");
      if ((await realpath(path)) !== path)
        throw new Error("Carrier path is not canonical");
      await chmod(path, 0o700);
      pendingCarriers.delete(carrier);
      return carrier;
    } catch (primary) {
      carrier.#primary = primary;
      try {
        await carrier.close();
      } catch (cleanup) {
        throw new OwnedProcessCarrierCleanupFailure(carrier, primary, cleanup);
      }
      throw primary;
    }
  }
  bindValidation(resources) {
    if (
      !(resources instanceof OwnedProcessControllerResources) ||
      this.#validation
    )
      throw new Error("Exact controller validation scope required");
    this.#validation = resources;
  }
  defer(primary, cleanup) {
    this.retainSetupFailure(primary);
    return new OwnedProcessCarrierCleanupFailure(this, primary, cleanup);
  }
  retainSetupFailure(primary) {
    this.#primary ??= primary;
    pendingCarriers.add(this);
  }
  close() {
    if (this.#closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    this.#closing = this.#cleanup().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }
  async #cleanup() {
    try {
      await this.#validation?.close();
      if (!this.#identity)
        throw new Error(
          "Carrier initial identity unconfirmed; removal unavailable",
        );
      const current = await lstat(this.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== this.#identity.dev ||
        current.ino !== this.#identity.ino
      )
        throw new Error("Carrier cleanup identity changed");
      for (const name of ["program.mjs", "scenario.json"]) {
        const path = join(this.path, name);
        const entry = await lstat(path).catch((cause) => {
          if (cause?.code === "ENOENT") return undefined;
          throw cause;
        });
        if (!entry) continue;
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
          throw new Error("Carrier file cleanup identity unavailable");
        await unlink(path);
      }
      await rmdir(this.path);
      this.#closed = true;
      pendingCarriers.delete(this);
    } catch (cause) {
      this.#failures.push(cause);
      pendingCarriers.add(this);
      throw new AggregateError(
        [
          ...(this.#primary === undefined ? [] : [this.#primary]),
          ...this.#failures,
        ],
        "Carrier cleanup attempts remain incomplete",
      );
    }
  }
}
/** Strong retained carrier + original/setup and all exact cleanup causes. */
export class OwnedProcessCarrierCleanupFailure extends Error {
  #carrier;
  get carrier() {
    return this.#carrier;
  }
  constructor(carrier, primary, cleanup) {
    super("Controller carrier cleanup remains incomplete", {
      cause: new AggregateError(
        [primary, cleanup],
        "Carrier setup and cleanup outcomes",
      ),
    });
    this.#carrier = carrier;
  }
}
export async function retryPendingOwnedProcessCarrierCleanup() {
  const outcomes = await Promise.allSettled(
    [...pendingCarriers].map((carrier) => carrier.close()),
  );
  const failures = outcomes
    .filter((x) => x.status === "rejected")
    .map((x) => x.reason);
  if (failures.length)
    throw new AggregateError(failures, "Controller carriers remain retained");
}

/** Keep cooperative cancellation installed through all owned cleanup and output. */
export async function withOwnedProcessReceiverSignals(
  signals,
  cancel,
  operation,
) {
  let interrupt = false;
  let terminate = false;
  try {
    signals.on("SIGINT", cancel);
    interrupt = true;
    signals.on("SIGTERM", cancel);
    terminate = true;
    return await operation();
  } finally {
    if (interrupt) signals.removeListener("SIGINT", cancel);
    if (terminate) signals.removeListener("SIGTERM", cancel);
  }
}

/** Join actual stream completion within the receiver's cancellation lease. */
export function writeOwnedProcessReceiverOutput(destination, output) {
  return new Promise((resolve, reject) => {
    const failures = [];
    const retain = (cause) => {
      if (!failures.includes(cause)) failures.push(cause);
    };
    const detach = () => destination.removeListener("error", retain);
    const finish = () => {
      detach();
      if (failures.length === 1) reject(failures[0]);
      else if (failures.length)
        reject(
          new AggregateError(failures, "Owned output write and stream failed"),
        );
      else resolve();
    };
    // An error event alone does not establish that the actual write callback settled.
    destination.on("error", retain);
    try {
      destination.write(output, (cause) => {
        if (cause) retain(cause);
        finish();
      });
    } catch (cause) {
      retain(cause);
      finish();
    }
  });
}

/** The enclosing receiver process owns cancellation until its actual exit event. */
export function installOwnedProcessReceiverExitSignals(signals, cancel) {
  let interrupt = false;
  let terminate = false;
  const cancellation = () => cancel();
  const release = () => {
    if (interrupt) signals.removeListener("SIGINT", cancellation);
    if (terminate) signals.removeListener("SIGTERM", cancellation);
  };
  try {
    signals.on("SIGINT", cancellation);
    interrupt = true;
    signals.on("SIGTERM", cancellation);
    terminate = true;
    signals.once("exit", release);
  } catch (cause) {
    release();
    throw cause;
  }
}
