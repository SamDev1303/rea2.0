import { Cli } from "incur";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSwiftCommands } from "../../dist/cli/swiftCommands.js";
import { DirectoryArtifactReader } from "../../dist/artifacts/DirectoryArtifactReader.js";
const root = mkdtempSync(join(tmpdir(), "rea2-owned-swift-cleanup-"));
const nativeClose = DirectoryArtifactReader.prototype.close;
DirectoryArtifactReader.prototype.close = async function () {
  await nativeClose.call(this);
  process.emit("SIGINT");
  throw new Error("Owned synthetic close rejection");
};
try {
  const cli = Cli.create("rea2-owned-swift-cleanup", { sync: false });
  registerSwiftCommands(cli);
  await cli.serve(["analyze-swift-application", root, "--json"], { env: {} });
} finally {
  DirectoryArtifactReader.prototype.close = nativeClose;
  rmSync(root, { recursive: true, force: true });
}
