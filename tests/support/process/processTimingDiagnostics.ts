import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

type CaseId = "F159" | "F160" | "F161" | "F162" | "F163" | "F182";
type RuntimeRoute =
  | "owned-web-cli-browser"
  | "owned-web-cli-discovery"
  | "owned-cli-receiver-and-direct-producer-mcp-readback";
type Fact = string | number | boolean | null;
type Facts = Readonly<Record<string, Fact>>;
type Mark = (event: string, facts?: Facts) => void;
type Collect = (channel: "stdout" | "stderr", chunk: Buffer | string) => void;

const observeChild = (child: ChildProcess, mark: Mark, collect: Collect) => {
  child.stdout?.on("data", (chunk: Buffer | string) =>
    collect("stdout", chunk),
  );
  child.stderr?.on("data", (chunk: Buffer | string) =>
    collect("stderr", chunk),
  );
  child.once("error", (cause) =>
    mark("cli_receiver_error", { message: cause.message }),
  );
  child.once("close", (code, signal) =>
    mark("cli_receiver_closed", {
      exit_code: code,
      termination_signal: signal,
    }),
  );
};

const observeSettlement = (
  stage: string,
  promise: Promise<unknown>,
  mark: Mark,
) => {
  void promise.then(
    () => mark(`${stage}_resolved`),
    (cause: unknown) =>
      mark(`${stage}_rejected`, {
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  );
};

const cleanup =
  (name: string, release: () => Promise<unknown>, mark: Mark) => async () => {
    mark("cleanup_started", { owner: name });
    try {
      await release();
      mark("cleanup_completed", { owner: name });
    } catch (cause) {
      mark("cleanup_failed", {
        owner: name,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }
  };

const persist = async (
  directory: string,
  events: readonly Record<string, unknown>[],
  streams: { stdout: Buffer[]; stderr: Buffer[] },
  outcome: Record<string, unknown>,
) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = {
    "events.jsonl":
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "stdout.txt": Buffer.concat(streams.stdout),
    "stderr.txt": Buffer.concat(streams.stderr),
    "outcome.json": JSON.stringify(outcome) + "\n",
  };
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(records)) {
    await writeFile(join(directory, name), content, {
      mode: 0o600,
      flag: "wx",
    });
    hashes[name] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schema: "rea2.private.timing-diagnostics.v1",
      file_sha256: hashes,
      runtime_route: outcome.runtime_route,
      historical_cause: "unknown",
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
};

/** Private diagnostics for authored fixtures; supplies no execution authority. */
export const processTimingDiagnostics = (
  caseId: CaseId,
  runtimeRoute: RuntimeRoute = "owned-cli-receiver-and-direct-producer-mcp-readback",
) => {
  const started = performance.now();
  const utc = new Date().toISOString();
  const runId = `${utc.replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
  const directory = join(
    process.cwd(),
    ".artifacts",
    "pending-timing-discriminators",
    runId,
    caseId,
  );
  const events: Array<Record<string, unknown>> = [];
  const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const observed = { stdout: 0, stderr: 0 };
  let retainedBytes = 0;
  let truncated = false;
  let factsTruncated = false;
  const mark: Mark = (event, facts = {}) => {
    if (events.length >= 1024) {
      truncated = true;
      return;
    }
    const factTruncated = Object.values(facts).some(
      (value) => typeof value === "string" && value.length > 4096,
    );
    factsTruncated ||= factTruncated;
    events.push({
      sequence: events.length,
      case_id: caseId,
      event,
      utc: new Date().toISOString(),
      elapsed_ms: performance.now() - started,
      facts_truncated: factTruncated,
      facts: Object.fromEntries(
        Object.entries(facts).map(([key, value]) => [
          key,
          typeof value === "string" ? value.slice(0, 4096) : value,
        ]),
      ),
    });
  };
  const collect: Collect = (channel, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    observed[channel] += bytes.length;
    const keep = Math.min(
      Math.max(0, 1024 * 1024 - retainedBytes),
      bytes.length,
    );
    if (keep > 0) {
      streams[channel].push(Buffer.from(bytes.subarray(0, keep)));
      retainedBytes += keep;
    }
    if (keep < bytes.length) truncated = true;
    mark(`cli_${channel}`, { bytes: bytes.length, retained_bytes: keep });
  };
  mark("test_diagnostics_started");
  return {
    mark,
    collect,
    outcome: (event: string, value: unknown) =>
      mark(event, {
        code:
          typeof value === "object" && value !== null && "code" in value
            ? String(value.code)
            : null,
      }),
    observeChild: (child: ChildProcess) => observeChild(child, mark, collect),
    observeProducer: (promise: Promise<unknown>) =>
      observeSettlement("producer_capture", promise, mark),
    observeSettlement: (stage: string, promise: Promise<unknown>) =>
      observeSettlement(stage, promise, mark),
    cleanup: (name: string, release: () => Promise<unknown>) =>
      cleanup(name, release, mark),
    persist: () =>
      persist(directory, events, streams, {
        case_id: caseId,
        started_utc: utc,
        output_bytes_observed: observed,
        retained_bytes: retainedBytes,
        truncated,
        facts_truncated: factsTruncated,
        limits: {
          output_bytes: 1024 * 1024,
          events: 1024,
          fact_string_characters: 4096,
        },
        runtime_route: runtimeRoute,
        historical_cause: "unknown",
      }),
  };
};
