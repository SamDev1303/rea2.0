import { join } from "node:path";

const programs = Object.freeze({
  minimal: "process.stdout.write('minimal-capture')",
  "complete-report":
    "const fs=require('node:fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/final.json',JSON.stringify({status:'complete',data:'X'.repeat(131072)}));console.log('x'.repeat(8192));",
  cumulative:
    "require('node:fs').writeFileSync('final.json','{\"status\":\"complete\"}')",
  "delete-create":
    "const fs=require('node:fs');fs.unlinkSync('z.txt');fs.writeFileSync('a.txt','added');fs.writeFileSync('b.txt','added');",
  rewrite: "require('node:fs').writeFileSync('changed.txt','after!')",
  symlink:
    "const fs=require('node:fs');fs.rmSync('subtree',{recursive:true});fs.symlinkSync(process.argv[1],'subtree');fs.unlinkSync('removed.txt');",
  choices:
    "require('node:fs').writeFileSync('state','selected');console.log(process.env['app.setting'],process.env.MY_PASSWORD,process.env['REA_PROCESS_RUN_ID'+String.fromCharCode(10)]);",
  stdin:
    "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.once('data',bytes=>{console.log('stdin-byte:'+bytes[0]);process.exit(0)});console.log('ready')",
  "raw-files":
    "process.stdout.write('x'.repeat(1000));require('node:fs').writeFileSync('c.txt','new');setTimeout(()=>{},100)",
  "digest-only": "console.log('done');setTimeout(()=>{},100)",
  "sample-limit":
    "setTimeout(()=>require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},800)'],{stdio:'ignore'}),100);console.log('ready')",
});

const FINALIZATION_SOURCE = `import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [mode, directory, finalExitCode = '0'] = process.argv.slice(2);
writeFileSync(join(directory, 'pid.txt'), String(process.pid));
writeFileSync(join(directory, 'periodic.json'), JSON.stringify({phase:'periodic'}));
if (mode === 'descendant') {
 const childDirectory=join(directory,'descendant'); mkdirSync(childDirectory);
 spawn(process.execPath,[fileURLToPath(import.meta.url),'ignoring',childDirectory],{detached:true,stdio:'ignore'});
}
if (mode === 'ignoring') {
 process.on('SIGTERM',()=>writeFileSync(join(directory,'sigterm-received'),'received'));
 process.on('SIGINT',()=>undefined);
} else {
 process.on('SIGTERM',()=>{writeFileSync(join(directory,'sigterm-received'),'received');process.stdout.write('finalized\\n');writeFileSync(join(directory,'final.json'),JSON.stringify({phase:'final'}));process.exit(Number(finalExitCode));});
}
setInterval(()=>undefined,1000);
`;

const allowedKeys = new Set([
  "template",
  "root",
  "target",
  "shortfall",
  "truncated",
  "mode",
  "timing",
  "exitCode",
]);
const timings = Object.freeze({
  standard: { timeout_ms: 1500, finalization_ms: 1500 },
  descendant: {
    timeout_ms: 1500,
    finalization_ms: 1500,
    settle_ms: 100,
    limits: { file_bytes: 1 },
  },
  default: { timeout_ms: 500 },
  cancel: { timeout_ms: 300, finalization_ms: 20000 },
  "invalid-budget": {
    timeout_ms: Number.MAX_SAFE_INTEGER,
    finalization_ms: 1,
    settle_ms: 0,
  },
});

const validateFinalization = (selection) => {
  const { mode, timing, exitCode } = selection;
  if (
    !["cooperative", "ignoring", "descendant"].includes(mode) ||
    !Object.hasOwn(timings, timing) ||
    ![undefined, 0, 3].includes(exitCode)
  )
    throw new Error("Invalid finalization variant");
  if ((mode === "descendant") !== (timing === "descendant"))
    throw new Error("Invalid descendant timing");
};

const validateSelection = (selection) => {
  if (
    selection === null ||
    typeof selection !== "object" ||
    Array.isArray(selection)
  )
    throw new Error("Invalid controller selection");
  for (const key of Object.keys(selection))
    if (!allowedKeys.has(key))
      throw new Error("Unknown controller selection field");
  const { template, root } = selection;
  if (typeof root !== "string" || typeof template !== "string")
    throw new Error("Missing owned root/template");
  if (!Object.hasOwn(builders, template))
    throw new Error("Unknown owned template");
  const extra = {
    symlink: ["target"],
    cumulative: ["shortfall"],
    choices: ["truncated"],
    finalization: ["mode", "timing", "exitCode"],
  };
  for (const key of Object.keys(selection))
    if (!["root", "template", ...(extra[template] ?? [])].includes(key))
      throw new Error("Unexpected template option");
  if (template === "symlink" && typeof selection.target !== "string")
    throw new Error("Missing symlink target");
  if (template === "cumulative" && ![0, 1].includes(selection.shortfall))
    throw new Error("Invalid shortfall");
  if (template === "choices" && typeof selection.truncated !== "boolean")
    throw new Error("Invalid output variant");
  if (template === "finalization") validateFinalization(selection);
};

