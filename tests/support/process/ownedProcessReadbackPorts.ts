import { retryProcessCliCaptureCleanup } from "../../../src/application/process/ProcessCliCaptureResources.js";
import type { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { OwnedProcessLifetime } from "./ownedProcessLifetime.js";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { silentLogger } from "../../../src/logger.js";

const pendingReadbackSetup = new Set<() => Promise<void>>();
export const prepareOwnedProcessReadback = async () => {
  const owners: Array<{ release: () => Promise<void>; released: boolean }> = [];
  const history: unknown[] = [];
  const acquisitions = new OwnedProcessLifetime();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      await acquisitions.settle();
      const failures: unknown[] = [];
      for (const owner of owners) {
        if (owner.released) continue;
        try {
          await owner.release();
          owner.released = true;
        } catch (cause: unknown) {
          failures.push(cause);
        }
      }
      if (failures.length) {
        history.push(...failures);
        pendingReadbackSetup.add(close);
        throw new AggregateError(
          [...history],
          "Owned MCP setup cleanup incomplete",
        );
      }
      pendingReadbackSetup.delete(close);
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  pendingReadbackSetup.add(close);
  try {
    const session = createTestBinarySession(() => {
      throw new Error("Owned capture must not start an analysis provider");
    });
    owners.push({
      released: false,
      release: async () => {
        const result = await session.close();
        if (!result.ok) throw result.error;
      },
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    owners.unshift({ released: false, release: () => server.close() });
    const client = new Client({ name: "owned-process-readback", version: "1" });
    owners.unshift({ released: false, release: () => client.close() });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await acquisitions.run(() => server.connect(serverTransport));
    acquisitions.assertOpen();
    await acquisitions.run(() => client.connect(clientTransport));
    acquisitions.assertOpen();
    return { session, server, client, close, lifetime: acquisitions };
  } catch (primary) {
    history.push(primary);
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        "Owned MCP setup and cleanup failed",
      );
    }
    throw primary;
  }
};
export const retryPendingOwnedProcessReadbackSetup =
  async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...pendingReadbackSetup].map((close) => close()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned MCP setup resources remain retained",
      );
  };

export const retainOwnedProcessReadbackCleanup = (
  close: () => Promise<void>,
): void => {
  pendingReadbackSetup.add(close);
};
export const forgetOwnedProcessReadbackCleanup = (
  close: () => Promise<void>,
): void => {
  pendingReadbackSetup.delete(close);
};

/** Wait for producers before ordered resource release; failures retain the whole closer. */
export const createOwnedReadbackCloser = <Owner>(
  lifetime: OwnedProcessLifetime,
  scopes: Map<ProcessCaptureResourceScope, Owner>,
  closeSetup: () => Promise<void>,
  forgetScope: (owner: Owner, scope: ProcessCaptureResourceScope) => void,
): (() => Promise<void>) => {
  let closing: Promise<void> | undefined;
  const cleanupFailures: unknown[] = [];
  const close = (): Promise<void> => {
    if (closing) return closing;
    retainOwnedProcessReadbackCleanup(close);
    closing = (async () => {
      await lifetime.settle();
      for (const [scope, controller] of scopes) {
        try {
          await retryProcessCliCaptureCleanup(scope);
          scopes.delete(scope);
          forgetScope(controller, scope);
        } catch (cause: unknown) {
          cleanupFailures.push(cause);
        }
      }
      let setupClosed = false;
      try {
        await closeSetup();
        setupClosed = true;
      } catch (cause: unknown) {
        cleanupFailures.push(cause);
      }
      if (scopes.size || !setupClosed)
        throw new AggregateError(
          [...lifetime.failures, ...cleanupFailures],
          "Owned capture and MCP readback cleanup failed",
        );
      forgetOwnedProcessReadbackCleanup(close);
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  retainOwnedProcessReadbackCleanup(close);
  forgetOwnedProcessReadbackCleanup(closeSetup);
  return close;
};
