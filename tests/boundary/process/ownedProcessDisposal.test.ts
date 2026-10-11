import { expect, it, onTestFinished, vi } from "vitest";
import * as harness from "../../../src/process/capture/ProcessHarness.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { err } from "../../../src/domain/result.js";
import { OwnedProcessCarrier } from "../../support/process/ownedProcessControllerResources.mjs";
import {
  prepareOwnedProcessController,
  captureOwnedProcessCli,
  connectOwnedProcessReadback,
} from "../../support/process/ownedProcessController.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const tree = (value: unknown): unknown[] =>
  value instanceof AggregateError
    ? [value, ...value.errors.flatMap(tree)]
    : value instanceof Error && value.cause !== undefined
      ? [value, ...tree(value.cause)]
      : [value];

it.each(["direct", "readback"] as const)(
  "retains the exact %s producer failure when final carrier removal fails",
  async (route) => {
    const root = await createTestTempDirectory("rea-carrier-outcome-");
    const controller = await prepareOwnedProcessController({
      template: "stdin",
      root,
    });
    onTestFinished(controller.dispose);
    const readback = await connectOwnedProcessReadback();
    onTestFinished(readback.close);
    const primary = new ProcessCaptureError("exact capture primary");
    const cleanup = new Error("exact final carrier cleanup");
    const capture = vi
      .spyOn(harness, "captureProcessScenario")
      .mockResolvedValue(err(primary));
    onTestFinished(() => {
      capture.mockRestore();
    });
    if (route === "direct") await captureOwnedProcessCli(controller);
    else await expect(readback.capture(controller)).rejects.toBe(primary);
    const actualClose = OwnedProcessCarrier.prototype.close;
    let allow = false;
    const removal = vi
      .spyOn(OwnedProcessCarrier.prototype, "close")
      .mockImplementation(async function (this: OwnedProcessCarrier) {
        if (!allow && this.path === controller.data.control_root) throw cleanup;
        return actualClose.call(this);
      });
    try {
      const failure = await controller
        .dispose()
        .catch((cause: unknown) => cause);
      expect(tree(failure)).toContain(primary);
      expect(tree(failure)).toContain(cleanup);
    } finally {
      allow = true;
      await controller.dispose();
      removal.mockRestore();
    }
  },
);

it("retains an unexpected direct capture rejection before safe CLI projection", async () => {
  const root = await createTestTempDirectory("rea-direct-raw-outcome-");
  const controller = await prepareOwnedProcessController({
    template: "stdin",
    root,
  });
  onTestFinished(controller.dispose);
  const primary = new Error("exact unexpected capture primary");
  const cleanup = new Error("exact independent validation cleanup");
  const capture = vi
    .spyOn(harness, "captureProcessScenario")
    .mockRejectedValue(primary);
  onTestFinished(() => {
    capture.mockRestore();
  });
  const result = await captureOwnedProcessCli(controller);
  expect(result).toMatchObject({
    error: "Process command failed",
    category: "execution_failure",
  });
  expect(JSON.stringify(result)).not.toContain("cause");
  const actualClose = controller.validation.close.bind(controller.validation);
  let allow = false;
  controller.validation.close = async () => {
    if (!allow) throw cleanup;
    await actualClose();
  };
  try {
    const failure = await controller.dispose().catch((cause: unknown) => cause);
    expect(tree(failure)).toContain(primary);
    expect(tree(failure)).toContain(cleanup);
  } finally {
    allow = true;
    await controller.dispose();
  }
});
