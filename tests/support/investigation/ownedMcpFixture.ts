import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";

/** Finite controller-authored requests, fixed before connecting target input. */
export interface OwnedMcpFixtureRequest {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Bind exact requests to a recording port; this never enables a host runtime. */
export const attachNonexecutingMcpFixture = async (
  server: object,
  port: object,
  requests: readonly OwnedMcpFixtureRequest[],
): Promise<void> => {
  if (requests.length === 0) return;
  const portId = "controller-recording-analysis-port";
  const capability = "recording-analysis-port";
  const grants = requests.map((request) => {
    const contract = TOOL_CONTRACTS.find(({ name }) => name === request.name);
    if (contract === undefined)
      throw new Error(`Unknown fixture operation ${request.name}`);
    // Match the SDK's typed/defaulted input, without receiving a live target call.
    const input = contract.inputSchema.parse(request.arguments);
    return {
      operation: request.name,
      input_digest: digestOwnedFixtureInput(input),
      capability,
      mode: "nonexecuting-stub" as const,
      port_id: portId,
    };
  });
  const token = await sealOwnedFixturePolicy(
    {
      roots: [],
      files: [],
      endpoints: [],
      environment: [],
      available_capabilities: [capability],
      grants,
    },
    { nonexecuting_ports: [{ port_id: portId, reference: port }] },
  );
  attachOwnedFixturePolicy(server, token, port);
};
