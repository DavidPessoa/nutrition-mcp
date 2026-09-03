// Food database lookups. Phase 1: barcode resolution via the Open Food Facts
// REST JSON API (https://world.openfoodfacts.org/api/v2/product/{barcode}.json).
//
// The model stays the parser/orchestrator; this module's only job is to return
// canonical macros for an already-identified product. Every path degrades
// gracefully — a miss or an outage returns null/throws and the caller falls
// back to LLM estimation, so the lookup is always additive, never a hard
// dependency for logging a meal.

import { getSupabase } from "./supabase.js";
import { gramsFromDrink, formatAlcohol, type DrinkUnit } from "./alcohol.js";
import {
    NUTRIENT_FIELDS,
    type NutrientField,
    type NutrientUnit,
    type NutrientProvenance,
} from "./nutrients.js";
import { convertNutrientValue } from "./nutrient-units.js";
import {
    emptyNutrientValues,
    type FoodNutrition,
    type ServingBasis,
} from "./providers/types.js";

const OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const REQUEST_TIMEOUT_MS = 8_000;

const SOURCE_OFF = "openfoodfacts" as const;
// Open Food Facts is community-edited and changes often; refresh weekly.
const OFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Open Food Facts requires a custom User-Agent in the form
// `AppName (ContactEmail)` so they can reach the operator about traffic. It is
// configuration, not a constant: every deployment (including self-hosters) must
// set OFF_USER_AGENT to its own app + contact.
function offUserAgent(): string {
    const ua = process.env.OFF_USER_AGENT;
    if (!ua) {
        throw new Error(
            "OFF_USER_AGENT is not configured — Open Food Facts requires a " +
                "User-Agent like 'nutrition-mcp (you@example.com)'",
        );
    }
    return ua;
}

// FoodResult is NOT a structural subtype of Agent 2's `FoodNutrition`
// (src/providers/types.ts) — a full migration onto that shape was judged too
// invasive for this change (see the module comment on `toFoodNutrition`
// below for exactly where the two disagree, namely `source`/`source_name`
// vs `source`/`sourceId`). What it IS: every one of the twenty canonical
// nutrient fields from src/nutrients.ts is present here by its exact
// canonical name (so `field in food` / `food[field]` works for any
// `NutrientField`), plus an explicit `servingBasis: ServingBasis` carrying
// the same per_100g/per_serving distinction `FoodNutrition.serving` uses.
// `toFoodNutrition()` below is the documented, tested adapter between the
// two shapes for any caller that wants the strict Agent 2 type.
export interface FoodResult {
    name: string;
    brand: string | null;
    serving: string | null; // human label for the basis of the macros below
    // ---- existing 8 canonical fields (unchanged names/semantics) ----
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null; // TOTAL sugars, incl. naturally occurring
    alcohol_g: number | null; // pure ethanol; often null — see resolveAlcoholGrams
    // Open Food Facts carries no caffeine data at all (see the lookup_barcode
    // tool description in src/mcp.ts) — always null from this provider. Kept
    // as an explicit field (rather than omitted) so FoodResult always covers
    // every NUTRIENT_FIELD by name, matching ProviderNutrientValues.
    caffeine_mg: number | null;
    // Open Food Facts' own quality scores. Both are null when OFF hasn't
    // computed one — a real gap, not a lookup failure — so unlike fiber/sugar
    // we don't advise the caller to estimate a replacement.
    nutriscore_grade: "a" | "b" | "c" | "d" | "e" | null;
    nova_group: 1 | 2 | 3 | 4 | null;
    // ---- twelve new canonical micronutrient fields (CONTRACT §1) ----
    // See MICRONUTRIENT_OFF_KEYS below for the OFF key + verified unit each
    // of these is read from.
    saturated_fat_g: number | null;
    trans_fat_g: number | null;
    added_sugar_g: number | null;
    sodium_mg: number | null;
    potassium_mg: number | null;
    cholesterol_mg: number | null;
    calcium_mg: number | null;
    iron_mg: number | null;
    magnesium_mg: number | null;
    vitamin_a_mcg: number | null;
    vitamin_c_mg: number | null;
    vitamin_d_mcg: number | null;
    // The same per_100g / per_serving distinction as `serving` (the display
    // string), but structured for a downstream scaler
    // (src/nutrient-units.ts's resolveServingValue/resolveServingValues) to
    // consume without re-parsing the label string. Constructed alongside
    // `serving` from the exact same `hasServing` decision — never
    // independently, so the two can never disagree about which basis a
    // product is on.
    servingBasis: ServingBasis;
    // Per-nutrient provenance for every field OFF actually populated
    // (CONTRACT §2) — see buildOFFProvenance. `null` when the product ended
    // up with no non-null nutrient at all (never happens for a value this
    // function returns, since the stub-product guard in
    // fetchProductFromOFF already rejects that case, but the type stays
    // honest about the general shape).
    provenance: NutrientProvenance | null;
    source: string; // stable id, e.g. "off:737628064502"
    source_name: typeof SOURCE_OFF;
    barcode: string;
}

