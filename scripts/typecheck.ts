// Typecheck gate for CI.
//
// Scoped to src/ on purpose. scripts/gen-map-data.ts carries 19 pre-existing
// strict-null errors that have nothing to do with the server, and blocking every
// PR on them is how a typecheck gate ends up never being added at all. src/ is
// clean today, so this starts green and stays green; widen the scope once the
// scripts/ backlog is cleared.
//
// tsc exits non-zero for errors anywhere in the project, so its exit code cannot
// be the verdict here — the src/-scoped diagnostic lines are. The exit code is
// still inspected to tell "compiled with errors elsewhere" (2) apart from "tsc
// could not run at all", which must fail loudly rather than pass silently.

const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "--pretty", "false"], {
    stdout: "pipe",
    stderr: "pipe",
});
const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
]);
const exitCode = await proc.exited;
const output = stdout + stderr;

// 0 = clean, 2 = type errors found. Anything else means tsc itself failed (bad
// config, missing binary), which would otherwise look identical to "no src/
// errors" and wave a broken build through.
if (exitCode !== 0 && exitCode !== 2) {
    console.error(`tsc failed to run (exit ${exitCode}):\n${output}`);
    process.exit(1);
}

const srcErrors = output.split("\n").filter((line) => line.startsWith("src/"));

if (srcErrors.length > 0) {
    console.error(`Type errors in src/ (${srcErrors.length}):\n`);
    for (const line of srcErrors) console.error(`  ${line}`);
    process.exit(1);
}

console.log("src/ typechecks clean");
