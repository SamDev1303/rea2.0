import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { createOwnedAppleStaticSession } from "../../src/application/binary/OwnedAppleStaticSession.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { machoImage } from "../../src/artifacts/apple/MachoImage.fixture.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** Entire bundle and finite open authority are authored before fault injection. */
export const ownedBundleCleanupFixture = async (wrapped = false) => {
  const root = await createTestTempDirectory("rea-owned-bundle-cleanup-");
  const selected = join(root, "Fixture.app");
  const wrapper = join(selected, "Wrapper");
  const app = wrapped ? join(wrapper, "Inner.app") : selected;
  const contents = join(app, "Contents");
  const programs = join(contents, "MacOS");
  await fs.mkdir(programs, { recursive: true });
  const plist = join(contents, "Info.plist");
  const image = join(programs, "Fixture");
  const plistBytes = Buffer.from(
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>',
  );
  const imageBytes = Buffer.from(machoImage({}));
  await fs.writeFile(plist, plistBytes);
  await fs.writeFile(image, imageBytes);
  const session = createOwnedAppleStaticSession();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const request = {
    name: "open_binary" as const,
    arguments: { path: selected },
  };
  const files = [
    [plist, plistBytes],
    [image, imageBytes],
  ] as const;
  const token = await sealOwnedFixturePolicy(
    {
      roots: [root],
      files: files.map(([path, bytes]) => ({
        path,
        role: "dependency" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
      static_inventory: {
        directories: wrapped
          ? [selected, wrapper, app, contents, programs]
          : [app, contents, programs],
      },
      environment: [],
      endpoints: [],
      available_capabilities: ["static"],
      grants: [
        {
          operation: request.name,
          input_digest: digestOwnedFixtureInput(
            toolContract(request.name).inputSchema.parse(request.arguments),
          ),
          capability: "static",
          mode: "owned-static",
          port_id: "static",
        },
      ],
    },
    { owned_static_ports: [{ port_id: "static", reference: session }] },
  );
  attachOwnedFixturePolicy(server, token, session);
  return { root, selected, wrapper, plist, session, server, request };
};
