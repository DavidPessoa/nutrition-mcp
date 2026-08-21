// End-to-end release validation for the nutrient-accuracy epic.
//
//   bun run e2e:nutrients --test-project
//
// Runs the six scenarios in validation/e2e/README.md against a REAL Supabase
// project, through the REAL MCP tool surface, and prints an evidence table.
// Nothing here is a unit test: every scenario writes a meal over HTTP and reads
// it back out of Postgres, because that is the only way to see a `numeric`
// column's precision, a jsonb round trip, and a nullable column that arrives as
// undefined — the three things unit tests structurally cannot check.
//
// HOW IT TALKS TO THE SERVER. It spawns `bun src/index.ts` on a spare port,
// mints an oauth_tokens row for a throwaway user, and drives it with real
// JSON-RPC `tools/call` requests over `/mcp`. So the tool descriptions, the zod
// input schemas, the outputSchema validation, the analytics wrapper and the
// resolution policy are all in the path — not just the functions underneath
// them. `/mcp` is stateless (a fresh McpServer per POST), so no session id is
// carried between calls.
//
// SAFETY. Requires `--test-project` on the command line, prints the project
// host it is about to write to, creates its own auth users, and deletes every
// row and user it created in a finally block. It will refuse to run against a
// database whose `meals` table already holds rows for the users it creates
// (they are fresh uuids, so that can only mean a collision).
//
// It is NOT part of `bun test`: it needs credentials, network, and about a
// minute. CI never runs it. Its output is meant to be pasted into
// validation/e2e/ as the evidence for a release.

import {
    getSupabase,
    storeToken,
    upsertProfile,
    upsertNutritionGoals,
    deleteAllUserData,
    getAllMeals,
    getMealById,
    type Meal,
} from "../src/supabase.js";
import { buildMealsCsv } from "../src/export.js";
import { lookupBarcode, toFoodNutrition } from "../src/foods.js";
import { lookupFood, resolveAmount } from "../src/usda.js";
import { mapExportCsvToRows } from "../src/csv-export-map.js";
import { MICRONUTRIENT_FIELDS } from "../src/nutrients.js";
import { dateInTz } from "../src/tz.js";

const TZ = "Europe/Kyiv";
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- evidence ----------

interface Check {
    what: string;
    expected: unknown;
    actual: unknown;
    ok: boolean;
}

const scenarios: {
    n: number;
    name: string;
    checks: Check[];
    notes: string[];
}[] = [];
let current: (typeof scenarios)[number] | null = null;

function scenario(n: number, name: string) {
    current = { n, name, checks: [], notes: [] };
    scenarios.push(current);
    console.log(`\n--- Scenario ${n}: ${name}`);
}

function note(text: string) {
    current!.notes.push(text);
    console.log(`    . ${text}`);
}

/** Records one comparison. Tolerance is absolute; null/undefined compare
 *  STRICTLY, because "within 0.1 of zero" must never pass for a nutrient that
 *  was never recorded. */
function check(
    what: string,
    expected: unknown,
    actual: unknown,
    tolerance = 0,
) {
    let ok: boolean;
    if (typeof expected === "number" && typeof actual === "number") {
        ok = Math.abs(expected - actual) <= tolerance;
    } else {
        ok = Object.is(expected, actual);
    }
    current!.checks.push({ what, expected, actual, ok });
    console.log(
        `    ${ok ? "PASS" : "FAIL"}  ${what}: expected ${fmt(expected)}, got ${fmt(actual)}`,
    );
}

function fmt(v: unknown): string {
    if (v === null) return "null";
    if (v === undefined) return "undefined";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

// ---------- MCP client ----------

let rpcId = 0;

async function callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
): Promise<{ text: string; structured: Record<string, unknown> | undefined }> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${BASE}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: ++rpcId,
                method: "tools/call",
                params: { name, arguments: args },
            }),
        });
        // 60 authenticated calls per minute, per user. A release run makes more
        // than that, so waiting is normal rather than a failure.
        if (res.status === 429 && attempt < 3) {
            const wait = Number(res.headers.get("retry-after") ?? 60);
            console.log(`    (rate limited, waiting ${wait}s)`);
            await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
            continue;
        }
        const body = await res.text();
        if (!res.ok) {
            throw new Error(
                `${name} -> HTTP ${res.status}: ${body.slice(0, 400)}`,
            );
        }
        const msg = parseRpc(body);
        if (msg.error) {
            throw new Error(
                `${name} -> JSON-RPC error ${JSON.stringify(msg.error)}`,
            );
        }
        const result = msg.result as {
            content?: { type: string; text?: string }[];
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
        };
        const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        if (result.isError) throw new Error(`${name} -> isError: ${text}`);
        return { text, structured: result.structuredContent };
    }
}

