import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Link-integrity only. Do not pin prose, headings, or service names — an
// editorial pass must not turn the build red.

const ROOT = resolve(".");
const DOC = "docs/architecture.md";

const KNOWN_FILES = new Set([
    "Dockerfile",
    "docker-compose.yml",
    ".env.example",
    "README.md",
    "CLAUDE.md",
]);

const PATH_PREFIXES = [
    "src/",
    "docs/",
    "schema/",
    "supabase/",
    ".github/",
    "public/",
];

function looksLikeRepoPath(raw: string): boolean {
    const s = raw.replace(/\/+$/, "") || raw;
    if (!s) return false;
    if (s.includes(" ") || s.includes("://") || s.includes("(")) return false;
    if (s.startsWith("#") || s.startsWith("/")) return false;
    if (s.includes("=") || s.includes(":")) return false;
    if (/^[A-Z][A-Z0-9_]*$/.test(s)) return false;
    if (KNOWN_FILES.has(s)) return true;
    if (PATH_PREFIXES.some((p) => s.startsWith(p))) return true;
    return s.includes("/") && /\.\w+$/.test(s);
}

type Ref = { kind: "md-link" | "path"; value: string };

function referenced(text: string): Ref[] {
    const out: Ref[] = [];
    const seen = new Set<string>();
    const add = (kind: Ref["kind"], value: string) => {
        const key = `${kind}:${value}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ kind, value });
    };

    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        let href = m[1]!.trim();
        const hash = href.indexOf("#");
        if (hash >= 0) href = href.slice(0, hash);
        const q = href.indexOf("?");
        if (q >= 0) href = href.slice(0, q);
        if (!href || href.startsWith("http") || href.startsWith("mailto:")) {
            continue;
        }
        add("md-link", href);
    }

    for (const m of text.matchAll(/`([^`]+)`/g)) {
        const raw = m[1]!.trim();
        if (looksLikeRepoPath(raw)) add("path", raw);
    }

    return out;
}

function onDisk(kind: Ref["kind"], value: string): boolean {
    const full =
        kind === "md-link"
            ? resolve(dirname(DOC), value)
            : resolve(ROOT, value);
    if (!full.startsWith(ROOT)) return false;
    return existsSync(full);
}

test("docs/architecture.md exists and is more than a stub", async () => {
    const file = Bun.file(DOC);
    expect(await file.exists()).toBe(true);
    const text = await file.text();
    expect(text.length).toBeGreaterThan(2000);
});

test("README.md links to docs/architecture.md", async () => {
    const text = await Bun.file("README.md").text();
    expect(text).toContain("docs/architecture.md");
});

test("CLAUDE.md links to docs/architecture.md", async () => {
    const text = await Bun.file("CLAUDE.md").text();
    expect(text).toContain("docs/architecture.md");
});

test("every relative markdown link and repo path in the doc resolves on disk", async () => {
    const text = await Bun.file(DOC).text();
    const refs = referenced(text);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs
        .filter((r) => !onDisk(r.kind, r.value))
        .map((r) => `${r.kind}: ${r.value}`);
    expect(missing).toEqual([]);
});
