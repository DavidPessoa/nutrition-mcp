import { test, expect, describe } from "bun:test";
import {
    NUTRIENT_FIELDS,
    MICRONUTRIENT_FIELDS,
    ESTIMABLE_FIELDS,
    NUTRIENT_UNITS,
    SOURCE_PRECEDENCE,
    parseNutrientProvenance,
    isValidNutrientValue,
    assertValidNutrientValue,
    type NutrientField,
    type NutrientProvenanceEntry,
} from "./nutrients.js";

// ---------------------------------------------------------------------------
// Field membership — the single source of truth every other layer derives
// from. These pin the exact contract (CONTRACT §1, §3), not just "some
// fields exist".
// ---------------------------------------------------------------------------

describe("NUTRIENT_FIELDS / MICRONUTRIENT_FIELDS / ESTIMABLE_FIELDS", () => {
    const EXPECTED_EXISTING = [
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugar_g",
        "alcohol_g",
        "caffeine_mg",
    ];

    const EXPECTED_MICRONUTRIENTS = [
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
    ];

    test("MICRONUTRIENT_FIELDS is exactly the twelve new fields from CONTRACT §1, no more, no fewer", () => {
        expect(MICRONUTRIENT_FIELDS.length).toBe(12);
        expect(([...MICRONUTRIENT_FIELDS] as string[]).sort()).toEqual(
            [...EXPECTED_MICRONUTRIENTS].sort(),
        );
    });

    test("NUTRIENT_FIELDS is exactly the 8 existing + 12 new fields, no more, no fewer", () => {
        expect(NUTRIENT_FIELDS.length).toBe(20);
        expect(([...NUTRIENT_FIELDS] as string[]).sort()).toEqual(
            [...EXPECTED_EXISTING, ...EXPECTED_MICRONUTRIENTS].sort(),
        );
    });

    test("NUTRIENT_FIELDS has no duplicates", () => {
        expect(new Set(NUTRIENT_FIELDS).size).toBe(NUTRIENT_FIELDS.length);
    });

    test("every MICRONUTRIENT_FIELDS entry is also in NUTRIENT_FIELDS", () => {
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(NUTRIENT_FIELDS).toContain(field);
        }
    });

    test("ESTIMABLE_FIELDS is exactly the six model-estimable macros (CONTRACT §0.2)", () => {
        expect(([...ESTIMABLE_FIELDS] as string[]).sort()).toEqual(
            [
                "calories",
                "protein_g",
                "carbs_g",
                "fat_g",
                "fiber_g",
                "sugar_g",
            ].sort(),
        );
    });

    // The guard that stops a later agent from quietly making a micronutrient
    // model-estimable — CONTRACT §0.2 is explicit that ONLY the six macros
    // may ever be model-estimated, and none of the twelve new micronutrients
    // are among them.
    test("MICRONUTRIENT_FIELDS and ESTIMABLE_FIELDS never intersect", () => {
        const estimable = new Set<string>(ESTIMABLE_FIELDS);
        const overlap = MICRONUTRIENT_FIELDS.filter((f) => estimable.has(f));
        expect(overlap).toEqual([]);
    });

    // alcohol_g and caffeine_mg are pre-existing, non-micronutrient fields
    // that are ALSO not estimable — pin that too, since a naive
    // "not a micronutrient" check would wrongly let them through.
    test("alcohol_g and caffeine_mg are neither micronutrients nor estimable", () => {
        expect(MICRONUTRIENT_FIELDS).not.toContain("alcohol_g");
        expect(MICRONUTRIENT_FIELDS).not.toContain("caffeine_mg");
        expect(ESTIMABLE_FIELDS).not.toContain("alcohol_g");
        expect(ESTIMABLE_FIELDS).not.toContain("caffeine_mg");
    });
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe("NUTRIENT_UNITS", () => {
    test("every field in NUTRIENT_FIELDS has an entry", () => {
        for (const field of NUTRIENT_FIELDS) {
            expect(NUTRIENT_UNITS[field]).toBeDefined();
        }
    });

    test("calories is the one kcal field", () => {
        expect(NUTRIENT_UNITS.calories).toBe("kcal");
        for (const field of NUTRIENT_FIELDS) {
            if (field !== "calories")
                expect(NUTRIENT_UNITS[field]).not.toBe("kcal");
        }
    });

    test("caffeine_mg and the mg-named micronutrients are mg", () => {
        const expectedMg: NutrientField[] = [
            "caffeine_mg",
            "sodium_mg",
            "potassium_mg",
            "cholesterol_mg",
            "calcium_mg",
            "iron_mg",
            "magnesium_mg",
            "vitamin_c_mg",
        ];
        for (const field of expectedMg) {
            expect(NUTRIENT_UNITS[field]).toBe("mg");
        }
    });

    test("the mcg-named micronutrients (vitamin A, vitamin D) are mcg", () => {
        expect(NUTRIENT_UNITS.vitamin_a_mcg).toBe("mcg");
        expect(NUTRIENT_UNITS.vitamin_d_mcg).toBe("mcg");
    });

    test("the g-named fields (existing macros plus the new fat/sugar splits) are g", () => {
        const expectedG: NutrientField[] = [
            "protein_g",
            "carbs_g",
            "fat_g",
            "fiber_g",
            "sugar_g",
            "alcohol_g",
            "saturated_fat_g",
            "trans_fat_g",
            "added_sugar_g",
        ];
        for (const field of expectedG) {
            expect(NUTRIENT_UNITS[field]).toBe("g");
        }
    });

    test("the unit's suffix in the field name matches the declared unit, for every field whose name carries one", () => {
        // Every new field (and caffeine_mg before it) carries its unit in the
        // name for exactly this reason — a mismatch here would mean the name
        // lies about the unit.
        for (const field of NUTRIENT_FIELDS) {
            if (field === "calories") continue; // no unit suffix by design
            if (field.endsWith("_mcg"))
                expect(NUTRIENT_UNITS[field]).toBe("mcg");
            else if (field.endsWith("_mg"))
                expect(NUTRIENT_UNITS[field]).toBe("mg");
            else if (field.endsWith("_g"))
                expect(NUTRIENT_UNITS[field]).toBe("g");
        }
    });
});

// ---------------------------------------------------------------------------
// SOURCE_PRECEDENCE (CONTRACT §4)
// ---------------------------------------------------------------------------

describe("SOURCE_PRECEDENCE", () => {
    test("nutrition_label outranks open_food_facts outranks restaurant_published outranks usda_fdc", () => {
        expect(SOURCE_PRECEDENCE.nutrition_label).toBeLessThan(
            SOURCE_PRECEDENCE.open_food_facts,
        );
        expect(SOURCE_PRECEDENCE.open_food_facts).toBeLessThan(
            SOURCE_PRECEDENCE.restaurant_published,
        );
        expect(SOURCE_PRECEDENCE.restaurant_published).toBeLessThan(
            SOURCE_PRECEDENCE.usda_fdc,
        );
    });

    test("usda_fdc outranks user_provided/import, which outrank model_estimate", () => {
        expect(SOURCE_PRECEDENCE.usda_fdc).toBeLessThan(
            SOURCE_PRECEDENCE.user_provided,
        );
        expect(SOURCE_PRECEDENCE.usda_fdc).toBeLessThan(
            SOURCE_PRECEDENCE.import,
        );
        expect(SOURCE_PRECEDENCE.user_provided).toBeLessThan(
            SOURCE_PRECEDENCE.model_estimate,
        );
        expect(SOURCE_PRECEDENCE.import).toBeLessThan(
            SOURCE_PRECEDENCE.model_estimate,
        );
    });

    test("model_estimate is the lowest-precedence (highest-number) source", () => {
        const max = Math.max(...Object.values(SOURCE_PRECEDENCE));
        expect(SOURCE_PRECEDENCE.model_estimate).toBe(max);
    });

    test("user_provided and import share the same tier — neither outranks the other", () => {
        expect(SOURCE_PRECEDENCE.user_provided).toBe(SOURCE_PRECEDENCE.import);
    });

    test("every source has a distinct rank from every OTHER tier's sources (only the user_provided/import pair ties)", () => {
        const bySource = Object.entries(SOURCE_PRECEDENCE);
        for (const [sourceA, rankA] of bySource) {
            for (const [sourceB, rankB] of bySource) {
                if (sourceA === sourceB) continue;
                const sameTierPair =
                    new Set([sourceA, sourceB]).size === 2 &&
                    new Set(["user_provided", "import"]).has(sourceA) &&
                    new Set(["user_provided", "import"]).has(sourceB);
                if (sameTierPair) {
                    expect(rankA).toBe(rankB);
                } else {
                    expect(rankA).not.toBe(rankB);
                }
            }
        }
    });
});

// ---------------------------------------------------------------------------
// parseNutrientProvenance
// ---------------------------------------------------------------------------

function entry(
    overrides: Partial<NutrientProvenanceEntry> = {},
): NutrientProvenanceEntry {
    return {
        source: "usda_fdc",
        source_id: "fdc:123456",
        confidence: "authoritative",
        ...overrides,
    };
}

describe("parseNutrientProvenance", () => {
    test("a valid single-entry object round-trips exactly", () => {
        const raw = { sodium_mg: entry() };
        expect(parseNutrientProvenance(raw)).toEqual(raw);
    });

    test("a valid multi-entry object round-trips exactly, one entry per nutrient", () => {
        const raw = {
            sodium_mg: entry({ source: "nutrition_label", source_id: null }),
            calories: entry({
                source: "model_estimate",
                source_id: null,
                confidence: "estimated",
            }),
        };
        expect(parseNutrientProvenance(raw)).toEqual(raw);
    });

    test("null and undefined return null", () => {
        expect(parseNutrientProvenance(null)).toBeNull();
        expect(parseNutrientProvenance(undefined)).toBeNull();
    });

    test("non-object primitives return null rather than throwing", () => {
        expect(parseNutrientProvenance("sodium_mg")).toBeNull();
        expect(parseNutrientProvenance(42)).toBeNull();
        expect(parseNutrientProvenance(true)).toBeNull();
    });

    test("an array returns null rather than being treated as an object", () => {
        expect(parseNutrientProvenance([entry()])).toBeNull();
        expect(parseNutrientProvenance([])).toBeNull();
    });

    test("an empty object returns null", () => {
        expect(parseNutrientProvenance({})).toBeNull();
    });

    test("a key that is not a recognised NutrientField is dropped", () => {
        const raw = {
            sodium_mg: entry(),
            not_a_real_nutrient: entry(),
            __proto__nonsense: entry(),
        };
        const parsed = parseNutrientProvenance(raw);
        expect(parsed).toEqual({ sodium_mg: entry() });
        expect(parsed).not.toHaveProperty("not_a_real_nutrient");
    });

    test("an entry with an invalid source string is dropped", () => {
        const raw = {
            sodium_mg: {
                source: "wikipedia",
                source_id: null,
                confidence: "authoritative",
            },
        };
        expect(parseNutrientProvenance(raw)).toBeNull();
    });

    test("an entry with an invalid confidence string is dropped", () => {
        const raw = {
            sodium_mg: {
                source: "usda_fdc",
                source_id: null,
                confidence: "very_sure",
            },
        };
        expect(parseNutrientProvenance(raw)).toBeNull();
    });

    test("an entry missing source or confidence entirely is dropped", () => {
        expect(
            parseNutrientProvenance({
                sodium_mg: { source_id: "x", confidence: "authoritative" },
            }),
        ).toBeNull();
        expect(
            parseNutrientProvenance({
                sodium_mg: { source: "usda_fdc", source_id: "x" },
            }),
        ).toBeNull();
    });

    test("an entry whose value is not an object (string, number, null, array) is dropped", () => {
        expect(parseNutrientProvenance({ sodium_mg: "usda_fdc" })).toBeNull();
        expect(parseNutrientProvenance({ sodium_mg: 5 })).toBeNull();
        expect(parseNutrientProvenance({ sodium_mg: null })).toBeNull();
        expect(parseNutrientProvenance({ sodium_mg: [] })).toBeNull();
    });

    test("source_id may be omitted and defaults to null", () => {
        const raw = {
            sodium_mg: { source: "usda_fdc", confidence: "authoritative" },
        };
        expect(parseNutrientProvenance(raw)).toEqual({
            sodium_mg: entry({ source_id: null }),
        });
    });

    test("a non-string source_id (other than null/undefined) invalidates the entry", () => {
        expect(
            parseNutrientProvenance({
                sodium_mg: {
                    source: "usda_fdc",
                    source_id: 12345,
                    confidence: "authoritative",
                },
            }),
        ).toBeNull();
    });

    test("one valid entry survives alongside one invalid entry — a single bad entry does not poison the whole object", () => {
        const raw = {
            sodium_mg: entry(),
            calcium_mg: {
                source: "not_a_source",
                source_id: null,
                confidence: "authoritative",
            },
        };
        expect(parseNutrientProvenance(raw)).toEqual({ sodium_mg: entry() });
    });

    test("deeply malformed input (nested garbage, unexpected types) degrades to null instead of throwing", () => {
        expect(() =>
            parseNutrientProvenance({
                sodium_mg: {
                    source: { nested: "object" },
                    confidence: [],
                    source_id: {},
                },
            }),
        ).not.toThrow();
        expect(
            parseNutrientProvenance({
                sodium_mg: {
                    source: { nested: "object" },
                    confidence: [],
                    source_id: {},
                },
            }),
        ).toBeNull();

        expect(() =>
            parseNutrientProvenance(Symbol("weird") as unknown),
        ).not.toThrow();
        expect(() => parseNutrientProvenance(() => {})).not.toThrow();
        expect(() => parseNutrientProvenance(new Date())).not.toThrow();
    });

    test("every field in NUTRIENT_FIELDS is accepted as a provenance key", () => {
        for (const field of NUTRIENT_FIELDS) {
            const raw = { [field]: entry() };
            expect(parseNutrientProvenance(raw)).toEqual({ [field]: entry() });
        }
    });
});

// ---------------------------------------------------------------------------
// isValidNutrientValue / assertValidNutrientValue
// ---------------------------------------------------------------------------

describe("isValidNutrientValue", () => {
    test("accepts zero", () => {
        expect(isValidNutrientValue(0)).toBe(true);
    });

    test("accepts a positive finite number", () => {
        expect(isValidNutrientValue(150.5)).toBe(true);
    });

    test("rejects negative numbers", () => {
        expect(isValidNutrientValue(-1)).toBe(false);
        expect(isValidNutrientValue(-0.001)).toBe(false);
    });

    test("rejects NaN", () => {
        expect(isValidNutrientValue(NaN)).toBe(false);
    });

    test("rejects Infinity and -Infinity", () => {
        expect(isValidNutrientValue(Infinity)).toBe(false);
        expect(isValidNutrientValue(-Infinity)).toBe(false);
    });

    test("rejects non-numbers: null, undefined, strings, objects, booleans", () => {
        expect(isValidNutrientValue(null)).toBe(false);
        expect(isValidNutrientValue(undefined)).toBe(false);
        expect(isValidNutrientValue("150")).toBe(false);
        expect(isValidNutrientValue({})).toBe(false);
        expect(isValidNutrientValue(true)).toBe(false);
    });
});

describe("assertValidNutrientValue", () => {
    test("is a no-op for null and undefined — 'not recorded' is always legal", () => {
        expect(() => assertValidNutrientValue("sodium_mg", null)).not.toThrow();
        expect(() =>
            assertValidNutrientValue("sodium_mg", undefined),
        ).not.toThrow();
    });

    test("is a no-op for zero and positive finite values", () => {
        expect(() => assertValidNutrientValue("sodium_mg", 0)).not.toThrow();
        expect(() =>
            assertValidNutrientValue("sodium_mg", 250.5),
        ).not.toThrow();
    });

    test("throws for negative, NaN and Infinity", () => {
        expect(() => assertValidNutrientValue("sodium_mg", -1)).toThrow();
        expect(() => assertValidNutrientValue("sodium_mg", NaN)).toThrow();
        expect(() => assertValidNutrientValue("sodium_mg", Infinity)).toThrow();
        expect(() =>
            assertValidNutrientValue("sodium_mg", -Infinity),
        ).toThrow();
    });

    test("the thrown error names the offending field", () => {
        expect(() => assertValidNutrientValue("vitamin_d_mcg", -5)).toThrow(
            /vitamin_d_mcg/,
        );
    });
});
