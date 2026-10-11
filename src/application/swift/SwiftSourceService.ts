import { setImmediate } from "node:timers/promises";
import { DirectoryArtifactReader } from "../../artifacts/DirectoryArtifactReader.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { streamChunkToBuffer } from "../../artifacts/StreamBytes.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { AnalysisUnsupportedTargetError } from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  swiftSourceAnalysisSchema,
  swiftSourceInputSchema,
  type SwiftSourceFile,
} from "../../domain/swift/swiftSourceAnalysis.js";
import { admitInvestigationPath } from "../investigationSafety/InvestigationAdmission.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import { parseSwiftSource } from "./SwiftSourceParser.js";
import { SWIFT_SOURCE_PROVIDER } from "../InvestigationProviders.js";
export const SWIFT_SOURCE_OPERATION = "analyze_swift_application" as const;

/** Shared CLI/MCP acquisition uses the maintained protected reader and caller-owned cleanup. */
export const analyzeSwiftSource = async (
  rawInput: unknown,
  resources: ArtifactResourceScope,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = swiftSourceInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        SWIFT_SOURCE_OPERATION,
        parsed.error.issues,
        rawInput,
      ),
    );
  try {
    return ok(
      await resources.run(async () => {
        if (options.signal?.aborted)
          throw new ArtifactReaderFailure(
            "cancelled",
            "Swift source analysis cancelled",
          );
        const root = await admitInvestigationPath(
          SWIFT_SOURCE_OPERATION,
          parsed.data.input_path,
        );
        const { files, entries, bytesRead, nonSwift } = await acquireSources(
          root,
          resources,
          options,
        );
        const result = swiftSourceAnalysisSchema.parse({
          language: "swift",
          analysis_kind: "lexical-source-map",
          files,
          coverage: {
            status: files.some((file) => file.diagnostics.length > 0)
              ? "partial"
              : "complete-within-lexical-scope",
            source_files: files.length,
            bytes_read: bytesRead,
            entries_examined: entries,
            non_swift_entries: nonSwift,
          },
          limitations: [
            "Only extracted UTF-8 .swift files were mapped; target code, compilers, macros and package scripts were never executed.",
            "This bounded lexical mapper is not a Swift compiler or complete grammar parser. Declaration and candidate-call locations are navigation evidence.",
            "Candidate calls are unresolved: overloads, dynamic dispatch, types, data flow, macro expansion and runtime behaviour are unverified.",
            "Conditional-compilation branches are retained without claiming that they are active. String interpolation bodies are excluded from the map.",
            "No vulnerability or behavioural defect is confirmed by this map. Safe reproduction and independent research remain required.",
          ],
        });
        return createEvidence(undefined, SWIFT_SOURCE_PROVIDER, {
          predicateType: "rea.swift-source-analysis",
          operation: SWIFT_SOURCE_OPERATION,
          parameters: { input_path: root },
          result,
          confidence: "derived",
          authority: "analyst-inference",
          limitations: result.limitations,
        });
      }),
    );
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    if (cause instanceof ArtifactReaderFailure)
      return err(
        new ArtifactOperationError(
          SWIFT_SOURCE_OPERATION,
          cause.reason,
          undefined,
          undefined,
          {
            cause,
            ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
          },
        ),
      );
    return err(
      new ArtifactOperationError(
        SWIFT_SOURCE_OPERATION,
        "io",
        undefined,
        undefined,
        { cause },
      ),
    );
  }
};

/** Acquire inert source with one explicit owner retained on any cleanup failure. */
const acquireSources = async (
  root: string,
  resources: ArtifactResourceScope,
  options: ExecutionOptions,
) => {
  const reader = new DirectoryArtifactReader(root);
  const owner = {
    kind: "reader" as const,
    reader,
    resource: "Swift source directory reader",
  };
  const deadline = Date.now() + 30_000;
  const check = () => {
    if (options.signal?.aborted)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Swift source analysis cancelled",
      );
    if (Date.now() > deadline)
      throw new ArtifactReaderFailure(
        "limit",
        "Swift analysis exceeds the 30 second acquisition budget",
      );
  };
  const files: SwiftSourceFile[] = [];
  let symbols = 0;
  let entries = 0,
    bytesRead = 0,
    nonSwift = 0;
  let failure: { cause: unknown } | undefined;
  try {
    check();
    for await (const entry of reader.entries(options.signal)) {
      check();
      if (++entries > 10_000)
        throw new ArtifactReaderFailure("limit", "Swift entry limit exceeded");
      if (entry.kind !== "file" || !entry.path.endsWith(".swift")) {
        nonSwift++;
        continue;
      }
      if (
        files.length >= 1_000 ||
        entry.declaredSize === null ||
        entry.declaredSize > 1024 * 1024
      )
        throw new ArtifactReaderFailure(
          "limit",
          "Swift source file limit exceeded",
        );
      const acquired = await readSource(reader, entry, {
        signal: options.signal,
        check,
        remainingBytes: 16 * 1024 * 1024 - bytesRead,
      });
      bytesRead += acquired.bytes.length;
      const file = parseSwiftSource(entry.path, acquired.bytes, options.signal);
      symbols +=
        file.imports.length +
        file.declarations.length +
        file.call_candidates.length;
      if (symbols > 100_000)
        throw new ArtifactReaderFailure(
          "limit",
          "Swift mapped-symbol budget exceeded",
        );
      files.push(file);
      await setImmediate();
      check();
    }
    if (files.length === 0)
      throw new AnalysisUnsupportedTargetError(
        SWIFT_SOURCE_OPERATION,
        root,
        "No Swift source files were examined. Supply an extracted, protected-file-free Swift source directory.",
      );
  } catch (cause: unknown) {
    failure = { cause };
  }
  const cleanup = await resources.release(owner);
  if (cleanup.kind === "failed") {
    const observation = ArtifactReaderFailure.cleanupObservation(
      cleanup.cause,
      owner.resource,
    );
    if (failure?.cause instanceof AnalysisError)
      throw analysisErrorWithCleanupFailure(
        failure.cause,
        new ArtifactOperationError(
          SWIFT_SOURCE_OPERATION,
          "unavailable",
          undefined,
          undefined,
          { cause: cleanup.cause, cleanup: observation },
        ),
        SWIFT_SOURCE_OPERATION,
      );
    throw ArtifactReaderFailure.withCleanup(
      failure?.cause ?? cleanup.cause,
      observation,
    );
  }
  if (failure !== undefined) throw failure.cause;
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  return { files, entries, bytesRead, nonSwift };
};

/** Keep acquisition limits beside the stream, before decoding or symbol allocation. */
const readSource = async (
  reader: DirectoryArtifactReader,
  entry: ArtifactEntry,
  options: {
    signal: AbortSignal | undefined;
    check: () => void;
    remainingBytes: number;
  },
) => {
  const stream = await reader.open(entry, options.signal);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    options.check();
    const bytes = streamChunkToBuffer(chunk);
    size += bytes.length;
    if (size > 1024 * 1024 || size > options.remainingBytes)
      throw new ArtifactReaderFailure(
        "limit",
        "Swift source byte budget exceeded",
      );
    chunks.push(bytes);
  }
  if (size !== entry.declaredSize)
    throw new ArtifactReaderFailure(
      "integrity",
      "Swift source size changed after inventory",
    );
  return { bytes: Buffer.concat(chunks) };
};
