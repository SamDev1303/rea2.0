import { lstat } from "node:fs/promises";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import {
  admitInvestigationInput,
  admitInvestigationPath,
} from "../application/investigationSafety/InvestigationAdmission.js";
import { admitPublicJavaScriptInput } from "../application/investigationSafety/PublicJavaScriptInput.js";
import { analyzeJavaScriptApplicationInputSchema } from "../domain/javascript/javascriptApplicationAnalysis.js";

type DirectoryPayload = Readonly<
  ReturnType<typeof analyzeJavaScriptApplicationInputSchema.parse>
>;

interface DirectoryReceipt {
  readonly selected: string;
  readonly canonical: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly payload: DirectoryPayload;
}

const receipts = new WeakMap<object, DirectoryReceipt>();
const operation = "analyze_javascript_application";
const changedInputMessage =
  "The admitted JavaScript directory changed before dispatch. Retry with a stable extracted directory; native fallback is unavailable.";

const changedInput = (): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    "rea2-protected-host",
    operation,
    changedInputMessage,
    { userMessage: changedInputMessage },
  );

const checkDirectoryIdentity = async (
  receipt: DirectoryReceipt,
): Promise<void> => {
  try {
    const canonical = await admitInvestigationPath(operation, receipt.selected);
    const metadata = await lstat(canonical, { bigint: true });
    if (
      canonical !== receipt.canonical ||
      !metadata.isDirectory() ||
      metadata.dev !== receipt.device ||
      metadata.ino !== receipt.inode
    )
      throw changedInput();
  } catch {
    throw changedInput();
  }
};

/** Admit only a stable extracted directory and bind its route to this context. */
export const admitPublicJavaScriptAlias = async (
  context: object,
): Promise<boolean> => {
  const value = context as {
    args?: { path?: unknown };
    options?: {
      provider?: unknown;
      snapshot?: unknown;
      "target-format"?: unknown;
      integrityPolicy?: unknown;
    };
  };
  const selected = value.args?.path;
  const options = value.options;
  if (
    typeof selected !== "string" ||
    options?.provider !== undefined ||
    options?.snapshot !== undefined ||
    options?.["target-format"] !== undefined ||
    selected.toLowerCase().endsWith(".app")
  )
    return false;
  const canonical = await admitInvestigationPath(operation, selected);
  if (canonical.toLowerCase().endsWith(".app")) return false;
  const metadata = await lstat(canonical, { bigint: true }).catch(
    () => undefined,
  );
  if (metadata === undefined || !metadata.isDirectory()) return false;
  const parsed = analyzeJavaScriptApplicationInputSchema.safeParse({
    input_path: canonical,
    format: "directory",
    integrity_policy: options?.integrityPolicy,
  });
  if (!parsed.success) {
    const message =
      "Malformed JavaScript directory request rejected before dispatch.";
    throw new AnalysisCapabilityUnavailableError(
      "rea2-protected-host",
      operation,
      message,
      { userMessage: message },
    );
  }
  const payload = Object.freeze(parsed.data);
  const receipt: DirectoryReceipt = Object.freeze({
    selected,
    canonical,
    device: metadata.dev,
    inode: metadata.ino,
    payload,
  });
  await admitInvestigationInput(operation, payload);
  await admitPublicJavaScriptInput(operation, payload);
  await checkDirectoryIdentity(receipt);
  receipts.set(context, receipt);
  return true;
};

/** Consume one context-bound route without reclassifying it as native input. */
export const consumePublicJavaScriptAlias = async (
  context: object,
): Promise<DirectoryPayload | undefined> => {
  const receipt = receipts.get(context);
  if (receipt === undefined) return undefined;
  receipts.delete(context);
  await checkDirectoryIdentity(receipt);
  return receipt.payload;
};
