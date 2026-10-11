import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  swiftSourceAnalysisSchema,
  swiftSourceInputSchema,
} from "../domain/swift/swiftSourceAnalysis.js";

/** Inert Swift source analysis shares one typed contract across MCP registration. */
export const SWIFT_TOOL_CONTRACTS = [
  {
    name: "analyze_swift_application",
    ...toolContractMetadata("analyze_swift_application"),
    description:
      "Map extracted Swift source without running target code or a compiler. Returns hashed files, imports, lexical declarations, parent scopes, unresolved candidate calls, source locations and explicit coverage limits. This is navigation evidence, not compiler semantics or proof of a vulnerability.",
    kind: "application",
    inputSchema: swiftSourceInputSchema,
    outputSchema: evidenceResultOf(swiftSourceAnalysisSchema),
    examples: [
      {
        title: "Map a sanitised Swift source directory",
        input: { input_path: "/approved/extracted-swift-source" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