/**
 * Adapt a `FoodResult` into Agent 2's `FoodNutrition` shape
 * (src/providers/types.ts) for a caller that wants the strict cross-provider
 * type rather than this module's own. This is the one place the two naming
 * schemes are reconciled:
 *   - `FoodNutrition.source` is the CONTRACT §2 vocabulary string
 *     ("open_food_facts"); `FoodResult.source_name` ("openfoodfacts", no
 *     underscore) is a *different*, older string — it is the `food_cache`
 *     table's cache-key/source column value and must never change, so it
 *     cannot simply become this.
 *   - `FoodNutrition.sourceId` is the provider-specific record id;
 *     `FoodResult.source` already holds exactly that ("off:<barcode>") today
 *     — same string, different field name.
 *   - `FoodNutrition.serving` is `FoodResult.servingBasis` (a `ServingBasis`
 *     object); `FoodResult.serving` is the display label string and has no
 *     equivalent on `FoodNutrition`.
 */
export function toFoodNutrition(food: FoodResult): FoodNutrition {
    const values = emptyNutrientValues();
    const nutrients: Record<NutrientField, number | null> = { ...values };
    for (const field of NUTRIENT_FIELDS) {
        nutrients[field] = food[field];
    }
    return {
        ...nutrients,
        name: food.name,
        brand: food.brand,
        serving: food.servingBasis,
        source: "open_food_facts",
        sourceId: food.source,
    };
}

/**
 * Per-nutrient provenance for every field a `FoodResult` actually populated
 * (CONTRACT §2): source `open_food_facts`, confidence `authoritative`,
 * `source_id` the same `off:<barcode>` id the result itself carries. A field
 * left `null` by OFF gets no provenance entry at all — provenance describes
 * "where did this VALUE come from", and there is no value to attribute.
 * Returns `null` when nothing was populated (see the `provenance` field doc
 * on FoodResult for why that should not occur for a value this module ever
 * returns).
 */
export function buildOFFProvenance(
    food: FoodResult,
): NutrientProvenance | null {
    const result: NutrientProvenance = {};
    for (const field of NUTRIENT_FIELDS) {
        const value = food[field];
        if (value == null) continue;
        result[field] = {
            source: "open_food_facts",
            source_id: food.source,
            confidence: "authoritative",
        };
    }
    return Object.keys(result).length > 0 ? result : null;
}

// Strip everything but digits and validate length. Real barcodes (EAN-8/13,
// UPC-A/E, GTIN-14) are 8–14 digits. Returns the cleaned digits or null.
export function normalizeBarcode(raw: string): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 14) return null;
    return digits;
}

// Coerce an Open Food Facts nutriment to a finite number rounded to one
// decimal, or null when absent/unparseable. Used for the ORIGINAL 8 fields
// only (calories/protein/carbs/fat/fiber/sugar/alcohol), which OFF already
// reports in the field's canonical unit — no conversion needed, just parsing
// + display rounding.
function num(value: unknown): number | null {
    const n = typeof value === "string" ? parseFloat(value) : (value as number);
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    return Math.round(n * 10) / 10;
}

