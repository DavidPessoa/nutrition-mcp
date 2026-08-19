// USDA FoodData Central provider (Agent 4).
//
// Why this exists: for a generic whole food ("150 g roasted chicken breast",
// "2 large eggs") there is no barcode and no packaged label, so Open Food
// Facts has nothing — and the alternative is the model inventing
// micronutrients, which CONTRACT.md §0.2 forbids outright. FDC is the
// authoritative source that makes those foods answerable instead of null.
//
// Schema verified against USDA's own OpenAPI v3 spec (fetched from
// https://api.swaggerhub.com/apis/fdcnal/food-data_central_api/1.0.1,
// mirrored at https://api.nal.usda.gov/fdc/v1/json-spec), not from memory:
//
//   - GET /v1/food/{fdcId}   -> foodNutrients[].nutrient.{number,name,unitName}
//                               plus foodNutrients[].amount   ("FoodNutrient")
//   - GET /v1/foods/search   -> foodNutrients[].{number,name,unitName,amount}
//                               ("AbridgedFoodNutrient" — flat, no `nutrient`)
//   - dataType is one of: Branded | Foundation | Survey (FNDDS) | SR Legacy
//   - foodPortions[].{amount, gramWeight, portionDescription, modifier}
//
// `readNutrients` below handles BOTH nutrient shapes, because the search
// endpoint returns the flat one and the detail endpoint the nested one.
//
// VALIDATED LIVE 2026-08-19 (`bun run validate:usda`, five real records
// across SR Legacy and Survey (FNDDS); see validation/usda/README.md for
// exactly what is proven and what is still assumed). The fixtures under
// src/fixtures/usda/ named after a food are now real captured payloads.
//
// Two things the live data corrected: `unitName` arrives LOWERCASE with a
// real micro sign ("g", "mg", "µg", "kcal"), not uppercase; and nutrient 539
// (added sugars) appeared in none of the sampled records, so that one row of
// NUTRIENT_NUMBERS remains unexercised by real data.

import {
    NUTRIENT_FIELDS,
    type NutrientField,
    type NutrientUnit,
    type NutrientProvenance,
} from "./nutrients.js";
import {
    convertNutrientValue,
    resolveServingValues,
    type NutrientValues,
} from "./nutrient-units.js";
import { emptyNutrientValues, type FoodNutrition } from "./providers/types.js";
import { getSupabase } from "./supabase.js";

const FDC_BASE_URL = "https://api.nal.usda.gov/fdc/v1";
const REQUEST_TIMEOUT_MS = 8_000;
const SOURCE_USDA = "usda_fdc";
// FDC records are versioned datasets that change only on publication, so a
// long TTL is safe — much safer than Open Food Facts' crowd-sourced data.
const USDA_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Which FDC datasets we search by default. `Branded` is deliberately absent:
 * a barcoded packaged product is Open Food Facts' job (and OFF's coverage of
 * it is better), while this provider exists for the generic whole foods OFF
 * cannot answer. A caller can still ask for it explicitly.
 */
export const DEFAULT_DATA_TYPES = [
    "Foundation",
    "SR Legacy",
    "Survey (FNDDS)",
] as const;

export class UsdaConfigError extends Error {}

function apiKey(): string {
    const key = process.env.USDA_FDC_API_KEY?.trim();
    if (!key) {
        throw new UsdaConfigError(
            "USDA_FDC_API_KEY is not set. Get a free key at " +
                "https://fdc.nal.usda.gov/api-key-signup.html",
        );
    }
    return key;
}

