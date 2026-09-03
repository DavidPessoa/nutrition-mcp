import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// The homeserver runs vanilla Postgres from schema/postgres.sql, a flattened
// hand-written copy of supabase/migrations/*.sql. Nothing at runtime compares
// them: a column added by a migration and forgotten here surfaces as a failing
// insert on somebody's self-hosted box, long after the change shipped. So
// compare them here instead.
//
// Additive-only is an assumption this check rests on — the migrations have
// never dropped or renamed a column, only added. A migration that does either
// would need this test taught about it rather than the drift ignored.

const MIGRATIONS_DIR = "supabase/migrations";
const FLAT_SCHEMA = "schema/postgres.sql";

// Line-leading words that open a table constraint rather than name a column.
const NOT_A_COLUMN = new Set([
    "constraint",
    "primary",
    "foreign",
    "unique",
    "check",
    "exclude",
    "like",
    "add",
]);

/** Quoted identifiers and case are noise for a name comparison. */
function normalize(sql: string): string {
    return sql.replace(/"/g, "").toLowerCase();
}

/** Strip `-- line comments`, which can otherwise look like column lines. */
function stripComments(sql: string): string {
    return sql.replace(/--[^\n]*/g, "");
}

/**
 * Column names declared inside each `create table` body, keyed by table. Only
 * the `public` schema — `storage.buckets` and friends belong to Supabase and
 * have no counterpart on the Postgres path.
 */
function createdTables(sql: string): Map<string, Set<string>> {
    const tables = new Map<string, Set<string>>();
    const header =
        /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(/g;

    for (const match of sql.matchAll(header)) {
        const table = match[1]!;
        // Walk to the paren that closes the table body; a column's own
        // `check (...)` nests inside it.
        let depth = 0;
        let end = match.index! + match[0].length - 1;
        for (let i = end; i < sql.length; i++) {
            if (sql[i] === "(") depth++;
            else if (sql[i] === ")" && --depth === 0) {
                end = i;
                break;
            }
        }
        const body = sql.slice(match.index! + match[0].length, end);

        const columns = tables.get(table) ?? new Set<string>();
        for (const line of body.split("\n")) {
            const name = line.trim().match(/^(\w+)\s+\S/)?.[1];
            if (name && !NOT_A_COLUMN.has(name)) columns.add(name);
        }
        tables.set(table, columns);
    }
    return tables;
}

/** Columns introduced later by `alter table … add column`. */
function addedColumns(sql: string): Map<string, Set<string>> {
    const tables = new Map<string, Set<string>>();
    const statement = /alter\s+table\s+(?:public\.)?(\w+)([\s\S]*?);/g;

    for (const match of sql.matchAll(statement)) {
        const table = match[1]!;
        const columns = tables.get(table) ?? new Set<string>();
        for (const add of match[2]!.matchAll(
            /add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/g,
        )) {
            columns.add(add[1]!);
        }
        if (columns.size > 0) tables.set(table, columns);
    }
    return tables;
}

async function migrationSql(): Promise<string> {
    const names = (await readdir(MIGRATIONS_DIR)).filter((n) =>
        n.endsWith(".sql"),
    );
    names.sort();
    const files = await Promise.all(
        names.map((n) => Bun.file(join(MIGRATIONS_DIR, n)).text()),
    );
    return stripComments(normalize(files.join("\n")));
}

test("schema/postgres.sql covers every table the migrations create", async () => {
    const migrations = await migrationSql();
    const flat = createdTables(
        stripComments(normalize(await Bun.file(FLAT_SCHEMA).text())),
    );

    const expected = [...createdTables(migrations).keys()].sort();
    expect(expected.length).toBeGreaterThan(0);
    const missing = expected.filter((t) => !flat.has(t));
    expect(missing).toEqual([]);
});

test("schema/postgres.sql covers every column the migrations declare", async () => {
    const migrations = await migrationSql();
    const flat = createdTables(
        stripComments(normalize(await Bun.file(FLAT_SCHEMA).text())),
    );

    const wanted = createdTables(migrations);
    for (const [table, columns] of addedColumns(migrations)) {
        const merged = wanted.get(table) ?? new Set<string>();
        for (const c of columns) merged.add(c);
        wanted.set(table, merged);
    }

    const missing: string[] = [];
    for (const [table, columns] of wanted) {
        const have = flat.get(table);
        if (!have) continue; // reported by the table-level test
        for (const column of columns) {
            if (!have.has(column)) missing.push(`${table}.${column}`);
        }
    }
    expect(missing.sort()).toEqual([]);
});

test("the parser actually finds the columns it is checking", async () => {
    // Guards the test above against silently passing on an empty parse: a
    // regex that matches nothing would report no drift at all.
    const flat = createdTables(
        stripComments(normalize(await Bun.file(FLAT_SCHEMA).text())),
    );
    expect(flat.get("meals")).toContain("vitamin_d_mcg");
    expect(flat.get("meals")).toContain("idempotency_key");
    expect(flat.get("meals")).not.toContain("check");
    expect(flat.get("nutrition_goals")).toContain("min_vitamin_c_mg");

    const migrations = createdTables(await migrationSql());
    expect(migrations.get("meals")).toContain("description");
    expect(addedColumns(await migrationSql()).get("meals")).toContain(
        "caffeine_mg",
    );
});