// Coerce an Open Food Facts nutriment to a finite number with NO rounding —
// used for the twelve new micronutrient fields, which (unlike the block
// above) still need to pass through convertNutrientValue's unit conversion
// before any rounding happens. Rounding here first would be actively wrong:
// e.g. sodium_100g 0.0428 (grams) rounded to one decimal is 0.0, and 0.0 g
// converts to 0 mg — silently turning a real 42.8 mg sodium figure into a
// false zero. convertNutrientValue (src/nutrient-units.ts) does its own
// floating-point-noise rounding after conversion, which is the only
// rounding these fields get.
function rawNum(value: unknown): number | null {
    const n = typeof value === "string" ? parseFloat(value) : (value as number);
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    return n;
}

interface OFFProduct {
    product_name?: string;
    brands?: string;
    serving_size?: string;
    // OFF's machine-parsed reading of serving_size ("33 cl" -> 330 + "ml").
    serving_quantity?: unknown;
    serving_quantity_unit?: unknown;
    nutriments?: Record<string, unknown>;
    // "a"-"e", or "not-applicable" / "unknown" when OFF hasn't computed one.
    nutriscore_grade?: unknown;
    nova_group?: unknown;
}

const NUTRISCORE_GRADES = ["a", "b", "c", "d", "e"] as const;

function normalizeNutriscoreGrade(
    value: unknown,
): FoodResult["nutriscore_grade"] {
    const grade = String(value ?? "")
        .trim()
        .toLowerCase();
    return (NUTRISCORE_GRADES as readonly string[]).includes(grade)
        ? (grade as FoodResult["nutriscore_grade"])
        : null;
}

function normalizeNovaGroup(value: unknown): FoodResult["nova_group"] {
    const group = typeof value === "string" ? parseFloat(value) : value;
    return group === 1 || group === 2 || group === 3 || group === 4
        ? group
        : null;
}

// The only alcohol unit Open Food Facts actually emits (see below).
const OFF_ABV_UNIT = "% vol";

// Serving volume in millilitres, or null when OFF did not parse one or parsed
// it in some other unit (grams, or an empty/garbage unit — both occur).
function servingVolumeMl(product: OFFProduct): number | null {
    const unit = String(product.serving_quantity_unit ?? "")
        .trim()
        .toLowerCase();
    if (unit !== "ml") return null;
    const ml = num(product.serving_quantity);
    if (ml == null || ml <= 0) return null;
    return ml;
}

// Serving weight in grams, when OFF machine-parsed the serving size into a
// mass rather than a volume (e.g. "40 g" -> 40 + "g", vs "330 ml" -> 330 +
// "ml" for servingVolumeMl above). Powers ServingBasis.grams so a downstream
// caller can rescale a per-serving figure without re-parsing the label
// string — the whole reason ServingBasis exists (src/providers/types.ts).
// null whenever OFF parsed no quantity, or parsed one in a non-mass unit —
// same "don't guess" posture as servingVolumeMl.
function servingGrams(product: OFFProduct): number | null {
    const unit = String(product.serving_quantity_unit ?? "")
        .trim()
        .toLowerCase();
    if (unit !== "g") return null;
    const grams = num(product.serving_quantity);
    if (grams == null || grams <= 0) return null;
    return grams;
}

