// The canonical nutrient model: every field name, its unit, and the
// provenance vocabulary every other layer (DB, CSV, widgets, providers,
// insights) derives from. See CONTRACT.md §1-§4 for the design this file
// implements — do not re-derive field names, units or source/confidence
// strings from anywhere else; import them from here.
//
// This module intentionally contains NO conversion arithmetic and NO
// Supabase/network code. Unit conversion lives exclusively in
// src/nutrient-units.ts; this file only names things and validates shape.

// ---------- Field names ----------

// The eight nutrients already shipped before this epic (see
// supabase/migrations/20260726120000_fiber_sugar_alcohol.sql and
// 20260809133215_caffeine.sql). Frozen — do not reorder or rename; every
// consumer (CSV headers, widget keys, tool schemas) already depends on these
// exact strings.
const EXISTING_NUTRIENT_FIELDS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "caffeine_mg",
] as const;

// The twelve new per-meal nutrients this epic adds (CONTRACT §1). All twelve
// are `numeric` and nullable in the DB — see the migration this agent adds —
// and NONE of them may ever be auto-estimated by a model (CONTRACT §0.2):
// they are the MICRO half of the model, filled only by a label, a barcode
// lookup, USDA FDC, a restaurant's published figures, an explicit user
// figure, or an import. `added_sugar_g` is its own figure and is never
// derived from `sugar_g` (which stays TOTAL sugars).
export const MICRONUTRIENT_FIELDS = [
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

// The single list every layer iterates to know "every nutrient field that
// exists" — CONTRACT §3: "Do NOT hardcode nutrient key lists anywhere else.
// Derive from NUTRIENT_FIELDS." Built by concatenation (not a fresh literal)
// so the two groups above stay the one source of truth for their members.
export const NUTRIENT_FIELDS = [
    ...EXISTING_NUTRIENT_FIELDS,
    ...MICRONUTRIENT_FIELDS,
] as const;

export type NutrientField = (typeof NUTRIENT_FIELDS)[number];

// The only six fields a model may ever estimate (CONTRACT §0.2). Every other
// field — all twelve new micronutrients plus alcohol_g and caffeine_mg — must
// come from a label, a lookup, an import or the user; never a guess.
export const ESTIMABLE_FIELDS = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
] as const satisfies readonly NutrientField[];

// ---------- Units ----------

export type NutrientUnit = "kcal" | "g" | "mg" | "mcg";

// Every unit rides in the field name already (that is WHY caffeine_mg and the
// new mg/mcg fields are named the way they are — see the caffeine migration's
// comment) — this map exists so code can look the unit up programmatically
// instead of parsing it back out of the field name string. vitamin_a_mcg is
// µg RAE (retinol activity equivalents) and vitamin_d_mcg is plain µg; "mcg"
// stands for both, since NutrientUnit has no separate RAE variant.
export const NUTRIENT_UNITS: Record<NutrientField, NutrientUnit> = {
    calories: "kcal",
    protein_g: "g",
    carbs_g: "g",
    fat_g: "g",
    fiber_g: "g",
    sugar_g: "g",
    alcohol_g: "g",
    caffeine_mg: "mg",
    saturated_fat_g: "g",
    trans_fat_g: "g",
    added_sugar_g: "g",
    sodium_mg: "mg",
    potassium_mg: "mg",
    cholesterol_mg: "mg",
    calcium_mg: "mg",
    iron_mg: "mg",
    magnesium_mg: "mg",
    vitamin_a_mcg: "mcg",
    vitamin_c_mg: "mg",
    vitamin_d_mcg: "mcg",
};

// ---------- Provenance ----------

// Exact strings from CONTRACT §2 — do not add, rename or reorder without
// updating the contract and every consumer.
export type NutrientSource =
    | "nutrition_label"
    | "open_food_facts"
    | "usda_fdc"
    | "restaurant_published"
    | "user_provided"
    | "import"
    | "model_estimate";

const NUTRIENT_SOURCES: readonly NutrientSource[] = [
    "nutrition_label",
    "open_food_facts",
    "usda_fdc",
    "restaurant_published",
    "user_provided",
    "import",
    "model_estimate",
];

export type NutrientConfidence =
    "authoritative" | "user_provided" | "estimated";

const NUTRIENT_CONFIDENCES: readonly NutrientConfidence[] = [
    "authoritative",
    "user_provided",
    "estimated",
];

export interface NutrientProvenanceEntry {
    source: NutrientSource;
    // Optional/nullable per CONTRACT §2 — e.g. "fdc:123456" for a USDA FDC
    // hit, or null when the source has no addressable id (user_provided,
    // model_estimate). Always present as an explicit key on a value this
    // module produces (parseNutrientProvenance never omits it) — see
    // CLAUDE.md on `.nullable()` meaning required-with-null, not optional,
    // which this mirrors even though this is a plain TS type, not Zod.
    source_id: string | null;
    confidence: NutrientConfidence;
}

