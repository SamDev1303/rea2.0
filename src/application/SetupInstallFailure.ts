export type SetupFailureCode =
  | "unsupported_host"
  | "download_failed"
  | "integrity_mismatch"
  | "authorization_or_package_manager_failed"
  | "launcher_missing"
  | "runtime_dependency_unavailable"
  | "unsupported_hopper_build"
  | "setup_cancelled"
  | "destination_exists"
  | "mount_failed"
  | "bundle_invalid"
  | "copy_failed"
  | "cleanup_failed";

export type SetupHopperInstallResult =
  | {
      readonly status: "installed";
      readonly launcherPath: string;
      readonly cleanupFailure?: string;
    }
  | {
      readonly status: "failed";
      readonly code: SetupFailureCode;
      readonly remediation: string;
    };
