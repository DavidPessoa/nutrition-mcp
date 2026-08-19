import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import {
    normalizeFdcFood,
    readNutrients,
    resolveAmount,
    buildUsdaProvenance,
    searchFoods,
    toFdcNutrientUnit,
    UsdaConfigError,
    DEFAULT_DATA_TYPES,
} from "./usda.js";
import { MICRONUTRIENT_FIELDS } from "./nutrients.js";

// No live FDC calls, ever — CONTRACT.md §0.8. Fixtures under
// src/fixtures/usda/ are currently SYNTHETIC but schema-shaped (see each
// file's `_note` and validation/usda/README.md); they are modeled on USDA's
// published OpenAPI schema, so they exercise the real response SHAPE even
// though the numbers still await a live capture.

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = mock((input: string | URL | Request) =>
        Promise.resolve(impl(String(input))),
    ) as unknown as typeof fetch;
}

async function fixture(name: string): Promise<unknown> {
    return await Bun.file(
        `${import.meta.dir}/fixtures/usda/${name}.json`,
    ).json();
}

beforeEach(() => {
    process.env.USDA_FDC_API_KEY = "test-key-not-a-real-one";
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("toFdcNutrientUnit", () => {
    test("accepts FDC's uppercase mass units", () => {
        expect(toFdcNutrientUnit("G")).toBe("g");
        expect(toFdcNutrientUnit("MG")).toBe("mg");
        expect(toFdcNutrientUnit("UG")).toBe("mcg");
        expect(toFdcNutrientUnit(" mg ")).toBe("mg");
    });

    test("rejects everything that is not confidently a mass", () => {
        for (const unit of ["IU", "MG_ATE", "KCAL", "kJ", "%", "", null, 5]) {
            expect(toFdcNutrientUnit(unit)).toBeNull();
        }
    });
});

describe("normalizeFdcFood", () => {
    test("maps a whole food with extensive micronutrients", async () => {
        const food = normalizeFdcFood(await fixture("chicken-breast-roasted"))!;
        expect(food).not.toBeNull();
        expect(food.name).toBe(
            "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
        );
        expect(food.source).toBe("usda_fdc");
        expect(food.sourceId).toBe("fdc:171077");
        // FDC reports every dataset per 100 g; declaring that honestly is
        // what lets resolveAmount scale exactly once.
        expect(food.serving).toEqual({ kind: "per_100g" });

        expect(food.calories).toBe(165); // 208 KCAL, never the 268 kJ entry
        expect(food.protein_g).toBe(31.02);
        expect(food.fat_g).toBe(3.57);
        expect(food.saturated_fat_g).toBe(1.01);
        expect(food.cholesterol_mg).toBe(85);
        expect(food.sodium_mg).toBe(74);
        expect(food.potassium_mg).toBe(256);
        expect(food.magnesium_mg).toBe(29);
        expect(food.vitamin_a_mcg).toBe(6); // 320 RAE, not the 318 IU entry
        expect(food.vitamin_d_mcg).toBe(0.2);

        // The source explicitly measured zero here — zero is data.
        expect(food.carbs_g).toBe(0);
        expect(food.fiber_g).toBe(0);

        // Not measured in this record.
        expect(food.sugar_g).toBeNull();
        expect(food.added_sugar_g).toBeNull();
        expect(food.vitamin_c_mg).toBeNull();
        expect(food.caffeine_mg).toBeNull();
    });

    test("a macros-only record leaves every micronutrient null", async () => {
        const food = normalizeFdcFood(await fixture("partial-nutrients"))!;
        expect(food.calories).toBe(141);
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(food[field]).toBeNull();
        }
    });

    test("kilojoule energy never becomes calories", async () => {
        const food = normalizeFdcFood(await fixture("kilojoule-only"))!;
        // 1506 kJ is 360 kcal. Reading it straight would be a 4x error that
        // looks entirely plausible in a food log.
        expect(food.calories).toBeNull();
        expect(food.protein_g).toBe(12); // the rest of the record still maps
    });

    test("unconvertible units and negative amounts yield null", async () => {
        const food = normalizeFdcFood(await fixture("unexpected-units"))!;
        expect(food.vitamin_a_mcg).toBeNull(); // IU only, no RAE entry
        expect(food.vitamin_d_mcg).toBeNull(); // IU only
        expect(food.calcium_mg).toBeNull(); // no unitName at all
        expect(food.sodium_mg).toBeNull(); // negative amount
        expect(food.calories).toBe(200); // unaffected
    });

    test("rejects a payload with no id or no usable macro", () => {
        expect(normalizeFdcFood(null)).toBeNull();
        expect(normalizeFdcFood({ description: "no id" })).toBeNull();
        expect(
            normalizeFdcFood({
                fdcId: 1,
                description: "empty",
                foodNutrients: [],
            }),
        ).toBeNull();
        // Sodium but no macros is a broken record, not a usable hit.
        expect(
            normalizeFdcFood({
                fdcId: 2,
                description: "sodium only",
                foodNutrients: [
                    {
                        amount: 5,
                        nutrient: { number: "307", unitName: "MG" },
                    },
                ],
            }),
        ).toBeNull();
    });

    test("the first usable entry wins when a nutrient repeats", () => {
        const values = readNutrients([
            { nutrient: { number: "307", unitName: "MG" }, amount: 74 },
            { nutrient: { number: "307", unitName: "MG" }, amount: 999 },
        ]);
        expect(values.sodium_mg).toBe(74);
    });

    test("a nutrient reported in grams converts to the canonical unit", () => {
        // FDC reports minerals in MG today, but the unit is read from the
        // payload rather than assumed, so a gram-reported sodium converts
        // instead of being off by 1000.
        const values = readNutrients([
            { nutrient: { number: "307", unitName: "G" }, amount: 0.074 },
        ]);
        expect(values.sodium_mg).toBe(74);
    });
});

describe("resolveAmount", () => {
    test("scales per-100g figures to a requested gram amount, exactly once", async () => {
        const food = normalizeFdcFood(await fixture("chicken-breast-roasted"))!;
        const scaled = resolveAmount(food, 150);
        expect(scaled.calories).toBeCloseTo(247.5, 6); // 165 * 1.5
        expect(scaled.protein_g).toBeCloseTo(46.53, 6); // 31.02 * 1.5
        expect(scaled.sodium_mg).toBeCloseTo(111, 6); // 74 * 1.5
        expect(scaled.vitamin_d_mcg).toBeCloseTo(0.3, 6);
        // Explicit zero scales to zero; unknown stays unknown.
        expect(scaled.carbs_g).toBe(0);
        expect(scaled.vitamin_c_mg).toBeNull();
    });

    test("an unusable gram amount yields null, not a zeroed meal", async () => {
        const food = normalizeFdcFood(await fixture("partial-nutrients"))!;
        for (const grams of [-1, NaN, Infinity]) {
            expect(resolveAmount(food, grams).calories).toBeNull();
        }
    });
});

describe("buildUsdaProvenance", () => {
    test("attributes populated fields only", async () => {
        const food = normalizeFdcFood(await fixture("partial-nutrients"))!;
        const provenance = buildUsdaProvenance(food, food.sourceId)!;
        expect(provenance.calories).toEqual({
            source: "usda_fdc",
            source_id: "fdc:2341234",
            confidence: "authoritative",
        });
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(provenance[field]).toBeUndefined();
        }
    });

    test("returns null when nothing was populated", () => {
        expect(buildUsdaProvenance({ sodium_mg: null }, "fdc:1")).toBeNull();
    });
});

