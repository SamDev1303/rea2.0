import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { snapshotOwnedFixtureInput } from "./OwnedFixturePolicyData.js";
import {
  PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES,
  snapshotPublicInvestigationInput,
} from "./PublicInputSnapshot.js";

it("keeps a valid public endpoint larger than the private grant budget immutable", () => {
  const input = {
    seed: { endpoint: "x".repeat(1024 * 1024 + 1) },
    array: [1, 2],
  };
  const snapshot = snapshotPublicInvestigationInput(
    "trace_application_feature",
    input,
  );
  input.seed.endpoint = "changed";
  input.array.push(3);
  expect(snapshot.seed.endpoint).toHaveLength(1024 * 1024 + 1);
  expect(snapshot.array).toEqual([1, 2]);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.seed)).toBe(true);
  expect(Object.isFrozen(snapshot.array)).toBe(true);
  expect(() => snapshotOwnedFixtureInput(snapshot)).toThrow(/fixture_input/u);
  expect(PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES).toBe(
    STDIO_DEFAULT_MAX_BUFFER_SIZE,
  );
});

it("rejects oversized public requests with a resource error, independent of fixture authority", () => {
  expect(() =>
    snapshotPublicInvestigationInput("trace_application_feature", {
      seed: "x".repeat(PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES),
    }),
  ).toThrow(AnalysisResourceConstraintError);
  expect(() =>
    snapshotPublicInvestigationInput(
      "read_evidence",
      Array(100_001).fill(null),
    ),
  ).toThrow(AnalysisResourceConstraintError);
  let nested: unknown = 0;
  for (let index = 0; index < 65; index++) nested = { nested };
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", nested),
  ).toThrow(AnalysisResourceConstraintError);
});

it("rejects accessor and conversion-bearing input without invoking its hooks", () => {
  let calls = 0;
  const accessor = {
    get secret() {
      calls++;
      return "private";
    },
  };
  const conversion = {
    toJSON() {
      calls++;
      return {};
    },
    valueOf() {
      calls++;
      return 1;
    },
  };
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", accessor),
  ).toThrow(AnalysisInputError);
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", conversion),
  ).toThrow(AnalysisInputError);
  expect(calls).toBe(0);
});

it.each([
  NaN,
  Infinity,
  () => undefined,
  Symbol("key"),
  new Date(),
  { [Symbol("key")]: 1 },
])("rejects non-plain or non-JSON input (%j)", (input) => {
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", input),
  ).toThrow(AnalysisInputError);
});

it("rejects cycles and throwing proxies with a secret-safe input error", () => {
  const input: { child?: object } = {};
  input.child = input;
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", input),
  ).toThrow(AnalysisInputError);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("private-value");
      },
    },
  );
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", proxy),
  ).toThrow("Invalid analysis input for read_evidence");
});

it("does not project a typed error supplied by input mechanics", () => {
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new AnalysisCapabilityUnavailableError(
          "target",
          "read",
          "private-target-value",
        );
      },
    },
  );
  expect(() =>
    snapshotPublicInvestigationInput("read_evidence", proxy),
  ).toThrow("Invalid analysis input for read_evidence");
});