/** The transport answers either plain JSON or an SSE frame depending on the
 *  request; accept both rather than pinning one and breaking on an SDK bump. */
function parseRpc(body: string): { result?: unknown; error?: unknown } {
    const trimmed = body.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    for (const line of trimmed.split("\n")) {
        if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
    }
    throw new Error(`unparseable /mcp response: ${body.slice(0, 200)}`);
}

// ---------- preflight ----------

async function preflight() {
    const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter(
        (k) => !process.env[k],
    );
    if (missing.length > 0) {
        fail(
            `${missing.join(" and ")} not set. Put a TEST project's url and service key in .env — never production.`,
        );
    }
    if (!process.argv.includes("--test-project")) {
        fail(
            `Refusing to run without --test-project. This writes and deletes rows in ${new URL(process.env.SUPABASE_URL!).host}.`,
        );
    }
    console.log(`Database: ${new URL(process.env.SUPABASE_URL!).host}`);

    // Both migrations, probed by selecting the columns they add. Without this
    // check every scenario fails with the same opaque error. PostgREST answers
    // 42703 — undefined_column — for a missing column, and that code is what
    // separates "the migration was never applied" from "the database is
    // unreachable"; reporting the second as the first sends the reader off to
    // apply a migration that is already there.
    const db = getSupabase();
    const mealCols = [...MICRONUTRIENT_FIELDS, "nutrient_provenance"].join(",");
    await probe(
        db.from("meals").select(mealCols).limit(1),
        "meals is missing the micronutrient columns",
        "supabase/migrations/20260819120000_micronutrient_expansion.sql",
    );
    await probe(
        db
            .from("nutrition_goals")
            .select("max_sodium_mg,min_iron_mg,min_vitamin_d_mcg")
            .limit(1),
        "nutrition_goals is missing the micronutrient goal columns",
        "supabase/migrations/20260819130000_micronutrient_goals.sql",
    );
    console.log("Migrations: both applied.");
    if (!process.env.OFF_USER_AGENT) {
        console.log(
            "WARNING: OFF_USER_AGENT unset — scenario 1 may be refused by Open Food Facts.",
        );
    }
    if (!process.env.USDA_FDC_API_KEY) {
        fail("USDA_FDC_API_KEY not set — scenario 2 cannot run.");
    }
}

async function probe(
    query: PromiseLike<{ error: { code?: string; message: string } | null }>,
    missing: string,
    migration: string,
) {
    const { error } = await query;
    if (!error) return;
    if (error.code === "42703") fail(`${missing}. Apply ${migration}.`);
    fail(
        `could not read the database: ${error.message} (code ${error.code || "none"})`,
    );
}

function fail(message: string): never {
    console.error(`\nSTOPPED: ${message}`);
    process.exit(1);
}

// ---------- users and server ----------

interface TestUser {
    id: string;
    token: string;
    email: string;
}

async function createUser(label: string): Promise<TestUser> {
    const email = `e2e-${label}-${crypto.randomUUID()}@example.invalid`;
    const { data, error } = await getSupabase().auth.admin.createUser({
        email,
        password: crypto.randomUUID(),
        email_confirm: true,
    });
    if (error || !data.user) {
        throw new Error(`could not create the test user: ${error?.message}`);
    }
    const token = `e2e_${crypto.randomUUID()}`;
    await storeToken(token, data.user.id);
    // Timezone is what places every local wall clock; an unset one silently
    // means UTC and would move meals across days (#68, #97).
    await upsertProfile(data.user.id, { timezone: TZ });
    const existing = await getAllMeals(data.user.id);
    if (existing.length > 0) {
        throw new Error(
            `fresh user ${data.user.id} already has ${existing.length} meals — refusing to continue`,
        );
    }
    return { id: data.user.id, token, email };
}

