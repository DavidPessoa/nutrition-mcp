import { test, expect, mock, beforeEach, afterEach, describe } from "bun:test";
import {
    normalizeBarcode,
    fetchProductFromOFF,
    formatFoodResult,
    buildOFFProvenance,
    toFoodNutrition,
    type FoodResult,
} from "./foods.js";
import { emptyNutrientValues } from "./providers/types.js";

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = mock((input: string | URL | Request) =>
        Promise.resolve(impl(String(input))),
    ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

beforeEach(() => {
    process.env.OFF_USER_AGENT = "nutrition-mcp-test (test@example.com)";
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe("normalizeBarcode", () => {
    test("keeps valid digit strings", () => {
        expect(normalizeBarcode("737628064502")).toBe("737628064502");
    });

    test("strips spaces and separators", () => {
        expect(normalizeBarcode(" 7376-2806 4502 ")).toBe("737628064502");
    });

    test("accepts EAN-8 lower bound and GTIN-14 upper bound", () => {
        expect(normalizeBarcode("12345678")).toBe("12345678");
        expect(normalizeBarcode("12345678901234")).toBe("12345678901234");
    });

    test("rejects too-short and too-long inputs", () => {
        expect(normalizeBarcode("1234567")).toBeNull();
        expect(normalizeBarcode("123456789012345")).toBeNull();
    });

    test("rejects non-numeric junk", () => {
        expect(normalizeBarcode("abc")).toBeNull();
        expect(normalizeBarcode("")).toBeNull();
    });
});

describe("fetchProductFromOFF", () => {
    test("normalizes per-serving values when a serving size is present", async () => {
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Coconut Milk",
                    brands: "Thai Kitchen, Simply Asia",
                    serving_size: "80 ml",
                    nutriments: {
                        "energy-kcal_serving": 120,
                        "energy-kcal_100g": 150,
                        proteins_serving: 1.2,
                        carbohydrates_serving: 2,
                        fat_serving: 12.34,
                    },
                },
            }),
        );

        const food = await fetchProductFromOFF("737628064502");
        expect(food).not.toBeNull();
        expect(food!.name).toBe("Coconut Milk");
        expect(food!.brand).toBe("Thai Kitchen"); // first brand only
        expect(food!.serving).toBe("80 ml");
        expect(food!.calories).toBe(120);
        expect(food!.protein_g).toBe(1.2);
        expect(food!.carbs_g).toBe(2);
        expect(food!.fat_g).toBe(12.3); // rounded to one decimal
        expect(food!.source).toBe("off:737628064502");
    });

    test("maps fiber and total sugars per serving", async () => {
        // Real shape from OFF barcode 3229820129488 (Muesli): OFF spells the key
        // "fiber" (American) and "sugars" (plural), both in grams, both scaled
        // to the serving alongside the other macros.
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Muesli Raisin, Figue, Datte, Abricot",
                    serving_size: "60g",
                    nutriments: {
                        "energy-kcal_serving": 220,
                        "energy-kcal_100g": 367,
                        fiber_100g: 10,
                        fiber_serving: 6,
                        fiber_unit: "g",
                        sugars_100g: 14,
                        sugars_serving: 8.4,
                        sugars_unit: "g",
                        // Present in OFF but deliberately ignored: we store
                        // TOTAL sugars, never added sugars.
                        "added-sugars_serving": 1.2,
                    },
                },
            }),
        );

        const food = await fetchProductFromOFF("3229820129488");
        expect(food!.serving).toBe("60g");
        expect(food!.fiber_g).toBe(6);
        expect(food!.sugar_g).toBe(8.4);
        expect(food!.alcohol_g).toBeNull();
    });

    test("falls back to per-100g fiber and sugars", async () => {
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Bran",
                    nutriments: {
                        "energy-kcal_100g": 250,
                        fiber_100g: 42.55,
                        sugars_100g: 0.7,
                    },
                },
            }),
        );

        const food = await fetchProductFromOFF("123456789");
        expect(food!.serving).toBe("100 g");
        expect(food!.fiber_g).toBe(42.6); // rounded to one decimal
        expect(food!.sugar_g).toBe(0.7);
    });

    test("leaves fiber and sugar null when OFF carries neither", async () => {
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Olive Oil",
                    nutriments: { "energy-kcal_100g": 884, fat_100g: 100 },
                },
            }),
        );

        const food = await fetchProductFromOFF("123456789");
        expect(food!.fiber_g).toBeNull();
        expect(food!.sugar_g).toBeNull();
    });
});