// ---------------------------------------------------------------------------
// Nutrient number -> canonical field
// ---------------------------------------------------------------------------
//
// Keyed by FDC's `nutrient.number` (the INFOODS tagname, a STRING in the
// detail response and a number in the abridged one — normalized to a string
// before lookup). Name matching is deliberately not used: descriptions vary
// across datasets ("Sugars, total including NLEA" vs "Sugars, total"), the
// numbers do not.
//
// Energy is handled separately (see readCalories) and is NOT in this table:
// FDC reports the same food's energy under BOTH 208 (kcal) and 268 (kJ), and
// a table lookup that only matched on number would happily read 1506 kJ into
// a kcal field. That is the single most expensive available mistake here.
//
// DELIBERATELY ABSENT, and why:
//   318  Vitamin A, IU     — IU -> µg RAE has no single valid factor
//                            (src/nutrient-units.ts explains at length).
//                            320 (RAE) is the only vitamin A we accept.
//   324  Vitamin D, IU     — same, for vitamin D. 328 is µg.
//   268  Energy (kJ)       — see above.
//   957/958 Atwater energies — alternative kcal derivations; accepting them
//                            alongside 208 would make "which number did this
//                            calorie figure come from" unanswerable.
const NUTRIENT_NUMBERS: ReadonlyArray<readonly [string, NutrientField]> = [
    ["203", "protein_g"],
    ["204", "fat_g"], // Total lipid (fat)
    ["205", "carbs_g"], // Carbohydrate, by difference
    ["291", "fiber_g"], // Fiber, total dietary
    ["269", "sugar_g"], // Sugars, total — TOTAL, never added
    // 539 (Sugars, added) is carried by Branded records and by a minority of
    // FNDDS ones; none of the five foods validated live on 2026-08-19 had it,
    // so this row is mapped from the INFOODS tagname and NOT yet confirmed
    // against a real payload. Recorded in validation/usda/README.md.
    ["539", "added_sugar_g"], // Sugars, added — its own measurement
    ["221", "alcohol_g"], // Alcohol, ethyl
    ["262", "caffeine_mg"],
    ["606", "saturated_fat_g"], // Fatty acids, total saturated
    ["605", "trans_fat_g"], // Fatty acids, total trans
    ["601", "cholesterol_mg"],
    ["307", "sodium_mg"], // Sodium, Na
    ["306", "potassium_mg"], // Potassium, K
    ["301", "calcium_mg"], // Calcium, Ca
    ["303", "iron_mg"], // Iron, Fe
    ["304", "magnesium_mg"], // Magnesium, Mg
    ["320", "vitamin_a_mcg"], // Vitamin A, RAE — µg RAE, the canonical unit
    ["401", "vitamin_c_mg"], // Vitamin C, total ascorbic acid
    ["328", "vitamin_d_mcg"], // Vitamin D (D2 + D3)
];

const ENERGY_KCAL_NUMBER = "208";

/**
 * Map an FDC `unitName` to the NutrientUnit vocabulary
 * `convertNutrientValue` understands. Live FDC writes these LOWERCASE and
 * uses a real micro sign ("g", "mg", "µg", "kcal", "IU" — verified 2026-08-19
 * across SR Legacy, Survey (FNDDS) and Foundation records), but the published
 * schema and older mirrors show uppercase, so matching stays case- and
 * whitespace-insensitive and accepts "ug" as well as "µg".
 *
 * Anything not confidently a mass unit returns null — including "IU",
 * "MG_ATE" (α-tocopherol equivalents) and "%". Per CONTRACT.md §0.9 an
 * unrecognized unit yields a null nutrient, never a guessed conversion.
 */
export function toFdcNutrientUnit(rawUnit: unknown): NutrientUnit | null {
    if (typeof rawUnit !== "string") return null;
    switch (rawUnit.trim().toLowerCase()) {
        case "g":
            return "g";
        case "mg":
            return "mg";
        case "ug":
        case "mcg":
        case "µg":
            return "mcg";
        default:
            return null;
    }
}

interface RawFdcNutrient {
    // Detail ("FoodNutrient") shape
    nutrient?: { number?: string | number; name?: string; unitName?: string };
    amount?: unknown;
    // Abridged ("AbridgedFoodNutrient", search results) shape
    number?: string | number;
    name?: string;
    unitName?: string;
}

/** The (number, unitName, amount) triple, read from either nutrient shape. */
function readEntry(entry: RawFdcNutrient): {
    number: string;
    unitName: unknown;
    amount: number | null;
} {
    const number = String(entry.nutrient?.number ?? entry.number ?? "").trim();
    const unitName = entry.nutrient?.unitName ?? entry.unitName;
    const raw = entry.amount;
    const amount =
        typeof raw === "number" && Number.isFinite(raw)
            ? raw
            : typeof raw === "string" &&
                raw.trim() !== "" &&
                !isNaN(Number(raw))
              ? Number(raw)
              : null;
    return { number, unitName, amount };
}

