import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// bun test is a hard gate, not a glob the orchestrator can swap out. CI already
// runs format + typecheck + bun test; this file pins those command strings in
// the workflows, package.json, and the fail-closed sentinel in the agent loop
// docs. Read as text — do not parse YAML. A structural parser would pass a
// renamed step that no longer runs the command.

const SENTINEL = "Tests are a hard gate";
const WORKFLOWS_DIR = ".github/workflows";
const COMMANDS = [
    "bun run format:check",
    "bun run typecheck",
    "bun test",
] as const;

const ci = await Bun.file(".github/workflows/ci.yml").text();
const publish = await Bun.file(".github/workflows/publish-mcp.yml").text();
const pkg = await Bun.file("package.json").text();

test("CI runs the full gate on pull requests and on push to main", () => {
    expect(ci).toContain("pull_request:");
    expect(ci).toContain("push:");
    expect(ci).toContain('branches: ["main"]');
    expect(ci).toContain("bun install --frozen-lockfile");
    for (const command of COMMANDS) {
        expect(ci).toContain(command);
    }
});

test("the registry publish workflow also runs bun test", () => {
    expect(publish).toContain("bun test");
});

test("package.json keeps test, typecheck, and format:check scripts", () => {
    expect(pkg).toContain('"test": "bun test"');
    expect(pkg).toContain('"typecheck":');
    expect(pkg).toContain('"format:check":');
});

test("no workflow runs the live-API validation scripts", async () => {
    const names = (await readdir(WORKFLOWS_DIR)).filter(
        (n) => n.endsWith(".yml") || n.endsWith(".yaml"),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
        const text = await Bun.file(join(WORKFLOWS_DIR, name)).text();
        expect(text, `${name} references e2e:nutrients`).not.toContain(
            "e2e:nutrients",
        );
        expect(text, `${name} references validate:usda`).not.toContain(
            "validate:usda",
        );
        expect(text, `${name} references validate:off`).not.toContain(
            "validate:off",
        );
    }
});

test("loop docs carry the fail-closed sentinel and the three commands", async () => {
    const paths = [
        "AGENTS.md",
        ".cursor/skills/ship-feature/SKILL.md",
        ".cursor/skills/review/SKILL.md",
    ];
    for (const path of paths) {
        const text = await Bun.file(path).text();
        expect(text, `${path} is missing ${SENTINEL}`).toContain(SENTINEL);
        for (const command of COMMANDS) {
            expect(text, `${path} is missing ${command}`).toContain(command);
        }
    }
});
