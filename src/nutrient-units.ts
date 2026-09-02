// Unit and serving-scaling arithmetic for the nutrient model.
//
// This is the ONLY module in the repo permitted to contain unit-conversion
// or serving-scaling arithmetic (CONTRACT.md §0.5). Tool handlers,
// providers, importers and widgets must call into these functions rather
// than doing their own kg/mg/mcg math or their own per-100g scaling — that
// concentration is what makes "did this value get scaled twice" and "is
// this mg or mcg" answerable by reading one file instead of grepping the
// whole tree. Mirrors the house style of src/units.ts and src/alcohol.ts:
// pure functions, heavy comments on WHY, and an unsafe conversion returns
// `null` rather than guessing (CONTRACT.md §0.9) — a guessed number
// silently corrupts a meal; a `null` is visibly missing and the caller (or
// the model) decides what to do about it.
//
// The other half of that same rule: `null` must never become `0` here.
// `null` means "we don't know this value"; `0` means "the source explicitly
// said zero" (CONTRACT.md §0.1). A helper that maps over nutrient fields —
// scaleNutrients below — has to preserve that distinction through
// arbitrary multiplication, including by a factor of 0.

import {
    NUTRIENT_FIELDS,
    NUTRIENT_UNITS,
    isValidNutrientValue,
    type NutrientField,
    type NutrientUnit,
} from "./nutrients.js";
import type { ServingBasis } from "./providers/types.js";

// ---------------------------------------------------------------------------
// Mass ladder: kg -> g -> mg -> mcg (and back)
// ---------------------------------------------------------------------------

export type MassUnit = "kg" | "g" | "mg" | "mcg";

export const MASS_UNITS: readonly MassUnit[] = ["kg", "g", "mg", "mcg"];

export function isMassUnit(x: unknown): x is MassUnit {
    return x === "kg" || x === "g" || x === "mg" || x === "mcg";
}

// Exact ladder factors, expressed as "how many of this unit make 1 mcg" is
// backwards to read, so instead this is "how many mcg is 1 of this unit" —
// i.e. the multiplier that converts FROM the unit TO mcg. Using mcg (the
// smallest unit any nutrient is stored in) as the common pivot means every
// conversion is exactly two multiplications (source -> mcg -> target)
// instead of needing a 4x4 factor table that could disagree with itself at
// the edges.
const MCG_PER_UNIT: Record<MassUnit, number> = {
    kg: 1_000_000_000,
    g: 1_000_000,
    mg: 1_000,
    mcg: 1,
};

// Floating-point noise guard. `0.1 g` round-tripped through the mcg pivot
// comes back as `99999.99999999999` mcg rather than `100000` — a real
// artifact of binary floating point, not a modeling choice. Nutrient
// columns are `numeric` with no fixed scale (CONTRACT.md §1), so this
// deliberately keeps far more precision than any real reading needs (9
// decimal places, i.e. sub-nanogram-per-kg noise) rather than rounding to a
// specific display precision — that decision belongs to a UI/formatting
// layer, not here.
function roundNoise(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}

// Every function below rejects non-finite and negative inputs the same way:
// a nutrient amount is a physical quantity, and no canonical field in
// CONTRACT.md §1 is ever negative (the DB migration backs this with a
// `check (<col> >= 0)`). Reuses src/nutrients.ts's own validity predicate
// (finite, >= 0) rather than redefining the same rule a second time — the
// "amounts" this file validates (grams-of-food, scale factors, mass
// quantities) are numerically the exact same class of value as a stored
// nutrient, they just aren't always literally a nutrient field.
function isValidAmount(value: number): boolean {
    return isValidNutrientValue(value);
}

/**
 * Convert a mass value between any two units on the kg/g/mg/mcg ladder.
 * Returns `null` — never a guess — when `value` is not a finite,
 * non-negative number, or when `from`/`to` somehow is not a recognized
 * MassUnit (defends against a widened/`any` caller; the type system already
 * rules this out for typed callers).
 *
 * `from === to` short-circuits to `value` unchanged rather than routing
 * through the mcg pivot and back — that avoids introducing the
 * roundNoise() floating-point rounding on values that never needed
 * converting at all (e.g. calling this generically without checking units
 * first should be free when units already match).
 */
export function convertMass(
    value: number,
    from: MassUnit,
    to: MassUnit,
): number | null {
    if (!isValidAmount(value)) return null;
    if (!isMassUnit(from) || !isMassUnit(to)) return null;
    if (from === to) return value;
    const mcg = value * MCG_PER_UNIT[from];
    const result = mcg / MCG_PER_UNIT[to];
    return Number.isFinite(result) ? roundNoise(result) : null;
}