// Open Food Facts reports alcohol as ABV — percent by VOLUME — and NOT as grams
// per serving or per 100 g the way every other nutriment is reported.
//
// Verified against the live API rather than assumed: of 164 products carrying an
// `alcohol` nutriment, 164 declared `alcohol_unit: "% vol"` and none declared
// grams. Decisively, all 164 also had
// `alcohol === alcohol_100g === alcohol_serving`. That equality is the proof: a
// genuine gram nutriment scales with the serving — the same product (1664,
// barcode 3080216052885, 250 mL serving) reports `carbohydrates_100g: 3` but
// `carbohydrates_serving: 7.5` — so a value that flatly refuses to scale with
// serving size is a dimensionless percentage, not a mass.
//
// Copying that number into `alcohol_g` would therefore be garbage: a 40% vodka
// would log "40 g of ethanol" no matter the pour, and the 250 mL 1664 above
// would log 5.5 g instead of its true ~10.8 g. So we populate `alcohol_g` only
// when we can honestly convert, which needs the serving VOLUME:
// grams = mL x ABV/100 x 0.789 (gramsFromDrink, src/alcohol.ts).
//
// All three conditions must hold; any miss yields null, never a guess:
//   1. the declared unit really is "% vol" — an unrecognized unit means OFF
//      changed something, and null beats a misread number;
//   2. OFF parsed a serving quantity AND it is in mL. Only ~1/3 of alcoholic
//      products have one; most carry no serving quantity at all;
//   3. we resolved on the per-serving basis. On the per-100 g fallback basis
//      every other field is per 100 GRAMS while ABV is per unit VOLUME, so
//      converting would need the beverage's density — which OFF does not
//      publish. Mixing two bases inside one FoodResult is worse than a null.
//
// Net effect: a real number for products that declare a millilitre serving, and
// null (rendered "n/a", so the caller can fall back to estimation) for the rest.
// A null is correct; a wrong number is not.
function resolveAlcoholGrams(
    product: OFFProduct,
    n: Record<string, unknown>,
    hasServing: boolean,
): number | null {
    if (!hasServing) return null;

    const unit =
        typeof n["alcohol_unit"] === "string"
            ? n["alcohol_unit"].trim().toLowerCase()
            : null;
    if (unit !== OFF_ABV_UNIT) return null;

    // All three keys carry the same ABV; prefer the most specific that is set.
    const abv = num(n["alcohol_serving"] ?? n["alcohol_100g"] ?? n["alcohol"]);
    // Bounds-check before calling gramsFromDrink, which throws on nonsense — a
    // corrupt community-edited value must degrade to null, not blow up a lookup.
    if (abv == null || abv < 0 || abv > 100) return null;

    const ml = servingVolumeMl(product);
    if (ml == null) return null;

    return num(gramsFromDrink(ml, abv));
}

// ---------------------------------------------------------------------------
// Micronutrients: OFF key + verified unit, one entry per new canonical field.
// ---------------------------------------------------------------------------
//
// Sources consulted (live API + official docs, not assumption):
//   - https://openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/
//     documents the suffix convention itself: `<key>_100g` / `<key>_serving`
//     is the numeric amount, `<key>_unit` is the unit those numbers are
//     actually IN (its own worked example: `nutriment_sodium_unit: "g"`).
//   - https://static.openfoodfacts.org/data/data-fields.txt confirms the key
//     spellings below (incl. the hyphenated ones) and states outright:
//     "fields that end with _100g correspond to the amount of a nutriment
//     (in g, or kJ for energy) for 100 g ... of product" — i.e. OFF's
//     internal storage unit for a non-energy nutriment is GRAMS, regardless
//     of what unit the taxonomy suggests for display.
//   - Confirmed on live products fetched during this work (barcodes below),
//     which is the part that actually matters: every _unit key observed was
//     "g", never "mg" or "mcg", for every nutrient in this table:
//       * sodium: 3017620422003 (Nutella) — sodium_100g 0.0428, sodium_unit "g"
//       * saturated-fat, trans-fat, cholesterol, fiber: 016000275287 (Cheerios)
//         — all four present with _unit "g" (trans-fat_100g: 0, still "g")
//       * added-sugars: 3017620422003 (Nutella) — added-sugars_100g 52.13, "g"
//       * potassium, calcium, magnesium, iron: several Moroccan mineral
//         waters (6111035000058, 6111128000071, 6111252421568) and cereals
//         (3387390123210 Chocapic: calcium 0.501, iron 0.012, vitamin-d
//         3.4e-6 — all _unit "g")
//       * vitamin-a, vitamin-d: 5000159461122 — vitamin-a_100g: 0,
//         vitamin-a_unit: "g"; vitamin-d_100g: 0, vitamin-d_unit: "g"
//
// vitamin-c was not observed populated on any live product sampled; its key
// spelling ("vitamin-c") is confirmed via data-fields.txt, and it is read
// through the exact same dynamic-unit path as every other field below — see
// the next paragraph for why that matters for this one specifically.
//
// Deliberately NOT hardcoded as "OFF always reports grams here": the code
// below reads each product's own `<key>_unit` value and only converts when
// it recognizes that unit (g / mg / mcg / µg), via
// convertNutrientValue (src/nutrient-units.ts) — the ONLY module allowed to
// do the arithmetic. An unrecognized unit (a future edge product using
// "IU", "%", or something else entirely) resolves to null rather than a
// guess. This is exactly the vitamin-A trap the task called out: IU is a
// real value OFF's schema permits for vitamin-a even though it was never
// observed live during this work, and src/nutrient-units.ts deliberately
// does not implement IU -> µg RAE (no single conversion factor exists — see
// its own comment on that). Reading the unit dynamically, rather than
// assuming "g" from the sample above, means an IU-reported product silently
// (and correctly) yields vitamin_a_mcg: null instead of a wrong number that
// looks right.
const MICRONUTRIENT_OFF_KEYS: ReadonlyArray<readonly [NutrientField, string]> =
    [
        ["saturated_fat_g", "saturated-fat"],
        ["trans_fat_g", "trans-fat"],
        // Total sugars stays `sugars` (handled by the original `num`/`pick`
        // path above); added sugars is its own, separate OFF key and is
        // never derived from total sugars.
        ["added_sugar_g", "added-sugars"],
        ["sodium_mg", "sodium"],
        ["potassium_mg", "potassium"],
        ["cholesterol_mg", "cholesterol"],
        ["calcium_mg", "calcium"],
        ["iron_mg", "iron"],
        ["magnesium_mg", "magnesium"],
        ["vitamin_a_mcg", "vitamin-a"],
        ["vitamin_c_mg", "vitamin-c"],
        ["vitamin_d_mcg", "vitamin-d"],
    ];