// Open Food Facts reports alcohol as ABV ("% vol"), never as grams — the raw
// value must never be copied into alcohol_g. See resolveAlcoholGrams in
// src/foods.ts for the evidence behind these rules.
describe("fetchProductFromOFF alcohol (ABV, not grams)", () => {
    // Shape copied from a real OFF beer record: note that alcohol does NOT
    // scale with the serving the way carbohydrates does — that is what proves
    // it is a percentage rather than a mass.
    function beer(over: Record<string, unknown> = {}) {
        return {
            status: 1,
            product: {
                product_name: "Cerveza Heineken",
                serving_size: "330ml",
                serving_quantity: 330,
                serving_quantity_unit: "ml",
                nutriments: {
                    "energy-kcal_serving": 139,
                    "energy-kcal_100g": 42,
                    carbohydrates_100g: 3,
                    carbohydrates_serving: 9.9,
                    alcohol: 5,
                    alcohol_100g: 5,
                    alcohol_serving: 5,
                    alcohol_unit: "% vol",
                },
                ...over,
            },
        };
    }

    test("converts ABV to grams of ethanol using the mL serving volume", async () => {
        mockFetch(() => jsonResponse(beer()));

        const food = await fetchProductFromOFF("75041670");
        // 330 mL x 5% = 16.5 mL ethanol x 0.789 g/mL = 13.02 g.
        expect(food!.alcohol_g).toBe(13);
        // The raw ABV must never leak through as if it were grams.
        expect(food!.alcohol_g).not.toBe(5);
    });

    test("keeps a genuine 0% ABV as 0 g, distinct from unknown", async () => {
        mockFetch(() =>
            jsonResponse(
                beer({
                    product_name: "Bière Blonde sans alcool 1664",
                    nutriments: {
                        "energy-kcal_serving": 60,
                        alcohol: 0,
                        alcohol_serving: 0,
                        alcohol_100g: 0,
                        alcohol_unit: "% vol",
                    },
                }),
            ),
        );

        const food = await fetchProductFromOFF("3080216055428");
        expect(food!.alcohol_g).toBe(0);
    });

    test("is null when OFF parsed no serving quantity", async () => {
        // Corona Extra is exactly this: a real ABV, but no serving volume at
        // all, so there is nothing to multiply by.
        mockFetch(() =>
            jsonResponse(
                beer({ serving_quantity: null, serving_quantity_unit: "ml" }),
            ),
        );

        expect((await fetchProductFromOFF("75041670"))!.alcohol_g).toBeNull();
    });

    test("is null when the serving quantity is a mass, not a volume", async () => {
        // ABV is per unit volume; converting from grams would need the
        // beverage's density, which OFF does not publish.
        mockFetch(() =>
            jsonResponse(
                beer({ serving_quantity: 330, serving_quantity_unit: "g" }),
            ),
        );

        expect((await fetchProductFromOFF("75041670"))!.alcohol_g).toBeNull();
    });

    test("is null on the per-100g basis, which would mix bases", async () => {
        // No serving_size / no per-serving energy => the 100 g fallback. Every
        // other field is then per 100 GRAMS, so a volume-derived alcohol figure
        // would not belong to the same basis.
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Vin blanc sec",
                    serving_quantity: 250,
                    serving_quantity_unit: "ml",
                    nutriments: {
                        "energy-kcal_100g": 73,
                        alcohol: 11,
                        alcohol_100g: 11,
                        alcohol_unit: "% vol",
                    },
                },
            }),
        );

        const food = await fetchProductFromOFF("3175520036338");
        expect(food!.serving).toBe("100 g");
        expect(food!.alcohol_g).toBeNull();
    });

    test("is null when the unit is not '% vol'", async () => {
        // If OFF ever changes the unit we must not silently reinterpret it.
        mockFetch(() =>
            jsonResponse(
                beer({ nutriments: { ...beer().product.nutriments } }),
            ),
        );
        // sanity: the shared fixture does convert
        expect((await fetchProductFromOFF("75041670"))!.alcohol_g).toBe(13);

        mockFetch(() =>
            jsonResponse(
                beer({
                    nutriments: {
                        "energy-kcal_serving": 139,
                        alcohol: 5,
                        alcohol_serving: 5,
                        alcohol_unit: "g",
                    },
                }),
            ),
        );
        expect((await fetchProductFromOFF("75041670"))!.alcohol_g).toBeNull();

        mockFetch(() =>
            jsonResponse(
                beer({
                    nutriments: {
                        "energy-kcal_serving": 139,
                        alcohol: 5,
                        alcohol_serving: 5,
                    },
                }),
            ),
        );
        expect((await fetchProductFromOFF("75041670"))!.alcohol_g).toBeNull();
    });

    test("is null for an out-of-range ABV instead of throwing", async () => {
        // gramsFromDrink throws on nonsense; a corrupt community-edited value
        // must degrade to null rather than break the whole lookup.
        for (const bad of [120, -1, "not a number"]) {
            mockFetch(() =>
                jsonResponse(
                    beer({
                        nutriments: {
                            "energy-kcal_serving": 139,
                            alcohol: bad,
                            alcohol_serving: bad,
                            alcohol_unit: "% vol",
                        },
                    }),
                ),
            );
            const food = await fetchProductFromOFF("75041670");
            expect(food!.alcohol_g).toBeNull();
        }
    });

    test("a spirit's ABV is never mistaken for grams", async () => {
        // The failure this whole design exists to prevent: 40 would be a
        // plausible-looking gram figure, and it is wrong by 3.5x for a 40 mL
        // measure.
        mockFetch(() =>
            jsonResponse(
                beer({
                    product_name: "Vodka",
                    serving_size: "40 ml",
                    serving_quantity: 40,
                    serving_quantity_unit: "ml",
                    nutriments: {
                        "energy-kcal_serving": 90,
                        alcohol: 40,
                        alcohol_serving: 40,
                        alcohol_100g: 40,
                        alcohol_unit: "% vol",
                    },
                }),
            ),
        );

        const food = await fetchProductFromOFF("75041670");
        // 40 mL x 40% x 0.789 = 12.62 g -> 12.6
        expect(food!.alcohol_g).toBe(12.6);
    });

    test("falls back to per-100g basis when no serving energy", async () => {
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Olive Oil",
                    nutriments: {
                        "energy-kcal_100g": 884,
                        proteins_100g: 0,
                        carbohydrates_100g: 0,
                        fat_100g: 100,
                    },
                },
            }),
        );

        const food = await fetchProductFromOFF("123456789");
        expect(food!.serving).toBe("100 g");
        expect(food!.calories).toBe(884);
        expect(food!.fat_g).toBe(100);
        expect(food!.brand).toBeNull();
    });

    test("returns null when OFF reports status 0", async () => {
        mockFetch(() => jsonResponse({ status: 0 }));
        expect(await fetchProductFromOFF("000000000000")).toBeNull();
    });

    test("returns null on HTTP 404", async () => {
        mockFetch(() => jsonResponse({ status: 0 }, 404));
        expect(await fetchProductFromOFF("000000000000")).toBeNull();
    });

    test("throws on unexpected HTTP error so the caller can degrade", async () => {
        mockFetch(() => jsonResponse({}, 500));
        expect(fetchProductFromOFF("737628064502")).rejects.toThrow(
            /Open Food Facts request failed: 500/,
        );
    });

    test("treats a stub product with no macros as not found (no empty cache)", async () => {
        // OFF returns status 1 for entries that exist but carry no nutriments.
        // We must report a miss so the caller can fall back to estimation and
        // no empty record is cached.
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: { product_name: "Mystery Snack" },
            }),
        );
        expect(await fetchProductFromOFF("737628064502")).toBeNull();
    });

    test("keeps a product that has at least one macro even if others are null", async () => {
        mockFetch(() =>
            jsonResponse({
                status: 1,
                product: {
                    product_name: "Just Calories",
                    nutriments: { "energy-kcal_100g": 250 },
                },
            }),
        );
        const food = await fetchProductFromOFF("737628064502");
        expect(food!.name).toBe("Just Calories");
        expect(food!.calories).toBe(250);
        expect(food!.protein_g).toBeNull();
    });

    test("sends the configured User-Agent and throws when it is unset", async () => {
        const seen: { ua: string | null } = { ua: null };
        globalThis.fetch = mock(
            (_input: string | URL | Request, init?: RequestInit) => {
                seen.ua = new Headers(init?.headers).get("User-Agent");
                return Promise.resolve(jsonResponse({ status: 0 }));
            },
        ) as unknown as typeof fetch;

        await fetchProductFromOFF("737628064502");
        expect(seen.ua).toBe("nutrition-mcp-test (test@example.com)");

        delete process.env.OFF_USER_AGENT;
        expect(fetchProductFromOFF("737628064502")).rejects.toThrow(
            /OFF_USER_AGENT is not configured/,
        );
    });
});

