import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as directAnalysis from "../../../src/application/DirectAnalysis.js";
import * as javascriptAnalysis from "../../../src/application/javascript/JavaScriptApplicationService.js";
import * as investigationAdmission from "../../../src/application/investigationSafety/InvestigationAdmission.js";
import * as publicJavaScriptInput from "../../../src/application/investigationSafety/PublicJavaScriptInput.js";
import * as cliJavaScriptAnalysis from "../../../src/cli/javascriptApplicationAnalysis.js";
import * as publicRoute from "../../../src/cli/publicJavaScriptRoute.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli } from "./cliServeHarness.js";

const savedExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe("public analyze exact JavaScript payload", () => {
  it.each(["fail", "record-and-continue"])(
    "dispatches the same complete admitted payload for integrity policy %s",
    async (integrityPolicy) => {
      const root = await createTestTempDirectory("rea2-js-alias-payload-");
      await writeFile(join(root, "main.js"), "export const answer = 42;");
      const admission = vi.spyOn(
        investigationAdmission,
        "admitInvestigationInput",
      );
      const preflight = vi.spyOn(
        publicJavaScriptInput,
        "admitPublicJavaScriptInput",
      );
      const dispatch = vi.spyOn(
        cliJavaScriptAnalysis,
        "runCliJavaScriptApplicationAnalysis",
      );
      const response = await serveCli([
        "analyze",
        root,
        "--integrity-policy",
        integrityPolicy,
        "--json",
      ]);
      expect(response.exitCode).toBe(0);
      expect(admission).toHaveBeenCalledWith("analyze_javascript_application", {
        input_path: root,
        format: "directory",
        integrity_policy: integrityPolicy,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      const admittedPayload = admission.mock.calls[0]?.[1];
      expect(preflight.mock.calls[0]?.[1]).toBe(admittedPayload);
      expect(dispatch.mock.calls[0]?.[0]).toBe(admittedPayload);
      expect(Object.isFrozen(admittedPayload)).toBe(true);
    },
  );

  it("rejects malformed integrity policy before static or native acquisition", async () => {
    const root = await createTestTempDirectory("rea2-js-alias-policy-");
    const dispatch = vi.spyOn(
      cliJavaScriptAnalysis,
      "runCliJavaScriptApplicationAnalysis",
    );
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const response = await serveCli([
      "analyze",
      root,
      "--integrity-policy",
      "grant-runtime",
      "--json",
    ]);
    expect(response.exitCode).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(nativeAcquisition).not.toHaveBeenCalled();
  });

  it.each(["grant-runtime", 0, { path: "../../secrets" }])(
    "rejects malformed integrity policy %j at alias admission",
    async (integrityPolicy) => {
      const root = await createTestTempDirectory("rea2-js-alias-policy-admit-");
      const context = { args: { path: root }, options: { integrityPolicy } };
      const preflight = vi.spyOn(
        publicJavaScriptInput,
        "admitPublicJavaScriptInput",
      );
      await expect(
        publicRoute.admitPublicJavaScriptAlias(context),
      ).rejects.toThrow(
        "Malformed JavaScript directory request rejected before dispatch",
      );
      expect(preflight).not.toHaveBeenCalled();
      expect(
        await publicRoute.consumePublicJavaScriptAlias(context),
      ).toBeUndefined();
    },
  );
});

describe("public analyze static JavaScript alias", () => {
  it("analyzes an extracted directory without acquiring a native provider", async () => {
    const root = await createTestTempDirectory("rea2-js-alias-");
    await writeFile(join(root, "main.js"), "export const answer = 42;");
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const response = await serveCli(["analyze", root, "--json"]);
    expect(JSON.parse(response.stdout)).toMatchObject({
      operation: "analyze_javascript_application",
    });
    expect(response.exitCode).toBe(0);
    expect(nativeAcquisition).not.toHaveBeenCalled();
  });

  it.each([
    ["--provider", "auto"],
    ["--snapshot", "snapshot.json"],
    ["--target-format", "dos-com"],
  ])("does not admit binary options %j", async (...options) => {
    const root = await createTestTempDirectory("rea2-js-alias-options-");
    await writeFile(join(root, "main.js"), "export const answer = 42;");
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const jsAcquisition = vi.spyOn(
      javascriptAnalysis,
      "analyzeJavaScriptApplicationValidated",
    );
    const response = await serveCli(["analyze", root, ...options, "--json"]);
    expect(response.stdout).toContain("capability_unavailable");
    expect(response.exitCode).toBe(1);
    expect(nativeAcquisition).not.toHaveBeenCalled();
    expect(jsAcquisition).not.toHaveBeenCalled();
  });

  it.each(["app", "archive", "nested-archive", "native", "missing"])(
    "keeps %s carriers outside the public static alias",
    async (kind) => {
      const root = await createTestTempDirectory("rea2-js-alias-carrier-");
      const selected = join(
        root,
        kind === "app"
          ? "target.app"
          : kind === "archive"
            ? "target.asar"
            : "target",
      );
      if (kind === "app" || kind === "nested-archive") {
        await mkdir(selected);
        await writeFile(
          join(selected, kind === "app" ? "main.js" : "app.asar"),
          "SYNTHETIC_PRIVATE_CARRIER",
        );
      } else if (kind !== "missing")
        await writeFile(selected, "SYNTHETIC_PRIVATE_CARRIER");
      const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
      const jsAcquisition = vi.spyOn(
        javascriptAnalysis,
        "analyzeJavaScriptApplicationValidated",
      );
      const response = await serveCli(["analyze", selected, "--json"]);
      expect(response.stdout).toContain("capability_unavailable");
      expect(response.stdout).not.toContain("SYNTHETIC_PRIVATE_CARRIER");
      expect(response.exitCode).toBe(1);
      expect(nativeAcquisition).not.toHaveBeenCalled();
      expect(jsAcquisition).not.toHaveBeenCalled();
    },
  );
});

describe("public analyze directory identity", () => {
  it.each(["file", "directory"])(
    "rejects an admitted root replaced with another %s before acquisition",
    async (replacement) => {
      const parent = await createTestTempDirectory("rea2-js-alias-swap-");
      const root = join(parent, "source");
      await mkdir(root);
      await writeFile(join(root, "main.js"), "export const answer = 42;");
      const admit = publicRoute.admitPublicJavaScriptAlias;
      vi.spyOn(publicRoute, "admitPublicJavaScriptAlias").mockImplementation(
        async (context) => {
          const admitted = await admit(context);
          if (admitted) {
            await rename(root, join(parent, "original"));
            if (replacement === "directory") await mkdir(root);
            else await writeFile(root, "SYNTHETIC_CHANGED_CARRIER");
          }
          return admitted;
        },
      );
      const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
      const jsAcquisition = vi.spyOn(
        javascriptAnalysis,
        "analyzeJavaScriptApplicationValidated",
      );
      const response = await serveCli(["analyze", root, "--json"]);
      expect(response.stdout).toContain("directory changed before dispatch");
      expect(response.exitCode).toBe(1);
      expect(nativeAcquisition).not.toHaveBeenCalled();
      expect(jsAcquisition).not.toHaveBeenCalled();
    },
  );

  it("rejects an admitted symlink retargeted to another directory", async () => {
    const parent = await createTestTempDirectory("rea2-js-alias-retarget-");
    const root = join(parent, "source");
    const other = join(parent, "other");
    const alias = join(parent, "selected");
    await mkdir(root);
    await mkdir(other);
    await writeFile(join(root, "main.js"), "export const answer = 42;");
    await symlink(root, alias);
    const admit = publicRoute.admitPublicJavaScriptAlias;
    vi.spyOn(publicRoute, "admitPublicJavaScriptAlias").mockImplementation(
      async (context) => {
        const admitted = await admit(context);
        if (admitted) {
          await unlink(alias);
          await symlink(other, alias);
        }
        return admitted;
      },
    );
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const jsAcquisition = vi.spyOn(
      javascriptAnalysis,
      "analyzeJavaScriptApplicationValidated",
    );
    const response = await serveCli(["analyze", alias, "--json"]);
    expect(response.stdout).toContain("directory changed before dispatch");
    expect(response.exitCode).toBe(1);
    expect(nativeAcquisition).not.toHaveBeenCalled();
    expect(jsAcquisition).not.toHaveBeenCalled();
  });

  it("prevents request mutation between admission and real dispatch", async () => {
    const root = await createTestTempDirectory("rea2-js-alias-mutation-");
    await writeFile(join(root, "main.js"), "export const answer = 42;");
    const admit = publicRoute.admitPublicJavaScriptAlias;
    const mutations: boolean[] = [];
    vi.spyOn(publicRoute, "admitPublicJavaScriptAlias").mockImplementation(
      async (context) => {
        const admitted = await admit(context);
        if (admitted) {
          const request = context as { args: object; options: object };
          mutations.push(
            Reflect.set(request.args, "path", join(root, "target.bin")),
            Reflect.set(request.options, "provider", "auto"),
            Reflect.set(request, "args", { path: join(root, "target.bin") }),
            Reflect.set(request, "options", { provider: "auto" }),
          );
        }
        return admitted;
      },
    );
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const response = await serveCli(["analyze", root, "--json"]);
    expect(mutations).toEqual([false, false, false, false]);
    expect(JSON.parse(response.stdout)).toMatchObject({
      operation: "analyze_javascript_application",
    });
    expect(response.exitCode).toBe(0);
    expect(nativeAcquisition).not.toHaveBeenCalled();
  });

  it("binds admission to the exact context and consumes the receipt once", async () => {
    const root = await createTestTempDirectory("rea2-js-alias-receipt-");
    const context = { args: { path: root }, options: {} };
    expect(await publicRoute.admitPublicJavaScriptAlias(context)).toBe(true);
    expect(
      await publicRoute.consumePublicJavaScriptAlias({ ...context }),
    ).toBeUndefined();
    expect(await publicRoute.consumePublicJavaScriptAlias(context)).toEqual({
      input_path: root,
      format: "directory",
      integrity_policy: "fail",
    });
    expect(
      await publicRoute.consumePublicJavaScriptAlias(context),
    ).toBeUndefined();
  });
});
