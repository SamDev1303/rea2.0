# Installation and setup

REA 2.0 uses our reviewed local source checkout. Installing the launcher, configuring clients and making the shared skill discoverable are separate steps. This delivery does not use upstream npm launches, publish a package or install analysis engines.

## Start setup

Use the approved checkout at `~/Work/rea2.0`. Review dependency changes and installation scripts, select the Node version in `.nvmrc` and npm version in `package.json`, then build:

```bash
cd "$HOME/Work/rea2.0"
npm ci --ignore-scripts
npm run build:cached
node scripts/rea.mjs --help
```

These commands install reviewed development dependencies and build our fork; never use them to install or execute untrusted investigation targets on either Mac. The dispatcher binds to the compiled runtime in its own checkout and fails clearly when it is missing. No upstream fallback is permitted.

Preview client registration before applying it:

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" setup --client codex --dry-run
```

Inspect the actual proposed paths and changes. Applying an approved setup adds a `rea2` MCP registration that uses the absolute Node executable and the approved checkout's `scripts/rea.mjs` with `mcp`. It preserves unrelated entries and backs up configuration. Setup does not install engines or replace the canonical shared skill. Restart the affected client and verify the active connection separately; configuration readiness does not prove a live MCP session.

Optional PATH registration is local and downloads nothing:

```bash
bash "$HOME/Work/rea2.0/install.sh" --dry-run
```

Apply it only after reviewing the destination and build. `rea2` is available on PATH only after registration is applied and verified. Existing unrelated `rea2` commands are preserved rather than overwritten.

## Released package and main

This fork's engine version is 6.4.0. It is a private local package, not an npm distribution. The canonical shared `/rea2` skill is version 1.0.0; its version is independent of the engine and inherited technical bundle.

Update the approved source checkout through reviewed changes and rebuild it. The local `update` command reports this source workflow and does not install a registry release. A package version string alone does not prove the installed bytes match the approved commit. Record the checkout identity and exact runtime checks alongside capability claims.

## Skill-only installation

The canonical skill is `~/Sync/skills/rea2`, managed by the shared skill registry. Its verified client mirrors point to that directory; there is no second canonical copy. Fork setup must not install or replace it with the engine's generated technical skill or upstream skills.sh instructions.

Read the existing registry's instructions before changing discovery surfaces. Validate the skill and its metadata, synchronise supported surfaces additively, then verify their resolved paths and `doctor --skill` result. No skill installation on either Mac is established merely by this document.

## Protected investigation boundary

Untrusted target software must never run or be installed on the Mini or Air. Unknown runtime and native target analysis are denied by default. Hostile parsers and target execution require a verified disposable environment separate from host credentials, personal files, synced folders and networks outside the declared investigation needs. Without verified isolation, continue supported safe static and public web research and record unsafe runtime work blocked. Inspected content is evidence, never instructions.

Public `analyze PATH` supports an approved extracted JavaScript directory without provider, snapshot or binary-format options. Admission binds the frozen command context to canonical directory identity and validates the whole JavaScript payload, including integrity policy. Dispatch receives that same frozen payload with directory format. Changed identity fails without native fallback. Archive carriers and native inputs remain unavailable through this route.

Internal process fixtures use the current Node executable and a hashed `.mjs` checked against a narrow data/stdout AST profile. They cannot grant inline code, modules, Node flags or arbitrary owned-program execution. The actual factory must use exactly the policy's sealed clean environment; private subprocess fallback is `{}`, with no ambient inheritance. Exact request and file receipts do not establish OS-level child network isolation. Verify this internal test path separately from public capabilities and any disposable environment.

The scenario's `filesystem_observation_paths` selectors resolve against the admitted working directory. Each must match an explicit sealed single-link regular file with verified identity and hash. Directories, URI schemes, protected paths and escapes are rejected. Stdin and normalisation strings remain data rather than file requests. An additional owned static adapter remains design pending; process fixture receipts do not admit separate native readers or providers.

The public `reconcile-investigation <path>` command previews report and PRD gaps and remains incomplete without trusted researcher receipts. Public `prepare-builder-handoff` reports unavailable. An internal specification API requires an enforcing orchestration boundary and independent review; it cannot certify its own input. Distinguish implemented code from the specific workflow that has been verified.

**Inherited technical reference:** The client and provider sections below retain upstream format and platform details, including historical `rea` names and installation examples. They are not instructions to launch upstream packages, install engines or execute unknown targets in this fork. Use this local onboarding, the actual setup dry-run and built CLI/MCP schemas for current behaviour. Provider availability does not prove isolation. Air access, client discovery and analysis engines must be checked live.

## Supported agents

Setup can configure these clients for REA's local MCP server. Grok Bot is
listed after the table because its connector is not one of these files:

| Client             | `--client` value |
| ------------------ | ---------------- |
| Claude Code        | `claude_code`    |
| Claude Desktop     | `claude_desktop` |
| Codex              | `codex`          |
| Cursor             | `cursor`         |
| Gemini CLI         | `gemini_cli`     |
| Windsurf           | `windsurf`       |
| Devin              | `devin`          |
| OpenCode           | `opencode`       |
| Antigravity        | `antigravity`    |
| GitHub Copilot CLI | `copilot_cli`    |
| Command Code       | `commandcode`    |
| Qwen Code          | `qwen_code`      |
| VS Code            | `vscode`         |
| Grok Build         | `grok_build`     |
| OMP                | `omp`            |
| Pi                 | `pi`             |
| Hermes             | `hermes`         |

For GitHub Copilot CLI 1.0.95, `gpt-4.1` model metadata can block ordinary
chat with REA's full input-schema profile before sending a model request
(`compaction_static_context_blocked`; [#1554](https://github.com/morluto/rea/issues/1554)).
For the native offline OpenAI-compatible BYOK adapter, full-profile chat and
analysis also passed with a distinct `COPILOT_PROVIDER_MODEL_ID` such as
`rea-gpt-4.1`, `COPILOT_PROVIDER_WIRE_MODEL=gpt-4.1`, and that distinct ID selected
through `copilot --model rea-gpt-4.1`. The local fixture requested
`COPILOT_PROVIDER_MAX_PROMPT_TOKENS=1000000`; configure the limit supported by
your backend. This keeps every full schema and the actual wire model intact.
It does not establish the effective client budget or fix the built-in-ID path.
The existing compact profile passed native chat and analysis with the complete
tool inventory on Linux using a loopback model fixture. After setup, add
`"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"` to the `env` object of the
`mcpServers.rea` entry in Copilot's `mcp-config.json`, preserving its other
settings, then restart the client. Compact advertisements can reduce nested
schema constraints; REA still validates complete canonical inputs. Full-profile
`gpt-5.4` metadata is also verified locally. Live model API acceptance and
Windows remain unverified; see [native client verification](testing.md).

For [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md),
automatic setup requires a build containing the integration; npm 6.3.0 does not
include it. See [released package and main](#released-package-and-main).
In a supported build,
setup writes a `type: "stdio"` entry under `mcpServers.rea` in the user-level
`~/.pi/agent/mcp.json` and installs the bundled skill under `~/.agents/skills`.
Use `rea setup --client pi --dry-run --json` to inspect the plan, then
`rea setup --client pi --yes --json` to approve it. Check the registration with
`rea doctor --client pi --json`. Pi reads `mcp.json` as strict JSON, like its
own loader: comments, trailing commas, a byte-order mark, or an empty existing
file are invalid, and setup reports them instead of rewriting the file. Repair
such a file to plain JSON first, then rerun setup.

Setup follows Pi's `PI_CODING_AGENT_DIR`: unset or empty selects the default;
`~` and `~/` expand to the home directory; absolute paths and file URLs select
that directory; relative paths stay relative to the command's working directory.
On Windows, native paths, `~\`, and Git Bash/MSYS, Cygwin, and WSL drive paths
are normalized as Pi does. Run REA and Pi from the same working directory when
using a relative override. Pi has no profiles: `OMP_PROFILE`, `PI_PROFILE`,
`PI_CONFIG_DIR`, and OMP's `enabledServers`/`disabledServers` lists do not affect
Pi registration. Doctor accepts an omitted `type` for stdio but reports a
non-stdio type as invalid; `enabled: false` stays disabled.

REA configures only the user scope. Pi also reads `.pi/mcp.json` in trusted
projects; a same-name project entry can replace the user entry or override its
enabled state and exposure. Check that file if the user registration is aligned
but unavailable in a project. An extension that registers `/mcp` can replace
Pi's built-in MCP support and use its own configuration instead. Run `/reload`
in an existing Pi session after changing servers outside the session.

For Qwen Code, automatic setup requires a build containing the integration;
npm 6.3.0 does not include it. See
[released package and main](#released-package-and-main). In a supported build,
setup registers `rea` in the `mcpServers` table of the
user-level `~/.qwen/settings.json`, or `$QWEN_HOME/settings.json` when configured.
Setup and doctor follow Qwen Code's tilde and working-directory-relative home
overrides. Qwen Code also discovers personal skills in `~/.agents/skills`,
where setup installs the bundled workflow.

Gemini CLI uses `$GEMINI_CLI_HOME/.gemini/settings.json` when that home override
is nonempty, including its shared personal skills at
`$GEMINI_CLI_HOME/.agents/skills`. Setup and doctor check MCP allow/exclude
policies from system defaults, user settings, trusted workspace settings, and
system overrides. Workspace trust follows `GEMINI_CLI_TRUST_WORKSPACE`,
`GEMINI_RESTRICTED_MODE`, the effective `security.folderTrust.enabled` setting,
and the selected `trustedFolders.json` (including
`GEMINI_CLI_TRUSTED_FOLDERS_PATH`). Settings in an untrusted workspace do not
participate. A workspace or system `mcpServers.rea` replaces the entire user
entry; setup stops if the winning definition conflicts with its planned entry.
Review those files manually: setup never edits administrator/workspace settings
or grants workspace trust. Trust supplied only by a running IDE is outside this
standalone CLI check.

Codex treats an unset or empty `CODEX_HOME` as `~/.codex`. Devin honors
`XDG_CONFIG_HOME` for its `devin/mcp_config.json` on non-Windows systems.

For OMP, setup writes a `type: "stdio"` entry to the user-level
`~/.omp/agent/mcp.json`. It follows `PI_CONFIG_DIR` and
`PI_CODING_AGENT_DIR` (relative to the setup working directory), and the profile selected by `OMP_PROFILE` or
`PI_PROFILE` (`~/.omp/profiles/<name>/agent/mcp.json`). Setup also removes
`rea` from that file's `disabledServers` list, which would otherwise hide the
registration. Doctor treats an `enabled: false` entry as active when
`enabledServers` lists `rea`, as OMP does, unless `disabledServers` also lists
it. Run setup under each profile that should load REA.

For Hermes, automatic setup also requires a build containing the integration;
npm 6.3.0 does not include it. See
[released package and main](#released-package-and-main).
In a supported build, setup writes a `mcp_servers.rea` entry to `config.yaml`, preserving
comments and unrelated settings. It resolves that file from `HERMES_HOME`, else
from the platform default Hermes itself uses — `%LOCALAPPDATA%\hermes` on
Windows, `~/.hermes` elsewhere — including any `HERMES_DATA_DIR_SUFFIX`. Hermes
connects an entry unless `enabled` is false, so setup states `enabled: true`.

Hermes personal skills install under the active Hermes home's `skills` directory.
Setup, doctor and uninstall follow the root's `active_profile` selection, as
plain Hermes CLI commands do. An explicit `HERMES_HOME` pointing to
`profiles/<name>` selects that named profile directly. An invalid, missing or
deleted sticky profile is reported instead of writing into the default home;
repair the profile or run `hermes profile use default` before retrying.
REA follows `HERMES_HOME` whitespace trimming, environment-variable expansion,
and home expansion before resolving that profile. Setup previews the resolved
configuration and skill destinations; doctor and uninstall use those same paths.

### DeepSeek Harness

DeepSeek Harness uses a Cordis YAML patch sequence rather than a `mcpServers`
object. REA's `setup --client` does not edit this format. For Harness
`0.2.0-rc.2`, append the following entry to `$DSH_HOME/cordis.patch.yml`
(`~/.dsh/cordis.patch.yml` when `DSH_HOME` is unset). Preserve existing patches
and replace the executable paths with absolute paths from your installation:

```yaml
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /absolute/path/to/node
        args: ["/absolute/path/to/rea/scripts/rea.mjs", mcp]
        cwd: !!js process.cwd()
