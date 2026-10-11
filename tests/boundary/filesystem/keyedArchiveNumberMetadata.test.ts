import { it } from "vitest";

import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { digestOwnedFixtureInput } from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { runOwnedCliFixture } from "../../support/investigation/ownedCliFixture.js";
import {
  archiveNumberMetadataCases,
  expectKeyedArchiveNumberMetadata,
  keyedArchiveNumberMetadataFixture,
} from "../../fixtures/keyedArchiveNumberMetadata.js";
import { cliTest } from "../../support/cli/cliFixture.js";

it.each(archiveNumberMetadataCases)(
  "filesystem preserves numeric meaning for $name",
  async (item) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const result = await inspectBundleKeyedArchive({
      bundlePath: fixture.root,
      targetSha256: fixture.digest,
      parameters: { path: "archive.plist" },
    });
    expectKeyedArchiveNumberMetadata(result, item, fixture.digest);
  },
);

cliTest.for(archiveNumberMetadataCases)(
  "built CLI preserves numeric meaning for $name",
  async (item, { processes }) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const output = await runOwnedCliFixture(processes, {
      arguments: ["inspect-keyed-archive", fixture.path, "--json"],
      policy: {
        roots: [fixture.root],
        files: [
          { path: fixture.path, sha256: fixture.digest, role: "dependency" },
        ],
        static_inventory: { directories: [] },
        endpoints: [],
        environment: [],
        available_capabilities: ["owned-apple-static-fixture"],
        grants: [
          {
            operation: "inspect-keyed-archive",
            input_digest: digestOwnedFixtureInput({
              args: { path: fixture.path, archive: "." },
              options: { offset: 0, limit: 20000 },
            }),
            capability: "owned-apple-static-fixture",
            mode: "owned-static",
            port_id: "controller-owned-apple-static-port",
          },
        ],
      },
    });
    expectKeyedArchiveNumberMetadata(
      parseEvidence(output.json).normalized_result,
      item,
      fixture.digest,
    );
  },
);
