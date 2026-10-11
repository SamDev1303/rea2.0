export type OwnedProcessSelection =
  | {
      readonly template:
        | "minimal"
        | "complete-report"
        | "delete-create"
        | "rewrite"
        | "stdin"
        | "printenv"
        | "raw-files"
        | "digest-only"
        | "sample-limit";
      readonly root: string;
    }
  | {
      readonly template: "cumulative";
      readonly root: string;
      readonly shortfall: 0 | 1;
    }
  | {
      readonly template: "symlink";
      readonly root: string;
      readonly target: string;
    }
  | {
      readonly template: "choices";
      readonly root: string;
      readonly truncated: boolean;
    }
  | {
      readonly template: "finalization";
      readonly root: string;
      readonly mode: "cooperative" | "ignoring" | "descendant";
      readonly timing:
        | "standard"
        | "descendant"
        | "default"
        | "cancel"
        | "invalid-budget";
      readonly exitCode?: 0 | 3;
    };
export function describeOwnedProcessTemplate(
  selection: OwnedProcessSelection,
  executable: string,
  programPath: string,
): {
  source: string;
  scenario: Record<string, unknown>;
  seeds: [string, string][];
  directories: string[];
  roots: string[];
};
