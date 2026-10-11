import { expect, onTestFinished } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { processTest } from "../../support/process/processFixture.js";
import { startOwnedInspectorFixture } from "../../support/web/ownedInspectorFixture.js";
import { connectOwnedEvidenceFixture } from "../../support/cli/ownedEvidenceFixture.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../../../src/application/javascript/JavaScriptRuntimeObservationService.js";
import { observeJavaScriptRuntimeInputSchema } from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

processTest(
  "observes a real Node Inspector and releases attachments after cancellation and failures",
  async ({ processes }) => {
    const owned = await startOwnedInspectorFixture(processes);
    const { child, fixture, terminate } = owned;
    onTestFinished(terminate);
    const stderr = owned.stderr;
    const address = /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/u;
    await expect.poll(stderr, { timeout: 5000 }).toMatch(address);
    const socket = address.exec(stderr())?.[0];
    if (socket === undefined) throw new Error("Node omitted its Inspector URL");
    const endpoint = `http://127.0.0.1:${new URL(socket).port}`;
    const { session, client } = await connectOwnedEvidenceFixture();
    const call = (name: string, input: Record<string, unknown>) =>
      client.callTool({ name, arguments: input });
    const denied = await call("list_javascript_runtime_targets", {
      inspector_endpoint: endpoint,
    });
    expect(denied.isError).toBe(true);
    const provider = new V8InspectorProvider();
    const discovery = await listJavaScriptRuntimeTargets(provider, {
      inspector_endpoint: endpoint,
    });
    expect(discovery.ok).toBe(true);
    if (!discovery.ok) throw discovery.error;
    const targets = toolContract(
      "list_javascript_runtime_targets",
    ).outputSchema.parse(discovery.value);
    const id = targets.normalized_result.targets[0]?.target_id;
    if (id === undefined)
      throw new Error("Node Inspector target was not listed");
    const request = {
      inspector_endpoint: endpoint,
      target_id: id,
      observation_ms: 100,
    };
    const observed = await observeJavaScriptRuntime(
      provider,
      observeJavaScriptRuntimeInputSchema.parse(request),
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw observed.error;
    const observation = toolContract(
      "observe_javascript_runtime",
    ).outputSchema.parse(observed.value);
    expect(observation.normalized_result.scripts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ file_path: fixture }),
        }),
      ]),
    );
    const missing = await observeJavaScriptRuntime(
      provider,
      observeJavaScriptRuntimeInputSchema.parse({
        ...request,
        target_id: "../missing-target",
      }),
    );
    expect(missing.ok).toBe(false);
    if (missing.ok)
      throw new Error("Missing Inspector target unexpectedly observed");
    expect({ error: projectAnalysisError(missing.error) }).toMatchObject({
      error: {
        code: "target_unavailable",
        message: expect.stringContaining("Refresh target discovery"),
        details: { reason: "target_not_found" },
      },
    });
    for (const invalid of [
      {
        name: "observe_javascript_runtime",
        arguments: { ...request, observation_ms: -1 },
      },
      {
        name: "list_javascript_runtime_targets",
        arguments: {
          inspector_endpoint: endpoint.replace(
            "http://",
            "http://user:password@",
          ),
        },
      },
    ])
      expect((await call(invalid.name, invalid.arguments)).isError).toBe(true);

    const attachments = () =>
      (stderr().match(/Debugger attached/gu) ?? []).length;
    const detachments = () =>
      (stderr().match(/Debugger ending on/gu) ?? []).length;
    const before = attachments();
    const controller = new AbortController();
    const cancelled = observeJavaScriptRuntime(
      provider,
      observeJavaScriptRuntimeInputSchema.parse({
        ...request,
        observation_ms: 10_000,
      }),
      { signal: controller.signal },
    );
    await expect.poll(attachments, { timeout: 5000 }).toBe(before + 1);
    controller.abort(new Error("cancel live observation"));
    const cancelledResult = await cancelled;
    expect(cancelledResult.ok).toBe(false);
    if (cancelledResult.ok)
      throw new Error("Cancelled observation unexpectedly completed");
    expect(projectAnalysisError(cancelledResult.error)).toMatchObject({
      code: "cancelled",
    });
    await expect.poll(detachments, { timeout: 5000 }).toBe(attachments());
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    const recovered = await observeJavaScriptRuntime(
      provider,
      observeJavaScriptRuntimeInputSchema.parse(request),
    );
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw recovered.error;
    expect(session.recordEvidence(recovered.value)).toMatchObject({ ok: true });
    const retained = await call("get_evidence_bundle", {});
    expect(retained.isError).not.toBe(true);
    expect(retained.structuredContent).toMatchObject({
      result: { records: expect.arrayContaining([recovered.value]) },
    });
    await client.ping();
    await terminate();
    const unreachable = await listJavaScriptRuntimeTargets(provider, {
      inspector_endpoint: endpoint,
    });
    expect(unreachable.ok).toBe(false);
    if (unreachable.ok)
      throw new Error("Terminated Inspector remained available");
    expect({ error: projectAnalysisError(unreachable.error) }).toMatchObject({
      error: {
        code: "provider_unavailable",
        message: expect.stringContaining(
          "target process is running with debugging enabled",
        ),
        details: { reason: "endpoint_unreachable" },
      },
    });
  },
  30_000,
);
