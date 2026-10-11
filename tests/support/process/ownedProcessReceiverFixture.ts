import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

/** Authored inert event-recorder channel, never a real receiver or target grant. */
export const ownedReceiverFixtureControl = (): PassThrough => {
  const control = new PassThrough();
  control.write('{"type":"ready"}\n');
  return control;
};
export const confirmOwnedReceiverFixtureCleanup = (
  child: ChildProcess,
): void => {
  const control = child.stdio[4];
  if (!control || !("write" in control))
    throw new Error("Fixture control socket missing");
  control.write('{"type":"cleanup","complete":true}\n');
};