// Keyed by canonical field name, one entry per nutrient — CONTRACT §2 is
// explicit that this is PER-NUTRIENT, never one confidence flag for the whole
// meal: a single log_meal call can blend a barcode-scanned ingredient
// (authoritative) with a model-estimated side dish (estimated).
export type NutrientProvenance = Partial<
    Record<NutrientField, NutrientProvenanceEntry>
>;

const NUTRIENT_FIELD_SET: ReadonlySet<string> = new Set(NUTRIENT_FIELDS);
const NUTRIENT_SOURCE_SET: ReadonlySet<string> = new Set(NUTRIENT_SOURCES);
const NUTRIENT_CONFIDENCE_SET: ReadonlySet<string> = new Set(
    NUTRIENT_CONFIDENCES,
);

function isValidEntry(value: unknown): value is NutrientProvenanceEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.source !== "string" || !NUTRIENT_SOURCE_SET.has(v.source)) {
        return false;
    }
    if (
        typeof v.confidence !== "string" ||
        !NUTRIENT_CONFIDENCE_SET.has(v.confidence)
    ) {
        return false;
    }
    if (
        v.source_id !== undefined &&
        v.source_id !== null &&
        typeof v.source_id !== "string"
    ) {
        return false;
    }
    return true;
}

/**
 * Defensively parses `meals.nutrient_provenance` JSONB into the typed shape,
 * dropping unknown keys and invalid entries instead of throwing. Postgres
 * enforces nothing about this column beyond "valid JSON", so the value can
 * predate today's field/source/confidence vocabulary, be hand-edited, or
 * simply be malformed — none of that should ever crash a read path. A key
 * that is not a recognised NutrientField is dropped (e.g. a since-renamed
 * field, or garbage); an entry whose shape doesn't match
 * NutrientProvenanceEntry is dropped independently, so one bad entry never
 * takes the rest of an otherwise-valid object down with it.
 *
 * Returns null for anything that isn't a plain object (including null,
 * arrays, primitives) and also when every entry in an object was invalid —
 * "provenance present but entirely unusable" and "no provenance at all" are
 * treated the same by every caller, so there is no reason to distinguish
 * them here.
 */
export function parseNutrientProvenance(
    raw: unknown,
): NutrientProvenance | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) return null;

    const result: NutrientProvenance = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!NUTRIENT_FIELD_SET.has(key)) continue;
        if (!isValidEntry(value)) continue;
        result[key as NutrientField] = {
            source: value.source,
            source_id: value.source_id ?? null,
            confidence: value.confidence,
        };
    }
    return Object.keys(result).length > 0 ? result : null;
}

// ---------- Source precedence (CONTRACT §4) ----------

// Lower number wins. A write may only replace an existing nutrient value when
// its precedence number is <= the stored one, or the user explicitly
// overrides — that comparison logic belongs to whoever resolves conflicting
// writes (see CONTRACT §3, src/resolution.ts), not to this module; this map
// only supplies the ranking. user_provided and import share tier 5
// deliberately: an import is the user's own historical data, not a
// third-party claim, so it should not be able to clobber (or be clobbered by)
// something the user typed directly, but also should not automatically win
// against it.
export const SOURCE_PRECEDENCE: Record<NutrientSource, number> = {
    nutrition_label: 1,
    open_food_facts: 2,
    restaurant_published: 3,
    usda_fdc: 4,
    user_provided: 5,
    import: 5,
    model_estimate: 6,
};

// ---------- Numeric validation ----------

/**
 * True for a legal STORED nutrient value: a finite number >= 0. null and
 * undefined are handled by callers separately (they mean "not recorded", not
 * "invalid") — this only classifies values that claim to be a number.
 */
export function isValidNutrientValue(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Throws when `value` is a defined-but-illegal nutrient value (negative,
 * NaN, or Infinity); a no-op for null/undefined, which mean "not recorded".
 *
 * This exists because the DB `check (<col> >= 0)` constraint cannot be
 * trusted to catch NaN or Infinity: supabase-js JSON-encodes the insert/
 * update body before it ever reaches Postgres, and both
 * `JSON.stringify(NaN)` and `JSON.stringify(Infinity)` produce the literal
 * `null` — so a caller's bug (a division by zero, a bad parse) would
 * silently become "not recorded" in the stored row instead of an error
 * anyone would ever see. (Infinity is also not reliably caught by the
 * constraint itself even server-side: Postgres `numeric` accepts Infinity as
 * of PG14, and `Infinity >= 0` is true, so the check would not reject it even
 * if it arrived intact.) Call this once, centrally, rather than scattering an
 * `isFinite` check at every write site — see CONTRACT §3's "do not hardcode
 * nutrient logic in more than one place" spirit.
 */
export function assertValidNutrientValue(
    field: NutrientField,
    value: number | null | undefined,
): void {
    if (value === null || value === undefined) return;
    if (!isValidNutrientValue(value)) {
        throw new Error(
            `Invalid value for ${field}: ${value} — nutrient values must be finite numbers >= 0, or null/omitted for "not recorded".`,
        );
    }
}
