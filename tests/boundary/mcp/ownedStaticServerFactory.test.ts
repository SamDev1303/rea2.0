import { afterEach, expect, it, vi } from "vitest";
import { createOwnedAppleStaticSession } from "../../../src/composition/OwnedAppleStaticSession.js";
import { createAndroidAnalysisProvider } from "../../../src/composition/android.js";
import { createEvmInterfaceService } from "../../../src/composition/evm.js";
import { createServer } from "../../../src/server/createServer.js";

vi.mock("../../../src/composition/android.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/composition/android.js")
    >();
  return {
    ...actual,
    createAndroidAnalysisProvider: vi.fn(actual.createAndroidAnalysisProvider),
  };
});
vi.mock("../../../src/composition/evm.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/composition/evm.js")>();
  return {
    ...actual,
    createEvmInterfaceService: vi.fn(actual.createEvmInterfaceService),
  };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("constructs no command-backed Android or EVM provider for the static controller", async () => {
  const session = createOwnedAppleStaticSession();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  try {
    expect(createAndroidAnalysisProvider).not.toHaveBeenCalled();
    expect(createEvmInterfaceService).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await session.close();
  }
});

it("refuses an explicit nonempty environment for the static controller", async () => {
  const session = createOwnedAppleStaticSession();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    expect(() => {
      server = createServer(
        { kind: "session", session },
        { environment: { REA_LOG_LEVEL: "debug" } },
      );
    }).toThrow(/empty environment/u);
  } finally {
    await server?.close();
    await session.close();
  }
});

it("ignores ambient MCP configuration for the static controller", async () => {
  vi.stubEnv("REA_MCP_MAX_RESPONSE_BYTES", "invalid-ambient-value");
  const session = createOwnedAppleStaticSession();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    expect(() => {
      server = createServer({ kind: "session", session });
    }).not.toThrow();
  } finally {
    await server?.close();
    await session.close();
  }
});
