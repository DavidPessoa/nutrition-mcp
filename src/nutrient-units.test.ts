import { test, expect } from "bun:test";
import {
    convertMass,
    convertNutrientValue,
    isMassUnit,
    resolveServingValue,
    resolveServingValues,
    scaleNutrients,
    scalePer100g,
    scalePer100gValues,
    scalePerServing,
    MASS_UNITS,
    type NutrientValues,
} from "./nutrient-units.js";
import type { ServingBasis } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Real-world conversion vectors, arithmetic worked out by hand.
// ---------------------------------------------------------------------------

test("REAL VECTOR 1: raw spinach potassium, per-100g -> a 30g serving", () => {
    // USDA FDC #168462 (spinach, raw): potassium = 558 mg per 100 g.
    // A 30 g serving (roughly a cup of loose leaves):
    //   558 * 30 / 100 = 167.4 mg
    expect(scalePer100g(558, 30)).toBe(167.4);
});

test("REAL VECTOR 2: Atlantic salmon sodium, per-100g -> a 154g fillet", () => {
    // USDA FDC #175167 (salmon, Atlantic, raw): sodium = 59 mg per 100 g.
    // A typical 154 g fillet:
    //   59 * 154 / 100 = 90.86 mg
    expect(scalePer100g(59, 154)).toBe(90.86);
});

test("REAL VECTOR 3: almonds magnesium, per-100g -> a 28g (1 oz) serving", () => {
    // USDA FDC #170567 (almonds): magnesium = 270 mg per 100 g.
    // A 28 g (1 oz) serving:
    //   270 * 28 / 100 = 75.6 mg
    expect(scalePer100g(270, 28)).toBe(75.6);
});

test("REAL VECTOR 4 (mass ladder): a cup of coffee's caffeine, mg <-> g", () => {
    // A typical 8 fl oz brewed coffee: 95 mg caffeine (USDA/FDA commonly
    // cited figure). 95 mg = 0.095 g exactly.
    expect(convertMass(95, "mg", "g")).toBe(0.095);
    expect(convertMass(0.095, "g", "mg")).toBe(95);
});

test("REAL VECTOR 5 (mass ladder): vitamin D 5 mcg (a common RDA-adjacent dose) across the full ladder", () => {
    // 5 mcg vitamin D = 0.005 mg = 0.000005 g = 0.000000005 kg.
    expect(convertMass(5, "mcg", "mg")).toBe(0.005);
    expect(convertMass(5, "mcg", "g")).toBe(0.000005);
    expect(convertMass(5, "mcg", "kg")).toBe(0.000000005);
    // and back
    expect(convertMass(0.000000005, "kg", "mcg")).toBe(5);
});

// ---------------------------------------------------------------------------
// Mass ladder: exact factors, round trips
// ---------------------------------------------------------------------------

test("mass ladder exact factors: kg -> g -> mg -> mcg", () => {
    expect(convertMass(1, "kg", "g")).toBe(1000);
    expect(convertMass(1, "g", "mg")).toBe(1000);
    expect(convertMass(1, "mg", "mcg")).toBe(1000);
    expect(convertMass(1, "kg", "mg")).toBe(1_000_000);
    expect(convertMass(1, "kg", "mcg")).toBe(1_000_000_000);
});

test("mass ladder exact factors: mcg -> mg -> g -> kg (inverse)", () => {
    expect(convertMass(1000, "mcg", "mg")).toBe(1);
    expect(convertMass(1000, "mg", "g")).toBe(1);
    expect(convertMass(1000, "g", "kg")).toBe(1);
});

test("mass ladder round-trips without floating-point drift", () => {
    for (const value of [0.1, 1, 3.3, 100, 12345.678]) {
        for (const unit of MASS_UNITS) {
            if (unit === "g") continue;
            const converted = convertMass(value, "g", unit);
            expect(converted).not.toBeNull();
            const back = convertMass(converted as number, unit, "g");
            expect(back).toBe(value);
        }
    }
});

test("convertMass same-unit is an identity, not a routed noop", () => {
    expect(convertMass(42.123456789, "mg", "mg")).toBe(42.123456789);
});