/**
 * Energy in kcal, and ONLY in kcal. FDC carries the same food's energy under
 * 208 (kcal) and 268 (kJ); an entry numbered 208 whose unitName is not KCAL
 * is treated as unusable rather than assumed — 1506 read as calories instead
 * of 360 is a 4x error that looks entirely plausible in a food log.
 */
function readCalories(entries: readonly RawFdcNutrient[]): number | null {
    for (const entry of entries) {
        const { number, unitName, amount } = readEntry(entry);
        if (number !== ENERGY_KCAL_NUMBER) continue;
        if (amount == null || amount < 0) continue;
        if (
            String(unitName ?? "")
                .trim()
                .toLowerCase() !== "kcal"
        )
            continue;
        return amount;
    }
    return null;
}

/**
 * Read every canonical nutrient FDC reported, converted into canonical units
 * via src/nutrient-units.ts (the only module allowed to do the arithmetic).
 * A nutrient that is absent, unparseable, negative, or reported in a unit we
 * cannot safely convert stays null. The first usable entry for a given
 * number wins — FDC occasionally repeats a nutrient across derivations.
 */
export function readNutrients(
    entries: readonly RawFdcNutrient[],
): Record<NutrientField, number | null> {
    const values: Record<NutrientField, number | null> = {
        ...emptyNutrientValues(),
    };
    values.calories = readCalories(entries);

    for (const entry of entries) {
        const { number, unitName, amount } = readEntry(entry);
        if (!number || amount == null || amount < 0) continue;
        const field = NUTRIENT_NUMBERS.find(([n]) => n === number)?.[1];
        if (!field || values[field] != null) continue;
        const unit = toFdcNutrientUnit(unitName);
        if (unit == null) continue;
        values[field] = convertNutrientValue(field, amount, unit);
    }
    return values;
}

interface RawFdcFood {
    fdcId?: number;
    description?: string;
    dataType?: string;
    brandOwner?: string;
    brandName?: string;
    publicationDate?: string;
    foodCategory?: { description?: string } | string;
    foodNutrients?: RawFdcNutrient[];
    foodPortions?: Array<{
        amount?: number;
        gramWeight?: number;
        portionDescription?: string;
        modifier?: string;
    }>;
}

/**
 * Normalize an FDC food record into the cross-provider `FoodNutrition`
 * shape.
 *
 * The serving basis is ALWAYS `per_100g`, and that is a fact about the
 * source, not a simplification: every FDC dataset reports `foodNutrients`
 * per 100 g of food, including Branded (whose per-serving figures live in a
 * separate `labelNutrients` object this provider does not read). Declaring
 * the basis honestly is what lets `resolveAmount` scale exactly once —
 * CONTRACT.md §0.6.
 *
 * Returns null when the payload carries no fdcId or no usable macro at all;
 * a record with a description and nothing else is not a nutrition result,
 * and returning it would suppress the estimation fallback that should take
 * over instead.
 */
export function normalizeFdcFood(payload: unknown): FoodNutrition | null {
    const food = payload as RawFdcFood | null;
    if (!food || typeof food !== "object") return null;
    const fdcId = food.fdcId;
    if (typeof fdcId !== "number" || !Number.isFinite(fdcId)) return null;

    const values = readNutrients(food.foodNutrients ?? []);
    if (
        values.calories == null &&
        values.protein_g == null &&
        values.carbs_g == null &&
        values.fat_g == null
    ) {
        return null;
    }

    const brand = food.brandOwner?.trim() || food.brandName?.trim() || null;
    return {
        ...values,
        name: food.description?.trim() || `FDC ${fdcId}`,
        brand,
        serving: { kind: "per_100g" },
        source: SOURCE_USDA,
        sourceId: `fdc:${fdcId}`,
    };
}

