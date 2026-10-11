import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const disabledWorkflow = z.object({
  jobs: z.record(z.string(), z.object({ if: z.literal("${{ false }}") })),
});

describe("REA 2.0 publication is disabled", () => {
  it.each(["release.yml", "website-pages.yml"])(
    "disables every retained historical job in %s and rejects an enabled job",
    async (name) => {
      const workflow: unknown = parse(
        await readFile(`.github/workflows/${name}`, "utf8"),
      );
      const parsed = disabledWorkflow.parse(workflow);
      expect(Object.keys(parsed.jobs).length).toBeGreaterThan(0);
      for (const job of Object.keys(parsed.jobs)) {
        expect(
          disabledWorkflow.safeParse({
            ...parsed,
            jobs: {
              ...parsed.jobs,
              [job]: { if: "github.event_name == 'push'" },
            },
          }).success,
        ).toBe(false);
      }
    },
  );
  it("refuses the publication lifecycle before any network request", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/block-publication.mjs"],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publication is disabled");
  });
});