describe("formatFoodResult", () => {
    const base: FoodResult = {
        servingBasis: { kind: "per_100g" },
        name: "Coconut Milk",
        brand: "Thai Kitchen",
        serving: "80 ml",
        calories: 120,
        protein_g: 1.2,
        carbs_g: 2,
        fat_g: 12,
        fiber_g: 0.5,
        sugar_g: 1.8,
        alcohol_g: null,
        caffeine_mg: null,
        saturated_fat_g: null,
        trans_fat_g: null,
        added_sugar_g: null,
        sodium_mg: null,
        potassium_mg: null,
        cholesterol_mg: null,
        calcium_mg: null,
        iron_mg: null,
        magnesium_mg: null,
        vitamin_a_mcg: null,
        vitamin_c_mg: null,
        vitamin_d_mcg: null,
        provenance: null,
        source: "off:737628064502",
        source_name: "openfoodfacts",
        barcode: "737628064502",
    };

    test("includes brand, serving, macros, and source", () => {
        const text = formatFoodResult(base);
        expect(text).toContain("Coconut Milk (Thai Kitchen)");
        expect(text).toContain("Serving: 80 ml");
        expect(text).toContain("120 kcal");
        expect(text).toContain("barcode 737628064502");
    });

    // "n/a" states the gap but leaves the model to decide what to do with it,
    // and what it did was omit the field — which records "nobody measured
    // this" and drops the whole day from the fiber average.
    test("an n/a fiber or sugar comes with what to do about it", () => {
        const text = formatFoodResult({ ...base, fiber_g: null });
        expect(text).toContain("no fiber figure");
        expect(text).toContain("not a zero");
        expect(text).toContain("log_meal");
        expect(text).not.toContain("no fiber or sugar figure");
    });

    test("both missing are named in one line", () => {
        const text = formatFoodResult({
            ...base,
            fiber_g: null,
            sugar_g: null,
        });
        expect(text).toContain("no fiber or sugar figure");
    });

    test("nothing is appended when the label carried both", () => {
        expect(formatFoodResult(base)).not.toContain("not a zero");
    });

    test("renders n/a for missing macros and omits empty brand", () => {
        const text = formatFoodResult({
            ...base,
            brand: null,
            calories: null,
        });
        expect(text).toContain("Coconut Milk\n");
        expect(text).not.toContain("()");
        expect(text).toContain("Calories: n/a");
    });
});