/**
 * Per-nutrient provenance for every field this record actually populated
 * (CONTRACT.md §2). A null nutrient gets no entry — provenance records where
 * a VALUE came from, and there is no value.
 */
export function buildUsdaProvenance(
    values: NutrientValues,
    sourceId: string,
): NutrientProvenance | null {
    const result: NutrientProvenance = {};
    for (const field of NUTRIENT_FIELDS) {
        if (values[field] == null) continue;
        result[field] = {
            source: "usda_fdc",
            source_id: sourceId,
            confidence: "authoritative",
        };
    }
    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Scale an FDC food's per-100g figures to an actual logged gram amount.
 *
 * A one-line wrapper over `resolveServingValues` ON PURPOSE: it is the only
 * scaling entry point callers of this module should use, so the arithmetic
 * stays in src/nutrient-units.ts and happens exactly once. Callers must not
 * multiply the returned values again.
 */
export function resolveAmount(
    food: FoodNutrition,
    grams: number,
): NutrientValues {
    const values: NutrientValues = {};
    for (const field of NUTRIENT_FIELDS) values[field] = food[field];
    return resolveServingValues(food.serving, values, grams);
}

/**
 * A search hit, carrying enough metadata for the caller (or the model) to
 * tell materially different foods apart — raw vs cooked, skin vs skinless,
 * fortified vs not, brand vs generic — rather than having this module pick
 * result #1 and hide the choice. FDC encodes all of that in `description`
 * and `dataType`, so both are surfaced verbatim, unranked and unfiltered.
 */
export interface UsdaCandidate {
    fdcId: number;
    description: string;
    dataType: string | null;
    brand: string | null;
    category: string | null;
    publishedOn: string | null;
    /** Per-100g nutrients from the abridged search payload, when present.
     * Search results carry only a handful of nutrients; treat this as a
     * preview for disambiguation, never as the full record — call
     * `getFood(fdcId)` for that. */
    preview: Record<NutrientField, number | null>;
}

function toCandidate(food: RawFdcFood): UsdaCandidate | null {
    if (typeof food.fdcId !== "number") return null;
    const category =
        typeof food.foodCategory === "string"
            ? food.foodCategory
            : (food.foodCategory?.description ?? null);
    return {
        fdcId: food.fdcId,
        description: food.description?.trim() || `FDC ${food.fdcId}`,
        dataType: food.dataType?.trim() || null,
        brand: food.brandOwner?.trim() || food.brandName?.trim() || null,
        category: category?.trim() || null,
        publishedOn: food.publicationDate?.trim() || null,
        preview: readNutrients(food.foodNutrients ?? []),
    };
}

// A PARENTHESIS ANYWHERE IN THE URL QUERY STRING IS UNUSABLE HERE.
//
// api.data.gov's edge (which fronts api.nal.usda.gov) intermittently answers
// any request whose query string contains "(" or ")" with a bare nginx
// `400 Bad Request` — no JSON, no explanation. Measured live 2026-08-19:
//
//   ?query=spinach                        12/12 -> 200
//   ?query=spinach&dataType=SR%20Legacy   12/12 -> 200
//   ?query=spinach%20(x)                   2/12 -> 200   (10 x 400)
//   ?query=spinach&dataType=Survey%20(FNDDS)   ~50% -> 400
//   ?query=spinach&dataType=Survey%20%28FNDDS%29 ~50% -> 400
//
// Percent-encoding does not help (the edge decodes first), repeated vs
// comma-joined `dataType` makes no difference (comma-joined answers 200 just
// as often), and it is not pinned to one edge IP. It is a flaky filter on the
// decoded query string, and it matters because one dataset is literally named
// "Survey (FNDDS)" — and because a user may well search for "chicken (cooked)".
//
// The fix is to keep parentheses out of the URL entirely: FDC documents
// `POST /v1/foods/search` taking the same criteria as a JSON body, with only
// `api_key` left in the URL. 12/12 -> 200 with the full three-dataset list.
// GET is still used for `/food/{id}`, whose path and params cannot contain a
// parenthesis.
async function fdcFetch(
    path: string,
    params: Record<string, string | readonly string[]>,
    body?: unknown,
) {
    const url = new URL(`${FDC_BASE_URL}${path}`);
    url.searchParams.set("api_key", apiKey());
    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) {
            for (const item of value) url.searchParams.append(key, item);
        } else {
            url.searchParams.set(key, value as string);
        }
    }
    const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        method: body === undefined ? "GET" : "POST",
        headers: {
            Accept: "application/json",
            ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 404 is "no such record", not a failure. FDC's search index and its
    // detail endpoint are not perfectly in sync — fdcId 747447 ("Broccoli,
    // raw", Foundation) is returned by search and 404s on /food/{id}, every
    // time (checked 2026-08-19). Throwing there would turn a routine dead
    // link into a tool error instead of a null lookup.
    if (response.status === 404) return null;
    if (!response.ok) {
        // The key is in the URL, so the URL must never reach a log or an
        // error message. Status only.
        throw new Error(`USDA FoodData Central returned ${response.status}`);
    }
    return await response.json();
}

