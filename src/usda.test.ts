import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import {
    normalizeFdcFood,
    readNutrients,
    resolveAmount,
    buildUsdaProvenance,
    searchFoods,
    fetchFoodFromFdc,
    toFdcNutrientUnit,
    UsdaConfigError,
    DEFAULT_DATA_TYPES,
} from "./usda.js";
import { MICRONUTRIENT_FIELDS } from "./nutrients.js";

// No live FDC calls, ever — CONTRACT.md §0.8.
//
// The five food fixtures under src/fixtures/usda/ are REAL payloads captured
// from FoodData Central on 2026-08-19 by `bun run validate:usda`, so every
// number asserted below is a number USDA actually publishes. Re-run that
// script to refresh them; if a value here moves, USDA republished the record.
//
// The four remaining fixtures (kilojoule-only, unexpected-units,
// partial-nutrients, search-raw-vs-cooked) are still SYNTHETIC on purpose —
// each `_note` says so. They cover shapes the real records do not contain
// (energy in kJ only, IU-only vitamins, a missing unitName, a negative
// amount), and a fixture we cannot find in the wild is the only way to test
// them.

const realFetch = globalThis.fetch;

function mockFetch(
    impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
    globalThis.fetch = mock(
        (input: string | URL | Request, init?: RequestInit) =>
            Promise.resolve(impl(String(input), init)),
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
    test("accepts the mass units FDC actually sends, in either case", () => {
        // Live FDC (2026-08-19) sends lowercase with a real micro sign;
        // the published schema shows uppercase. Both must work.
        expect(toFdcNutrientUnit("g")).toBe("g");
        expect(toFdcNutrientUnit("mg")).toBe("mg");
        expect(toFdcNutrientUnit("µg")).toBe("mcg");
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
        // The real record is 171477. The synthetic placeholder guessed
        // 171077 — which is a real fdcId, just a different chicken.
        expect(food.sourceId).toBe("fdc:171477");
        // FDC reports every dataset per 100 g; declaring that honestly is
        // what lets resolveAmount scale exactly once.
        expect(food.serving).toEqual({ kind: "per_100g" });

        // 208 "kcal", never the 268 entry — which this record really does
        // carry, at 690 kJ. Reading that would log 4.2x the calories.
        expect(food.calories).toBe(165);
        expect(food.protein_g).toBe(31.02);
        expect(food.fat_g).toBe(3.57);
        expect(food.saturated_fat_g).toBe(1.01);
        expect(food.cholesterol_mg).toBe(85);
        expect(food.sodium_mg).toBe(74);
        expect(food.potassium_mg).toBe(256);
        expect(food.calcium_mg).toBe(15);
        expect(food.iron_mg).toBe(1.04);
        expect(food.magnesium_mg).toBe(29);
        // 320 (RAE, µg). The record also carries 318 "Vitamin A, IU" = 21 IU
        // and 324 "Vitamin D, IU" = 5 IU; both are dropped, never converted.
        expect(food.vitamin_a_mcg).toBe(6);
        expect(food.vitamin_d_mcg).toBe(0.1);

        // The source explicitly measured zero here — zero is data, and USDA
        // really does publish 0 for all of these on this record.
        expect(food.carbs_g).toBe(0);
        expect(food.fiber_g).toBe(0);
        expect(food.sugar_g).toBe(0);
        expect(food.vitamin_c_mg).toBe(0);
        expect(food.caffeine_mg).toBe(0);
        expect(food.alcohol_g).toBe(0);

        // Genuinely absent from the record — unknown, not zero.
        expect(food.trans_fat_g).toBeNull();
        expect(food.added_sugar_g).toBeNull();
    });

    test("a Survey (FNDDS) record reads identically to an SR Legacy one", async () => {
        // Different dataset, different payload envelope (foodCode /
        // wweiaFoodCategory instead of ndbNumber), same per-100 g basis and
        // the same nutrient numbers and lowercase unit names.
        const food = normalizeFdcFood(await fixture("spinach-raw"))!;
        expect(food.sourceId).toBe("fdc:2709614");
        expect(food.serving).toEqual({ kind: "per_100g" });
        expect(food.calories).toBe(27);
        expect(food.protein_g).toBe(2.85);
        expect(food.carbs_g).toBe(2.41);
        expect(food.fiber_g).toBe(1.6);
        expect(food.magnesium_mg).toBe(93);
        expect(food.potassium_mg).toBe(582);
        expect(food.vitamin_c_mg).toBe(26.5);
        expect(food.vitamin_a_mcg).toBe(283); // µg RAE, lowercase "µg"
        expect(food.vitamin_d_mcg).toBe(0); // measured zero
        expect(food.cholesterol_mg).toBe(0);
        expect(food.trans_fat_g).toBeNull();
        expect(food.added_sugar_g).toBeNull();
    });

    test("a whole-egg record carries trans fat and a real vitamin D", async () => {
        // The only sampled record with nutrient 605 (trans fat) present, and
        // the one that pins vitamin D coming from 328 (µg) rather than the
        // 324 (IU) entry sitting next to it at 82 IU.
        const food = normalizeFdcFood(await fixture("egg-whole-raw"))!;
        expect(food.sourceId).toBe("fdc:171287");
        expect(food.calories).toBe(143);
        expect(food.protein_g).toBe(12.56);
        expect(food.fat_g).toBe(9.51);
        expect(food.saturated_fat_g).toBe(3.126);
        expect(food.trans_fat_g).toBe(0.038);
        expect(food.cholesterol_mg).toBe(372);
        expect(food.vitamin_a_mcg).toBe(160);
        expect(food.vitamin_d_mcg).toBe(2);
        expect(food.added_sugar_g).toBeNull();
    });

    test("plant foods keep zero cholesterol as zero, not null", async () => {
        const potato = normalizeFdcFood(await fixture("potato-baked"))!;
        expect(potato.sourceId).toBe("fdc:170111");
        expect(potato.calories).toBe(93);
        expect(potato.carbs_g).toBe(21.15);
        expect(potato.fiber_g).toBe(2.2);
        expect(potato.potassium_mg).toBe(535);
        expect(potato.vitamin_c_mg).toBe(9.6);
        expect(potato.cholesterol_mg).toBe(0);
        expect(potato.trans_fat_g).toBe(0);

        const rice = normalizeFdcFood(await fixture("rice-white-cooked"))!;
        expect(rice.sourceId).toBe("fdc:169708");
        expect(rice.calories).toBe(123);
        expect(rice.carbs_g).toBe(26.05);
        expect(rice.iron_mg).toBe(1.81); // enriched
        expect(rice.cholesterol_mg).toBe(0);
        expect(rice.vitamin_a_mcg).toBe(0);
        expect(rice.trans_fat_g).toBeNull(); // absent, unlike the potato's 0
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
        expect(scaled.potassium_mg).toBeCloseTo(384, 6); // 256 * 1.5
        expect(scaled.vitamin_d_mcg).toBeCloseTo(0.15, 6); // 0.1 * 1.5
        // Explicit zero scales to zero; unknown stays unknown.
        expect(scaled.carbs_g).toBe(0);
        expect(scaled.vitamin_c_mg).toBe(0);
        expect(scaled.trans_fat_g).toBeNull();
        expect(scaled.added_sugar_g).toBeNull();
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

    test("searches by POST body, keeping parentheses out of the URL", async () => {
        let seenUrl = "";
        let seenInit: RequestInit | undefined;
        mockFetch(async (url, init) => {
            seenUrl = url;
            seenInit = init;
            return Response.json({ foods: [] });
        });
        await searchFoods("chicken (cooked)");

        // THE LOCK on the live 400: api.data.gov's edge intermittently
        // rejects any query string containing "(" or ")", and one dataset is
        // named "Survey (FNDDS)". Only api_key may ride in the URL.
        expect(seenUrl).not.toContain("(");
        expect(seenUrl).not.toContain(")");
        expect(seenUrl).not.toContain("%28");
        expect([...new URL(seenUrl).searchParams.keys()]).toEqual(["api_key"]);

        expect(seenInit?.method).toBe("POST");
        const body = JSON.parse(String(seenInit?.body));
        expect(body.query).toBe("chicken (cooked)");
        expect(body.dataType).toEqual([...DEFAULT_DATA_TYPES]);
        expect(body.dataType).not.toContain("Branded");
    });

    test("a 404 is an empty lookup, not an error", async () => {
        // FDC's search index and detail endpoint are not in sync: fdcId
        // 747447 is a live search hit that 404s on /food/{id}.
        mockFetch(() => new Response("", { status: 404 }));
        expect(await fetchFoodFromFdc(747447)).toBeNull();
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