async function destroyUser(user: TestUser) {
    await deleteAllUserData(user.id);
    const { error } = await getSupabase().auth.admin.deleteUser(user.id);
    if (error) {
        console.error(
            `WARNING: left the auth user ${user.email} behind (${error.message}); delete it by hand.`,
        );
    }
}

async function startServer(): Promise<{ stop: () => void }> {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
        env: { ...process.env, PORT: String(PORT) },
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch(`${BASE}/mcp`, { method: "GET" });
            // 401/405 both prove it is listening; anything answered is enough.
            if (res.status > 0) return { stop: () => proc.kill() };
        } catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    proc.kill();
    throw new Error(`server did not come up on ${BASE}`);
}

// ---------- helpers ----------

/** Sum a field across meals, treating null as "not recorded" — never as 0. */
function sumRecorded(meals: Meal[], field: keyof Meal): number {
    return meals.reduce((n, m) => {
        const v = m[field];
        return typeof v === "number" ? n + v : n;
    }, 0);
}

function today(): string {
    return dateInTz(new Date(), TZ);
}

// ---------- the six scenarios ----------
//
// Each one is a CHAIN, and the point of a chain is that a value survives every
// link unchanged. Where a number is compared against the provider, the
// expectation is computed from the provider module directly rather than from the
// tool's prose — and the provider itself is independently checked against
// hand-derived values by `bun run validate:off` / `validate:usda`, which is the
// link this script does not have to re-prove.

/** Barcode -> Open Food Facts -> normalize -> MCP lookup -> log -> retrieve
 *  -> summary -> export. */
async function scenario1(u: TestUser) {
    scenario(1, "Packaged barcode food (Open Food Facts)");
    const barcode = "3017620422003"; // Nutella, 400 g jar
    const grams = 37;

    const food = await lookupBarcode(barcode);
    if (!food) {
        note(
            "no product returned by Open Food Facts — cannot run this scenario",
        );
        check("product found", true, false);
        return;
    }
    const expected = resolveAmount(toFoodNutrition(food), grams);
    note(`source: OFF ${barcode}, scaled to ${grams} g`);

    const lookup = await callTool(u.token, "lookup_barcode", { barcode });
    check("lookup_barcode names the product", true, lookup.text.length > 0);

    const args: Record<string, unknown> = {
        description: `Nutella (${grams} g) [e2e-1]`,
        meal_type: "breakfast",
        nutrient_source: "open_food_facts",
        nutrient_source_id: barcode,
    };
    for (const [field, value] of Object.entries(expected)) {
        if (typeof value === "number") args[field] = value;
    }
    const logged = await callTool(u.token, "log_meal", args);
    const id =
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
            logged.text,
        )?.[1];
    check("log_meal returned a meal id", true, id !== undefined);
    if (!id) return;

    const row = await getMealById(u.id, id);
    check("the meal is readable", true, row !== null);
    if (!row) return;

    // Every nutrient the provider reported must be in the row, in its unit,
    // and every nutrient it did NOT report must be null — not 0.
    for (const field of MICRONUTRIENT_FIELDS) {
        const want = expected[field];
        if (typeof want === "number") {
            check(`stored ${field}`, round2(want), num(row[field]), 0.02);
        } else {
            check(`unrecorded ${field} stays null`, null, row[field] ?? null);
        }
    }
    const prov = row.nutrient_provenance ?? {};
    const anyMicro = MICRONUTRIENT_FIELDS.find(
        (f) => typeof expected[f] === "number",
    );
    if (anyMicro) {
        check(
            `provenance source for ${anyMicro}`,
            "open_food_facts",
            prov[anyMicro]?.source ?? null,
        );
        check(
            `provenance confidence for ${anyMicro}`,
            "authoritative",
            prov[anyMicro]?.confidence ?? null,
        );
        check(
            `provenance source_id for ${anyMicro}`,
            barcode,
            prov[anyMicro]?.source_id ?? null,
        );
    }

    // The same figure, through the summary and then through the export.
    const day = today();
    const summary = await callTool(u.token, "get_nutrition_summary", {
        start_date: day,
        end_date: day,
    });
    if (anyMicro) {
        const item = coverageItem(summary.structured, anyMicro);
        check(
            `summary total for ${anyMicro}`,
            round2(expected[anyMicro] as number),
            item === null ? null : round2(item.known_total as number),
            0.02,
        );
        check(
            `summary marks ${anyMicro} complete`,
            true,
            item?.complete ?? null,
        );
    }
    const csv = buildMealsCsv(await getAllMeals(u.id), TZ);
    check("meals.csv carries the row", true, csv.includes("[e2e-1]"));
}

