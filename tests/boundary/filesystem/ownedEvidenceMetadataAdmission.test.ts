import { expect, it, vi } from "vitest";
import * as paths from "../../../src/filesystem/ProtectedPaths.js";
import { admitInvestigationInput } from "../../../src/application/investigationSafety/InvestigationAdmission.js";

vi.mock("../../../src/filesystem/ProtectedPaths.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/filesystem/ProtectedPaths.js")
    >();
  return {
    ...actual,
    canonicalAdmissionPath: vi.fn(actual.canonicalAdmissionPath),
  };
});

it.each([
  ["compare_application_versions", "left"],
  ["compare_javascript_export_shapes", "right"],
  ["trace_application_feature", "application"],
  ["compare_application_versions", "left_native_observations"],
])(
  "keeps %s %s Evidence path metadata outside filesystem admission",
  async (operation, field) => {
    vi.mocked(paths.canonicalAdmissionPath).mockClear();
    const evidence = {
      subject: { path: "/synthetic/secrets/source" },
      parameters: { input_path: "/" },
      uri: "rea-evidence://synthetic",
    };
    await expect(
      admitInvestigationInput(operation!, {
        [field!]: field!.includes("observations") ? [evidence] : evidence,
      }),
    ).resolves.toBeUndefined();
    expect(paths.canonicalAdmissionPath).not.toHaveBeenCalled();
  },
);

it("still rejects actual source acquisition with identical protected metadata text", async () => {
  await expect(
    admitInvestigationInput("import_reference_source", {
      source: { path: "/synthetic/secrets/source" },
    }),
  ).rejects.toThrow("protected input or output path");
});

it("does not exempt CLI JSON file acquisition at the transport envelope", async () => {
  await expect(
    admitInvestigationInput("compare_application_versions", {
      args: { inputJson: "/synthetic/secrets/request.json" },
      options: {},
    }),
  ).rejects.toThrow("protected input or output path");
});

it.each([
  "/synthetic/secrets/source",
  "/synthetic/.env",
  "/synthetic/.ssh/id_ed25519",
])(
  "rejects lexical protected path %s before canonical probes",
  async (path) => {
    vi.mocked(paths.canonicalAdmissionPath).mockClear();
    await expect(
      admitInvestigationInput("import_reference_source", { source: { path } }),
    ).rejects.toThrow("protected input or output path");
    expect(paths.canonicalAdmissionPath).not.toHaveBeenCalled();
  },
);
