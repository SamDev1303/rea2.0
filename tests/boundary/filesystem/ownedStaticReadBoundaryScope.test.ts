import { expect, it, vi } from "vitest";
import {
  assertOwnedStaticFixtureAcquisition,
  withOwnedStaticReadBoundary,
} from "../../../src/filesystem/OwnedStaticReadBoundary.js";

it("captures the admission mechanics before caller mutation and releases scope", async () => {
  const admitted = vi.fn(async () => undefined);
  const replacement = vi.fn(async () => undefined);
  const mechanics = { acquire: admitted, descriptor: () => undefined };
  await withOwnedStaticReadBoundary(mechanics, async () => {
    await Promise.resolve();
    mechanics.acquire = replacement;
    await assertOwnedStaticFixtureAcquisition(
      "/synthetic/archive.plist",
      "file",
    );
  });
  await assertOwnedStaticFixtureAcquisition(
    "/outside/no-operation-granted",
    "file",
  );
  expect(admitted).toHaveBeenCalledExactlyOnceWith(
    "/synthetic/archive.plist",
    "file",
  );
  expect(replacement).not.toHaveBeenCalled();
});

it("keeps concurrent and nested controller mechanics separate after failures", async () => {
  const first = vi.fn(async (_path: string) => undefined);
  const second = vi.fn(async (_path: string) => undefined);
  await Promise.all([
    withOwnedStaticReadBoundary(
      { acquire: first, descriptor: () => undefined },
      async () => {
        await Promise.resolve();
        await expect(
          withOwnedStaticReadBoundary(
            { acquire: second, descriptor: () => undefined },
            async () => {
              await assertOwnedStaticFixtureAcquisition(
                "/synthetic/nested",
                "file",
              );
              throw new Error("SYNTHETIC_FAILURE");
            },
          ),
        ).rejects.toThrow("SYNTHETIC_FAILURE");
        await assertOwnedStaticFixtureAcquisition("/synthetic/first", "file");
      },
    ),
    withOwnedStaticReadBoundary(
      { acquire: second, descriptor: () => undefined },
      async () => {
        await Promise.resolve();
        await assertOwnedStaticFixtureAcquisition("/synthetic/second", "file");
      },
    ),
  ]);
  expect(first.mock.calls.map(([path]) => path)).toEqual(["/synthetic/first"]);
  expect(second.mock.calls.map(([path]) => path).sort()).toEqual([
    "/synthetic/nested",
    "/synthetic/second",
  ]);
});