test("isMassUnit recognizes only the four ladder units", () => {
    expect(isMassUnit("kg")).toBe(true);
    expect(isMassUnit("g")).toBe(true);
    expect(isMassUnit("mg")).toBe(true);
    expect(isMassUnit("mcg")).toBe(true);
    expect(isMassUnit("kcal")).toBe(false);
    expect(isMassUnit("lb")).toBe(false);
    expect(isMassUnit(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// convertMass / convertNutrientValue: invalid and adversarial input
// ---------------------------------------------------------------------------

test("convertMass rejects non-finite and negative values", () => {
    expect(convertMass(NaN, "g", "mg")).toBeNull();
    expect(convertMass(Infinity, "g", "mg")).toBeNull();
    expect(convertMass(-Infinity, "g", "mg")).toBeNull();
    expect(convertMass(-5, "g", "mg")).toBeNull();
});

test("convertMass rejects unrecognized units even past the type system", () => {
    expect(convertMass(5, "lb" as never, "g")).toBeNull();
    expect(convertMass(5, "g", "cup" as never)).toBeNull();
});

test("convertMass(0, ...) is a real zero, not null", () => {
    expect(convertMass(0, "g", "mg")).toBe(0);
    expect(convertMass(0, "kg", "mcg")).toBe(0);
});

test("convertNutrientValue converts a provider's non-canonical unit into the field's canonical one", () => {
    // Chicken breast sodium reported as 0.074 g by some hypothetical
    // provider; canonical field is sodium_mg.
    expect(convertNutrientValue("sodium_mg", 0.074, "g")).toBe(74);
});

test("convertNutrientValue is a no-op (post-validation) when units already match", () => {
    expect(convertNutrientValue("sodium_mg", 74, "mg")).toBe(74);
    expect(convertNutrientValue("calories", 250, "kcal")).toBe(250);
});

test("convertNutrientValue never bridges energy and mass", () => {
    expect(convertNutrientValue("sodium_mg", 5, "kcal")).toBeNull();
    expect(convertNutrientValue("calories", 100, "g")).toBeNull();
});

test("convertNutrientValue preserves null and rejects invalid amounts", () => {
    expect(convertNutrientValue("sodium_mg", null, "mg")).toBeNull();
    expect(convertNutrientValue("sodium_mg", NaN, "mg")).toBeNull();
    expect(convertNutrientValue("sodium_mg", -1, "mg")).toBeNull();
    expect(convertNutrientValue("sodium_mg", 0, "mg")).toBe(0);
});

// ---------------------------------------------------------------------------
// scalePer100g
// ---------------------------------------------------------------------------

test("scalePer100g at exactly 100g is an identity", () => {
    expect(scalePer100g(50, 100)).toBe(50);
});

test("scalePer100g scales proportionally", () => {
    expect(scalePer100g(10, 200)).toBe(20);
    expect(scalePer100g(10, 50)).toBe(5);
});

test("scalePer100g(0, grams) is 0, not null — a true reported zero", () => {
    expect(scalePer100g(0, 250)).toBe(0);
});

test("scalePer100g(value, 0) is 0 — zero grams of anything is zero of everything", () => {
    expect(scalePer100g(500, 0)).toBe(0);
});

test("scalePer100g preserves null", () => {
    expect(scalePer100g(null, 100)).toBeNull();
});

test("scalePer100g rejects adversarial input", () => {
    expect(scalePer100g(NaN, 100)).toBeNull();
    expect(scalePer100g(Infinity, 100)).toBeNull();
    expect(scalePer100g(-5, 100)).toBeNull();
    expect(scalePer100g(50, NaN)).toBeNull();
    expect(scalePer100g(50, Infinity)).toBeNull();
    expect(scalePer100g(50, -10)).toBeNull();
    // strings occasionally arrive from JSON.parse of a malformed payload —
    // the type system won't catch it, so this must degrade cleanly.
    expect(scalePer100g("50" as unknown as number, 100)).toBeNull();
    expect(scalePer100g(50, "100" as unknown as number)).toBeNull();
    expect(scalePer100g(undefined as unknown as number, 100)).toBeNull();
});

// ---------------------------------------------------------------------------
// scalePerServing: no double scaling
// ---------------------------------------------------------------------------

test("scalePerServing is a pure passthrough for valid values", () => {
    expect(scalePerServing(42.5)).toBe(42.5);
    expect(scalePerServing(0)).toBe(0);
});

test("scalePerServing preserves null", () => {
    expect(scalePerServing(null)).toBeNull();
});

test("scalePerServing rejects adversarial input", () => {
    expect(scalePerServing(NaN)).toBeNull();
    expect(scalePerServing(Infinity)).toBeNull();
    expect(scalePerServing(-1)).toBeNull();
    expect(scalePerServing("42" as unknown as number)).toBeNull();
});

// ---------------------------------------------------------------------------
// resolveServingValue: the basis-aware entry point, no double scaling
// ---------------------------------------------------------------------------

test("resolveServingValue on per_100g scales to the requested grams", () => {
    const basis: ServingBasis = { kind: "per_100g" };
    expect(resolveServingValue(basis, 200, 150)).toBe(300);
});

test("resolveServingValue on per_100g with no requestedGrams defaults to identity (100g)", () => {
    const basis: ServingBasis = { kind: "per_100g" };
    expect(resolveServingValue(basis, 200)).toBe(200);
});

test("resolveServingValue on per_serving NEVER rescales, even when requestedGrams is given and grams is known", () => {
    const basis: ServingBasis = {
        kind: "per_serving",
        grams: 42,
        label: "1 bar (42 g)",
    };
    // A caller passing requestedGrams=100 here must NOT get 100/42 * value —
    // that would be the exact double-scaling bug this function exists to
    // prevent. The value already IS the whole (42 g) serving.
    expect(resolveServingValue(basis, 12, 100)).toBe(12);
    expect(resolveServingValue(basis, 12)).toBe(12);
});

test("resolveServingValue on per_serving with unknown grams still returns the value unscaled", () => {
    const basis: ServingBasis = {
        kind: "per_serving",
        grams: null,
        label: "1 slice",
    };
    expect(resolveServingValue(basis, 7)).toBe(7);
});

test("resolveServingValue preserves null on both basis kinds", () => {
    const per100g: ServingBasis = { kind: "per_100g" };
    const perServing: ServingBasis = {
        kind: "per_serving",
        grams: 30,
        label: "1 scoop",
    };
    expect(resolveServingValue(per100g, null, 50)).toBeNull();
    expect(resolveServingValue(perServing, null)).toBeNull();
});

// ---------------------------------------------------------------------------
// scaleNutrients: maps over nutrient fields, null survives, 0 survives
// ---------------------------------------------------------------------------

test("scaleNutrients scales every present field by the factor", () => {
    const values: NutrientValues = {
        calories: 200,
        protein_g: 10,
        sodium_mg: 300,
    };
    const scaled = scaleNutrients(values, 2);
    expect(scaled.calories).toBe(400);
    expect(scaled.protein_g).toBe(20);
    expect(scaled.sodium_mg).toBe(600);
});

test("scaleNutrients: null stays null under any factor, including 0", () => {
    const values: NutrientValues = { sodium_mg: null, potassium_mg: null };
    expect(scaleNutrients(values, 3).sodium_mg).toBeNull();
    expect(scaleNutrients(values, 0).sodium_mg).toBeNull();
    expect(scaleNutrients(values, 0).potassium_mg).toBeNull();
});

test("scaleNutrients: null must NEVER become 0 — the core invariant", () => {
    const values: NutrientValues = { iron_mg: null };
    const scaled = scaleNutrients(values, 0);
    expect(scaled.iron_mg).toBeNull();
    expect(scaled.iron_mg).not.toBe(0);
});

test("scaleNutrients: 0 survives as 0, never becomes null", () => {
    const values: NutrientValues = { fiber_g: 0 };
    expect(scaleNutrients(values, 5).fiber_g).toBe(0);
    expect(scaleNutrients(values, 5).fiber_g).not.toBeNull();
});

test("scaleNutrients only emits keys that were present in the input", () => {
    const values: NutrientValues = { calories: 100 };
    const scaled = scaleNutrients(values, 2);
    expect(Object.keys(scaled)).toEqual(["calories"]);
    expect(scaled.protein_g).toBeUndefined();
});

test("scaleNutrients rejects adversarial per-field and per-call input", () => {
    const values: NutrientValues = {
        calories: NaN,
        protein_g: Infinity,
        fat_g: -5,
        carbs_g: 10,
    };
    const badFactor = scaleNutrients(values, NaN);
    expect(badFactor.calories).toBeNull();
    expect(badFactor.protein_g).toBeNull();
    expect(badFactor.fat_g).toBeNull();
    // even a valid field becomes null when the factor itself is untrustworthy
    expect(badFactor.carbs_g).toBeNull();

    const goodFactor = scaleNutrients(values, 2);
    expect(goodFactor.calories).toBeNull();
    expect(goodFactor.protein_g).toBeNull();
    expect(goodFactor.fat_g).toBeNull();
    expect(goodFactor.carbs_g).toBe(20);
});

// ---------------------------------------------------------------------------
// scalePer100gValues / resolveServingValues: bulk helpers
// ---------------------------------------------------------------------------

test("scalePer100gValues scales every present field to the requested grams", () => {
    const values: NutrientValues = {
        calories: 52,
        potassium_mg: 358,
        sodium_mg: null,
    };
    const scaled = scalePer100gValues(values, 118); // one medium banana
    expect(scaled.calories).toBe(61.36);
    expect(scaled.potassium_mg).toBe(422.44);
    expect(scaled.sodium_mg).toBeNull();
});

test("resolveServingValues dispatches per_100g vs per_serving across a whole nutrient set", () => {
    const values: NutrientValues = {
        calories: 100,
        sodium_mg: 50,
        magnesium_mg: null,
    };
    const per100g = resolveServingValues({ kind: "per_100g" }, values, 250);
    expect(per100g.calories).toBe(250);
    expect(per100g.sodium_mg).toBe(125);
    expect(per100g.magnesium_mg).toBeNull();

    const perServing = resolveServingValues(
        { kind: "per_serving", grams: 30, label: "1 bar" },
        values,
        250, // must be ignored entirely
    );
    expect(perServing.calories).toBe(100);
    expect(perServing.sodium_mg).toBe(50);
    expect(perServing.magnesium_mg).toBeNull();
});