// ---------------------------------------------------------------------------
// Nutrient-unit-aware conversion
// ---------------------------------------------------------------------------

/**
 * Convert a raw value reported in `fromUnit` into the canonical unit for
 * `field` (per `NUTRIENT_UNITS`). This is the entry point a provider should
 * use when it reports a field in an unexpected unit — e.g. sodium in grams
 * instead of the canonical milligrams.
 *
 * Energy ("kcal") is never converted to or from a mass unit: doing so would
 * require knowing the food's caloric density, which is not a piece of
 * information this module has access to, and a provider that mixed up
 * "kcal" with "g" almost certainly has a bug worth surfacing as `null`
 * rather than a wrong number computed from nonsense inputs.
 */
export function convertNutrientValue(
    field: NutrientField,
    value: number | null,
    fromUnit: NutrientUnit,
): number | null {
    if (value == null) return null;
    const toUnit = NUTRIENT_UNITS[field];
    if (fromUnit === toUnit) {
        return isValidAmount(value) ? value : null;
    }
    if (fromUnit === "kcal" || toUnit === "kcal") return null;
    return convertMass(value, fromUnit, toUnit);
}

// ---------------------------------------------------------------------------
// Vitamin A: IU -> µg RAE is deliberately NOT offered
// ---------------------------------------------------------------------------
//
// vitamin_a_mcg is canonically µg RAE (Retinol Activity Equivalents), but
// many food labels and older provider payloads report vitamin A in IU
// (International Units) instead. There is no single IU -> µg RAE factor:
// preformed retinol converts at 1 IU = 0.3 µg RAE, a dietary provitamin-A
// carotenoid mix (the pre-2016 FDA convention) converts at roughly
// 1 IU = 0.05 µg RAE, and supplement-form beta-carotene converts at yet a
// third rate. Which one applies depends on what was actually measured, and
// no provider payload this repo talks to states that. Multiplying by any
// single factor would produce a specific WRONG number dressed up as a real
// one — worse than the `null` it would replace, because a wrong number does
// not look wrong. Per CONTRACT.md §0.9 ("ambiguous unit or basis => null"),
// this conversion is not implemented anywhere in this module: a caller
// holding an IU figure for vitamin A must leave `vitamin_a_mcg` `null`
// rather than invent a source-semantics assumption here.

// ---------------------------------------------------------------------------
// Serving scaling
// ---------------------------------------------------------------------------

/**
 * Scale a per-100g nutrient value to an actual requested gram serving.
 *
 * `value` is the per-100g label figure (what nutrition labels, Open Food
 * Facts and USDA FDC all report as their "base" figure). `requestedGrams`
 * is how many grams of the food are actually being logged.
 *
 * Returns `null` when either input is not a finite, non-negative number —
 * never a guessed number — since a bad `requestedGrams` (0 meant as "I
 * don't know", a stray NaN, a negative typo) would otherwise silently zero
 * out or corrupt every nutrient in the meal rather than surfacing as a
 * clearly missing value.
 */
export function scalePer100g(
    value: number | null,
    requestedGrams: number,
): number | null {
    if (value == null) return null;
    if (!isValidAmount(value)) return null;
    if (!isValidAmount(requestedGrams)) return null;
    const result = (value * requestedGrams) / 100;
    return Number.isFinite(result) ? roundNoise(result) : null;
}

/**
 * Accept an already-per-serving nutrient value as the canonical figure for
 * that serving.
 *
 * This is deliberately NOT a bare passthrough of `value` — it exists as a
 * named function so a call site reads as "this value is already scoped to
 * the serving being logged; do not scale it again" instead of looking like
 * a forgotten conversion step. Still validates like every function here:
 * invalid input -> `null`, never a guess.
 */
export function scalePerServing(value: number | null): number | null {
    if (value == null) return null;
    return isValidAmount(value) ? value : null;
}