/** FDC record -> normalize -> scale to serving -> log -> retrieve -> summary. */
async function scenario2(u: TestUser) {
    scenario(2, "USDA generic food (FoodData Central)");
    const fdcId = 173410; // Egg, whole, raw, fresh — a Foundation/SR record
    const grams = 100;

    const food = await lookupFood(fdcId);
    if (!food) {
        note(`FDC ${fdcId} did not resolve — cannot run this scenario`);
        check("food found", true, false);
        return;
    }
    const expected = resolveAmount(food, grams);
    note(`source: FDC ${fdcId}, scaled to ${grams} g`);

    // The tool must do the scaling itself; the model is told never to.
    const lookup = await callTool(u.token, "lookup_food", {
        fdc_id: fdcId,
        grams,
    });
    check("lookup_food returned a scaled record", true, lookup.text.length > 0);

    const args: Record<string, unknown> = {
        description: `Egg, whole, raw (${grams} g) [e2e-2]`,
        meal_type: "breakfast",
        nutrient_source: "usda_fdc",
        nutrient_source_id: `fdc:${fdcId}`,
    };
    for (const [field, value] of Object.entries(expected)) {
        if (typeof value === "number") args[field] = value;
    }
    const logged = await callTool(u.token, "log_meal", args);
    const id = /([0-9a-f-]{36})/i.exec(logged.text)?.[1];
    check("log_meal returned a meal id", true, id !== undefined);
    if (!id) return;

    const row = await getMealById(u.id, id);
    if (!row) {
        check("the meal is readable", true, false);
        return;
    }
    for (const field of MICRONUTRIENT_FIELDS) {
        const want = expected[field];
        if (typeof want === "number") {
            check(`stored ${field}`, round2(want), num(row[field]), 0.02);
        } else {
            check(`unrecorded ${field} stays null`, null, row[field] ?? null);
        }
    }
    // Vitamins A and D are the IU trap: FDC carries an IU entry beside the µg
    // one, and an IU figure must never reach these columns.
    note(
        `vitamin_a_mcg=${fmt(row.vitamin_a_mcg)}, vitamin_d_mcg=${fmt(row.vitamin_d_mcg)} (µg, never IU)`,
    );
    const micro = MICRONUTRIENT_FIELDS.find(
        (f) => typeof expected[f] === "number",
    );
    if (micro) {
        check(
            `provenance source for ${micro}`,
            "usda_fdc",
            (row.nutrient_provenance ?? {})[micro]?.source ?? null,
        );
    }
}

/** Four real foods, summed independently, compared with the day's total. */
async function scenario3(u: TestUser) {
    scenario(3, "Multi-food day");
    const day = today();
    // Two label meals with figures a human can add up, on top of the two real
    // provider-backed meals scenarios 1 and 2 already logged today.
    const extra = [
        {
            description: "Cheddar (30 g, label) [e2e-3a]",
            meal_type: "lunch",
            calories: 120,
            sodium_mg: 180,
            calcium_mg: 200,
            saturated_fat_g: 6,
        },
        {
            description: "Wholemeal bread (2 slices, label) [e2e-3b]",
            meal_type: "lunch",
            calories: 180,
            sodium_mg: 340,
            calcium_mg: 60,
            saturated_fat_g: 0.6,
        },
    ];
    for (const m of extra) {
        await callTool(u.token, "log_meal", {
            ...m,
            nutrient_source: "nutrition_label",
        });
    }

    const meals = await getAllMeals(u.id);
    const summary = await callTool(u.token, "get_nutrition_summary", {
        start_date: day,
        end_date: day,
    });
    check("the day has at least 4 meals", true, meals.length >= 4);

    // Independent sums, straight from the rows, treating null as unrecorded.
    for (const field of ["sodium_mg", "calcium_mg"] as const) {
        const mine = round2(sumRecorded(meals, field));
        const item = coverageItem(summary.structured, field);
        check(
            `summary total for ${field} matches an independent sum`,
            mine,
            item === null ? null : round2(item.known_total as number),
            0.02,
        );
    }
}