describe("searchFoods", () => {
    test("returns every materially different candidate, unranked", async () => {
        mockFetch(async () =>
            Response.json(await fixture("search-raw-vs-cooked")),
        );
        const candidates = await searchFoods("roasted chicken breast");
        expect(candidates).toHaveLength(4);
        // Raw, skinless-roasted and skin-on-roasted are all present: the
        // caller decides, this module does not silently pick #1.
        expect(candidates.map((c) => c.fdcId)).toEqual([
            171077, 171075, 171074, 2646170,
        ]);
        expect(candidates[0]!.dataType).toBe("SR Legacy");
        expect(candidates[0]!.category).toBe("Poultry Products");
        // The abridged search shape uses a flat nutrient object with an
        // INTEGER number; it must read the same as the nested detail shape.
        expect(candidates[0]!.preview.calories).toBe(165);
        expect(candidates[0]!.preview.protein_g).toBe(31.02);
        expect(candidates[3]!.preview.calories).toBeNull();
    });

    test("sends the default generic-food datasets and never Branded", async () => {
        let seen = "";
        mockFetch(async (url) => {
            seen = url;
            return Response.json({ foods: [] });
        });
        await searchFoods("spinach");
        const params = new URL(seen).searchParams;
        expect(params.get("dataType")).toBe(DEFAULT_DATA_TYPES.join(","));
        expect(params.get("query")).toBe("spinach");
    });

    test("an empty query never hits the network", async () => {
        mockFetch(() => {
            throw new Error("should not fetch");
        });
        expect(await searchFoods("   ")).toEqual([]);
    });

    test("a missing API key fails loudly rather than silently returning nothing", async () => {
        delete process.env.USDA_FDC_API_KEY;
        await expect(searchFoods("spinach")).rejects.toThrow(UsdaConfigError);
    });

    test("an API error never leaks the key-bearing URL", async () => {
        mockFetch(() => new Response("nope", { status: 403 }));
        try {
            await searchFoods("spinach");
            throw new Error("expected a throw");
        } catch (error) {
            expect(String(error)).toContain("403");
            expect(String(error)).not.toContain("api_key");
            expect(String(error)).not.toContain("test-key-not-a-real-one");
        }
    });
});