/**
 * Resolve a single nutrient value against its `ServingBasis` to the amount
 * for `requestedGrams` grams of food — or, when `requestedGrams` is
 * omitted, to the value as the basis itself reports it. This is the one
 * place that decides "does this number need scaling", so a provider,
 * importer or tool handler never has to branch on serving basis itself —
 * see CONTRACT.md §0.6, "serving scaling happens exactly once."
 *
 *  - `"per_100g"`: always scaled via `scalePer100g`. `requestedGrams`
 *    defaults to 100 when omitted, since "100 g of a per-100g figure" is
 *    itself the identity case — this lets a caller who only wants the raw
 *    per-100g number call this function without a gram amount at all.
 *  - `"per_serving"`: NEVER rescaled by `requestedGrams`, even when the
 *    basis carries a known `grams` weight that differs from it — the value
 *    already IS the whole serving. Silently rescaling here would be
 *    exactly the double-scaling bug this function exists to prevent: a
 *    caller who wants a different serving size must first convert to a
 *    per-100g figure through some other means (this module has none, on
 *    purpose — a provider that only gives per-serving figures with no
 *    weight cannot honestly be rescaled at all), not ask this function to
 *    guess a ratio from a label string.
 */
export function resolveServingValue(
    basis: ServingBasis,
    value: number | null,
    requestedGrams?: number,
): number | null {
    if (basis.kind === "per_100g") {
        return scalePer100g(value, requestedGrams ?? 100);
    }
    return scalePerServing(value);
}

// ---------------------------------------------------------------------------
// Whole-nutrient-set helpers
// ---------------------------------------------------------------------------

/** A partial map of canonical nutrient field -> value, the shape every
 * bulk helper below reads and returns. Partial (rather than requiring every
 * field) because a provider or a meal rarely has all twenty fields present
 * — an absent key and a `null` value both mean "unknown" to every reader,
 * matching CONTRACT.md §0.1; only fields actually present in the input are
 * present in the output, so these helpers never invent new keys. */
export type NutrientValues = Partial<Record<NutrientField, number | null>>;

/**
 * Multiply every present nutrient field in `values` by `factor` (e.g. 0.5
 * when the user logged half a serving, 3 for three servings). `null` stays
 * `null` under ANY factor, including `factor === 0` or an invalid factor —
 * a `null` nutrient means "we don't know this food's sodium", and
 * multiplying "don't know" by anything is still "don't know". Collapsing
 * that to `0` was the exact failure mode CONTRACT.md §0.1 calls out.
 *
 * A present-but-invalid value (negative, NaN, Infinity) or an invalid
 * `factor` (negative, NaN, Infinity) also degrades that field to `null`
 * rather than propagating garbage arithmetic — bad input should look like
 * missing data, not like a very wrong number. `factor === 0` on an
 * otherwise-valid value legitimately produces `0` (a true "zero grams of
 * this food ate zero of everything"), not `null` — that is a real zero,
 * distinct from the "don't know" case above.
 */
export function scaleNutrients(
    values: NutrientValues,
    factor: number,
): NutrientValues {
    const factorValid = isValidAmount(factor);
    const result: NutrientValues = {};
    for (const field of NUTRIENT_FIELDS) {
        if (!(field in values)) continue;
        const v = values[field];
        if (v === null || v === undefined) {
            result[field] = null;
            continue;
        }
        if (!isValidAmount(v) || !factorValid) {
            result[field] = null;
            continue;
        }
        const scaled = v * factor;
        result[field] = Number.isFinite(scaled) ? roundNoise(scaled) : null;
    }
    return result;
}

/**
 * Scale every present nutrient field in `values` from a per-100g basis to
 * `requestedGrams`. Thin per-field wrapper over `scalePer100g`, so a
 * provider or importer scales a whole nutrient row in one call instead of
 * writing its own loop — which is exactly the per-field arithmetic
 * CONTRACT.md §0.5 reserves for this file alone.
 */
export function scalePer100gValues(
    values: NutrientValues,
    requestedGrams: number,
): NutrientValues {
    const result: NutrientValues = {};
    for (const field of NUTRIENT_FIELDS) {
        if (!(field in values)) continue;
        result[field] = scalePer100g(values[field] ?? null, requestedGrams);
    }
    return result;
}

/**
 * `resolveServingValue`, applied across every present field in `values`.
 * The bulk entry point a provider consumer should reach for when turning a
 * `FoodNutrition` payload into the amounts for a logged meal — see that
 * function's docs for the per_100g / per_serving distinction and why
 * `per_serving` is never rescaled.
 */
export function resolveServingValues(
    basis: ServingBasis,
    values: NutrientValues,
    requestedGrams?: number,
): NutrientValues {
    const result: NutrientValues = {};
    for (const field of NUTRIENT_FIELDS) {
        if (!(field in values)) continue;
        result[field] = resolveServingValue(
            basis,
            values[field] ?? null,
            requestedGrams,
        );
    }
    return result;
}
