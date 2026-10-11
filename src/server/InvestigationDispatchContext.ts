import type { ServerContext } from "@modelcontextprotocol/server";
import { snapshotPublicInvestigationInput } from "../application/investigationSafety/PublicInputSnapshot.js";

/** Capture SDK services separately from immutable target input before admission. */
export const captureInvestigationDispatchContext = (
  operation: string,
  context: ServerContext,
): ServerContext => {
  const request = context.mcpReq;
  const data = snapshotPublicInvestigationInput(operation, {
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
    ...(request.envelope === undefined ? {} : { envelope: request.envelope }),
    ...(request.inputResponses === undefined
      ? {}
      : { inputResponses: request.inputResponses }),
    ...(request.droppedInputResponseKeys === undefined
      ? {}
      : { droppedInputResponseKeys: request.droppedInputResponseKeys }),
  });
  return Object.freeze({
    ...context,
    mcpReq: Object.freeze({
      ...request,
      ...data,
      // Keep the original signal live for cancellation; its reference cannot change.
      signal: request.signal,
    }),
  });
};
