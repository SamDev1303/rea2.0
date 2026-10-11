import type { FileHandle } from "node:fs/promises";
import type { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
export class OwnedProcessControllerCleanupFailure extends Error {
  readonly owner: OwnedFileHandle;
  readonly resources: OwnedProcessControllerResources;
}
export class OwnedProcessControllerResources {
  withFile<T>(
    path: string,
    flags: number,
    read: (handle: FileHandle) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}
export function retryPendingOwnedProcessControllerCleanup(): Promise<void>;

export function ownedProcessReceiverExitCode(
  result: unknown,
  aborted: boolean,
  shutdownFailed: boolean,
): 0 | 1 | 130;
export class OwnedProcessReceiverShutdownFailure extends Error {
  constructor(
    outcome: { readonly result: unknown; readonly primaryFailure: unknown },
    failures: readonly unknown[],
  );
  readonly outcome: {
    readonly result: unknown;
    readonly primaryFailure: unknown;
  };
  readonly failures: readonly unknown[];
  project(): {
    readonly code: "cleanup_incomplete";
    readonly details: { readonly original_output: unknown };
  };
}

export class OwnedProcessCarrier {
  readonly path: string;
  static create(parent: string): Promise<OwnedProcessCarrier>;
  bindValidation(resources: OwnedProcessControllerResources): void;
  defer(primary: unknown, cleanup: unknown): OwnedProcessCarrierCleanupFailure;
  retainSetupFailure(primary: unknown): void;
  close(): Promise<void>;
}
export class OwnedProcessCarrierCleanupFailure extends Error {
  readonly carrier: OwnedProcessCarrier;
}
export function retryPendingOwnedProcessCarrierCleanup(): Promise<void>;

export function withOwnedProcessReceiverSignals<T>(
  signals: {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  },
  cancel: () => void,
  operation: () => Promise<T>,
): Promise<T>;
export function writeOwnedProcessReceiverOutput(
  destination: {
    on(event: "error", listener: (cause: Error) => void): unknown;
    removeListener(event: "error", listener: (cause: Error) => void): unknown;
    write(output: string, callback: (cause?: Error | null) => void): unknown;
  },
  output: string,
): Promise<void>;
export function installOwnedProcessReceiverExitSignals(
  signals: {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    once(event: "exit", listener: () => void): unknown;
    removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  },
  cancel: () => void,
): void;
