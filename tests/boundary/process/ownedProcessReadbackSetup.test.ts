import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import * as servers from "../../../src/server/createServer.js";
import {
  prepareOwnedProcessReadback,
  retryPendingOwnedProcessReadbackSetup,
} from "../../support/process/ownedProcessReadbackPorts.js";

it("joins pending setup acquisition before recovery releases owners and seals subsequent connections", async () => {
  let release!: () => void;
  let entered!: () => void;
  const connected = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = {
    connect: vi.fn(async () => {
      entered();
      await gate;
    }),
    close: vi.fn(async () => {}),
  };
  const factory = vi
    .spyOn(servers, "createServer")
    .mockReturnValue(
      server as unknown as ReturnType<typeof servers.createServer>,
    );
  const clientConnect = vi
    .spyOn(Client.prototype, "connect")
    .mockResolvedValue(undefined);
  const clientClose = vi
    .spyOn(Client.prototype, "close")
    .mockResolvedValue(undefined);
  const setup = prepareOwnedProcessReadback();
  void setup.catch(() => {});
  await connected;
  const recovery = retryPendingOwnedProcessReadbackSetup();
  void recovery.catch(() => {});
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(clientClose).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    release();
    await expect(setup).rejects.toThrow("closing");
    await recovery;
    expect(clientConnect).not.toHaveBeenCalled();
    expect(clientClose).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  } finally {
    release();
    const outcome = await setup.catch(() => undefined);
    if (outcome) await outcome.close();
    await recovery;
    factory.mockRestore();
    clientConnect.mockRestore();
    clientClose.mockRestore();
  }
});

it("preserves closing admission across fulfilled setup handoff and joins deferred port release", async () => {
  const ports =
    await import("../../support/process/ownedProcessReadbackPorts.js");
  const { connectOwnedProcessReadback, prepareOwnedProcessController } =
    await import("../../support/process/ownedProcessController.js");
  const harness =
    await import("../../../src/process/capture/ProcessHarness.js");
  const { createTestTempDirectory } =
    await import("../../fixtures/temporaryDirectory.js");
  let release!: () => void;
  let releasing!: () => void;
  const released = new Promise<void>((resolve) => {
    releasing = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actualPrepare = ports.prepareOwnedProcessReadback;
  let recovery!: Promise<void>;
  const prepare = vi
    .spyOn(ports, "prepareOwnedProcessReadback")
    .mockImplementation(() =>
      actualPrepare().then((prepared) => {
        // Select recovery after preparation fulfilled but before its caller resumes.
        recovery = ports.retryPendingOwnedProcessReadbackSetup();
        void recovery.catch(() => {});
        return prepared;
      }),
    );
  const closeClient = vi
    .spyOn(Client.prototype, "close")
    .mockImplementation(async () => {
      releasing();
      await gate;
    });
  const capture = vi
    .spyOn(harness, "captureProcessScenario")
    .mockImplementation(async () => {
      throw new Error("No target dispatch after setup shutdown");
    });
  const root = await createTestTempDirectory("rea-readback-handoff-");
  const controller = await prepareOwnedProcessController({
    template: "stdin",
    root,
  });
  const readback = await connectOwnedProcessReadback();
  await released;
  try {
    await expect(readback.capture(controller)).rejects.toThrow("closing");
    expect(capture).not.toHaveBeenCalled();
  } finally {
    release();
    await recovery;
    await readback.close();
    await controller.dispose();
    prepare.mockRestore();
    closeClient.mockRestore();
    capture.mockRestore();
  }
});