/** Remove one meal's sodium and confirm the total reads as a floor. */
async function scenario4(u: TestUser) {
    scenario(4, "Partial coverage");
    const day = today();
    const meals = await getAllMeals(u.id);
    const target = meals.find(
        (m) => m.description.includes("[e2e-3a]") && m.sodium_mg !== null,
    );
    if (!target) {
        check("a meal with sodium to clear", true, false);
        return;
    }
    // An explicit null is "not recorded" — the one write that must not become 0.
    await callTool(u.token, "update_meal", { id: target.id, sodium_mg: null });
    const after = await getMealById(u.id, target.id);
    check("cleared sodium is null, not 0", null, after?.sodium_mg ?? null);

    const meals2 = await getAllMeals(u.id);
    const recorded = meals2.filter((m) => m.sodium_mg !== null).length;
    const summary = await callTool(u.token, "get_nutrition_summary", {
        start_date: day,
        end_date: day,
    });
    const item = coverageItem(summary.structured, "sodium_mg");
    check("sodium is reported incomplete", false, item?.complete ?? null);
    check(
        "known_meals counts only the recorded ones",
        recorded,
        item?.known_meals ?? null,
    );
    check(
        "total_meals counts them all",
        meals2.length,
        item?.total_meals ?? null,
    );
    check(
        "known_total is the floor, not the whole day",
        round2(sumRecorded(meals2, "sodium_mg")),
        item === null ? null : round2(item.known_total as number),
        0.02,
    );
}

/** A vague meal: macros estimated and marked, micronutrients refused. */
async function scenario5(u: TestUser) {
    scenario(5, "Estimated meal");
    // No nutrient_source, so the server records model_estimate — and must
    // refuse the sodium outright (CONTRACT §0.2).
    const logged = await callTool(u.token, "log_meal", {
        description: "A bowl of pasta, roughly [e2e-5]",
        meal_type: "dinner",
        calories: 600,
        protein_g: 20,
        carbs_g: 90,
        fat_g: 15,
        sodium_mg: 900,
    });
    const id = /([0-9a-f-]{36})/i.exec(logged.text)?.[1];
    check("log_meal returned a meal id", true, id !== undefined);
    if (!id) return;
    const row = await getMealById(u.id, id);
    if (!row) {
        check("the meal is readable", true, false);
        return;
    }
    check("the estimated macros are stored", 600, num(row.calories));
    check(
        "the estimated micronutrient is NOT stored",
        null,
        row.sodium_mg ?? null,
    );
    check(
        "the response says so",
        true,
        /not stored/i.test(logged.text) && /sodium_mg/.test(logged.text),
    );
    check(
        "no provenance claims a source for sodium",
        null,
        (row.nutrient_provenance ?? {}).sodium_mg?.source ?? null,
    );
}

/** CSV -> dry run -> import -> retrieve -> export -> clean user -> re-import
 *  -> compare. */