const builders = Object.freeze({
  minimal: (_selection, _source, programPath) => ({ arguments: [programPath] }),
  "raw-files": ({ root }) => ({
    seeds: [
      [join(root, "a.txt"), "abc"],
      [join(root, "b.txt"), "12345678"],
    ],
    options: {
      filesystem_observation_paths: [root],
      limits: { output_bytes: 50, files: 3, file_bytes: 4 },
    },
  }),
  "digest-only": ({ root }) => ({
    seeds: [
      [join(root, "a.txt"), "abc"],
      [join(root, "b.txt"), "12345678"],
      [join(root, "c.txt"), "z"],
    ],
    options: {
      filesystem_observation_paths: [root],
      limits: { file_bytes: 4 },
    },
  }),
  "sample-limit": () => ({ options: { limits: { processes: 1 } } }),
  "complete-report": ({ root }) => ({
    options: {
      filesystem_observation_paths: [join(root, "reports")],
      limits: { output_bytes: 1024, file_bytes: 262144 },
    },
  }),
  cumulative: ({ root, shortfall }) => ({
    seeds: [[join(root, "periodic.json"), '{"status":"running"}']],
    options: {
      filesystem_observation_paths: [root],
      limits: {
        output_bytes: 1,
        file_bytes:
          Buffer.byteLength('{"status":"running"}') +
          Buffer.byteLength('{"status":"complete"}') -
          shortfall,
      },
    },
  }),
  "delete-create": ({ root }) => ({
    seeds: [[join(root, "z.txt"), "unchanged"]],
    options: { filesystem_observation_paths: [root], limits: { files: 2 } },
  }),
  rewrite: ({ root }) => ({
    seeds: [[join(root, "changed.txt"), "before"]],
    options: {
      filesystem_observation_paths: [root],
      limits: { file_bytes: 1 },
    },
  }),
  symlink: ({ root, target }, source) => ({
    arguments: ["-e", source, target],
    seeds: [
      [join(root, "subtree", "z.txt"), "unchanged"],
      [join(root, "removed.txt"), "removed"],
      [join(target, "z.txt"), "unchanged"],
    ],
    directories: [join(root, "subtree")],
    options: { filesystem_observation_paths: [root] },
  }),
  choices: ({ root, truncated }) => ({
    options: {
      environment: {
        "app.setting": "value",
        1: "numbered",
        MY_PASSWORD: "ordinary-evidence",
        "REA_PROCESS_RUN_ID\n": "caller-value",
      },
      filesystem_observation_paths: [root],
      limits: truncated ? { output_bytes: 128 } : {},
    },
  }),
  printenv: () => ({
    arguments: ["1"],
    options: { environment: { 1: "numbered" } },
  }),
  stdin: () => ({
    options: { events: [{ type: "input", at_ms: 1000, data: "\0" }] },
  }),
  finalization: ({ root, mode, timing, exitCode }, _source, programPath) => ({
    arguments: [
      programPath,
      mode,
      root,
      ...(exitCode === undefined ? [] : [String(exitCode)]),
    ],
    options: {
      filesystem_observation_paths: [root],
      idle_timeout_ms: 10000,
      ...timings[timing],
    },
  }),
});

/** Only source-authored finite templates are accepted. There is no source or argv parameter. */
export function describeOwnedProcessTemplate(
  selection,
  executable,
  programPath,
) {
  validateSelection(selection);
  const { template, root, target, truncated } = selection;
  let source =
    template === "finalization"
      ? FINALIZATION_SOURCE
      : (programs[template] ?? "");
  if (template === "choices" && truncated)
    source += "console.log('x'.repeat(5000))";
  const built = builders[template](selection, source, programPath);
  const scenario = {
    executable,
    arguments: built.arguments ?? ["-e", source],
    working_directory: root,
    ...built.options,
  };
  return {
    source,
    scenario,
    seeds: built.seeds ?? [],
    directories: built.directories ?? [],
    roots: target === undefined ? [root] : [root, target],
  };
}
