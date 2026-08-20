// Nutrient resolution policy (Agent 5).
//
// One question, answered in one place: when a write arrives carrying nutrient
// values, which of them are allowed to land on the meal, and what does the
// stored provenance become?
//
// Two rules do all the work, and both are refusals:
//
//   1. A model estimate may never produce a MICRONUTRIENT. The model may
//      estimate calories and the five macros in ESTIMABLE_FIELDS; it may not
//      estimate sodium, iron or vitamin D, because a plausible-looking
//      invented micronutrient is worse than a missing one — the user cannot
//      tell it is invented (CONTRACT.md §0.2).
//   2. A lower-precedence source may not overwrite a value that a
//      higher-precedence one already established (CONTRACT.md §4). A model
//      estimate must not overwrite the label figure a barcode lookup wrote.
//
// Everything else — clearing a field to null, a user explicitly overriding,
// filling a field nothing has claimed yet — is allowed.
//
// This module is PURE: no database, no network, no clock. It takes the prior
// state and the proposed write and returns what should be stored, plus a
// report of what it refused and why, so the caller can tell the model rather
// than silently dropping data.

import {
    MICRONUTRIENT_FIELDS,
    NUTRIENT_FIELDS,
    SOURCE_PRECEDENCE,
    type NutrientField,
    type NutrientProvenance,
    type NutrientSource,
} from "./nutrients.js";
import type { NutrientValues } from "./nutrient-units.js";

/** Confidence class implied by a source. Kept here rather than on the caller
 * so two call sites can never disagree about whether `usda_fdc` is
 * authoritative. */
export function confidenceOf(source: NutrientSource) {
    switch (source) {
        case "user_provided":
        case "import":
            return "user_provided" as const;
        case "model_estimate":
            return "estimated" as const;
        default:
            return "authoritative" as const;
    }
}

const MICRONUTRIENT_SET: ReadonlySet<string> = new Set(MICRONUTRIENT_FIELDS);

/**
 * True when a micronutrient is being estimated by the model — the one
 * combination this module refuses outright, whatever else the caller claims.
 *
 * Deliberately scoped to MICRONUTRIENT_FIELDS and not to "everything outside
 * ESTIMABLE_FIELDS": `caffeine_mg` and `alcohol_g` sit in neither list, and
 * the server has always asked the model for a caffeine figure (see the
 * log_meal field description). Widening the ban to them would silently break
 * shipped behaviour that users depend on, to protect fields that were never
 * the concern.
 */
export function isForbiddenEstimate(
    field: NutrientField,
    source: NutrientSource,
): boolean {
    return source === "model_estimate" && MICRONUTRIENT_SET.has(field);
}

export interface NutrientWrite {
    /** Only the fields actually supplied. A key present with `null` means
     * "clear this field"; a key that is absent means "leave it alone". The
     * difference is load-bearing — see CONTRACT.md §0.1. */
    values: NutrientValues;
    source: NutrientSource;
    sourceId?: string | null;
}

export interface PriorNutrients {
    values: NutrientValues;
    provenance: NutrientProvenance | null;
}

export interface NutrientResolution {
    /** Exactly the fields to write, including explicit `null`s for clears.
     * A field the policy refused is absent, so the stored value is untouched
     * rather than overwritten with null. */
    values: NutrientValues;
    /** The full merged provenance to store, or null when nothing is
     * attributed. Untouched fields keep their existing entries. */
    provenance: NutrientProvenance | null;
    /** Micronutrients dropped because the model tried to estimate them. */
    rejectedEstimates: NutrientField[];
    /** Fields left alone because a better-sourced value is already stored. */
    blockedByPrecedence: NutrientField[];
}

/**
 * Resolve a proposed nutrient write against what is already stored.
 *
 * `prior` is null for a fresh insert (nothing to protect, so only rule 1
 * applies). `options.userOverride` is the user explicitly saying "no, it is
 * this value" — it bypasses precedence, but NOT the micronutrient-estimate
 * ban: a model asserting an override for an iron figure it invented is
 * precisely the failure this exists to stop.
 */
