import { test, expect, describe } from "bun:test";
import {
    resolveNutrientWrite,
    resolutionNote,
    confidenceOf,
    isForbiddenEstimate,
} from "./resolution.js";
import { MICRONUTRIENT_FIELDS } from "./nutrients.js";

describe("confidenceOf", () => {
    test("maps each source to its confidence class", () => {
        expect(confidenceOf("nutrition_label")).toBe("authoritative");
        expect(confidenceOf("open_food_facts")).toBe("authoritative");
        expect(confidenceOf("restaurant_published")).toBe("authoritative");
        expect(confidenceOf("usda_fdc")).toBe("authoritative");
        expect(confidenceOf("user_provided")).toBe("user_provided");
        expect(confidenceOf("import")).toBe("user_provided");
        expect(confidenceOf("model_estimate")).toBe("estimated");
    });
});

describe("the model may not estimate micronutrients", () => {
    test("every micronutrient is refused from model_estimate", () => {
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(isForbiddenEstimate(field, "model_estimate")).toBe(true);
            expect(isForbiddenEstimate(field, "nutrition_label")).toBe(false);
        }
    });

    test("the six estimable macros are not refused", () => {
        for (const field of [
            "calories",
            "protein_g",
            "carbs_g",
            "fat_g",
            "fiber_g",
            "sugar_g",
        ] as const) {
            expect(isForbiddenEstimate(field, "model_estimate")).toBe(false);
        }
    });

    test("caffeine and alcohol stay estimable — shipped behaviour", () => {
        // log_meal has always asked the model for a caffeine figure. Widening
        // the ban to these would break that to protect fields that were never
        // the concern.
        expect(isForbiddenEstimate("caffeine_mg", "model_estimate")).toBe(
            false,
        );
        expect(isForbiddenEstimate("alcohol_g", "model_estimate")).toBe(false);
    });

    test("an estimated meal keeps its macros and drops its micros", () => {
        const resolved = resolveNutrientWrite(null, {
            values: {
                calories: 640,
                protein_g: 42,
                fiber_g: 6,
                sodium_mg: 890,
                iron_mg: 3,
            },
            source: "model_estimate",
        });
        expect(resolved.values).toEqual({
            calories: 640,
            protein_g: 42,
            fiber_g: 6,
        });
        // Refused, not zeroed: the fields are absent from the write, so the
        // stored columns stay null.
        expect(resolved.values.sodium_mg).toBeUndefined();
        expect(resolved.rejectedEstimates).toEqual(["sodium_mg", "iron_mg"]);
        expect(resolved.provenance).toEqual({
            calories: {
                source: "model_estimate",
                source_id: null,
                confidence: "estimated",
            },
            protein_g: {
                source: "model_estimate",
                source_id: null,
                confidence: "estimated",
            },
            fiber_g: {
                source: "model_estimate",
                source_id: null,
                confidence: "estimated",
            },
        });
    });

    test("a user override cannot launder an estimated micronutrient", () => {
        const resolved = resolveNutrientWrite(
            null,
            { values: { iron_mg: 3 }, source: "model_estimate" },
            { userOverride: true },
        );
        expect(resolved.values.iron_mg).toBeUndefined();
        expect(resolved.rejectedEstimates).toEqual(["iron_mg"]);
    });
});

describe("source precedence", () => {
    const priorFromBarcode = {
        values: { sodium_mg: 890, calories: 250 },
        provenance: {
            sodium_mg: {
                source: "open_food_facts" as const,
                source_id: "off:123",
                confidence: "authoritative" as const,
            },
            calories: {
                source: "open_food_facts" as const,
                source_id: "off:123",
                confidence: "authoritative" as const,
            },
        },
    };

    test("an estimate never overwrites an authoritative value", () => {
        const resolved = resolveNutrientWrite(priorFromBarcode, {
            values: { calories: 300 },
            source: "model_estimate",
        });
        expect(resolved.values.calories).toBeUndefined();
        expect(resolved.blockedByPrecedence).toEqual(["calories"]);
        // The stored attribution survives untouched.
        expect(resolved.provenance!.calories!.source).toBe("open_food_facts");
    });

    test("a more authoritative source does overwrite", () => {
        const resolved = resolveNutrientWrite(priorFromBarcode, {
            values: { calories: 300 },
            source: "nutrition_label",
            sourceId: "manual",
        });
        expect(resolved.values.calories).toBe(300);
        expect(resolved.provenance!.calories).toEqual({
            source: "nutrition_label",
            source_id: "manual",
            confidence: "authoritative",
        });
    });

    test("an equal-precedence source overwrites", () => {
        // user_provided and import are the same tier — both are the user's
        // own data, and a re-import should not be refused.
        const resolved = resolveNutrientWrite(
            {
                values: { fiber_g: 4 },
                provenance: {
                    fiber_g: {
                        source: "user_provided",
                        source_id: null,
                        confidence: "user_provided",
                    },
                },
            },
            { values: { fiber_g: 5 }, source: "import" },
        );
        expect(resolved.values.fiber_g).toBe(5);
    });

    test("an explicit user override beats precedence", () => {
        const resolved = resolveNutrientWrite(
            priorFromBarcode,
            { values: { sodium_mg: 700 }, source: "user_provided" },
            { userOverride: true },
        );
        expect(resolved.values.sodium_mg).toBe(700);
        expect(resolved.blockedByPrecedence).toEqual([]);
    });

    test("filling a stored null is never an overwrite", () => {
        // The barcode lookup had no fiber figure; an estimate may fill it.
        const resolved = resolveNutrientWrite(
            { values: { fiber_g: null, calories: 250 }, provenance: null },
            { values: { fiber_g: 3 }, source: "model_estimate" },
        );
        expect(resolved.values.fiber_g).toBe(3);
        expect(resolved.blockedByPrecedence).toEqual([]);
    });

    test("a pre-epic meal with no provenance is treated as the user's own data", () => {
        // Every meal logged before this epic has a value and no provenance.
        // Treating that absence as "overwritable" would let a fresh estimate
        // silently rewrite the user's history.
        const prior = { values: { calories: 500 }, provenance: null };
        expect(
            resolveNutrientWrite(prior, {
                values: { calories: 400 },
                source: "model_estimate",
            }).values.calories,
        ).toBeUndefined();
        // ...but an authoritative source still wins over it.
        expect(
            resolveNutrientWrite(prior, {
                values: { calories: 400 },
                source: "usda_fdc",
                sourceId: "fdc:1",
            }).values.calories,
        ).toBe(400);
    });
});

