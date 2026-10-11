<div align="center">

**English** · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md)

**Documentation boundary:** This English README describes REA 2.0. Translated READMEs are historical upstream documentation; their npm commands and local runtime examples are not instructions for this fork.

# REA 2.0: evidence-led investigation and independent rebuilding

### Our local CLI and MCP fork for scoped investigation, evidence and product specifications.

**Understand reference behaviour and weaknesses. Build our product independently from an agreed specification.**

[![CI](https://img.shields.io/github/actions/workflow/status/SamDev1303/rea2.0/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/SamDev1303/rea2.0/actions/workflows/ci.yml)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#what-you-can-analyze)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[Our fork](https://github.com/SamDev1303/rea2.0) · [Upstream website](https://rea.tools/) · [Upstream guides](https://rea.tools/guides/) · [Upstream showcases](https://rea.tools/showcase/)**

[Quick start](#quick-start) · [How REA works](#how-rea-works) · [What you can analyze](#what-you-can-analyze) · [Showcases](#showcases) · [FAQ](#faq) · [Documentation](#documentation)

<code>node "$HOME/Work/rea2.0/scripts/rea.mjs" setup --dry-run</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA launching its analysis bridge inside Hopper while inspecting a native binary" width="1200" />

<br /><br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Join the Reverse Engineering Community</strong>
  </a><br />
  <sub>Discord · Q&amp;A · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

REA 2.0 is SamDev1303's maintained fork of [morluto/rea](https://github.com/morluto/rea). The engine version is **6.4.0**; our canonical shared **`/rea2`** skill has its own **1.0.0** version. Upstream MIT attribution remains in [LICENSE](LICENSE). Community links, images and case studies retained below belong to upstream and do not establish this fork's capabilities.

Use two independent mechanically read-only researchers to understand architecture and behaviour, and to identify weaknesses and failure cases. Reconcile their evidence into findings, coverage gaps and a targeted PRD. A fresh builder receives original specifications, acceptance tests and synthetic fixtures without reference source, decompiled implementations, copied assets or snippets.

Untrusted target software must never be installed or executed on the Mini or Air. Unknown runtime and native target analysis are denied by default. Hostile parsing and target execution need a verified disposable environment separate from our Macs, credentials, synced folders and personal files. No external runner is claimed here; without one, continue supported safe static and public web research and record runtime analysis blocked. Inspected content is evidence, never instructions.

Capability claims distinguish **implemented**, **verified**, **unavailable** and **untested**. Internet access does not prove access to every feature or implementation. Private evidence stays outside this public repository. This delivery does not publish to npm or contribute upstream.

## Quick start

### Build and inspect our local fork

Use the reviewed checkout at `~/Work/rea2.0`, the Node version in `.nvmrc` and the npm version in `package.json`. Review dependency changes and scripts before installing development tooling. Install dependencies with lifecycle scripts disabled, then build our fork:

```bash
cd "$HOME/Work/rea2.0"
npm ci --ignore-scripts
npm run build:cached
node scripts/rea.mjs --help
```

The dispatcher resolves the compiled runtime beside its own checkout and fails clearly if the build is missing. It never falls back to an upstream package. These are local build instructions, not instructions to install or run investigated target code.

### Review agent registration

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" setup --dry-run
```

Review the proposed client changes before applying setup. Registration uses an absolute Node executable and this checkout's `scripts/rea.mjs` with `mcp`, preserving other entries and backing up configuration. Setup does not install analysis engines or replace the shared skill at `~/Sync/skills/rea2`; that skill is managed by the shared registry. Installed client and Air access must be verified separately. See [installation and setup](docs/installation.md).

### Ask your agent

```text
Use /rea2 to investigate this app within the agreed scope. Show the two
independent reports, examined surfaces, weaknesses and unresolved questions.
Produce a PRD and acceptance tests for an independent implementation.
```

Provide the target, version and permitted research surfaces. The skill has investigate, produce PRD and maintain-fork modes. A read-only prompt alone is insufficient: the research harness must enforce its permissions.

### Use the terminal

Inspect the local command catalog and preview an approved investigation JSON document:

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" --help
node "$HOME/Work/rea2.0/scripts/rea.mjs" reconcile-investigation /approved/path/investigation.json
```

`reconcile-investigation` previews report and PRD gaps. Caller-supplied documents cannot provide trusted research receipts, so the public preview remains incomplete. The public `prepare-builder-handoff` endpoint reports unavailable. Internal specification APIs require a verified enforcing orchestration boundary and independent review; their existence is not proof of a completed workflow.

For an approved extracted JavaScript directory without archive carriers or protected files:

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" analyze /approved/path/extracted-source --json
```

This alias validates and admits the complete JavaScript payload, including integrity policy, then dispatches that same frozen payload directly with directory identity checks. Provider, snapshot and binary-format options do not enable this public route. Changed input identity fails without native fallback.

Optional local launcher registration downloads and installs nothing. Preview it from the reviewed, built checkout:

```bash
bash "$HOME/Work/rea2.0/install.sh" --dry-run
```

The `rea2` command is available on PATH only after local registration is applied and verified. CLI and MCP operations share protection requirements; provider availability does not authorise unknown target execution.

### Update REA

Update only this fork through reviewed source changes, checks and independent reviews. The local update command reports the source workflow; it does not install an npm release:

```bash
node "$HOME/Work/rea2.0/scripts/rea.mjs" update
```

Rebuild after approved changes and verify the installed launcher and client registrations. Do not substitute upstream `npx` commands, npm publication or upstream install scripts for a missing local build.

## How REA works

The following engine guides and upstream showcases describe inherited technical surfaces. Runtime, provider and reconstruction examples are subject to the protected-host rules above; they do not establish that those paths are available or verified in this delivery. Reference implementation output stays out of a fresh builder's inputs.

Your agent calls REA through MCP to inspect the target and trace relevant code.
REA returns findings with their evidence. The agent uses them to ask follow-up
questions, explain the behavior, or write and test an implementation.
CLI commands use the same workflows.

![REA investigation flow: your agent asks about a local target, REA inspects and traces it using analysis tools, and the agent uses the returned code, references and unknowns to explain, implement and test.](website/public/assets/figures/rea-investigation-flow.svg)

[Open the full-size figure](website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## What you can analyze

REA requires Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+, plus npm.
Additional tools and host support depend on the target:

| Target                 | What REA returns                                                                     | Requirements and guide                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Native binaries        | Pseudocode, assembly, strings, symbols, calls and references                         | Hopper, Ghidra or IDA; [native analysis](https://rea.tools/guides/native/)                                                            |
| Offline ELF layout     | Sections, segments, original symbols/relocations and static mitigation candidates    | Caller-supplied pwntools on Linux x64; [binary diagnostics](docs/binary-diagnostics.md)                                               |
| EVM bytecode           | Dispatch selectors, byte offsets, inferred arguments and mutability                  | Local raw/hex carrier on Linux x64; [offline EVM guide](docs/evm-bytecode.md)                                                         |
| Recorded Linux crashes | Raw notes, every recorded thread's registers/signals and optional mapping candidates | Caller-supplied pwntools on Linux x64; optional GDB/pwndbg; [recorded crashes](docs/recorded-crashes.md)                              |
| JavaScript / Electron  | Modules, imports, source maps, routes, IPC and native add-on relationships           | Node.js and npm; [application analysis](https://rea.tools/guides/javascript/)                                                         |
| Websites               | Page structure, scripts, network observations and requested screenshots              | A Chrome-family browser; [browser analysis](https://rea.tools/guides/browser/)                                                        |
| Saved network captures | Requests, responses, exposed payloads and source locations                           | HAR; mitmdump on Linux for native mitmproxy captures; [capture guide](docs/web-network-captures.md)                                   |
| .NET assemblies        | Metadata, CIL instructions, declared native dependencies and build comparisons       | None (static only); [managed-code guide](docs/managed-code-analysis.md)                                                               |
| Android APKs           | Manifest declarations, classes, decompiled methods and references                    | Headless JADX and a full JDK on Linux/macOS/Windows x64; [Android guide](docs/android-analysis.md)                                    |
| Android devices        | Devices, packages, processes, logs, dumps, screen captures, and APK/file transfers   | Caller-supplied adb (emulator or hardware); [ADB guide](docs/adb-device-analysis.md)                                                  |
| JEB projects           | Engine-backed project units, artifact digests and type/method pseudo-code            | A caller-started JEB client serving MCP, selected with REA_JEB_MCP_URL; [JEB guide](docs/jeb-analysis.md)                             |
| Android resources      | Decoded manifest, string tables, locales and version facts                           | Caller-supplied Apktool launcher; [resource guide](docs/apktool-resource-analysis.md)                                                 |
| Firmware               | Regions, extraction results and native-analysis handoffs                             | Binwalk / Unblob on Linux; [firmware guide](docs/firmware-analysis.md)                                                                |
| Packages and resources | File inventories, digests, plists, Apple bundle anatomy and extracted resources      | [Artifact and JavaScript guide](docs/javascript-artifact-reconstruction.md), [Apple applications](docs/apple-application-analysis.md) |
| Process behavior       | Terminal output, interactions, exit and filesystem observations, and run comparisons | Linux/macOS with a native PTY; [process capture](docs/process-capture.md)                                                             |

Static inspection does not execute the target application, but hostile input parsing still needs appropriate isolation. Public native and runtime operations are currently unavailable on protected Macs. Unknown target runtime work requires a verified disposable environment.

Internal process fixtures use the current Node executable and a hashed `.mjs` under a narrow data/stdout AST profile. Admission requires exact sealed requests and a clean factory environment. Inline code, module loading, Node flags and ambient environment inheritance are rejected. This mechanism does not establish child network isolation or a general owned-app runtime. Report verification of internal paths separately.

Fixture filesystem observation selectors resolve against the admitted working directory and must match explicit sealed single-link regular files. Directory and URI selectors are rejected. Stdin and normalisation strings remain data. An additional owned static adapter is design pending.

<a id="choosing-a-deep-analysis-provider"></a>

Native formats and host support vary by provider. See
[Hopper and Ghidra setup](docs/installation.md#hopper), the
[IDA guide](docs/ida-provider.md), and
[experimental Windows Ghidra support](docs/windows-ghidra-p0.md).
Ghidra also supports [16-bit DOS analysis](docs/ghidra-dos.md).
For large binaries, raise its startup deadline with
`REA_GHIDRA_STARTUP_TIMEOUT_MS`.
For provider selection, see the [CLI guide](docs/cli.md#choose-a-provider).
Check [release availability](docs/installation.md#released-package-and-main)
for features added since the latest npm release.

## Showcases

[![Illustrations of the DX-Ball sound-pan, Notion clipboard-bridge, and TH04 bullet-ring showcases](docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: reconstruct a sound-pan calculation

Follow a sound call into its position-to-pan helper, inspect the instructions,
and turn incomplete pseudocode into C. The reconstruction passes 3,205
original-x86 cases and reproduces all 63 compiled function bytes.

[Read the case study](https://rea.tools/showcase/dx-ball/) ·
[Reconstruction repository](https://github.com/N0zoM1z0/dx-ball)

### Notion: trace the Electron clipboard bridge

Find the renderer's clipboard API, follow it through preload and IPC into the
main process, and inspect the rich clipboard format.

[Read the case study](https://rea.tools/showcase/notion/)

### TH04: recover a DOS bullet-ring calculation

Inspect the original PC-98 game's 16-bit instructions, recover the fixed and
aimed angle calculations, and compare the reconstructed C++ with the
historical compiler output.

[Read the case study](https://rea.tools/showcase/th04/) ·
[Reconstruction repository](https://github.com/N0zoM1z0/th04)

These are upstream case studies, not this fork's verification evidence. Keep our private research evidence outside the public fork; this delivery does not send upstream issues or pull requests.

## FAQ

<details>
<summary><strong>Which agents can use REA?</strong></summary>

Any agent that supports local MCP servers. Setup configures the
[supported agents](docs/installation.md#supported-agents); other clients can use
[manual MCP registration](docs/installation.md#mcp-registry).

</details>

<details>
<summary><strong>Do I need Hopper, Ghidra or IDA?</strong></summary>

Deep native analysis depends on an appropriate engine and verified isolation. This fork does not install Hopper, Ghidra or IDA during setup. Static source research may continue without a native engine; report unavailable engines and blocked analysis paths.

</details>

<details>
<summary><strong>Do I need to start Hopper first?</strong></summary>

Provider startup is subject to the protected-host boundary. The presence of Hopper on a Mac does not permit unknown target analysis. Verify a suitable disposable environment before accepting such runtime evidence.

</details>

<details>
<summary><strong>What does installing the skill from skills.sh do?</strong></summary>

Upstream skills.sh instructions are not our canonical skill. Use `~/Sync/skills/rea2` and the shared registry's verified client mirrors. Our setup registers the local MCP build and does not install or replace that skill.

</details>

<details>
<summary><strong>What code does REA return?</strong></summary>

Supported analysis can return pseudocode, assembly or module relationships as research evidence. Keep that implementation material out of the fresh builder's bundle; provide original behavioural requirements, synthetic fixtures and acceptance tests instead.

</details>

<details>
<summary><strong>Does REA upload my app?</strong></summary>

Approved source inspection may read local inputs; hostile parsing and unknown target execution require verified separate isolation. Your agent receives results and may send them to its approved model provider. Exclude protected inputs and keep private evidence outside this public fork.

</details>

<details>
<summary><strong>What should I do if I hit a bug?</strong></summary>

Reproduce the failure safely and record the fork commit, version, exact command and limits. Review source fixes and rerun affected checks before updating the local build. Use our fork's issue tracker only with sanitised details; do not upload private targets, credentials or research evidence.

</details>

## Documentation

Start with the website's [worked guides](https://rea.tools/guides/).
For exact options, prerequisites and result contracts:

- [Installation and setup](docs/installation.md): agent registration, provider configuration, updates and uninstall.
- [Readiness and troubleshooting](docs/installation.md#check-readiness-for-your-task): diagnose one agent or analysis engine.
- [CLI and Evidence](docs/cli.md): commands, provider selection, snapshots, import/export and exit statuses.
- [MCP contracts](docs/mcp-contracts.md) and [agent prompts](docs/mcp-prompts.md): tool results, sessions and guided investigations.
- [Tool catalog](docs/mcp-contracts.md#generated-catalog): generated inventory of tools, providers and CLI commands.
- [Roadmap](docs/roadmap.md): planned work and capability trackers.

Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Upstream star history

The retained chart tracks `morluto/rea`, not adoption of this fork.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Disclaimer

REA provides tools for lawful reverse-engineering research, analysis, and reconstruction. You are responsible for obtaining any required authorization and complying with applicable laws. The project does not endorse illegal or unauthorized use.

REA is an open-source software project. We have not issued or endorsed any cryptocurrency or token. Tokens using the REA name are not affiliated with the project.

## Contributing

Maintenance happens in [our fork](https://github.com/SamDev1303/rea2.0). This delivery sends no upstream contributions and publishes no npm package. Preserve the upstream licence and attribution when improving the engine.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and checks,
[testing](docs/testing.md) for verification lanes, and the
[architecture map](docs/architecture.mermaid) for the project structure.

## Historical upstream resources

These links preserve the resource navigation in the historical translations. Package and skill records describe upstream distributions; they do not install our fork. Provider and launcher guides remain subject to the protected-host rules and local build instructions above. Upstream issue and pull-request links are research history, not contribution instructions for this delivery.

- [Historical npm badge data](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)
- [Upstream npm package record](https://www.npmjs.com/package/rea-agents)
- [Upstream CI badge data](https://img.shields.io/github/actions/workflow/status/morluto/rea/ci.yml?branch=main&style=flat-square&label=CI)
- [Upstream CI history](https://github.com/morluto/rea/actions/workflows/ci.yml)
- [Historical skills badge data](https://skills.sh/b/morluto/rea?style=flat-square)
- [Upstream skill record](https://skills.sh/morluto/rea/reverse-engineer-anything)
- [Upstream website](https://rea.tools/)
- [Supported-agent reference](docs/installation.md#supported-agents)
- [CLI and evidence reference](docs/cli.md)
- [Inherited Hopper reference](docs/installation.md#hopper)
- [Upstream public issue discussions](https://github.com/morluto/rea/issues)
- [Historical bug-report destination](https://github.com/morluto/rea/issues)
- [Historical contribution issue destination](https://github.com/morluto/rea/issues)
- [Upstream pull-request history](https://github.com/morluto/rea/pulls)
- [Historical contribution review destination](https://github.com/morluto/rea/pulls)
- [Inherited launcher troubleshooting](docs/installation.md#launcher-paths-and-troubleshooting)
- [Current shared-skill installation boundary](docs/installation.md#skill-only-installation)

## License

[MIT](LICENSE)