export function resolveNutrientWrite(
    prior: PriorNutrients | null,
    incoming: NutrientWrite,
    options: { userOverride?: boolean } = {},
): NutrientResolution {
    const values: NutrientValues = {};
    const provenance: NutrientProvenance = { ...(prior?.provenance ?? {}) };
    const rejectedEstimates: NutrientField[] = [];
    const blockedByPrecedence: NutrientField[] = [];
    const incomingRank = SOURCE_PRECEDENCE[incoming.source];

    for (const field of NUTRIENT_FIELDS) {
        if (!(field in incoming.values)) continue;
        // `{sodium_mg: undefined}` reads as present to `in` but means nothing
        // was supplied — a spread of an object with optional keys produces it
        // routinely. Treated as ABSENT, not as the explicit null that clears a
        // stored value: CONTRACT §0.1 makes that distinction load-bearing, and
        // only a real `null` is a caller saying "this is not known". Every
        // current call site filters undefined out before it gets here; this is
        // the guard that keeps the next one from wiping stored nutrients.
        if (incoming.values[field] === undefined) continue;
        const value = incoming.values[field] ?? null;

        // Clearing is always the caller's prerogative — an explicit null is a
        // statement that the value is not known, which no precedence rule
        // should be able to veto. The attribution goes with the value.
        if (value === null) {
            values[field] = null;
            delete provenance[field];
            continue;
        }

        if (isForbiddenEstimate(field, incoming.source)) {
            rejectedEstimates.push(field);
            continue;
        }

        // Precedence only protects a value that actually exists. A stored
        // null is "unknown", and filling an unknown is never an overwrite —
        // this is what lets a model estimate fill a macro that a barcode
        // lookup had no figure for.
        const storedValue = prior?.values[field] ?? null;
        if (storedValue !== null && !options.userOverride) {
            const storedSource = prior?.provenance?.[field]?.source;
            const storedRank =
                storedSource === undefined
                    ? // No recorded provenance: every meal written before this
                      // epic is in this state. Treated as user_provided rather
                      // than as "unknown, so overwritable" — the value came
                      // from the user's own log, and letting a fresh model
                      // estimate silently replace their history would be the
                      // worst reading of an absent field.
                      SOURCE_PRECEDENCE.user_provided
                    : SOURCE_PRECEDENCE[storedSource];
            if (incomingRank > storedRank) {
                blockedByPrecedence.push(field);
                continue;
            }
        }

        values[field] = value;
        provenance[field] = {
            source: incoming.source,
            source_id: incoming.sourceId ?? null,
            confidence: confidenceOf(incoming.source),
        };
    }

    return {
        values,
        provenance: Object.keys(provenance).length > 0 ? provenance : null,
        rejectedEstimates,
        blockedByPrecedence,
    };
}

/**
 * A one-line note for the model when the policy refused part of its write.
 * Empty string when everything landed, so a call site can append it
 * unconditionally.
 *
 * This exists because a silent drop teaches the model nothing: it wrote an
 * iron figure, got a success back, and will do it again next meal. Saying
 * what was dropped and why is the only feedback in the loop — the same
 * reasoning as missingNutrientNote in src/mcp.ts.
 */
export function resolutionNote(resolution: NutrientResolution): string {
    const parts: string[] = [];
    if (resolution.rejectedEstimates.length > 0) {
        parts.push(
            `Not stored: ${resolution.rejectedEstimates.join(", ")}. ` +
                "Micronutrients cannot be model-estimated — they are only " +
                "stored when they come from a label, a barcode lookup, USDA " +
                "FoodData Central, published restaurant nutrition, or the " +
                "user reading a value off the package. A missing " +
                "micronutrient is correct here; an invented one is not.",
        );
    }
    if (resolution.blockedByPrecedence.length > 0) {
        parts.push(
            `Kept the existing values for: ${resolution.blockedByPrecedence.join(", ")}. ` +
                "Each already holds a figure from a more authoritative source " +
                "than this write. Pass nutrient_source='user_provided' with " +
                "the user's explicit correction to override.",
        );
    }
    return parts.length > 0 ? `\n\n(${parts.join(" ")})` : "";
}
