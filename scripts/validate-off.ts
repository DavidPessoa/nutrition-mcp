// Live Open Food Facts validation (Agent 3). NOT part of `bun test` — this
// makes real network calls, and a third-party outage must never turn CI red.
//
//   bun run validate:off
//
// It fetches each product below through the SAME code path the MCP server
// uses (fetchProductFromOFF), and compares the result against values worked
// out by hand from the provider's own response — see
// validation/open-food-facts/README.md for the derivation of every number.
//
// These are direct-copy / unit-conversion cases, so the documented tolerance
// is EXACT after canonical rounding (validation/README.md). null is asserted
// as null, separately from any numeric comparison: "within tolerance of zero"
// must never pass for a nutrient the source never reported.

import { fetchProductFromOFF, type FoodResult } from "../src/foods.js";

type Expected = Partial<Record<keyof FoodResult, unknown>>;

const CASES: ReadonlyArray<{
    barcode: string;
    what: string;
    expected: Expected;
}> = [
    {
        barcode: "3017620422003",
        what: "Nutella — per-100g basis, sub-0.1 g sodium (false-zero trap)",
        expected: {
            servingBasis: { kind: "per_100g" },
            sodium_mg: 42.8, // 0.0428 g x 1000
            saturated_fat_g: 10.6,
            added_sugar_g: 52.13,
            sugar_g: 56.3,
            trans_fat_g: null,
            potassium_mg: null,
            vitamin_c_mg: null,
            caffeine_mg: null,
        },
    },
    {
        barcode: "016000275287",
        what: "Cheerios — per-serving basis, explicit zeros",
        expected: {
            servingBasis: { kind: "per_serving", grams: 39, label: "39g" },
            sodium_mg: 190, // 0.19 g x 1000, from the _serving key
            saturated_fat_g: 0.5,
            trans_fat_g: 0, // explicitly reported zero, not missing
            cholesterol_mg: 0,
            added_sugar_g: 0,
        },
    },
    {
        barcode: "3387390123210",
        what: "Chocapic — per-serving basis, microgram-scale vitamin D",
        expected: {
            servingBasis: { kind: "per_serving", grams: 30, label: "30 g" },
            vitamin_d_mcg: 1.02, // 0.00000102 g x 1e6
            calcium_mg: 150,
            iron_mg: 3.6,
            sodium_mg: 24,
            added_sugar_g: 5.78,
        },
    },
];

function render(value: unknown): string {
    return value === null ? "null" : JSON.stringify(value);
}

if (!process.env.OFF_USER_AGENT) {
    console.error(
        "OFF_USER_AGENT is not set. Open Food Facts requires an identifying\n" +
            'User-Agent of the form "AppName/version (contact@email)".',
    );
    process.exit(1);
}

let failures = 0;
const lines: string[] = [
    "# Open Food Facts live validation",
    "",
    `Validated: ${new Date().toISOString().slice(0, 10)}`,
    "Provider: Open Food Facts API v2",
    "Tolerance: exact after canonical rounding (direct copy + unit conversion);",
    "null asserted as null, never as a value near zero.",
    "",
];

for (const { barcode, what, expected } of CASES) {
    console.log(`\n${barcode}  ${what}`);
    lines.push(
        `## ${barcode} — ${what}`,
        "",
        "| field | expected | actual | result |",
        "| --- | --- | --- | --- |",
    );

    const food = await fetchProductFromOFF(barcode);
    if (!food) {
        failures++;
        console.log("  FAIL  product not found / no usable macros");
        lines.push("| _(product)_ | found | not found | FAIL |", "");
        continue;
    }
    console.log(`  ${food.name}${food.brand ? ` (${food.brand})` : ""}`);

    for (const [field, want] of Object.entries(expected)) {
        const got = (food as unknown as Record<string, unknown>)[field];
        const ok =
            want === null
                ? got === null
                : JSON.stringify(got) === JSON.stringify(want);
        if (!ok) failures++;
        console.log(
            `  ${ok ? "pass" : "FAIL"}  ${field}: expected ${render(want)}, got ${render(got)}`,
        );
        lines.push(
            `| \`${field}\` | ${render(want)} | ${render(got)} | ${ok ? "pass" : "**FAIL**"} |`,
        );
    }
    lines.push("");
}

await Bun.write("validation/open-food-facts/live-report.md", lines.join("\n"));

console.log(
    `\n${failures === 0 ? "PASS" : `FAIL — ${failures} mismatch(es)`}` +
        "  report: validation/open-food-facts/live-report.md",
);
process.exit(failures === 0 ? 0 : 1);