async function scenario6(first: TestUser) {
    scenario(6, "Import/export round trip");
    const rows = [
        {
            source_line: 2,
            logged_at: "2026-07-18T08:30",
            meal_type: "breakfast",
            description: "Porridge with milk [e2e-6a]",
            calories: 320,
            protein_g: 12,
            sodium_mg: 180,
            calcium_mg: 300,
            iron_mg: 0, // a real measured zero
            vitamin_d_mcg: null, // an explicit "not recorded"
        },
        {
            source_line: 3,
            logged_at: "2026-07-18",
            meal_type: "lunch",
            description: "Soup, tinned [e2e-6b]",
            calories: 210,
            sodium_mg: 1240,
            potassium_mg: 390,
        },
    ];
    const args = {
        meals: rows,
        expected_row_count: rows.length,
        expected_total_kcal: 530,
    };

    const dry = await callTool(first.token, "bulk_import_meals", {
        ...args,
        dry_run: true,
    });
    check("dry run creates nothing", 0, count(dry.structured, "created"));
    check(
        "dry run would create both rows",
        2,
        count(dry.structured, "would_create"),
    );

    const real = await callTool(first.token, "bulk_import_meals", args);
    check("both rows imported", 2, count(real.structured, "created"));

    const imported = (await getAllMeals(first.id)).filter((m) =>
        m.description.includes("[e2e-6"),
    );
    check("both rows readable", 2, imported.length);
    const a = imported.find((m) => m.description.includes("[e2e-6a]"));
    check("a real measured zero survives as 0", 0, num(a?.iron_mg));
    check("an explicit blank stays null", null, a?.vitamin_d_mcg ?? null);

    // Replaying the same call must be a perfect no-op.
    const replay = await callTool(first.token, "bulk_import_meals", args);
    check(
        "replaying the file creates nothing",
        0,
        count(replay.structured, "created"),
    );
    check(
        "replaying the file dedupes both rows",
        2,
        count(replay.structured, "deduplicated"),
    );

    // Export, then re-import into a CLEAN user and compare the two exports.
    const csv1 = buildMealsCsv(await getAllMeals(first.id), TZ);
    const archive = await callTool(first.token, "export_all_data", {});
    check(
        "export_all_data returned a link",
        true,
        /https?:\/\//.test(archive.text),
    );

    const second = await createUser("roundtrip");
    try {
        const back = await callTool(second.token, "bulk_import_meals", {
            meals: mapExportCsvToRows(csv1),
            expected_row_count: mapExportCsvToRows(csv1).length,
        });
        check(
            "every exported row re-imports",
            0,
            count(back.structured, "failed"),
        );
        const csv2 = buildMealsCsv(await getAllMeals(second.id), TZ);
        check(
            "the two exports are identical but for the meal ids",
            stripIds(csv1),
            stripIds(csv2),
        );
    } finally {
        await destroyUser(second);
    }
}

// ---------- small readers ----------

function num(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" ? Number(v) : (v as number);
    return Number.isFinite(n) ? round2(n) : null;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function count(structured: Record<string, unknown> | undefined, key: string) {
    const summary = structured?.summary as Record<string, unknown> | undefined;
    return (summary?.[key] as number | undefined) ?? null;
}

function coverageItem(
    structured: Record<string, unknown> | undefined,
    field: string,
): Record<string, unknown> | null {
    const rows = (structured?.nutrient_coverage ?? []) as Record<
        string,
        unknown
    >[];
    return rows.find((r) => r.nutrient === field) ?? null;
}

/** Compare two exports ignoring the meal id, which is per-user by definition. */
function stripIds(csv: string): string {
    const lines = csv.split("\n");
    const idIdx = (lines[0] ?? "").split(",").indexOf("id");
    if (idIdx < 0) return csv;
    return lines
        .map((l) =>
            l
                .split(",")
                .filter((_, i) => i !== idIdx)
                .join(","),
        )
        .join("\n");
}

// ---------- main ----------

await preflight();
const server = await startServer();
const user = await createUser("main");
console.log(`Test user: ${user.id}`);
let threw: unknown = null;
try {
    await scenario1(user);
    await scenario2(user);
    await scenario3(user);
    await scenario4(user);
    await scenario5(user);
    await scenario6(user);
} catch (err) {
    threw = err;
} finally {
    await destroyUser(user);
    server.stop();
}

console.log("\n===== EVIDENCE =====");
let failed = 0;
for (const s of scenarios) {
    const bad = s.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(
        `Scenario ${s.n} — ${s.name}: ${bad.length === 0 ? "PASS" : `FAIL (${bad.length}/${s.checks.length})`}`,
    );
    for (const c of bad) {
        console.log(
            `    FAIL ${c.what}: expected ${fmt(c.expected)}, got ${fmt(c.actual)}`,
        );
    }
}
if (threw) {
    console.error(
        `\nAborted: ${threw instanceof Error ? threw.stack : String(threw)}`,
    );
}
console.log(
    `\n${failed === 0 && !threw ? "ALL SCENARIOS PASS" : `${failed} check(s) failed`}`,
);
console.log(
    "Paste this output into validation/e2e/ as the evidence for the release.",
);
process.exit(failed === 0 && !threw ? 0 : 1);