/**
 * Search FDC for generic foods matching `query`. Returns candidates in the
 * order FDC ranked them and does NOT pick one: "roasted chicken breast" has
 * materially different records for skin-on and skinless, and silently
 * choosing the first is how a food log ends up 40 kcal/100 g wrong with no
 * trace of the decision.
 */
export async function searchFoods(
    query: string,
    options: { pageSize?: number; dataTypes?: readonly string[] } = {},
): Promise<UsdaCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const payload = (await fdcFetch(
        "/foods/search",
        {},
        {
            query: trimmed,
            pageSize: Math.min(Math.max(options.pageSize ?? 10, 1), 50),
            dataType: [...(options.dataTypes ?? DEFAULT_DATA_TYPES)],
        },
    )) as { foods?: RawFdcFood[] } | null;
    return (payload?.foods ?? [])
        .map(toCandidate)
        .filter((c): c is UsdaCandidate => c !== null);
}

/** Fetch one FDC record by id. Returns the RAW payload — see `lookupFood`
 * for the normalized, cached entry point. */
export async function fetchFoodFromFdc(fdcId: number): Promise<unknown | null> {
    const payload = await fdcFetch(`/food/${fdcId}`, { format: "full" });
    return payload && typeof payload === "object" ? payload : null;
}

/**
 * The cache stores the RAW FDC payload rather than the normalized result, so
 * a later improvement to the nutrient mapping applies to already-cached
 * foods instead of being locked out until the TTL expires. It also means a
 * newly added nutrient field needs no cache backfill dance — normalization
 * runs on read.
 */
async function getCachedPayload(fdcId: number): Promise<unknown | null> {
    try {
        const { data, error } = await getSupabase()
            .from("food_cache")
            .select("payload, fetched_at")
            .eq("source", SOURCE_USDA)
            .eq("source_id", String(fdcId))
            .maybeSingle();
        if (error || !data) return null;
        if (Date.now() - new Date(data.fetched_at).getTime() > USDA_TTL_MS) {
            return null;
        }
        return data.payload;
    } catch {
        return null;
    }
}

async function putCachedPayload(
    fdcId: number,
    payload: unknown,
): Promise<void> {
    try {
        await getSupabase()
            .from("food_cache")
            .upsert(
                {
                    source: SOURCE_USDA,
                    source_id: String(fdcId),
                    payload,
                    fetched_at: new Date().toISOString(),
                },
                { onConflict: "source,source_id" },
            );
    } catch {
        // best-effort; a cache problem must never break a lookup
    }
}

/** Cache-first FDC lookup, normalized into `FoodNutrition` (per 100 g). */
export async function lookupFood(fdcId: number): Promise<FoodNutrition | null> {
    const cached = await getCachedPayload(fdcId);
    if (cached) {
        const food = normalizeFdcFood(cached);
        if (food) return food;
    }
    const payload = await fetchFoodFromFdc(fdcId);
    if (!payload) return null;
    const food = normalizeFdcFood(payload);
    if (food) await putCachedPayload(fdcId, payload);
    return food;
}
