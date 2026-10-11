import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const translatedReadmes = [
  "README_zh.md",
  "README_zh-TW.md",
  "README_ja.md",
  "README_ko.md",
  "README_tr.md",
  "README_ru.md",
  "README_vi.md",
  "README_th.md",
  "README_de.md",
  "README_es.md",
  "README_fr.md",
  "README_uk.md",
  "README_pl.md",
  "README_pt-BR.md",
  "README_ar.md",
  "README_fa.md",
  "README_id.md",
] as const;

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

const shellExamples = (content: string): string[] =>
  [...content.matchAll(/```bash\s*([\s\S]*?)```/gu)].map((match) =>
    (match[1] ?? "").trim(),
  );

describe("onboarding documentation product facts", () => {
  it("keeps the installation MCP example aligned with the package registration command", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          [PRODUCT_IDENTITY.mcpServerKey]: expect.objectContaining({
            command: "NODE_EXECUTABLE",
            args: ["APPROVED_CHECKOUT/scripts/rea.mjs", "mcp"],
          }),
        }),
      }),
    );
  });

  it("marks translated npm onboarding as historical upstream documentation", async () => {
    const english = await readFile(resolve("README.md"), "utf8");
    expect(english).toContain(
      "Translated READMEs are historical upstream documentation",
    );
    expect(english).toContain("not instructions for this fork");
    for (const path of translatedReadmes) {
      expect(english, path).toContain(path);
      expect(
        shellExamples(await readFile(resolve(path), "utf8")).length,
        path,
      ).toBeGreaterThan(0);
    }
  });
});