// ---------------------------------------------------------------------------
// Micronutrient mapping (Agent 3) — fixtures only, never a live call.
// ---------------------------------------------------------------------------
//
// The three product fixtures under src/fixtures/off/ are REAL Open Food Facts
// API v2 responses, captured 2026-08-19 and trimmed to the fields this module
// reads (see validation/open-food-facts/README.md for the capture command and
// the hand-computed expected values). The rest are synthetic and say so in
// their own `_note`.
//
// The assertion style here is deliberate: a micronutrient the source did not
// report is asserted `toBeNull()`, NEVER `toBe(0)` and never a numeric
// tolerance around zero — "within 0.1 of zero" would pass for an unrecorded
// nutrient, which is the exact null-vs-zero collapse CONTRACT.md 0.1 forbids.

async function offFixture(name: string): Promise<unknown> {
    return await Bun.file(
        `${import.meta.dir}/fixtures/off/${name}.json`,
    ).json();
}

async function fromFixture(name: string, barcode: string) {
    mockFetch(async () => jsonResponse(await offFixture(name)));
    const food = await fetchProductFromOFF(barcode);
    expect(food).not.toBeNull();
    return food!;
}

const MICRONUTRIENT_KEYS = [
    "saturated_fat_g",
    "trans_fat_g",
    "added_sugar_g",
    "sodium_mg",
    "potassium_mg",
    "cholesterol_mg",
    "calcium_mg",
    "iron_mg",
    "magnesium_mg",
    "vitamin_a_mcg",
    "vitamin_c_mg",
    "vitamin_d_mcg",
] as const;

