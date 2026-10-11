import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { inventoryArtifact } from "./inventory/ArtifactInventory.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { analyzeAppleAssetCatalogs } from "./apple/AppleAssetCatalogAnalysis.js";
import {
  ARTIFACT_ANALYSIS_OPERATIONS,
  artifactInventoryInputSchema,
  artifactExtractionExecutionSchema,
  type ArtifactAnalysisOperation,
} from "../contracts/artifactToolContracts.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { artifactCapabilities } from "./ArtifactProviderMetadata.js";
import { ARTIFACT_GRAPH_PROVIDER } from "../application/InvestigationProviders.js";
import { createEvidence } from "../domain/evidence.js";
import { createArtifactInspection } from "../domain/artifactInspection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AppleStaticArtifactProvider,
  isAppleStaticArtifactOperation,
} from "./AppleStaticArtifactProvider.js";
import { translateArtifactFailure } from "./ArtifactFailure.js";
export { translateArtifactFailure } from "./ArtifactFailure.js";

/** Read-only inventory and exclusively owned extraction provider. */
export class ArtifactProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];
  readonly #platform: NodeJS.Platform;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.environment = snapshotEnvironment(environment, platform);
    this.#capabilities = artifactCapabilities(platform);
    this.#platform = platform;
  }

  identity(): ProviderIdentity {
    return ARTIFACT_GRAPH_PROVIDER;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return new ArtifactClient(target, this.environment, this.#platform);
  }
}

class ArtifactClient implements AnalysisClient {
  readonly #resourceScope = new ArtifactResourceScope();
  readonly #appleStatic: AnalysisClient;

  constructor(
    private readonly target: BinaryTarget,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform,
  ) {
    this.#appleStatic = new AppleStaticArtifactProvider(platform).createClient(
      target,
    );
  }

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (operation === "health")
      return ok(createAnalysisExecution(null, ARTIFACT_GRAPH_PROVIDER));
    if (isAppleStaticArtifactOperation(operation))
      return this.#appleStatic.execute(operation, parameters, options);
    if (!isArtifactOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          ARTIFACT_GRAPH_PROVIDER.id,
          operation,
          "Operation is not implemented by artifact graph provider.",
        ),
      );
    try {
      if (operation === "inspect_artifact") {
        const inspected = await this.inspectArtifact(parameters, options);
        return inspected;
      }
      if (operation === "inspect_asset_catalog") {
        return await this.inspectAssetCatalog(parameters, options);
      }
      if (operation === "extract_artifact") {
        const parsed = artifactExtractionExecutionSchema.parse(parameters);
        const result = await extractArtifact(
          {
            inputPath: this.target.sourcePath ?? this.target.path,
            inputFormat: this.target.format,
            outputRoot: parsed.output_root,
            environment: this.environment,
            integrityPolicy: parsed.integrity_policy,
            resourceScope: this.#resourceScope,
          },
          options?.signal,
        );
        return ok(
          createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
            rawResult: null,
            limitations: result.limitations,
            subject: subjectFor(
              this.target.sourcePath ?? this.target.path,
              result.manifest,
            ),
            // Each extracted file's path is already in artifacts.
            locations: [],
          }),
        );
      }
      const parsed = artifactInventoryInputSchema.parse(parameters);
      const result = await this.inventory(parsed, options);
      return ok(
        createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
          rawResult: null,
          limitations: result.limitations,
          subject: subjectFor(
            this.target.sourcePath ?? this.target.path,
            result.manifest,
          ),
          // Each occurrence's logical path is already in the result.
          locations: [],
        }),
      );
    } catch (cause: unknown) {
      return err(translateArtifactFailure(operation, cause));
    }
  }

  close(): Promise<Result<null, AnalysisError>> {
    return this.#resourceScope.close().then(
      () => ok(null),
      (cause: unknown) => {
        const failure =
          cause instanceof ArtifactReaderFailure ? cause : undefined;
        return err(
          new ProviderCleanupError(
            ARTIFACT_GRAPH_PROVIDER.id,
            failure?.cleanup?.resources ?? ["artifact resources"],
            {
              reason:
                failure?.cleanup?.reason ??
                (cause instanceof Error ? cause.message : String(cause)),
            },
            { cause, operation: "close_binary" },
          ),
        );
      },
    );
  }

  /** The active target's kind is outside this operation's supported targets. */
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

  private async inspectAssetCatalog(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const bundlePath = this.target.sourcePath;
    if (
      this.target.kind !== "executable" ||
      bundlePath === undefined ||
      !bundlePath.toLowerCase().endsWith(".app")
    )
      throw this.unsupportedTarget(
        "inspect_asset_catalog",
        "inspect_asset_catalog requires an active .app bundle target",
      );
    const result = await analyzeAppleAssetCatalogs({
      environment: this.environment,
      bundlePath,
      targetSha256: this.target.sha256,
      page: parameters,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        limitations: result.limitations,
        locations: result.catalogs.map(({ path }) => ({
          kind: "artifact-path" as const,
          path,
        })),
      }),
    );
  }

  private async inspectArtifact(
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const parsed = artifactInventoryInputSchema.parse(parameters);
    const inventoryParameters = {
      integrity_policy: parsed.integrity_policy,
    };
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 0,
      total: 1,
      message: "inventory substep started",
    });
    const inventory = await this.inventory(inventoryParameters, options);
    const subject = subjectFor(
      this.target.sourcePath ?? this.target.path,
      inventory.manifest,
    );
    const inventoryEvidence = createEvidence(subject, ARTIFACT_GRAPH_PROVIDER, {
      operation: "inventory_artifact",
      parameters: inventoryParameters,
      result: inventory,
      rawResult: null,
      limitations: inventory.limitations,
      // The nested inventory already names every occurrence's logical path.
      locations: [],
    });
    const result = createArtifactInspection(inventoryEvidence);
    await options?.progress?.report({
      phase: "inspect_artifact.inventory",
      completed: 1,
      total: 1,
      message: "inventory substep completed",
    });
    return ok(
      createAnalysisExecution(result, ARTIFACT_GRAPH_PROVIDER, {
        rawResult: null,
        limitations: result.limitations,
        subject,
        locations: [],
      }),
    );
  }

  private inventory(
    parsed: {
      readonly integrity_policy: "fail" | "record-and-continue";
    },
    options?: ExecutionOptions,
  ) {
    return inventoryArtifact(this.target.sourcePath ?? this.target.path, {
      resourceScope: this.#resourceScope,
      environment: this.environment,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      integrity: { mode: parsed.integrity_policy },
    });
  }
}

const isArtifactOperation = (
  operation: AnalysisOperation,
): operation is ArtifactAnalysisOperation =>
  ARTIFACT_ANALYSIS_OPERATIONS.includes(
    operation as (typeof ARTIFACT_ANALYSIS_OPERATIONS)[number],
  );

const subjectFor = (
  path: string,
  manifest: {
    readonly root_sha256: string;
    readonly root_format: import("../domain/artifactGraph.js").ArtifactInventoryResult["manifest"]["root_format"];
  },
) => ({
  path,
  sha256: manifest.root_sha256,
  format: manifest.root_format,
});
