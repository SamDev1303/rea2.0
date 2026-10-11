import { basename, dirname } from "node:path";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../application/InvestigationProviders.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { interfaceBuilderLimitsSchema } from "../domain/apple/interfaceBuilderGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactFailure.js";
import { inspectBundleKeyedArchive } from "./apple/KeyedArchiveReader.js";
import { traceDylibResolution } from "./apple/DylibResolutionReader.js";
import { analyzeInterfaceBuilderBundle } from "./apple/InterfaceBuilderAnalysis.js";

const OPERATIONS = [
  "decode_interface_builder",
  "inspect_keyed_archive",
  "trace_dylib_resolution",
] as const;
type AppleStaticOperation = (typeof OPERATIONS)[number];

/** Select only the three in-process Apple artifact readers. */
export const isAppleStaticArtifactOperation = (
  operation: AnalysisOperation,
): operation is AppleStaticOperation =>
  OPERATIONS.includes(operation as AppleStaticOperation);

const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze(
  OPERATIONS.map((operation) =>
    Object.freeze({
      provider: ARTIFACT_GRAPH_PROVIDER,
      operation,
      available: true as const,
      reason: null,
      effects: Object.freeze({
        mutatesArtifact: false,
        launchesProcess: false,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: false,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: Object.freeze([]),
    }),
  ),
);

/** Parse Apple archive and Mach-O metadata in-process without execution providers. */
export class AppleStaticArtifactProvider implements AnalysisProvider {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  identity(): ProviderIdentity {
    return ARTIFACT_GRAPH_PROVIDER;
  }
  capabilities(): readonly CapabilityDescriptor[] {
    return CAPABILITIES;
  }
  createClient(target: BinaryTarget): AnalysisClient {
    return new AppleStaticArtifactClient(target, this.platform);
  }
}

class AppleStaticArtifactClient implements AnalysisClient {
  constructor(
    private readonly target: BinaryTarget,
    private readonly platform: NodeJS.Platform,
  ) {}

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, ARTIFACT_GRAPH_PROVIDER));
    if (!isAppleStaticArtifactOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          ARTIFACT_GRAPH_PROVIDER.id,
          operation,
          "Operation is not implemented by the in-process Apple artifact provider.",
        ),
      );
    try {
      if (operation === "decode_interface_builder")
        return await this.decodeInterfaceBuilder(parameters, options);
      if (operation === "inspect_keyed_archive")
        return await this.inspectKeyedArchive(parameters, options);
      return await this.traceDylibResolution(parameters, options);
    } catch (cause: unknown) {
      return err(translateArtifactFailure(operation, cause));
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return Promise.resolve(ok(null));
  }

  private unsupportedTarget(
    operation: string,
    reason: string,
  ): AnalysisUnsupportedTargetError {
    return new AnalysisUnsupportedTargetError(
      operation,
      this.target.sourcePath ?? this.target.path,
      reason,
    );
  }

  private async decodeInterfaceBuilder(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const operation = "decode_interface_builder";
    if (
      this.target.kind !== "executable" ||
      this.target.sourcePath === undefined ||
      !this.target.sourcePath.toLowerCase().endsWith(".app")
    )
      throw this.unsupportedTarget(
        operation,
        "decode_interface_builder requires an active .app bundle target",
      );
    const limits = interfaceBuilderLimitsSchema.parse(parameters);
    const result = await analyzeInterfaceBuilderBundle({
      bundlePath: this.target.sourcePath,
      targetSha256: this.target.sha256,
      limits,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: result.documents.map(({ relative_path: path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      }),
    );
  }

  private async inspectKeyedArchive(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const operation = "inspect_keyed_archive";
    const standalone =
      this.target.kind === "artifact" && this.target.format === "plist";
    if (
      standalone &&
      parameters.path !== undefined &&
      parameters.path !== "." &&
      parameters.path !== basename(this.target.path)
    )
      throw new AnalysisInputError(operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message:
            "For an active plist, path must select that archive (omit path or use its basename).",
          expected: basename(this.target.path),
        },
      ]);
    const bundlePath = standalone
      ? dirname(this.target.path)
      : this.target.sourcePath;
    if (
      bundlePath === undefined ||
      (!standalone && !bundlePath.toLowerCase().endsWith(".app"))
    )
      throw this.unsupportedTarget(
        operation,
        "inspect_keyed_archive requires an active plist or .app bundle",
      );
    const result = await inspectBundleKeyedArchive({
      bundlePath,
      targetSha256: this.target.sha256,
      parameters: standalone
        ? { ...parameters, path: basename(this.target.path) }
        : parameters,
      platform: this.platform,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (standalone && result.archive_sha256 !== this.target.sha256)
      throw new ArtifactReaderFailure(
        "integrity",
        `Active archive digest changed: expected ${this.target.sha256}, observed ${result.archive_sha256}`,
      );
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: [{ kind: "artifact-path", path: result.archive_path }],
      }),
    );
  }

  private async traceDylibResolution(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (this.target.kind !== "executable" || this.target.format !== "mach-o")
      throw this.unsupportedTarget(
        "trace_dylib_resolution",
        "trace_dylib_resolution requires an active Mach-O or .app bundle target",
      );
    // Only a target opened from an app bundle directory carries its Info.plist;
    // a regular file whose name ends in .app is a standalone image.
    const bundle =
      this.target.bundleInfoPlist === undefined
        ? undefined
        : this.target.sourcePath;
    const result = await traceDylibResolution({
      rootPath: bundle ?? dirname(this.target.path),
      targetPath: this.target.path,
      targetSha256: this.target.sha256,
      enumerateRoots: bundle !== undefined,
      parameters,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: result.images.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      }),
    );
  }
}
