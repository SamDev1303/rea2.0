import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { admitInvestigationPath } from "./InvestigationAdmission.js";
import { isProtectedReferencePath } from "../../filesystem/ProtectedPaths.js";

const operation = "analyze_javascript_application";
const reject = (): never => {
  throw new AnalysisCapabilityUnavailableError(
    "rea2-protected-host",
    operation,
    "Unfamiliar archives require a sanitized snapshot or verified disposable runner before ingestion. Public JavaScript analysis accepts extracted directories without archive carriers.",
    {
      userMessage:
        "Unfamiliar archives require a sanitized snapshot or verified disposable runner before ingestion.",
    },
  );
};

/** Check archive carriers before the analysis hashes or reads their contents. */
export const admitPublicJavaScriptInput = async (
  name: string,
  input: unknown,
): Promise<void> => {
  if (
    name.replaceAll("-", "_") !== operation ||
    typeof input !== "object" ||
    input === null
  )
    return;
  const value = input as {
    input_path?: unknown;
    format?: unknown;
    args?: { path?: unknown };
    options?: { artifactFormat?: unknown };
  };
  const selected = value.input_path ?? value.args?.path;
  const format = value.format ?? value.options?.artifactFormat;
  if (typeof selected !== "string") return;
  if (format === "asar") reject();
  const root = await admitInvestigationPath(operation, selected);
  const initial = await lstat(root).catch(() => undefined);
  if (initial === undefined) return; // Preserve the handler's typed missing-input error.
  if (!initial.isDirectory()) reject();
  const pending = [root];
  const deadline = Date.now() + 30_000;
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (++count > 10_000 || Date.now() > deadline) reject();
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      // The reader rejects protected entries before their bytes are acquired.
      // Do not traverse excluded stores while checking archive carrier names.
      if (isProtectedReferencePath(relative(root, candidate))) continue;
      if (/\.(?:asar|zip|ipa|apk|msix|appx|dmg|pkg)$/iu.test(entry.name))
        reject();
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
};
