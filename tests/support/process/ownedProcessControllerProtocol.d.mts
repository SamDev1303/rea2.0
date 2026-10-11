import type { OwnedProcessControllerResources } from "./ownedProcessControllerResources.mjs";
import type { OwnedProcessSelection } from "./ownedProcessTemplates.mjs";
export interface OwnedDirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
}
export interface OwnedFileIdentity extends OwnedDirectoryIdentity {
  readonly size: number;
  readonly sha256: string;
}
export interface OwnedProcessControllerData {
  readonly selection: OwnedProcessSelection;
  readonly control_root: string;
  readonly program: string;
  readonly scenario: string;
  readonly directories: readonly OwnedDirectoryIdentity[];
  readonly files: readonly OwnedFileIdentity[];
  readonly executable: OwnedFileIdentity;
}
export function ownedDirectoryIdentity(
  path: string,
  privateRoot?: boolean,
): Promise<OwnedDirectoryIdentity>;
export function ownedFileIdentity(
  path: string,
  resources?: OwnedProcessControllerResources,
): Promise<OwnedFileIdentity>;
export function validateOwnedProcessControllerData(
  data: unknown,
  resources?: OwnedProcessControllerResources,
): Promise<Record<string, unknown>>;
