// The common shape every external nutrition provider (Open Food Facts,
// USDA FDC, and any future provider) normalizes into, and the interface each
// provider module implements. Nothing downstream of a provider — tool
// handlers, importers, widgets — should ever see a provider-specific field
// layout; they consume FoodNutrition and hand it to src/nutrient-units.ts to
// scale it. See CLAUDE.md's Custom-UI-Widgets note on why concentration like
// this matters, and CONTRACT.md §0.5-6 for why unit/serving arithmetic is
// forbidden here — this file defines shapes, it does no math.

import { NUTRIENT_FIELDS, type NutrientField } from "../nutrients.js";

/**
 * What basis a provider's nutrient figures are reported against.
 *
 * This is the type that prevents double-scaling (CONTRACT.md §0.6): a
 * caller must be able to tell "this number is per 100 g, scale it to what
 * was actually eaten" apart from "this number IS the whole serving, do not
 * touch it again" before doing any arithmetic. Collapsing both into a single
 * `serving: string` label — which is what the pre-existing `FoodResult` in
 * src/foods.ts does today — loses exactly that distinction: its `pick()`
 * helper decides per-100g vs per-serving once at read time and the string
 * label is purely for display afterward, so there is nothing left in the
 * shape itself for a later scaling step to inspect. Migrating `FoodResult`
 * onto `FoodNutrition` (Agent 3) should carry that same per-field decision
 * into an explicit `ServingBasis` instead of re-deriving it from a string.
 *
 *  - "per_100g": every nutrient figure is per 100 g of the food. Always
 *    needs a gram amount to become a real serving — see
 *    `scalePer100g` / `resolveServingValue` in src/nutrient-units.ts.
 *  - "per_serving": every nutrient figure already describes one serving
 *    as-eaten, and must NEVER be rescaled again.
 *      - `grams` carries the serving's known gram weight when the provider
 *        states one, so a caller can still convert further (e.g. back to a
 *        per-100g basis) or display "per 42 g". It is `null` when the
 *        provider gives a serving with no parsed gram equivalent (Open Food
 *        Facts frequently has `serving_size: "1 slice"` with nothing
 *        machine-parsed) — the figures are still fully valid at that
 *        serving and must not be treated as missing just because their
 *        weight is unknown.
 *      - `label` is the provider's own human-readable serving description
 *        ("2 tbsp (30 g)", "1 medium banana"). Display only — never parsed
 *        for arithmetic; that is exactly the kind of string-math this
 *        module exists to avoid.
 */
export type ServingBasis =
    | { readonly kind: "per_100g" }
    | {
          readonly kind: "per_serving";
          readonly grams: number | null;
          readonly label: string | null;
      };

/**
 * All twenty canonical nutrient fields (CONTRACT.md §1), each independently
 * nullable. A provider rarely reports every field, and "this provider
 * doesn't carry this field" must read identically to "field present but
 * unknown" — both are `null`, never `0` (CONTRACT.md §0.1).
 */
export type ProviderNutrientValues = {
    readonly [K in NutrientField]: number | null;
};

/**
 * All twenty canonical nutrient fields set to `null`. Spread this and
 * override only what a provider actually reports, instead of hand-listing
 * all twenty keys at every provider call site — that hardcoded-field-list
 * pattern is exactly what CONTRACT.md §3 reserves for the shared nutrient
 * modules, not for individual providers.
 */
export function emptyNutrientValues(): ProviderNutrientValues {
    const values = {} as Record<NutrientField, number | null>;
    for (const field of NUTRIENT_FIELDS) {
        values[field] = null;
    }
    return values as ProviderNutrientValues;
}

/**
 * Normalized response from any nutrition provider. Every provider module
 * (src/foods.ts for Open Food Facts, src/usda.ts for USDA FDC, ...) maps its
 * own wire format into this shape and nothing else crosses the boundary —
 * see CONTRACT.md §5 for file ownership.
 */
export interface FoodNutrition extends ProviderNutrientValues {
    readonly name: string;
    readonly brand: string | null;
    readonly serving: ServingBasis;
    /**
     * Stable provider identifier — one of CONTRACT.md §2's SOURCES strings
     * (e.g. "open_food_facts", "usda_fdc"), since this is what a caller
     * writes verbatim into `nutrient_provenance.<field>.source`.
     */
    readonly source: string;
    /**
     * Provider-specific record id (a barcode, an FDC id, ...), opaque
     * outside the provider that issued it. Written into
     * `nutrient_provenance.<field>.source_id`.
     */
    readonly sourceId: string;
}

/**
 * What a nutrition provider module implements. `search` is optional because
 * not every provider supports free-text search — Open Food Facts' barcode
 * lookup has nothing to search by. `lookup` is the one operation every
 * provider must support: resolve a single, already-identified item (a
 * barcode, an FDC id, ...) to nutrition data.
 */
export interface NutritionProvider {
    /**
     * Free-text search, returning candidates for the caller (or model) to
     * disambiguate before calling `lookup`.
     */
    search?(query: string): Promise<FoodNutrition[]>;

    /**
     * Resolve a single identifier to full nutrition data. Returns `null`
     * when the id is well-formed but not found; throws when the provider
     * itself could not be reached (network failure, unexpected HTTP
     * status) — matching the null-vs-throw split `lookupBarcode` already
     * uses in src/foods.ts.
     */
    lookup(id: string): Promise<FoodNutrition | null>;
}