describe("micronutrients from real OFF fixtures", () => {
    test("Nutella (per-100g, sub-0.1 g sodium) — the false-zero landmine", async () => {
        const food = await fromFixture("nutella-per-100g", "3017620422003");

        // 0.0428 g of sodium. Rounding to one decimal BEFORE converting
        // yields 0.0 g -> 0 mg: a real 42.8 mg figure destroyed and, worse,
        // replaced by a confident zero. This assertion is the regression lock
        // on that whole class of bug.
        expect(food.sodium_mg).toBe(42.8);

        expect(food.saturated_fat_g).toBe(10.6);
        // Added sugar is its own OFF key and is never derived from total
        // sugars — both are present here and they differ.
        expect(food.added_sugar_g).toBe(52.13);
        expect(food.sugar_g).toBe(56.3);

        // Everything Nutella's record does not carry stays unknown.
        for (const key of [
            "trans_fat_g",
            "potassium_mg",
            "cholesterol_mg",
            "calcium_mg",
            "iron_mg",
            "magnesium_mg",
            "vitamin_a_mcg",
            "vitamin_c_mg",
            "vitamin_d_mcg",
        ] as const) {
            expect(food[key]).toBeNull();
        }

        // OFF carries no caffeine nutriment at all.
        expect(food.caffeine_mg).toBeNull();

        expect(food.serving).toBe("100 g");
        expect(food.servingBasis).toEqual({ kind: "per_100g" });
    });

    test("Cheerios (per-serving) — explicit zeros survive as zero", async () => {
        const food = await fromFixture("cheerios-per-serving", "016000275287");

        expect(food.servingBasis).toEqual({
            kind: "per_serving",
            grams: 39,
            label: "39g",
        });

        // 0.19 g -> 190 mg, read from the _serving key, not _100g
        // (0.487… g would be 487 mg).
        expect(food.sodium_mg).toBe(190);
        expect(food.saturated_fat_g).toBe(0.5);

        // The source explicitly reports zero for these. Zero is DATA here and
        // must not be nulled out any more than a missing value may become 0.
        expect(food.trans_fat_g).toBe(0);
        expect(food.cholesterol_mg).toBe(0);
        expect(food.added_sugar_g).toBe(0);
    });

    test("Chocapic (per-serving) — microgram-scale vitamin D", async () => {
        const food = await fromFixture("chocapic-per-serving", "3387390123210");

        // 0.00000102 g. Through the mcg pivot this is 1.0200000000000002
        // before the noise guard; anything but exactly 1.02 means the guard
        // regressed.
        expect(food.vitamin_d_mcg).toBe(1.02);
        expect(food.calcium_mg).toBe(150);
        expect(food.iron_mg).toBe(3.6);
        expect(food.sodium_mg).toBe(24);
        expect(food.added_sugar_g).toBe(5.78);
        expect(food.servingBasis).toEqual({
            kind: "per_serving",
            grams: 30,
            label: "30 g",
        });
    });
});