// Map an Open Food Facts `<key>_unit` string to the NutrientUnit vocabulary
// convertNutrientValue understands. Returns null for anything not
// confidently a mass unit (including "", "IU", "%", "% vol", "ml", "l",
// "kg" — the last because no per-100g/per-serving nutrient amount this
// module has ever observed uses it, and treating an unexpected unit as
// "ambiguous -> null" (CONTRACT §0.9) is the safe default over guessing a
// kg->g shift). Case/whitespace-insensitive, matching every other OFF unit
// read in this file (e.g. servingVolumeMl, resolveAlcoholGrams).
function toMassNutrientUnit(rawUnit: unknown): NutrientUnit | null {
    if (typeof rawUnit !== "string") return null;
    switch (rawUnit.trim().toLowerCase()) {
        case "g":
            return "g";
        case "mg":
            return "mg";
        case "mcg":
        case "µg":
        case "ug":
            return "mcg";
        default:
            return null;
    }
}

// Read + unit-convert one micronutrient field from OFF's nutriments object.
// Picks `_serving` or `_100g` per the SAME hasServing decision every other
// field in this product uses (so a product is never a mix of bases across
// fields), reads that same key's sibling `_unit`, and hands both to
// convertNutrientValue — the one place allowed to do the g/mg/mcg
// arithmetic (CONTRACT §0.5). Missing value, malformed value, or an
// unrecognized/absent unit all resolve to null; an explicit 0 survives as 0
// (convertMass treats 0 as a valid amount, not a missing one).
function readMicronutrient(
    field: NutrientField,
    offKey: string,
    n: Record<string, unknown>,
    hasServing: boolean,
): number | null {
    const raw = hasServing ? n[`${offKey}_serving`] : n[`${offKey}_100g`];
    const value = rawNum(raw);
    if (value == null) return null;
    const unit = toMassNutrientUnit(n[`${offKey}_unit`]);
    if (unit == null) return null;
    return convertNutrientValue(field, value, unit);
}