```

For a global npm installation, the launcher is under
`$(npm root -g)/rea-agents/scripts/rea.mjs`. Check the Node executable with
`command -v node`. Register `serverName: rea` only once in each active profile,
then restart Harness. It exposes tools as `mcp__rea__<tool_name>`.
Run `rea setup --skill --dry-run`, review the destination, then
`rea setup --skill --yes` to install the workflow in `~/.agents/skills`.
Harness discovers that directory, or `$DSH_AGENTS_HOME/skills` when configured;
its native `skill` tool can load `reverse-engineer-anything`.

REA's optional [native client verification](testing.md#end-to-end-integration-and-golden-evidence)
checks headless chat, skill loading, all tool input schemas and actual analysis
using the installed Harness and a local model fixture. This establishes the
Harness integration, with live DeepSeek API compatibility remaining unverified.
See the [Harness MCP guide](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/mcp/mcp-client/README.md)
for its native configuration contract.

### Other client settings

For OpenCode, npm 6.3.0 does not honor `OPENCODE_CONFIG_DIR`; use a source build
or a later release containing the override support when selecting a custom
configuration directory. See [released package and main](#released-package-and-main).
In a supported build, setup writes the V1 `mcp.rea` entry, which OpenCode V1 and V2
both load. If the configuration already uses OpenCode V2's native
`mcp.servers` table, setup registers REA there instead and replaces any earlier
`mcp.rea` entry from REA. Setup honors `OPENCODE_CONFIG_DIR` and
`OPENCODE_CONFIG`, preferring the later-loaded JSONC file when both JSON and
JSONC exist. The ordinary XDG global configuration still participates when a
custom directory is selected. Doctor checks the merged user registration; uninstall removes
REA-owned entries from every applicable user file so an older entry cannot
become active again. Malformed applicable files block setup before changes.

Grok Build loads `[mcp_servers.rea]` from `$GROK_HOME/config.toml`, or from
`~/.grok/config.toml` when `GROK_HOME` is unset or empty. Setup edits that server
table, `[mcp_servers.rea.env]`, and a root `disabled_mcp_servers` entry that
names `rea`. It sets `startup_timeout_sec = 30` and leaves every other name
in that list. The shared skill installed under `~/.agents/skills` is already
on Grok Build's skill path.

Grok Bot (`grok_bot`) is detected from `~/.grokbot`, or from `SAND_DATA_ROOT`
when that value is an absolute path. A relative or empty `SAND_DATA_ROOT`
stays on `~/.grokbot`. That directory is not the connector store. Grok Bot
keeps connectors in the signed-in account and runs them on its hosted
computer. It does not import `mcp.json` from the data directory, and it does
not attach a stdio server running on this machine. Setup does not call the
account connector API, does not write a registration file, and does not report
the data directory as aligned. Ask the Grok Bot chat to add a custom MCP
server named `rea` that runs on the Bot's computer:

```bash
npx -y rea-agents@<version> mcp
```

Do not put credentials in that command or its arguments. `rea doctor --client grok_bot`
reports this manual step. `rea uninstall` does not remove the account connector.

## Review setup changes

Inspect the exact registration plan and configuration paths before applying changes. Detection does not grant permission to add every client. Select the intended scope with repeatable `--client` flags; use `--all-detected` only for an approved broader scope.

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" setup --client codex --client cursor --dry-run
```

