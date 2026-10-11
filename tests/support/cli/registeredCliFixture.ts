import { Cli } from "incur";
import type { CliInstance } from "../../../src/cli/types.js";

/** Exercise internal command registration with explicitly denying test producers.
 * Public admission is tested separately; this helper grants no host capability.
 */
export const serveRegisteredCliFixture = async (
  register: (cli: CliInstance) => void,
  argv: readonly string[],
) => {
  const cli = Cli.create("rea2", { sync: false });
  register(cli);
  let stdout = "";
  let requestedExit: number | undefined;
  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    await cli.serve([...argv], {
      env: {},
      exit: (code) => {
        requestedExit = code;
      },
      stdout: (value) => {
        stdout += value;
      },
    });
    return {
      stdout,
      exitCode: requestedExit ?? Number(process.exitCode),
      json: JSON.parse(stdout) as unknown,
    };
  } finally {
    process.exitCode = previousExit;
  }
};
