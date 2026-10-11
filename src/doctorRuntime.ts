import { systemDoctorHost, type DoctorHost } from "./application/Doctor.js";
import { inspectIdaRegistration } from "./ida/IdaDoctor.js";

/** Compose provider diagnostics at the outer CLI adapter boundary. */
export const createSystemDoctorHost = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): DoctorHost =>
  systemDoctorHost({
    environment,
    providerInspections: async () => [
      {
        id: "ghidra",
        configured: environment.GHIDRA_INSTALL_DIR !== undefined,
        available: false,
        providerVersion: null,
        registrationEnvironment: {},
        checks: [
          {
            name: "protected-host-engine-probe",
            ok: false,
            code: "capability_unavailable",
            detail:
              "Engine execution and selected Java probes require a verified trusted-tool boundary; no runtime probe ran.",
            remediation:
              "Use source research or a verified disposable environment for unfamiliar engines.",
            classification: "missing_analysis_engine",
          },
        ],
      },
      inspectIdaRegistration(environment.REA_IDA_MCP_CONFIG),
    ],
    linuxDemoRuntimeCheck: async () => ({
      name: "hopper-demo-runtime",
      ok: false,
      classification: "missing_dependency",
      code: "capability_unavailable",
      detail:
        "Private-display runtime probing is unavailable on protected hosts; no selected Python or namespace command ran.",
      remediation:
        "Use a verified disposable analysis environment for runtime diagnostics.",
    }),
  });
