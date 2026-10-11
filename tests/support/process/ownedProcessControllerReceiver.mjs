import { createReadStream, fstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { validateOwnedProcessControllerData } from "./ownedProcessControllerProtocol.mjs";
import { assertOwnedReceiverEnvironment } from "./ownedProcessReceiverEnvironment.mjs";
import {
  OwnedProcessControllerResources,
  ownedProcessReceiverExitCode,
  OwnedProcessReceiverShutdownFailure,
  withOwnedProcessReceiverSignals,
  installOwnedProcessReceiverExitSignals,
  writeOwnedProcessReceiverOutput,
} from "./ownedProcessControllerResources.mjs";

const receive = async () => {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("Owned CLI fixture cancelled"));
  installOwnedProcessReceiverExitSignals(process, cancel);
  await withOwnedProcessReceiverSignals(process, cancel, async () => {
    if (
      process.argv.length !== 2 ||
      !fstatSync(3).isSocket() ||
      !fstatSync(4).isSocket()
    )
      throw new Error("Private controller and lifecycle sockets required");
    const control = new Socket({ fd: 4, readable: false, writable: true });
    let controlFailure;
    control.on("error", (cause) => {
      controlFailure ??= cause;
    });
    try {
      let inputs;
      let retryCapture;
      let result;
      let primaryFailure;
      let shutdownFailed = false;
      try {
        await writeOwnedProcessReceiverOutput(control, '{"type":"ready"}\n');
        assertOwnedReceiverEnvironment(
          process.env,
          process.platform,
          await realpath(tmpdir()),
        );
        const chunks = [];
        let bytes = 0;
        for await (const chunk of createReadStream("", {
          fd: 3,
          autoClose: true,
          signal: AbortSignal.timeout(5000),
        })) {
          bytes += chunk.length;
          if (bytes > 65536)
            throw new Error("Controller receipt exceeds budget");
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const validation = new OwnedProcessControllerResources();
        let validationFailure;
        let validationRejected = false;
        try {
          await validateOwnedProcessControllerData(data, validation);
        } catch (cause) {
          validationFailure = cause;
          validationRejected = true;
        }
        try {
          await validation.close();
        } catch (cleanup) {
          shutdownFailed = true;
          throw new AggregateError(
            validationRejected ? [validationFailure, cleanup] : [cleanup],
            "Controller receipt and descriptor cleanup failed",
          );
        }
        if (validationRejected) throw validationFailure;
        if (process.cwd() !== data.selection.root)
          throw new Error("Receiver cwd differs from owned root");
        const { captureProcessScenarioFile, projectProcessCliError } =
          await import("../../../dist/application/process/ProcessCli.js");
        const { ProcessCliInputResources } =
          await import("../../../dist/application/process/ProcessCliInputResources.js");
        const { retryPendingProcessCliCaptureCleanup } =
          await import("../../../dist/application/process/ProcessCliCaptureResources.js");
        inputs = new ProcessCliInputResources();
        retryCapture = retryPendingProcessCliCaptureCleanup;
        if (controller.signal.aborted)
          result = {
            error: "Process command failed",
            category: "cancelled",
            message: "Owned CLI fixture cancelled before target dispatch",
          };
        else {
          try {
            result = await captureProcessScenarioFile(
              data.scenario,
              {},
              controller.signal,
              inputs,
            );
          } catch (cause) {
            primaryFailure = cause;
            result = projectProcessCliError(cause);
          }
        }
      } catch (cause) {
        primaryFailure = cause;
        result = {
          error: "Process command failed",
          category: "execution_failure",
          message: "Owned receiver startup failed",
        };
      } finally {
        const outcomes = await Promise.allSettled([
          ...(inputs ? [inputs.close()] : []),
          ...(retryCapture ? [retryCapture()] : []),
        ]);
        const failures = outcomes
          .filter((outcome) => outcome.status === "rejected")
          .map((outcome) => outcome.reason);
        if (failures.length) {
          shutdownFailed = true;
          result = new OwnedProcessReceiverShutdownFailure(
            { result, primaryFailure },
            failures,
          ).project();
        }
      }
      const complete =
        !shutdownFailed &&
        result?.code !== "cleanup_incomplete" &&
        result?.details?.cleanup !== "incomplete" &&
        controlFailure === undefined;
      await writeOwnedProcessReceiverOutput(
        process.stdout,
        JSON.stringify(result) + "\n",
      );
      await writeOwnedProcessReceiverOutput(
        control,
        JSON.stringify({ type: "cleanup", complete }) + "\n",
      );
      process.exitCode = ownedProcessReceiverExitCode(
        result,
        controller.signal.aborted,
        !complete,
      );
    } finally {
      control.destroy();
    }
  });
};
receive().catch((error) => {
  process.stderr.write(String(error.message) + "\n");
  process.exitCode = 1;
});
