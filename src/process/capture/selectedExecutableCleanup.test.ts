import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { observeSelectedExecutable } from "./ProcessCaptureLifecycle.js";
const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of emergency.splice(0)) await close();
});
it.each(["success", "read", "cancel"] as const)(
  "retains the selected authored file after %s and failed close",
  async (route) => {
    const root = await createTestTempDirectory("rea-selected-close-");
    const path = join(root, "authored-not-executable");
    await fs.writeFile(path, "authored metadata-only fixture");
    const controller = new AbortController();
    const primary = new Error("selected file read failed");
    const cleanup = new Error("selected file native close failed");
    let actual: Awaited<ReturnType<typeof fs.open>> | undefined;
    const fileSystem = {
      open: async (selected: string, flags: number) => {
        const handle = await fs.open(selected, flags);
        actual = handle;
        const close = handle.close.bind(handle);
        emergency.push(async () => {
          if (handle.fd >= 0) await close();
        });
        vi.spyOn(handle, "close").mockRejectedValue(cleanup);
        if (route === "read")
          vi.spyOn(handle, "read").mockRejectedValue(primary);
        if (route === "cancel") controller.abort();
        return handle;
      },
      stat: (selected: string) => fs.stat(selected, { bigint: true }),
    };
    const failure = await observeSelectedExecutable(
      path,
      controller.signal,
      fileSystem,
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      cleanupCause: cleanup,
      cause:
        route === "success"
          ? cleanup
          : route === "read"
            ? primary
            : expect.objectContaining({ reason: "cancelled" }),
    });
    expect(failure).toHaveProperty("retainedOwnedFile.handle", actual);
    expect(failure).toHaveProperty("resources.pendingCount", 1);
  },
);