// Normalize an OFF product into our shape. Prefer per-serving values when the
// product declares a serving size and a per-serving energy; otherwise fall back
// to the always-present per-100g basis and label it as such.
function normalizeOFFProduct(product: OFFProduct, barcode: string): FoodResult {
    const n = product.nutriments ?? {};
    const hasServing =
        !!product.serving_size && n["energy-kcal_serving"] != null;
    const pick = (servingKey: string, hundredKey: string) =>
        hasServing ? num(n[servingKey]) : num(n[hundredKey]);

    const servingBasis: ServingBasis = hasServing
        ? {
              kind: "per_serving",
              grams: servingGrams(product),
              label: product.serving_size!.trim(),
          }
        : { kind: "per_100g" };

    const food: FoodResult = {
        name: product.product_name?.trim() || `Product ${barcode}`,
        brand: product.brands?.split(",")[0]?.trim() || null,
        serving: hasServing ? product.serving_size!.trim() : "100 g",
        calories: pick("energy-kcal_serving", "energy-kcal_100g"),
        protein_g: pick("proteins_serving", "proteins_100g"),
        carbs_g: pick("carbohydrates_serving", "carbohydrates_100g"),
        fat_g: pick("fat_serving", "fat_100g"),
        // OFF spells it "fiber" (American) — no "fibre_*" key exists; confirmed
        // across 100 products, where only fiber_100g / fiber_serving appear.
        fiber_g: pick("fiber_serving", "fiber_100g"),
        // "sugars", plural. This is TOTAL sugars including naturally occurring
        // sugar from fruit and milk. OFF also carries a separate
        // `added-sugars_*`, mapped below into added_sugar_g — the two are
        // never conflated.
        sugar_g: pick("sugars_serving", "sugars_100g"),
        alcohol_g: resolveAlcoholGrams(product, n, hasServing),
        // Open Food Facts has no caffeine nutriment at all.
        caffeine_mg: null,
        nutriscore_grade: normalizeNutriscoreGrade(product.nutriscore_grade),
        nova_group: normalizeNovaGroup(product.nova_group),
        saturated_fat_g: readMicronutrient(
            "saturated_fat_g",
            "saturated-fat",
            n,
            hasServing,
        ),
        trans_fat_g: readMicronutrient(
            "trans_fat_g",
            "trans-fat",
            n,
            hasServing,
        ),
        added_sugar_g: readMicronutrient(
            "added_sugar_g",
            "added-sugars",
            n,
            hasServing,
        ),
        sodium_mg: readMicronutrient("sodium_mg", "sodium", n, hasServing),
        potassium_mg: readMicronutrient(
            "potassium_mg",
            "potassium",
            n,
            hasServing,
        ),
        cholesterol_mg: readMicronutrient(
            "cholesterol_mg",
            "cholesterol",
            n,
            hasServing,
        ),
        calcium_mg: readMicronutrient("calcium_mg", "calcium", n, hasServing),
        iron_mg: readMicronutrient("iron_mg", "iron", n, hasServing),
        magnesium_mg: readMicronutrient(
            "magnesium_mg",
            "magnesium",
            n,
            hasServing,
        ),
        vitamin_a_mcg: readMicronutrient(
            "vitamin_a_mcg",
            "vitamin-a",
            n,
            hasServing,
        ),
        vitamin_c_mg: readMicronutrient(
            "vitamin_c_mg",
            "vitamin-c",
            n,
            hasServing,
        ),
        vitamin_d_mcg: readMicronutrient(
            "vitamin_d_mcg",
            "vitamin-d",
            n,
            hasServing,
        ),
        servingBasis,
        provenance: null, // filled in below, once the literal above exists
        source: `off:${barcode}`,
        source_name: SOURCE_OFF,
        barcode,
    };
    food.provenance = buildOFFProvenance(food);
    return food;
}

