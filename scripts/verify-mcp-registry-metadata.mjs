import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const server = JSON.parse(await readFile(new URL("server.json", root), "utf8"));
if (
  packageJson.private !== true ||
  packageJson.name !== "rea2-local" ||
  packageJson.mcpName !== "io.github.SamDev1303/rea2" ||
  server.name !== packageJson.mcpName ||
  server.version !== packageJson.version ||
  server.packages !== undefined
)
  throw new Error(
    "REA 2.0 local identity drifted or registry publication was enabled.",
  );
process.stdout.write(
  "REA 2.0 local-only MCP metadata is aligned; registry publication is disabled.\n",
);
