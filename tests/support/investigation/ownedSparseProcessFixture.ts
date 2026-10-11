import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { digestOwnedFixtureInput } from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { prepareOwnedTimedProcessFixture } from "./ownedTimedProcessFixture.js";

/** Exactly 65 literal lines; only the trusted test controller constructs source. */
export const OWNED_SPARSE_PROCESS_SOURCE = Array.from(
  { length: 65 },
  (_, index) => {
    const line = `board ${String(index).padStart(2, "0")} completed; score ${String(index * 10)}\n`;
    const write = `process.stdout.write(${JSON.stringify(line)})`;
    return index === 0
      ? `${write};`
      : `setTimeout(() => ${write},${String(index * 20)});`;
  },
).join("");

/** Preserve observed raw bytes and separated rendered snapshots without loops in the child. */
export const prepareOwnedSparseProcessFixture = async (
  adapter: "cli" | "mcp",
) => {
  // Prepare only the explicitly authored script, then write CLI scenario once.
  const fixture = await prepareOwnedTimedProcessFixture({
    source: OWNED_SPARSE_PROCESS_SOURCE,
    adapter: "mcp",
    timeoutMs: 10000,
    idleTimeoutMs: 10000,
  });
  const input = toolContract("capture_process_scenario").inputSchema.parse({
    ...fixture.input,
    normalization: {
      ports: false,
      pids: false,
      paths: false,
      time_bucket_ms: 1,
    },
    limits: { output_bytes: 30000 },
  });
  const serialized = JSON.stringify(input);
  if (adapter === "cli")
    await writeFile(fixture.scenario, serialized, { flag: "wx" });
  return {
    ...fixture,
    input,
    policy: {
      ...fixture.policy,
      files:
        adapter === "cli"
          ? [
              ...fixture.policy.files,
              {
                path: fixture.scenario,
                sha256: createHash("sha256").update(serialized).digest("hex"),
                role: "scenario" as const,
              },
            ]
          : fixture.policy.files,
      grants: fixture.policy.grants.map((grant) => ({
        ...grant,
        operation:
          adapter === "cli" ? "capture-process" : "capture_process_scenario",
        input_digest: digestOwnedFixtureInput(
          adapter === "cli"
            ? { args: { scenario: fixture.scenario }, options: {} }
            : input,
        ),
      })),
    },
  };
};
