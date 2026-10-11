/** Fixed compiled modules preserve the maintained HAR worker's sibling path.
 * No caller chooses modules, engines, environment or code through this loader.
 */
export const loadCompiledHistoricalCaptureFixture = async () => {
  const factory = (await import(
    new URL("../../../dist/composition/webNetworkCaptures.js", import.meta.url)
      .href
  )) as typeof import("../../../src/composition/webNetworkCaptures.js");
  const commands = (await import(
    new URL("../../../dist/cli/webNetworkCaptureCommands.js", import.meta.url)
      .href
  )) as typeof import("../../../src/cli/webNetworkCaptureCommands.js");
  const errors = (await import(
    new URL("../../../dist/domain/analysisErrorProjection.js", import.meta.url)
      .href
  )) as typeof import("../../../src/domain/analysisErrorProjection.js");
  return { ...factory, ...commands, ...errors };
};