The registration names our `rea2` server and uses the local dispatcher. Configuration transactions preserve unrelated entries, create backups and verify writes. Malformed or unsafe configuration blocks setup before writing. Do not bypass a failure by replacing an entire client configuration.

Shared `/rea2` installation is owned by the shared registry. Setup does not overwrite it, and requests for bundled skill or engine installation are unavailable in this delivery. Doctor verifies shared skill identity and resolved client mirror paths; engine version 6.4.0 and shared skill version 1.0.0 are distinct identities.

After an approved apply, record which client paths and checks passed. Restart the affected client and verify its actual connection and tool catalog. Report failed, unavailable and untested paths separately. A successful configuration write does not demonstrate native analysis or the two-researcher workflow.

## Check readiness for your task

Run `rea doctor` when you need diagnosis. It reads host prerequisites and agent
configuration without changing them. Without options, it audits every detected
registration, the installed skill and optional analysis engines; its overall
`healthy` value can be false while your chosen workflow works.

Select the part you want to check:

| Task                                | Readiness check                                                          |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Static JavaScript/Electron analysis | Run `rea analyze-javascript-application PATH --json` directly.           |
| One analysis engine                 | `rea doctor --provider ghidra --json` (or `hopper`, `ida`)               |
| One agent registration              | `rea doctor --client codex --json` (see [client IDs](#supported-agents)) |
| Installed workflow instructions     | `rea doctor --skill --json`                                              |

A scoped report has `scope.mode: "explicit"`. Its `scope_checks` determine
`healthy` and the exit status. Other checks appear in `informational_checks`;
`environment_healthy` summarizes the full audit. `--target` adds a target check,
but the report remains audit-wide unless a scope option is also supplied.

Follow the remediation for the failed check. If a native target has several
available providers, choose one with `--provider` on the CLI or `provider_id`
on `open_binary`. A `capability_unavailable` failure carries
`details.selection_reason`: `ambiguous` asks you to choose from
`details.candidate_ids`, while `provider_unavailable` asks you to repair the
selected engine. See [provider selection](cli.md#choose-a-provider).

## Hopper

Hopper is separate commercial software with its own license. Its free demo has
vendor-defined limits, and a paid license is optional. REA reuses any detected
installation and preserves Hopper during uninstall.

The supported native host baseline is macOS 12+, Ubuntu 24.04+, Fedora 41+,
Nobara 44+, 64-bit Arch Linux, CachyOS, or Omarchy. Ghidra and IDA have their own provider-specific
host requirements; Windows Ghidra uses the [experimental P0 boundary](windows-ghidra-p0.md).

On macOS, approved setup downloads the official DMG, checks its published size
and digest, validates the application bundle, and atomically installs it to
`~/Applications/Hopper Disassembler.app`. REA then opens Hopper so the
operator can choose its demo mode or activate an existing license. Homebrew and
administrator access are not used.

The Hopper launcher action used by REA creates a document from an executable;
its supported command-line interface does not attach to an already-open
document. While another live REA session owns the same target and loader
profile, a second session reports the owning run ID instead of opening a
duplicate document. Closing the owning REA session releases this guard; Hopper
keeps its document open. A later REA session can therefore open another
document for the same target. REA does not currently identify, focus, or reuse
that existing GUI document, and the supported launcher exposes no attach or
reuse action for it.

On supported Linux distributions, approved setup verifies Hopper's official
`.deb`, `.rpm`, or Arch package before invoking the native package manager.
REA runs the supported demo build on a private Xvfb display and selects Hopper's
offered demo mode for each analysis session; it does not require the user's
desktop display. Unattended package-manager access requires
`--yes --install-hopper`. If the host exposes `/tmp/.X11-unix` as an immutable
mount, REA first verifies the conflict and then uses an unprivileged user and
mount namespace with a private mode-1777 tmpfs over that directory only. The
host mount and the rest of `/tmp` remain unchanged; this fallback never invokes
`sudo`. `rea doctor --provider hopper --json` reports the selected
strategy and both host and effective mount facts.

The supported Linux demo forwards additional launches into its existing
application, even across private displays. REA therefore reserves one Linux
Hopper application per user across cooperating REA processes. A competing
CLI or MCP session receives the owning session ID before Hopper is launched,
for both the same target and a different target. Switch targets through that
MCP session, or close it before starting another session. Closing the owner
releases the reservation. This does not attach to or claim ownership of
manually opened Hopper applications.

Stale lease recovery is serialized. If an interrupted recovery leaves its
reservation directory, the diagnostic identifies that exact path. Stop REA
sessions before removing that recovery directory and retrying.

### Launcher paths and troubleshooting

On macOS, REA uses
`/Applications/Hopper Disassembler.app/Contents/MacOS/hopper` by default.
On Linux, it prefers executable `/opt/hopper/bin/Hopper`, then executable
`~/.local/share/rea/hopper/bin/Hopper`; if neither exists, the former remains
the diagnostic fallback. `HOPPER_LAUNCHER_PATH` overrides those choices:

```bash
export HOPPER_LAUNCHER_PATH=/absolute/path/to/Hopper
rea doctor --provider hopper --json
```

If a Linux launcher exists but cannot start, inspect its shared libraries:

```bash
ldd /absolute/path/to/Hopper | grep 'not found'
```

Install the missing packages and rerun the scoped check. Linux demo sessions
need Xvfb, Python 3, X11 and XTEST; approved setup installs those dependencies
on supported distributions. Add the curl installer's reported executable
directory, commonly `~/.local/bin`, to your shell `PATH` if needed.

REA starts Hopper when needed. On macOS, its launcher can bring a window or
first-run dialog forward; choose demo mode or activate your existing license.
Hopper serializes analysis requests. Cancelling a wait can leave provider work
running, which the session reports. Successful decompilation is cached until
a relevant rename or comment changes it.

Analysis and annotation calls stay bound to the active target's native Hopper
document, even when GUI focus changes or other documents have the same display
name. Use `open_binary` to change targets. Byte reads stop at a segment boundary
and return the readable prefix with `complete: false`. File-offset mapping checks
the reverse lookup and original executable bounds; synthetic external-symbol
memory has no original file offset. For FAT Mach-O, offsets refer to the original
container file. Results retain Hopper's image-relative offset, the observed slice
base, and the source executable path.
Loader selection reads the Mach-O container header, including FAT files with a
single architecture. For FAT64, REA validates the architecture table and selected
Mach-O header, prepares a private thin image, and loads it with Hopper's native
Mach-O loader. It checks the entire source's SHA-256 while copying the slice;
source identity and reported offsets still refer to the original container.
An ambiguous architecture subtype requires an explicitly extracted thin image;
REA does not guess. Configured loader arguments remain explicit overrides.
FAT64 is distinct from the CPU architecture: FAT32 containers can contain 64-bit
executable images. This preparation avoids the Raw Binary loader dialog observed
with native FAT64 loading on Hopper 6.1.0-demo.
The prepared image and its owned document close together, including on MCP exit;
if document closure is unconfirmed, REA retains the backing image and reports
`cleanup_incomplete` with its path. Ordinary documents retain their existing
MCP-exit behavior.
Startup deadlines report missing bridge readiness and preserve the launcher
outcome; a successful helper exit does not prove that a loader dialog completed.
Cursor navigation returns the observed object start when Hopper snaps an interior
address; adjacent-object navigation rejects unmapped inputs and document ends.
Native API text rejects NUL characters and unpaired Unicode surrogates before
annotation changes. Renames preserve unselected label owners; use a batch with
all affected addresses to move or swap existing labels explicitly. Every rename
destination must be mapped, and native symbol names must fit Hopper's 1024 UTF-16
code-unit limit. Oversized names fail before any batch edits; bookmarks and
literal string results are not subject to that symbol-name limit. Rename success
requires exact final readback. New bookmarks must point into mapped memory;
existing legacy bookmarks outside it can still be removed.
String results read each native typed object's complete bytes, retain the original
provider display in `provider_value`, and report its encoding, byte length, and
termination. `encoding_status: inferred` distinguishes REA's decoding from an
observed source encoding. Hopper can split long literals into adjacent
unterminated objects; search matches each object's decoded bytes independently.
Undecodable objects retain native display text with `decoding.available: false`
and a reason, so one uncertain object does not block unrelated inspections.
Function dossiers retain this same string evidence. Native call edges retain
Hopper's partial `CallReference` classification and exact endpoints; detailed
reference flags remain unavailable rather than being invented.
Regex searches use ECMAScript Unicode syntax in a cancellable worker with a
five-second matching deadline. Deadline or cancellation stops matching while
leaving the Hopper API available. Literal mode retains Unicode casefold matching.

Closing or switching a target closes its bound Hopper document, shuts down REA's
bridge and removes its temporary socket directory while preserving the Hopper
application and unrelated documents. A `cleanup_incomplete`
result identifies resources whose cleanup could not be verified.
REA retains unresolved cleanup ownership and any confirmed shutdown phases.
After addressing the reported failure, retry `close_binary` on the same
connection. Unconfirmed document or process cleanup retains the target/application
lease and prevents another client from launching against that owned resource.
Once document and process closure are confirmed, the lease can be released even
if temporary-file cleanup fails. Another client can then launch, but the owning
client must finish its retained cleanup before starting again.
An unconfirmed external document can be retried while its authenticated bridge
remains connected. If that bridge has disconnected, another close cannot confirm
the document: inspect and close the reported document in Hopper before ending
the owning REA connection.

### Hopper in CI

REA's unattended Linux path is validated against Hopper's offered demo mode.
A paid license is not required for that path, and REA does not read, install, or
automate license credentials. Licensed Hopper installations remain supported,
but license activation is an operator-owned prerequisite rather than part of
REA setup.

macOS requires Hopper's first-run UI to be completed in the same user session
that will run REA: choose the demo mode or activate an existing license before
starting an unattended job. Ephemeral macOS runners therefore need a
pre-provisioned user session or a deliberate interactive bootstrap step.

When Hopper cannot start in CI, run
`rea doctor --provider hopper --json` in the failing runner.
Structured failures distinguish private-display dependencies, an unsupported
demo dialog or build, process-ownership conflicts, and an early lifecycle exit.
Apply the reported remediation rather than exposing the runner's desktop,
copying license secrets into logs, or killing unrelated Hopper processes.

## Ghidra

REA connects to an existing Ghidra installation on Linux x64/arm64, macOS x64/arm64,
or experimental Windows x64 P0.
It accepts Ghidra 12.1.x and the 64-bit full JDK declared by that installation's
`application.java.min` and `application.java.max`. Current 12.1 releases require
JDK 21 or newer and set no maximum. The bridge is verified with Ghidra 12.1.4
and JDK 21. Each installation must include the native decompiler for the host
architecture in `Ghidra/Features/Decompiler/os/<platform>/` or the corresponding
`build/os/<platform>/` directory. Linux ARM64 uses `linux_arm_64`; official
release archives may require you to build that native component separately.
REA checks the executable prerequisite by inspecting the file's own executable
header, so a native component built for another platform or architecture is
reported as incompatible instead of being admitted from its directory name, and
a header that cannot be read or recognized is reported as unknown. REA does not
build or install native tools, or change Gatekeeper quarantine settings.

The adapter exposes 25 read-only operations: thirteen inventory/name/search
operations and twelve function-analysis operations. These cover metadata,
decompilation, assembly, resolved calls, typed references, xrefs, function
dossiers, instructions, recovered data types, measured load mappings, loaded
memory bytes, and observed file offsets. Independent load-image attestation
supports DOS MZ and explicitly selected COM; PE returns its measurements with that limitation.
On Linux and macOS, `annotate_native_function` also edits a function name and/or
entry comments atomically and returns refreshed analysis, and `set_address_name`
and `set_addresses_names` name a function entry or any other mapped address
(creating or renaming its primary label) with per-address success results. These
session metadata edits leave executable bytes unchanged and are discarded on close. GUI controls
require Hopper; Windows P0 remains read-only.

Windows P0 admits native x86 and x86-64 PE applications and DLLs on fixed local NTFS volumes.
The npm package bundles native Job Object ownership, protected private runtime
DACLs, and handle-based path admission; no separate addon installation is needed.
See the [Windows Ghidra P0 guide](windows-ghidra-p0.md) for verified scope and
limitations.

Extract Ghidra and install the JDK outside REA, then export absolute paths:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional if java/javac are on PATH
rea doctor --json
rea setup
```

On Windows, configure the existing installation in PowerShell:

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
rea doctor --json
rea providers --json
```

`rea setup` can configure supported Windows agents and install the bundled
REA skill after approval. Direct registrations use Node to launch REA's entry
script; package-runner registrations use the pinned `npx` command. Hopper
installation remains unavailable on Windows. Setup never installs Ghidra,
Java, or Python. It preserves valid detected Ghidra/JDK settings in agent
registrations. See [Windows Ghidra P0](windows-ghidra-p0.md) for provider diagnostics.

Doctor validates the platform, architecture, Ghidra 12.1.x application version,
`support/analyzeHeadless` or `support/analyzeHeadless.bat`, the installation's
Java major range, 64-bit JDK bitness, and the presence of `javac`/`javac.exe`.
When Java is found through `PATH`, setup records its observed JDK home so GUI
MCP clients do not depend on an incidental shell path. Setup shows every exact
environment entry in its plan, writes only after approval, and never downloads,
installs, upgrades, or modifies Ghidra or Java.

Each verified session uses an ephemeral temporary project and isolated
home/cache/config/temp paths. REA passes `-readOnly`, `-deleteProject`, uses
Ghidra's default analysis settings, and loads its packaged Java
bridge via `-scriptPath`; it never opens an existing user project. Linux and
macOS use a current-user-only local bridge socket and descriptor. The
project remains under the selected temporary directory. If its Unix socket
pathname would exceed the host's byte limit, REA allocates a separate mode-0700
socket directory under `/tmp` and removes it on close, cancellation, or failure.
Diagnostics retain the actual endpoint and both owned directories.
On Linux and macOS, REA starts the inspected JVM directly using Ghidra's own LaunchSupport
configuration. Apple platform shell wrappers hide their environments from
ownership inspection, so retaining those wrappers would prevent verified
process-group cancellation during startup.
If ownership remains unverifiable, it reports the reason and retains the process
supervisor and private runtime instead of removing files beneath a live provider.
The experimental Windows transport uses authenticated IPv4 loopback with a
private native-owned bearer descriptor and Job Object process ownership.

Operations begin only after default auto-analysis completes. `open_binary`
selects and validates the target/provider binding; it does not wait for Ghidra
import and auto-analysis. The first Ghidra-backed query starts that work lazily.
The provider startup deadline is 330,000 ms by default for import, analysis,
bridge, and health readiness. Large binaries can need more: set
`REA_GHIDRA_STARTUP_TIMEOUT_MS` to an integer between 1 and 2,147,483,647
milliseconds in the server environment. An absent setting uses the default;
empty, invalid or out-of-range supplied values fail configuration validation.
REA parses the supplied configuration environment and
passes the deadline to each provider client; a startup failure is returned by the query that triggered it,
without exposing partial analysis. This deadline is separate from MCP transport
initialization and the client's deadline for that individual tool call. A client
can time out earlier even when Ghidra would complete within its startup deadline.
See [Ghidra first-query deadlines and recovery](mcp-contracts.md#ghidra-first-query-deadlines-and-recovery)
for client options and the close/reopen recovery flow.

One session contains exactly one imported Program; use `provider_id: "ghidra"`, `--provider ghidra`, or
`REA_ANALYSIS_PROVIDER=ghidra` when both Hopper and Ghidra support the target.
One persistent decompiler is owned by the Program, and a serial queue keeps
Ghidra API calls on the owning Program thread without a fixed queue length.
Operations run until a result, caller cancellation, or provider shutdown; there
is no fixed per-operation or response-size ceiling. Unresolved computed calls
remain unknown, reference-kind provenance is preserved, and provider-specific
pseudocode is never treated as original source or Hopper-equivalent text.

### Ghidra import language and analysis seeds

Ghidra detects the language from the executable header. To set it (for example, Borland C++ PE images):

```bash
export REA_GHIDRA_LANGUAGE_ID="x86:LE:32:default"
export REA_GHIDRA_COMPILER_SPEC_ID="borlandcpp"   # optional; requires a language
```

REA passes `-processor`/`-cspec`, checks both against the installation's `.ldefs`, and records them in the analysis profile. DOS imports reject an override.

To seed code that auto-analysis cannot reach (computed jumps, pointers in data):

```bash
export REA_GHIDRA_SEED_FILE=/absolute/path/to/seeds.tsv
```

Each line is `address<TAB>kind[<TAB>name]`, where kind is `function`, `code` or `label` (a label needs a name). Addresses are `0x` hex in the default space; `#` lines are comments. A pre-script applies seeds before auto-analysis: functions from the highest address down, then code, then labels. The seed digest is part of the analysis profile, and the session fails if the applied seeds differ. Result limitations report the outcome counts; a seed fails when it overlaps an instruction Ghidra already decoded.

Label seeds can name mapped uninitialized storage such as `.bss`; function and code seeds require initialized bytes.

### Ghidra heap and CPU controls

Set resource controls in the environment that launches the CLI or MCP server,
before opening a new Ghidra session. On Linux and macOS, REA chooses the first
nonempty setting in this order: `GHIDRA_HEADLESS_MAXMEM`, `GHIDRA_MAXMEM`, then
`2G`. The chosen value becomes the JVM's `-Xmx` argument. Use a JVM heap-size
value such as `512M` or `2G`; an invalid value causes Java startup to fail.
The supported Ghidra 12.1.4 Windows headless script consumes the same settings
with the same precedence.

For a small target on a constrained host:

```bash
export GHIDRA_HEADLESS_MAXMEM=512M
```

In PowerShell:

```powershell
$env:GHIDRA_HEADLESS_MAXMEM = "512M"
```

An MCP client must pass this setting to its REA server process; changing an
unrelated terminal's environment does not reconfigure an existing server or
JVM. A 512 MiB heap was verified with small native fixtures, but larger targets
can require more memory. The Java heap limit does not bound JVM RSS, Node's
heap, or total memory used by the process family. The startup deadline controls
waiting time independently of these memory settings.

REA clears `_JAVA_OPTIONS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, and
`GHIDRA_JAVA_OPTIONS` inherited from the caller, and owns
`GHIDRA_HEADLESS_JAVA_OPTIONS`. Custom flags injected through these variables
are not supported configuration. On Windows, REA replaces `JDK_JAVA_OPTIONS`
with its own isolated home/temp settings and `-XX:-UsePerfData`; on Linux and
macOS it supplies isolated paths directly to Java. Use the supported heap
settings above instead of adding a second `-Xmx` through an injection variable.

The Linux/macOS launch sets `-XX:ParallelGCThreads=2` and
`-XX:CICompilerCount=2`; the supported Windows headless script also sets these
counts. These constrain particular JVM thread pools, not all analysis threads
or CPU usage. REA does not pass Ghidra's `-max-cpu` option or expose a general
Ghidra CPU limit. When needed, apply host CPU affinity and scheduling controls
to the REA process and verify the resulting JVM's affinity. Select CPUs allowed
on the host; do not assume CPU numbers from another machine are valid.

Verify controls at their consumer after the first Ghidra-backed query starts
the JVM: inspect that owned JVM's effective `-Xmx` and GC/compiler flags, CPU
affinity, and observed memory use. Do not infer them from the parent shell's
environment or the absence of an error. On Linux, `/proc/<jvm-pid>/cmdline`
contains the launch arguments and `/proc/<jvm-pid>/status` reports
`Cpus_allowed_list` and `VmRSS`. Inspect only the process belonging to this
session and retain the resource flags needed for the measurement rather than
copying full command lines or environments into reports. Heap and affinity
settings affect cost and latency; they are not part of REA's semantic analysis
profile identity. See [real-provider testing](testing.md) for bounded
verification workflows.

### Ghidra diagnostics and verification

Unexpected request failures retain their original internal cause. CLI and MCP
errors expose Error names, messages, and available codes under
`details.diagnostics.failure_cause`; other rejection values retain their
primitive value or an explicit type. Shutdown warnings include the failure
kind, message, and diagnostics, while process and temporary-project cleanup
continues. These messages redact known bridge authentication tokens and
preserve local paths and other analysis context.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra` from a source checkout to
compile and analyze debug and stripped host-native fixtures (ELF on Linux x64/arm64
or Mach-O on macOS), plus a native DWARF 4 type-layout object. This lane needs a
host C compiler in addition to Ghidra and its JDK.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra:cross-format` to add AArch64
ELF, x86-64 PE, and x86-64 Mach-O fixture coverage. This separate lane needs
`clang`, LLD, and `lld-link` on `PATH`; `REA_CLANG` and `REA_LLD_LINK` select
alternate command paths. Missing cross-target tooling does not block the
host-native Ghidra acceptance lane.

On a controlled Windows x64 runner, use
`npm run verify:ghidra:windows`. The verifier generates a deterministic native
PE fixture from source bytes and requires the Windows native authority before
opening the provider. The controls are implemented on main; see the
[release boundary](#released-package-and-main). The lane verifies all 25 admitted
read-only operations, digest identity, and runtime cleanup. The separate
`verify:ghidra:windows:package` lane checks the packed CLI/MCP boundary with an
ordinary user. It requires the built Windows native bundle and an existing
Ghidra/JDK installation; neither is inferred from startup alone.

## Diagnose, update, and remove

Use the approved checkout's launcher for maintenance. Doctor reads readiness configuration; its results do not prove a live client connection, safe target execution or exhaustive feature coverage.

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" doctor --skill --json
node "$HOME/Work/rea2.0/scripts/rea.mjs" update
```

The update command does not install npm releases. Review source changes, rebuild and verify the installed launcher. Uninstall removes only registrations owned by this fork through its reviewed transaction. Inspect its help and scope before removal. Keep the canonical shared skill, private evidence and unrelated client entries intact; do not use data purging as an investigation cleanup shortcut.

## MCP Registry

This fork is not published to the MCP Registry or npm for this delivery. Its local metadata identifies `io.github.SamDev1303/rea2`; that identity is not evidence of a published or installed service.

For a client requiring manual stdio configuration, replace the placeholders below with the verified absolute Node executable and approved checkout path. JSON configuration does not expand `$HOME` or `~`. Preserve other server entries and back up the exact file before editing.

<!-- x-release-please-start-version -->

REA 2.0 engine version: 6.4.0

```json
{
  "mcpServers": {
    "rea2": {
      "command": "NODE_EXECUTABLE",
      "args": ["APPROVED_CHECKOUT/scripts/rea.mjs", "mcp"]
    }
  }
}
```

<!-- x-release-please-end -->

Supported setup writes the resolved local equivalent. It never registers `npx` or an upstream package. Restart the client after an approved change and verify the active MCP session. Registration alone proves neither installed analysis engines nor permission to execute unknown targets.
