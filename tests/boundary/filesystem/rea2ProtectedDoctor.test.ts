import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { systemDoctorHost } from "../../../src/application/Doctor.js";
import { createSystemDoctorHost } from "../../../src/doctorRuntime.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("protected diagnostic probes", () => {
  it("never executes selected engines, package managers, or runtime probes", async () => {
    const root = await createTestTempDirectory("rea2-doctor-sentinel-");
    const sentinel = join(root, "executed.txt");
    const executable = join(root, "ilspycmd");
    const javaHome = join(root, "java-home");
    await mkdir(join(javaHome, "bin"), { recursive: true });
    const script = `#!/bin/sh\nprintf 'SYNTHETIC_EXECUTION' > '${sentinel.replaceAll("'", "'\\''")}'\n`;
    for (const path of [
      executable,
      join(root, "brew"),
      join(javaHome, "bin", "java"),
    ]) {
      await writeFile(path, script);
      await chmod(path, 0o755);
    }
    const environment = {
      HOME: root,
      PATH: root,
      JAVA_HOME: javaHome,
      GHIDRA_INSTALL_DIR: join(root, "ghidra"),
      REA_ILSPY_CMD_PATH: executable,
    };
    const host = createSystemDoctorHost(environment);
    if (host.ilspyCmdVersion === undefined)
      throw new Error("Diagnostic port missing");
    expect(await host.ilspyCmdVersion(executable)).toBeUndefined();
    expect(await host.brewHopperPath()).toBeUndefined();
    expect(await host.providerInspections?.()).toContainEqual(
      expect.objectContaining({ id: "ghidra", available: false }),
    );
    expect(await host.linuxDemoRuntimeCheck()).toMatchObject({
      ok: false,
      code: "capability_unavailable",
    });
    const linux = systemDoctorHost({ platform: "linux", environment });
    expect(await linux.executable(executable)).toBe(false);
    expect(await host.validTarget(executable)).toBe(false);
    expect(await host.inspectTarget?.(executable)).toMatchObject({
      ok: false,
      code: "capability_unavailable",
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