// Pure HTTP fetch + normalize, no caching. Returns null when the product is not
// in Open Food Facts; throws on network failure or an unexpected HTTP status so
// the caller can distinguish "not found" from "couldn't reach the service".
export async function fetchProductFromOFF(
    barcode: string,
): Promise<FoodResult | null> {
    const url = `${OFF_PRODUCT_URL}/${barcode}.json`;
    const res = await fetch(url, {
        headers: { "User-Agent": offUserAgent(), Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
        throw new Error(`Open Food Facts request failed: ${res.status}`);
    }

    const body = (await res.json()) as {
        status?: number;
        product?: OFFProduct;
    };
    if (!body || body.status === 0 || !body.product) return null;

    const food = normalizeOFFProduct(body.product, barcode);
    // Open Food Facts is full of "stub" products: an entry exists (status 1,
    // sometimes even a name) but carries no nutriments at all. That is a miss
    // for our purposes — returning it would report the product as "found" with
    // every macro n/a (suppressing the caller's estimation fallback) and pin a
    // useless record in the cache for the full TTL. Treat it as not found.
    //
    // Deliberately still keyed on the four core macros only, not on the newer
    // fiber/sugar/alcohol/micronutrient fields. A product with, say, sodium but
    // no calories, protein, carbs or fat is a broken record, not a usable hit,
    // and returning it would suppress exactly the estimation fallback this
    // check exists to preserve. (Adding alcohol_g here would be a no-op
    // regardless: it is only ever non-null on the per-serving basis, which
    // requires energy-kcal_serving, which makes calories non-null.)
    if (
        food.calories == null &&
        food.protein_g == null &&
        food.carbs_g == null &&
        food.fat_g == null
    ) {
        return null;
    }
    return food;
}

// ---------- Cache ----------
// All cache access is best-effort: any failure (missing table, no Supabase
// config, transient error) is swallowed and treated as a miss so a cache
// problem can never break a lookup.

// Fields added after the cache table started filling — every one of them
// must backfill to `null` (or, for `servingBasis`/`provenance`, an honest
// reconstruction) for a row cached before it existed, or a stale cache hit
// deserializes with `undefined` fields instead of `null`, which fails
// `.nullable()` structuredContent validation (CONTRACT §7) the moment such a
// row is served instead of re-fetched.
const BACKFILL_NULL_FIELDS = [
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    "caffeine_mg",
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
] as const satisfies readonly NutrientField[];

export async function getCachedFood(
    source: string,
    sourceId: string,
    ttlMs: number,
): Promise<FoodResult | null> {
    try {
        const { data, error } = await getSupabase()
            .from("food_cache")
            .select("payload, fetched_at")
            .eq("source", source)
            .eq("source_id", sourceId)
            .maybeSingle();
        if (error || !data) return null;
        const ageMs = Date.now() - new Date(data.fetched_at).getTime();
        if (ageMs > ttlMs) return null;
        const payload = data.payload as FoodResult;
        const backfilled: FoodResult = { ...payload };
        for (const field of BACKFILL_NULL_FIELDS) {
            backfilled[field] = payload[field] ?? null;
        }
        backfilled.nutriscore_grade = payload.nutriscore_grade ?? null;
        backfilled.nova_group = payload.nova_group ?? null;
        // `servingBasis` did not exist before this change. Best-effort
        // reconstruction from the pre-existing `serving` label: the old
        // normalizer only ever wrote the literal "100 g" on the per-100g
        // fallback path, so that exact string is a reliable (if slightly
        // heuristic — a product whose real serving label happened to BE
        // "100 g" would misclassify) signal; anything else was a genuine
        // per-serving label with no parsed gram weight recorded at the time.
        if (backfilled.servingBasis == null) {
            backfilled.servingBasis =
                payload.serving === "100 g"
                    ? { kind: "per_100g" }
                    : {
                          kind: "per_serving",
                          grams: null,
                          label: payload.serving ?? null,
                      };
        }
        // `provenance` did not exist before this change either; rebuild it
        // from the now-backfilled nutrient fields rather than leaving it
        // undefined.
        if (backfilled.provenance === undefined) {
            backfilled.provenance = buildOFFProvenance(backfilled);
        }
        return backfilled;
    } catch {
        return null;
    }
}

async function putCachedFood(
    source: string,
    sourceId: string,
    payload: FoodResult,
): Promise<void> {
    try {
        await getSupabase().from("food_cache").upsert(
            {
                source,
                source_id: sourceId,
                payload,
                fetched_at: new Date().toISOString(),
            },
            { onConflict: "source,source_id" },
        );
    } catch {
        // best-effort; ignore
    }
}

// Cache-first barcode lookup. `barcode` must already be normalized
// (see normalizeBarcode). Returns null when the product is unknown; throws only
// when Open Food Facts itself is unreachable.
export async function lookupBarcode(
    barcode: string,
): Promise<FoodResult | null> {
    const cached = await getCachedFood(SOURCE_OFF, barcode, OFF_TTL_MS);
    if (cached) return cached;

    const food = await fetchProductFromOFF(barcode);
    if (food) await putCachedFood(SOURCE_OFF, barcode, food);
    return food;
}

// ---------- Formatting ----------

function macro(value: number | null, unit: string): string {
    return value == null ? "n/a" : `${value} ${unit}`;
}

function novaLabel(group: 1 | 2 | 3 | 4): string {
    switch (group) {
        case 1:
            return "unprocessed/minimally processed";
        case 2:
            return "processed culinary ingredient";
        case 3:
            return "processed";
        case 4:
            return "ultra-processed";
    }
}

// Human labels for the micronutrient line, in the order they are checked —
// only fields Open Food Facts actually populated are ever shown, so a
// product with a sparse micronutrient panel gets a short line instead of a
// wall of "n/a"s (fiber/sugar keep their own dedicated "n/a states the gap"
// treatment below; these twelve are additive detail, not core macros).
const MICRONUTRIENT_DISPLAY: ReadonlyArray<
    readonly [NutrientField, string, string]
> = [
    ["saturated_fat_g", "Saturated fat", "g"],
    ["trans_fat_g", "Trans fat", "g"],
    ["added_sugar_g", "Added sugar", "g"],
    ["sodium_mg", "Sodium", "mg"],
    ["potassium_mg", "Potassium", "mg"],
    ["cholesterol_mg", "Cholesterol", "mg"],
    ["calcium_mg", "Calcium", "mg"],
    ["iron_mg", "Iron", "mg"],
    ["magnesium_mg", "Magnesium", "mg"],
    ["vitamin_a_mcg", "Vitamin A", "mcg"],
    ["vitamin_c_mg", "Vitamin C", "mg"],
    ["vitamin_d_mcg", "Vitamin D", "mcg"],
];

/**
 * Render a lookup for the model. `alcoholUnit` is the user's drink unit, or null
 * when alcohol tracking is off for them — in which case the alcohol line is
 * omitted entirely, matching every other display path. The value is still
 * returned in the FoodResult and still stored if the meal is logged; only the
 * rendering is gated.
 *
 * Fiber and sugar are never gated, and are shown even when null ("n/a"): a food
 * with no fiber figure in Open Food Facts is a fact worth stating, since the
 * alternative is the model quietly assuming zero.
 *
 * The twelve new micronutrients get one extra line, present only when at
 * least one of them is non-null — a product Open Food Facts has no
 * micronutrient data for at all renders exactly as it did before this field
 * set existed, so this is purely additive.
 *
 * Nutri-Score and NOVA are omitted entirely when OFF hasn't computed them —
 * unlike fiber/sugar, that is not a gap to estimate around.
 */
export function formatFoodResult(
    food: FoodResult,
    alcoholUnit: DrinkUnit | null = null,
): string {
    const title = food.brand ? `${food.name} (${food.brand})` : food.name;
    const lines = [
        title,
        `Serving: ${food.serving ?? "n/a"}`,
        `Calories: ${macro(food.calories, "kcal")} · Protein: ${macro(
            food.protein_g,
            "g",
        )} · Carbs: ${macro(food.carbs_g, "g")} · Fat: ${macro(
            food.fat_g,
            "g",
        )}`,
        `Fiber: ${macro(food.fiber_g, "g")} · Sugar (total): ${macro(
            food.sugar_g,
            "g",
        )}`,
    ];
    const scoreParts = [
        food.nutriscore_grade
            ? `Nutri-Score: ${food.nutriscore_grade.toUpperCase()}`
            : null,
        food.nova_group
            ? `NOVA: ${food.nova_group} (${novaLabel(food.nova_group)})`
            : null,
    ].filter(Boolean);
    if (scoreParts.length > 0) lines.push(scoreParts.join(" · "));
    if (alcoholUnit && food.alcohol_g != null) {
        lines.push(`Alcohol: ${formatAlcohol(food.alcohol_g, alcoholUnit)}`);
    }
    const microParts = MICRONUTRIENT_DISPLAY.filter(
        ([field]) => food[field] != null,
    ).map(([field, label, unit]) => `${label}: ${macro(food[field], unit)}`);
    if (microParts.length > 0) {
        lines.push(microParts.join(" · "));
    }
    // "n/a" states the gap honestly but says nothing about what to do next,
    // which is how a lookup with no fiber figure turns into a meal with no
    // fiber figure. The sibling error paths in mcp.ts all prescribe a fallback
    // ("fall back to web search or estimation"); the success path did not.
    const unknown = [
        food.fiber_g == null ? "fiber" : null,
        food.sugar_g == null ? "sugar" : null,
    ].filter(Boolean);
    if (unknown.length > 0) {
        lines.push(
            `(Open Food Facts has no ${unknown.join(" or ")} figure for this product — that is missing data, not a zero. Estimate from the ingredients or a web search and still pass the value to log_meal.)`,
        );
    }
    lines.push(`Source: Open Food Facts (barcode ${food.barcode})`);
    return lines.join("\n");
}