describe("micronutrient edge cases", () => {
    test("a product carrying one micronutrient leaves the other eleven null", async () => {
        const food = await fromFixture("partial-micros", "0000000000017");
        expect(food.sodium_mg).toBe(500);
        for (const key of MICRONUTRIENT_KEYS) {
            if (key === "sodium_mg") continue;
            expect(food[key]).toBeNull();
        }
    });

    test("ambiguous or absent units yield null, never a guessed number", async () => {
        const food = await fromFixture("unknown-units", "0000000000024");
        // IU -> µg RAE has no single valid factor (see src/nutrient-units.ts).
        expect(food.vitamin_a_mcg).toBeNull();
        // Amount present, no _unit key at all.
        expect(food.potassium_mg).toBeNull();
        // "%" of some daily value is not a mass.
        expect(food.magnesium_mg).toBeNull();
        // "kg" is a mass but never a real per-100g nutrient unit; treated as
        // unrecognized rather than shifted by 1e6.
        expect(food.calcium_mg).toBeNull();
    });

    test("unusable amounts yield null; numeric strings still parse", async () => {
        const food = await fromFixture("bad-values", "0000000000031");
        expect(food.sodium_mg).toBeNull(); // "n/a"
        expect(food.potassium_mg).toBeNull(); // JSON null
        expect(food.calcium_mg).toBeNull(); // ""
        expect(food.magnesium_mg).toBeNull(); // true
        expect(food.iron_mg).toBe(14); // "0.014" g -> 14 mg
    });

    test("a serving_size without per-serving energy falls back to per-100g for micros too", async () => {
        const food = await fromFixture(
            "serving-basis-fallback",
            "0000000000048",
        );
        expect(food.servingBasis).toEqual({ kind: "per_100g" });
        // The _serving keys exist and carry different numbers; reading them
        // here would mix two bases inside one product.
        expect(food.sodium_mg).toBe(400);
        expect(food.calcium_mg).toBe(200);
    });

    test("a volume-parsed serving keeps grams null rather than borrowing the volume", async () => {
        const food = await fromFixture(
            "serving-no-gram-weight",
            "0000000000055",
        );
        expect(food.servingBasis).toEqual({
            kind: "per_serving",
            grams: null,
            label: "330 ml",
        });
        expect(food.sodium_mg).toBe(33);
    });
});

describe("OFF provenance", () => {
    test("every populated nutrient gets an entry, every null one gets none", async () => {
        const food = await fromFixture("partial-micros", "0000000000017");
        const provenance = food.provenance!;
        expect(provenance.sodium_mg).toEqual({
            source: "open_food_facts",
            source_id: "off:0000000000017",
            confidence: "authoritative",
        });
        expect(provenance.calories).toBeDefined();
        // Provenance describes where a VALUE came from; there is no value.
        for (const key of MICRONUTRIENT_KEYS) {
            if (key === "sodium_mg") continue;
            expect(provenance[key]).toBeUndefined();
        }
        expect(provenance.caffeine_mg).toBeUndefined();
    });

    test("buildOFFProvenance returns null when nothing was populated", () => {
        const empty = {
            ...emptyNutrientValues(),
            source: "off:0000000000017",
        } as unknown as FoodResult;
        expect(buildOFFProvenance(empty)).toBeNull();
    });
});

describe("toFoodNutrition adapter", () => {
    test("maps onto the cross-provider shape without renaming values", async () => {
        const food = await fromFixture("cheerios-per-serving", "016000275287");
        const nutrition = toFoodNutrition(food);
        expect(nutrition.source).toBe("open_food_facts");
        expect(nutrition.sourceId).toBe("off:016000275287");
        expect(nutrition.serving).toEqual(food.servingBasis);
        expect(nutrition.name).toBe(food.name);
        expect(nutrition.brand).toBe(food.brand);
        for (const key of MICRONUTRIENT_KEYS) {
            expect(nutrition[key]).toBe(food[key]);
        }
    });
});
