import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readInvestigationWorkflowInput } from "./investigationWorkflowInput.js";
import { reconcileInvestigation } from "../domain/investigationWorkflow.js";
import { assertInvestigationWorkflowBudget } from "../domain/investigationWorkflowBudget.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { quantityInvestigationFixture } from "../../tests/fixtures/investigationWorkflow/quantitySpecification.js";

describe("public investigation document admission", () => {
  it("reads an owned regular document without giving public input receipt authority", async () => {
    const directory = await createTestTempDirectory(
      "rea2-investigation-input-",
    );
    const { input } = quantityInvestigationFixture();
    const path = join(directory, "investigation.json");
    await writeFile(path, JSON.stringify(input));
    const parsed = await readInvestigationWorkflowInput(path);
    expect(reconcileInvestigation(parsed, []).status).toBe("incomplete");
  });

  it("rejects protected names, protected parent aliases, symlinks and oversized input", async () => {
    const directory = await createTestTempDirectory(
      "rea2-investigation-input-",
    );
    const safe = join(directory, "safe.json");
    await writeFile(safe, "{}");
    const secret = join(directory, ".env");
    await writeFile(secret, "not-a-credential");
    await expect(readInvestigationWorkflowInput(secret)).rejects.toThrow(
      "Invalid analysis input",
    );
    const alias = join(directory, "alias.json");
    await symlink(safe, alias);
    await expect(readInvestigationWorkflowInput(alias)).rejects.toBeDefined();
    const secrets = join(directory, "secrets");
    await mkdir(secrets);
    await writeFile(join(secrets, "input.json"), "{}");
    const aliasedDirectory = join(directory, "data");
    await symlink(secrets, aliasedDirectory);
    await expect(
      readInvestigationWorkflowInput(join(aliasedDirectory, "input.json")),
    ).rejects.toThrow("Invalid analysis input");
    await writeFile(safe, " ".repeat(1024 * 1024 + 1));
    await expect(readInvestigationWorkflowInput(safe)).rejects.toThrow(
      "read budget",
    );
  });

  it("rejects malformed JSON, non-files and cancelled reads", async () => {
    const directory = await createTestTempDirectory(
      "rea2-investigation-input-",
    );
    const path = join(directory, "bad.json");
    await writeFile(path, "{ invalid JSON");
    await expect(readInvestigationWorkflowInput(path)).rejects.toThrow(
      "Invalid analysis input",
    );
    await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));
    await expect(readInvestigationWorkflowInput(path)).rejects.toThrow(
      "Invalid analysis input",
    );
    await expect(readInvestigationWorkflowInput(directory)).rejects.toThrow(
      "regular file",
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      readInvestigationWorkflowInput(path, abort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds nesting, cyclic values, payload size and active properties before reconciliation", () => {
    expect(() =>
      assertInvestigationWorkflowBudget("x".repeat(1024 * 1024 + 1)),
    ).toThrow("document budget");
    const nested = Array.from({ length: 33 }).reduce<unknown>(
      (value) => [value],
      null,
    );
    expect(() => assertInvestigationWorkflowBudget(nested)).toThrow(
      "nesting budget",
    );
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => assertInvestigationWorkflowBudget(cyclic)).toThrow("cycles");
    const active = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must never run");
      },
    });
    expect(() => assertInvestigationWorkflowBudget(active)).toThrow(
      "data properties",
    );
  });
});
