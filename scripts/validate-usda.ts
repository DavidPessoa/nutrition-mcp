// Live USDA FoodData Central validation (Agent 4). NOT part of `bun test`.
//
//   USDA_FDC_API_KEY=... bun run validate:usda
//
// Two jobs, in this order:
//
//   1. CAPTURE — fetch each food below and write the raw response to
//      src/fixtures/usda/. The fixtures committed today are synthetic
//      (schema-shaped, but the numbers are placeholders); the first run of
//      this script with a real key replaces them with real records, at
//      which point `bun test` starts asserting against real data.
//   2. COMPARE — scale each record to a requested gram amount through
//      resolveAmount and check the result against arithmetic done here,
//      independently of src/nutrient-units.ts. Tolerances are the absolute
//      ones documented in validation/README.md, never a percentage.
//
// `null` is compared as `null`, separately from any numeric tolerance: a
// nutrient the record does not carry must not pass by being "within 1 mg of
// zero".

import {
    fetchFoodFromFdc,
    normalizeFdcFood,
    resolveAmount,
    searchFoods,
} from "../src/usda.js";
import { NUTRIENT_UNITS, type NutrientField } from "../src/nutrients.js";

// The five foods the epic names, plus the gram amount each is validated at.
// fdcId is left null until the first capture run resolves it by search —
// hardcoding an id from memory is exactly the unverified assumption this
// script exists to remove.
const FOODS: ReadonlyArray<{
    slug: string;
    query: string;
    grams: number;
    prefer?: string;
}> = [
    {
        slug: "chicken-breast-roasted",
        query: "chicken breast roasted",
        grams: 150,
        prefer: "meat only",
    },
    { slug: "egg-whole-raw", query: "egg whole raw fresh", grams: 100 },
    { slug: "potato-baked", query: "potato baked flesh and skin", grams: 200 },
    { slug: "spinach-raw", query: "spinach raw", grams: 100 },
    {
        slug: "rice-white-cooked",
        query: "rice white long-grain cooked",
        grams: 100,
    },
];

// Absolute tolerances, per validation/README.md. A percentage tolerance is
// what hides a systematic unit or serving error, so there is none here.
const TOLERANCE: Record<string, number> = {
    kcal: 1,
    g: 0.1,
    mg: 1,
    mcg: 1,
};

if (!process.env.USDA_FDC_API_KEY) {
    console.error(
        "USDA_FDC_API_KEY is not set. Get a free key at\n" +
            "https://fdc.nal.usda.gov/api-key-signup.html and put it in .env\n" +
            "(gitignored). This script never prints it.",
    );
    process.exit(1);
}

let failures = 0;
const report: string[] = [
    "# USDA FoodData Central live validation",
    "",
    `Validated: ${new Date().toISOString().slice(0, 10)}`,
    "Provider: FoodData Central API v1",
    "Basis: every FDC dataset reports foodNutrients per 100 g.",
    "Tolerance: <= 1 kcal, <= 0.1 g, <= 1 mg, <= 1 mcg (absolute).",
    "null is asserted as null, never as a value near zero.",
    "",
];

for (const { slug, query, grams, prefer } of FOODS) {
    console.log(`\n${slug}  "${query}"  @ ${grams} g`);

    const candidates = await searchFoods(query, { pageSize: 10 });
    if (candidates.length === 0) {
        failures++;
        console.log("  FAIL  no candidates");
        report.push(`## ${slug}`, "", "No search candidates. **FAIL**", "");
        continue;
    }

    // Deliberately NOT "take result #1": for these queries FDC returns
    // materially different foods (raw vs cooked, skin vs skinless), so the
    // choice is made explicitly here and recorded in the report.
    const chosen =
        (prefer
            ? candidates.find((c) =>
                  c.description.toLowerCase().includes(prefer),
              )
            : undefined) ?? candidates[0]!;
    console.log(`  chose fdcId ${chosen.fdcId} — ${chosen.description}`);
    console.log(
        `  other candidates: ${
            candidates
                .filter((c) => c.fdcId !== chosen.fdcId)
                .map((c) => `${c.fdcId} ${c.description}`)
                .join(" | ") || "(none)"
        }`,
    );

    const payload = await fetchFoodFromFdc(chosen.fdcId);
    if (!payload) {
        failures++;
        console.log("  FAIL  detail fetch returned nothing");
        continue;
    }
    // Capture the real record so `bun test` stops asserting against
    // placeholder numbers.
    await Bun.write(
        `src/fixtures/usda/${slug}.json`,
        JSON.stringify(payload, null, 4) + "\n",
    );

    const food = normalizeFdcFood(payload);
    if (!food) {
        failures++;
        console.log("  FAIL  record normalized to nothing");
        continue;
    }
    const scaled = resolveAmount(food, grams);

    report.push(
        `## ${slug} — fdcId ${chosen.fdcId}`,
        "",
        `Record: ${food.name}  (${chosen.dataType ?? "unknown dataset"})`,
        `Basis: per 100 g. Requested: ${grams} g.`,
        "",
        "| nutrient | per 100 g (source) | expected @ serving | actual | diff | result |",
        "| --- | --- | --- | --- | --- | --- |",
    );

    for (const [field, unit] of Object.entries(NUTRIENT_UNITS)) {
        const base = food[field as NutrientField];
        const actual = scaled[field as NutrientField] ?? null;
        // Independent arithmetic: this is NOT src/nutrient-units.ts.
        const expected = base == null ? null : (base * grams) / 100;

        if (expected === null || actual === null) {
            const ok = expected === null && actual === null;
            if (!ok) failures++;
            if (base != null || actual != null) {
                report.push(
                    `| \`${field}\` | ${base ?? "null"} | ${expected ?? "null"} | ${actual ?? "null"} | — | ${ok ? "pass" : "**FAIL**"} |`,
                );
            }
            if (!ok) {
                console.log(
                    `  FAIL  ${field}: expected ${expected ?? "null"}, got ${actual ?? "null"}`,
                );
            }
            continue;
        }

        const diff = Math.abs(actual - expected);
        const ok = diff <= (TOLERANCE[unit] ?? 0);
        if (!ok) {
            failures++;
            console.log(
                `  FAIL  ${field}: expected ${expected}, got ${actual} (diff ${diff} ${unit})`,
            );
        }
        report.push(
            `| \`${field}\` | ${base} | ${expected.toFixed(3)} | ${actual} | ${diff.toFixed(4)} | ${ok ? "pass" : "**FAIL**"} |`,
        );
    }
    report.push("");
}

await Bun.write("validation/usda/live-report.md", report.join("\n"));
console.log(
    `\n${failures === 0 ? "PASS" : `FAIL — ${failures} mismatch(es)`}` +
        "  report: validation/usda/live-report.md" +
        "\nCaptured records written to src/fixtures/usda/ — review the diff," +
        "\nthen update the expected values in src/usda.test.ts to match.",
);
process.exit(failures === 0 ? 0 : 1);