describe("clearing and untouched fields", () => {
    const prior = {
        values: { sodium_mg: 890, calories: 250 },
        provenance: {
            sodium_mg: {
                source: "open_food_facts" as const,
                source_id: "off:123",
                confidence: "authoritative" as const,
            },
            calories: {
                source: "open_food_facts" as const,
                source_id: "off:123",
                confidence: "authoritative" as const,
            },
        },
    };

    test("an explicit null clears the value and its attribution", () => {
        const resolved = resolveNutrientWrite(prior, {
            values: { sodium_mg: null },
            source: "model_estimate",
        });
        // Clearing is always allowed — no precedence check, even from the
        // lowest-ranked source, because "I don't actually know this" is not
        // an overwrite.
        expect(resolved.values.sodium_mg).toBeNull();
        expect(resolved.provenance!.sodium_mg).toBeUndefined();
        expect(resolved.blockedByPrecedence).toEqual([]);
        expect(resolved.rejectedEstimates).toEqual([]);
    });

    test("a field not mentioned is left completely alone", () => {
        const resolved = resolveNutrientWrite(prior, {
            values: { protein_g: 10 },
            source: "user_provided",
        });
        expect("sodium_mg" in resolved.values).toBe(false);
        expect("calories" in resolved.values).toBe(false);
        // Its provenance survives the merge.
        expect(resolved.provenance!.sodium_mg!.source).toBe("open_food_facts");
    });

    test("undefined is absent, not a clear", () => {
        const resolved = resolveNutrientWrite(prior, {
            values: { sodium_mg: undefined },
            source: "user_provided",
        });
        // `{sodium_mg: undefined}` reads as present to `in` but means nothing
        // was supplied — spreading an object with optional keys produces it
        // routinely. It must leave the stored value and its attribution
        // alone; only a real null clears (CONTRACT §0.1). Every live call
        // site filters undefined out first, so this is the guard on the next
        // one rather than a behaviour anything depends on today.
        expect("sodium_mg" in resolved.values).toBe(false);
        expect(resolved.provenance!.sodium_mg!.source).toBe("open_food_facts");
        // A real null still clears, value and attribution together.
        const cleared = resolveNutrientWrite(prior, {
            values: { sodium_mg: null },
            source: "user_provided",
        });
        expect(cleared.values.sodium_mg).toBeNull();
        expect(cleared.provenance?.sodium_mg).toBeUndefined();
    });

    test("a fresh insert with nothing attributable yields null provenance", () => {
        const resolved = resolveNutrientWrite(null, {
            values: {},
            source: "user_provided",
        });
        expect(resolved.provenance).toBeNull();
        expect(resolved.values).toEqual({});
    });
});

describe("resolutionNote", () => {
    test("is empty when everything landed", () => {
        expect(
            resolutionNote({
                values: {},
                provenance: null,
                rejectedEstimates: [],
                blockedByPrecedence: [],
            }),
        ).toBe("");
    });

    test("names the dropped micronutrients and says why", () => {
        const note = resolutionNote({
            values: {},
            provenance: null,
            rejectedEstimates: ["sodium_mg", "iron_mg"],
            blockedByPrecedence: [],
        });
        expect(note).toContain("sodium_mg, iron_mg");
        expect(note).toContain("cannot be model-estimated");
    });

    test("explains a precedence block and how to override it", () => {
        const note = resolutionNote({
            values: {},
            provenance: null,
            rejectedEstimates: [],
            blockedByPrecedence: ["calories"],
        });
        expect(note).toContain("calories");
        expect(note).toContain("user_provided");
    });
});
