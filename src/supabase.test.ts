import { test, expect, describe, mock, beforeEach } from "bun:test";
import {
    mealIdempotencyKey,
    updatedMealIdempotencyKey,
    normalizeMeal,
    insertMeal,
    updateMeal,
    updateWeight,
    widgetsEnabledFromProfile,
    alcoholTrackingEnabledFromProfile,
    preferredDrinkUnitFromProfile,
    timezoneFromProfile,
    fetchAllPages,
    exportArchivePath,
    exportStoragePaths,
    timezoneLevels,
    TZ_LEVEL_THRESHOLDS,
    type Meal,
    type MealInput,
    type Profile,
    type WeightEntry,
} from "./supabase.js";
import { rowContentDigest } from "./import.js";
import { MICRONUTRIENT_FIELDS, type NutrientProvenance } from "./nutrients.js";

// Most exports exercised here are pure: no Supabase client, no network, no
// database. The exception is the "insertMeal / updateMeal against a fake
// Supabase client" section below, which needs a stand-in for the real DB —
// see the comment there for why and how.

const USER = "11111111-1111-4111-8111-111111111111";
const LOGGED_AT = "2026-03-14T12:00:00.000Z";

function meal(overrides: Partial<MealInput> = {}): MealInput {
    return {
        description: "oat porridge with berries",
        meal_type: "breakfast",
        calories: 300,
        protein_g: 12,
        carbs_g: 45,
        fat_g: 8,
        notes: "made with milk",
        ...overrides,
    };
}

function key(input: MealInput, userId = USER, loggedAt = LOGGED_AT): string {
    return mealIdempotencyKey(userId, input, loggedAt);
}

describe("mealIdempotencyKey", () => {
    test("fiber, sugar, alcohol and caffeine are EXCLUDED from the derived key", () => {
        const base = meal();
        const withNewFields = meal({
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });

        // The whole point of the frozen array: adding one of the four
        // non-macro columns to it would change the key of every future write,
        // so a user re-logging or re-importing something they already have
        // would get a duplicate row instead of a clean no-op — and every
        // "auto:" key already in the table would be orphaned.
        expect(key(withNewFields)).toBe(key(base));

        // Negative control — this test must be able to fail. A field that IS
        // hashed changes the key, proving the assertion above is not just
        // "every input produces the same key".
        expect(key(meal({ calories: 301 }))).not.toBe(key(base));
    });

    test("each new field is excluded on its own, not just in combination", () => {
        const base = key(meal());
        expect(key(meal({ fiber_g: 6.2 }))).toBe(base);
        expect(key(meal({ sugar_g: 14.5 }))).toBe(base);
        expect(key(meal({ alcohol_g: 3.1 }))).toBe(base);
        expect(key(meal({ caffeine_mg: 95 }))).toBe(base);
        // Zero is not the same as absent to a hasher that stringifies parts,
        // so pin it too: it must still be excluded.
        expect(
            key(
                meal({
                    fiber_g: 0,
                    sugar_g: 0,
                    alcohol_g: 0,
                    caffeine_mg: 0,
                }),
            ),
        ).toBe(base);
    });

    test("REGRESSION: none of the twelve new micronutrient fields are hashed — two meals differing only in those fields produce an IDENTICAL key", () => {
        // Locks the frozen-digest decision in CONTRACT §6 for the fields this
        // agent added: MealInput now carries all twelve, and the array in
        // mealIdempotencyKey must still describe exactly the same content it
        // did before this epic. If a future agent "fixes" this by appending
        // one of the twelve to the array, this test is the one that catches
        // it — every stored "auto:" key would otherwise be silently
        // orphaned (see the warning comment on the array itself).
        const base = key(meal());
        const withEveryMicronutrient = meal(
            Object.fromEntries(
                MICRONUTRIENT_FIELDS.map((field, i) => [field, i + 1]),
            ),
        );
        expect(key(withEveryMicronutrient)).toBe(base);

        // Negative control, same purpose as the one above: a field that IS
        // hashed must still change the key, so this test can actually fail.
        expect(key(meal({ description: "different meal" }))).not.toBe(base);
    });

    test("two coffees differing only in caffeine dedupe to one — the accepted cost", () => {
        // Same trade as fiber above, restated for the mg column because it is
        // the one whose values a user is most likely to tune after the fact
        // (a single vs a double shot logged under the same description).
        expect(key(meal({ caffeine_mg: 63 }))).toBe(
            key(meal({ caffeine_mg: 126 })),
        );
    });

    test("two meals differing only in fiber dedupe to one — the accepted cost", () => {
        // Documented in CONTRACT §2 and in the comment on the array: this is a
        // deliberate trade, not an oversight. A caller who needs the rows kept
        // apart passes an explicit idempotency_key.
        expect(key(meal({ fiber_g: 1 }))).toBe(key(meal({ fiber_g: 99 })));
    });

    test("every field that IS hashed changes the key", () => {
        const base = key(meal());
        const variants: [string, MealInput][] = [
            ["description", meal({ description: "oat porridge" })],
            ["meal_type", meal({ meal_type: "snack" })],
            ["calories", meal({ calories: 301 })],
            ["protein_g", meal({ protein_g: 12.5 })],
            ["carbs_g", meal({ carbs_g: 46 })],
            ["fat_g", meal({ fat_g: 8.5 })],
            ["notes", meal({ notes: "made with water" })],
        ];
        for (const [label, input] of variants) {
            expect(`${label}:${key(input)}`).not.toBe(`${label}:${base}`);
        }

        // The two arguments outside MealInput matter as much: without userId
        // two users' identical meals would collide, and without logged_at the
        // same breakfast eaten on two days would dedupe into one.
        expect(key(meal(), "22222222-2222-4222-8222-222222222222")).not.toBe(
            base,
        );
        expect(key(meal(), USER, "2026-03-15T12:00:00.000Z")).not.toBe(base);
    });

    test("is deterministic and marked as server-derived", () => {
        expect(key(meal())).toBe(key(meal()));
        expect(key(meal())).toMatch(/^auto:[0-9a-f]{64}$/);
    });

    test("an absent field and an explicitly null-ish one hash alike", () => {
        // parts.map(p => p ?? "") — undefined and null collapse to the same
        // empty segment, so an omitted note and a cleared note dedupe together.
        expect(key(meal({ notes: undefined }))).toBe(
            key({ ...meal(), notes: undefined }),
        );
    });

    test("stays in step with rowContentDigest in src/import.ts", () => {
        // The two frozen arrays are mirrors: same fields, same order, same
        // hash. If either drifts, meals written through log_meal and the same
        // meals written through bulk_import_meals stop deduping against each
        // other. Both are frozen by CONTRACT §2.
        const input = meal({
            logged_at: LOGGED_AT,
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });
        expect(key(input)).toBe(`auto:${rowContentDigest(USER, input)}`);
    });
});

function existingMeal(overrides: Partial<Meal> = {}): Meal {
    return {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: USER,
        logged_at: LOGGED_AT,
        meal_type: "breakfast",
        description: "oat porridge with berries",
        calories: 300,
        protein_g: 12,
        carbs_g: 45,
        fat_g: 8,
        fiber_g: null,
        sugar_g: null,
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
        nutrient_provenance: null,
        notes: "made with milk",
        idempotency_key: key(meal()),
        ...overrides,
    };
}

describe("updatedMealIdempotencyKey", () => {
    test("recomputes the digest when an edit changes content, for an auto: key", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            calories: 600,
        });

        expect(updated).not.toBeNull();
        // Differs from the pre-edit row's key...
        expect(updated).not.toBe(existing.idempotency_key);
        // ...and from what the ORIGINAL (pre-edit) content would still hash to
        // — this is the #84 replay case: a replay of the original log_meal
        // call must no longer dedupe onto the corrected row.
        expect(updated).not.toBe(key(meal()));
        // It matches recomputing over the merged (post-edit) content.
        expect(updated).toBe(key(meal({ calories: 600 })));
    });

    test("a caller-supplied idempotency_key is left untouched", () => {
        const existing = existingMeal({
            idempotency_key: "client-supplied-key-123",
        });
        expect(
            updatedMealIdempotencyKey(USER, existing, { calories: 600 }),
        ).toBeNull();
    });

    test("a row with idempotency_key: null returns null", () => {
        const existing = existingMeal({ idempotency_key: null });
        expect(
            updatedMealIdempotencyKey(USER, existing, { calories: 600 }),
        ).toBeNull();
    });

    test("fields not passed in the update fall back to the existing row's content", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            notes: "made with oat milk",
        });

        expect(updated).toBe(key(meal({ notes: "made with oat milk" })));
    });

    test("editing fiber_g/sugar_g/alcohol_g/caffeine_mg alone does not change the recomputed key", () => {
        const existing = existingMeal();
        const updated = updatedMealIdempotencyKey(USER, existing, {
            fiber_g: 6.2,
            sugar_g: 14.5,
            alcohol_g: 3.1,
            caffeine_mg: 95,
        });

        expect(updated).toBe(existing.idempotency_key);
    });

    test("editing logged_at changes the key to match the new timestamp", () => {
        const existing = existingMeal();
        const newLoggedAt = "2026-03-15T12:00:00.000Z";
        const updated = updatedMealIdempotencyKey(USER, existing, {
            logged_at: newLoggedAt,
        });

        expect(updated).toBe(key(meal(), USER, newLoggedAt));
    });

    test("an existing row's logged_at in PostgREST's +00:00 form recomputes the same key a fresh identical log_meal call would produce", () => {
        // PostgREST renders timestamptz as "+00:00" (and drops an all-zero
        // fractional part), never as the "Z"-suffixed, millisecond-padded
        // form every write path hashes with. A row fetched back from the DB
        // carries the former; verify the fallback canonicalizes it before
        // hashing, rather than baking the DB's rendering into the key.
        const existing = existingMeal({
            logged_at: "2026-03-14T12:00:00+00:00",
        });
        const updated = updatedMealIdempotencyKey(USER, existing, {
            calories: 600,
        });

        expect(updated).toBe(key(meal({ calories: 600 })));
    });
});

// ---------- insertMeal / updateMeal against a fake Supabase client ----------
//
// Every export exercised above this line is pure. insertMeal and updateMeal
// are not — they call getSupabase() — so exercising the actual DB-write code
// (the `?? null` coalescing into every column, the `!== undefined`
// clear-vs-omit idiom, the assertValidNutrientValue guard, normalizeMeal on
// the way back out) needs a stand-in for the real client.
//
// mock.module retroactively patches the module registry entry for
// "@supabase/supabase-js" itself — one level below "./supabase.js", since
// this file IS ./supabase.js's test and so cannot mock the module it is
// testing (that's what middleware.test.ts and mcp.test.ts do instead, for
// modules that import ./supabase.js). It still works for the same reason
// their pattern does: supabase.ts's own
// `import { createClient } from "@supabase/supabase-js"` only binds the name
// at module-load time — the actual call happens lazily, inside
// buildClient(), the first time any test here invokes getSupabase() (via
// insertMeal/updateMeal) — which is always after every file's top-level
// code, mock.module calls included, has already run.
//
// The fake implements the exact chained calls insertMeal/updateMeal make
// against "meals" — `.select().eq().eq().maybeSingle()`,
// `.insert().select().single()`, `.update().eq().eq().select().single()` —
// and updateWeight's `.update().eq().eq().select()` without `.single()` on
// "weight_log". It is not a general PostgREST simulator.

type FakeRow = Record<string, unknown>;

function rowMatches(row: FakeRow, filters: [string, unknown][]): boolean {
    return filters.every(([col, val]) => row[col] === val);
}

function createFakeTableClient(rows: FakeRow[]) {
    function builder() {
        const filters: [string, unknown][] = [];
        let op: "select" | "insert" | "update" = "select";
        let payload: FakeRow = {};
        let queryCount = 0;

        async function execute(): Promise<{
            data: FakeRow | FakeRow[] | null;
            error: { message: string } | null;
        }> {
            queryCount += 1;
            if (op === "insert") {
                const row: FakeRow = {
                    id: `fake-${rows.length + 1}`,
                    ...payload,
                };
                rows.push(row);
                return { data: { ...row }, error: null };
            }
            if (op === "update") {
                const idx = rows.findIndex((r) => rowMatches(r, filters));
                if (idx === -1) {
                    return { data: [], error: null };
                }
                rows[idx] = { ...rows[idx], ...payload };
                return { data: [{ ...rows[idx] }], error: null };
            }
            const found = rows.find((r) => rowMatches(r, filters));
            return found
                ? { data: { ...found }, error: null }
                : { data: null, error: { message: "no rows found" } };
        }

        const api = {
            select(_cols?: string) {
                return api;
            },
            insert(row: FakeRow) {
                op = "insert";
                payload = row;
                return api;
            },
            update(row: FakeRow) {
                op = "update";
                payload = row;
                return api;
            },
            eq(col: string, val: unknown) {
                filters.push([col, val]);
                return api;
            },
            async maybeSingle() {
                const result = await execute();
                if (result.error) {
                    return { data: null, error: null };
                }
                return {
                    data:
                        result.data == null || Array.isArray(result.data)
                            ? null
                            : result.data,
                    error: null,
                };
            },
            async single() {
                const result = await execute();
                if (op === "update") {
                    if (
                        result.data == null ||
                        (Array.isArray(result.data) && result.data.length === 0)
                    ) {
                        return {
                            data: null,
                            error: { message: "no rows found" },
                        };
                    }
                    const row = Array.isArray(result.data)
                        ? result.data[0]
                        : result.data;
                    return { data: row, error: null };
                }
                if (result.error) return result;
                return {
                    data: Array.isArray(result.data)
                        ? result.data[0]
                        : result.data,
                    error: null,
                };
            },
            then(
                onFulfilled: (value: {
                    data: FakeRow | FakeRow[] | null;
                    error: { message: string } | null;
                }) => unknown,
                onRejected?: (reason: unknown) => unknown,
            ) {
                return execute().then(onFulfilled, onRejected);
            },
            getQueryCount() {
                return queryCount;
            },
        };
        return api;
    }
    return {
        builder,
        rows,
    };
}

function createFakeSupabaseClient(mealRows: FakeRow[], weightRows: FakeRow[]) {
    const meals = createFakeTableClient(mealRows);
    const weights = createFakeTableClient(weightRows);
    return {
        from(table: string) {
            if (table === "meals") return meals.builder();
            if (table === "weight_log") return weights.builder();
            throw new Error(
                `fake client only supports "meals" and "weight_log", got "${table}"`,
            );
        },
        weights,
    };
}

// One array, never reassigned — reset with .length = 0 in beforeEach so the
// fake client (created once, the first time getSupabase() memoizes it) keeps
// referencing the same backing store across the whole file.
const fakeMealRows: FakeRow[] = [];
const fakeWeightRows: FakeRow[] = [];

// createClient's real signature is (url, key, options); the fake ignores all
// three — insertMeal/updateMeal never see raw URLs or keys, only the
// client's query-builder surface.
mock.module("@supabase/supabase-js", () => ({
    createClient: () => createFakeSupabaseClient(fakeMealRows, fakeWeightRows),
}));

// buildClient() throws before ever reaching createClient if these are unset;
// the values themselves are never used since createClient is mocked above.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-secret-key";

beforeEach(() => {
    fakeMealRows.length = 0;
    fakeWeightRows.length = 0;
});

describe("normalizeMeal — backward compatibility for rows predating this migration", () => {
    // The exact shape PostgREST would have returned before the
    // micronutrient_expansion migration's columns existed: no
    // saturated_fat_g..vitamin_d_mcg keys, no nutrient_provenance key at all.
    const oldRow = {
        id: "old-1",
        user_id: USER,
        logged_at: LOGGED_AT,
        meal_type: "breakfast",
        description: "oatmeal",
        calories: 300,
        protein_g: 12,
        carbs_g: 45,
        fat_g: 8,
        fiber_g: null,
        sugar_g: null,
        alcohol_g: null,
        caffeine_mg: null,
        notes: null,
        idempotency_key: null,
    };

    test("every new field is backfilled to null, never 0, when the row has no such column at all", () => {
        const normalized = normalizeMeal(oldRow);
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(normalized[field]).toBeNull();
            expect(normalized[field]).not.toBe(0);
        }
        expect(normalized.nutrient_provenance).toBeNull();
    });

    test("existing fields pass through untouched", () => {
        const normalized = normalizeMeal(oldRow);
        expect(normalized.calories).toBe(300);
        expect(normalized.protein_g).toBe(12);
        expect(normalized.description).toBe("oatmeal");
        expect(normalized.id).toBe("old-1");
    });

    test("a row that already has the new columns as explicit null normalizes the same way", () => {
        const normalized = normalizeMeal({ ...existingMeal() });
        for (const field of MICRONUTRIENT_FIELDS) {
            expect(normalized[field]).toBeNull();
        }
        expect(normalized.nutrient_provenance).toBeNull();
    });

    test("a genuine zero on a new field is preserved, never collapsed to null", () => {
        const normalized = normalizeMeal({ ...existingMeal(), sodium_mg: 0 });
        expect(normalized.sodium_mg).toBe(0);
    });

    test("malformed nutrient_provenance degrades to null on read instead of propagating or throwing", () => {
        expect(() =>
            normalizeMeal({
                ...oldRow,
                nutrient_provenance: { sodium_mg: { source: "made_up" } },
            }),
        ).not.toThrow();
        const normalized = normalizeMeal({
            ...oldRow,
            nutrient_provenance: { sodium_mg: { source: "made_up" } },
        });
        expect(normalized.nutrient_provenance).toBeNull();
    });
});

describe("insertMeal — micronutrient value handling (the 7-case matrix, CONTRACT §8)", () => {
    for (const field of MICRONUTRIENT_FIELDS) {
        describe(field, () => {
            test("undefined -> null", async () => {
                const { meal: stored } = await insertMeal(USER, meal());
                expect(stored[field]).toBeNull();
            });

            test("null -> null", async () => {
                const { meal: stored } = await insertMeal(
                    USER,
                    meal({ [field]: null }) as MealInput,
                );
                expect(stored[field]).toBeNull();
            });

            test("0 -> 0 (zero is preserved, never collapsed to null)", async () => {
                const { meal: stored } = await insertMeal(
                    USER,
                    meal({ [field]: 0 }) as MealInput,
                );
                expect(stored[field]).toBe(0);
            });

            test("a positive value is preserved exactly", async () => {
                const { meal: stored } = await insertMeal(
                    USER,
                    meal({ [field]: 123.45 }) as MealInput,
                );
                expect(stored[field]).toBe(123.45);
            });

            test("a negative value is rejected", async () => {
                await expect(
                    insertMeal(USER, meal({ [field]: -1 }) as MealInput),
                ).rejects.toThrow();
            });

            test("NaN is rejected", async () => {
                await expect(
                    insertMeal(USER, meal({ [field]: NaN }) as MealInput),
                ).rejects.toThrow();
            });

            test("Infinity is rejected", async () => {
                await expect(
                    insertMeal(USER, meal({ [field]: Infinity }) as MealInput),
                ).rejects.toThrow();
            });
        });
    }
});

describe("insertMeal / updateMeal — micronutrient round trips", () => {
    test("create -> retrieve preserves an explicit 0 alongside an explicit null in the same row", async () => {
        const loggedAt = "2026-04-01T12:00:00.000Z";
        const input = meal({
            logged_at: loggedAt,
            sodium_mg: 0,
            potassium_mg: null,
            vitamin_c_mg: 42.5,
        });

        const created = await insertMeal(USER, input);
        expect(created.deduplicated).toBe(false);
        expect(created.meal.sodium_mg).toBe(0);
        expect(created.meal.potassium_mg).toBeNull();
        expect(created.meal.vitamin_c_mg).toBe(42.5);

        // Same content, same logged_at -> same derived idempotency key, so
        // this re-runs the select-by-idempotency-key retrieval path (not a
        // second insert) and must hand back the exact same stored values.
        const retrieved = await insertMeal(USER, input);
        expect(retrieved.deduplicated).toBe(true);
        expect(retrieved.meal.id).toBe(created.meal.id);
        expect(retrieved.meal.sodium_mg).toBe(0);
        expect(retrieved.meal.potassium_mg).toBeNull();
        expect(retrieved.meal.vitamin_c_mg).toBe(42.5);
    });

    test("create -> update one nutrient leaves every other nutrient (and non-nutrient fields) untouched", async () => {
        const created = await insertMeal(
            USER,
            meal({
                sodium_mg: 500,
                potassium_mg: 300,
                calcium_mg: 120,
                vitamin_c_mg: 10,
            }),
        );

        const updated = await updateMeal(USER, created.meal.id, {
            sodium_mg: 750,
        });

        expect(updated.sodium_mg).toBe(750);
        expect(updated.potassium_mg).toBe(300);
        expect(updated.calcium_mg).toBe(120);
        expect(updated.vitamin_c_mg).toBe(10);
        expect(updated.description).toBe(created.meal.description);
        expect(updated.calories).toBe(created.meal.calories);
    });

    test("create -> clear a nutrient explicitly back to null", async () => {
        const created = await insertMeal(USER, meal({ sodium_mg: 500 }));
        expect(created.meal.sodium_mg).toBe(500);

        const updated = await updateMeal(USER, created.meal.id, {
            sodium_mg: null,
        });
        expect(updated.sodium_mg).toBeNull();
    });

    test("updateMeal rejects a negative/NaN/Infinity micronutrient value and leaves the stored row untouched", async () => {
        const created = await insertMeal(USER, meal({ sodium_mg: 500 }));

        await expect(
            updateMeal(USER, created.meal.id, { sodium_mg: -1 }),
        ).rejects.toThrow();
        await expect(
            updateMeal(USER, created.meal.id, { potassium_mg: NaN }),
        ).rejects.toThrow();
        await expect(
            updateMeal(USER, created.meal.id, { calcium_mg: Infinity }),
        ).rejects.toThrow();

        // None of the rejected calls wrote anything.
        const stillThere = await insertMeal(
            USER,
            meal({
                logged_at: new Date(created.meal.logged_at).toISOString(),
                sodium_mg: 500,
            }),
        );
        expect(stillThere.meal.sodium_mg).toBe(500);
        expect(stillThere.meal.potassium_mg).toBeNull();
        expect(stillThere.meal.calcium_mg).toBeNull();
    });
});

describe("insertMeal / updateMeal — nutrient_provenance", () => {
    const provenance: NutrientProvenance = {
        sodium_mg: {
            source: "usda_fdc",
            source_id: "fdc:111",
            confidence: "authoritative",
        },
    };

    test("undefined -> null", async () => {
        const { meal: stored } = await insertMeal(USER, meal());
        expect(stored.nutrient_provenance).toBeNull();
    });

    test("null -> null", async () => {
        const { meal: stored } = await insertMeal(
            USER,
            meal({ nutrient_provenance: null }),
        );
        expect(stored.nutrient_provenance).toBeNull();
    });

    test("create -> retrieve preserves the provenance object exactly", async () => {
        const loggedAt = "2026-04-02T09:00:00.000Z";
        const input = meal({
            logged_at: loggedAt,
            nutrient_provenance: provenance,
        });

        const created = await insertMeal(USER, input);
        expect(created.meal.nutrient_provenance).toEqual(provenance);

        const retrieved = await insertMeal(USER, input);
        expect(retrieved.deduplicated).toBe(true);
        expect(retrieved.meal.nutrient_provenance).toEqual(provenance);
    });

    test("create -> update REPLACES the whole object rather than merging per key", async () => {
        const created = await insertMeal(
            USER,
            meal({ nutrient_provenance: provenance }),
        );
        const replacement: NutrientProvenance = {
            calcium_mg: {
                source: "nutrition_label",
                source_id: null,
                confidence: "authoritative",
            },
        };

        const updated = await updateMeal(USER, created.meal.id, {
            nutrient_provenance: replacement,
        });

        expect(updated.nutrient_provenance).toEqual(replacement);
        // The sodium_mg entry from the original object is gone, not merged —
        // updateMeal is a thin plumbing layer; a caller wanting a merge must
        // read-modify-write client-side.
        expect(updated.nutrient_provenance).not.toHaveProperty("sodium_mg");
    });

    test("create -> clear back to null", async () => {
        const created = await insertMeal(
            USER,
            meal({ nutrient_provenance: provenance }),
        );

        const updated = await updateMeal(USER, created.meal.id, {
            nutrient_provenance: null,
        });
        expect(updated.nutrient_provenance).toBeNull();
    });
});

describe("updateWeight against a fake Supabase client", () => {
    const WEIGHT_ID = "w-1";

    function weightRow(over: Partial<WeightEntry> = {}): WeightEntry {
        return {
            id: WEIGHT_ID,
            user_id: USER,
            weight_g: 70_000,
            logged_at: LOGGED_AT,
            notes: null,
            created_at: LOGGED_AT,
            idempotency_key: null,
            ...over,
        };
    }

    test("zero-row update throws entry not found", async () => {
        await expect(
            updateWeight(USER, WEIGHT_ID, { weight_g: 71_000 }),
        ).rejects.toThrow("Failed to update weight: entry not found");
    });

    test("a matching row is updated and returned", async () => {
        fakeWeightRows.push(weightRow() as unknown as FakeRow);
        const updated = await updateWeight(USER, WEIGHT_ID, {
            weight_g: 71_000,
        });
        expect(updated.weight_g).toBe(71_000);
        expect(fakeWeightRows[0]!.weight_g).toBe(71_000);
    });

    test("uses one round trip (no separate existence check)", async () => {
        fakeWeightRows.push(weightRow() as unknown as FakeRow);
        const client = createFakeSupabaseClient(fakeMealRows, fakeWeightRows);
        const builder = client.from("weight_log");
        builder
            .update({ weight_g: 72_000 })
            .eq("id", WEIGHT_ID)
            .eq("user_id", USER);
        expect(builder.getQueryCount()).toBe(0);
        await builder.select();
        expect(builder.getQueryCount()).toBe(1);
    });
});

// ---------- Profile-derived display preferences ----------

function profile(overrides: Partial<Profile> = {}): Profile {
    return {
        user_id: USER,
        timezone: "Europe/Kyiv",
        preferred_weight_unit: "kg",
        widgets_enabled: true,
        alcohol_tracking_enabled: false,
        preferred_drink_unit: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

// A row written before the column existed: present in the DB, absent from the
// JSON, so the property reads as undefined at runtime despite the type.
function withoutColumn(column: keyof Profile): Profile {
    const row = profile();
    delete (row as unknown as Record<string, unknown>)[column];
    return row;
}

describe("widgetsEnabledFromProfile", () => {
    test("defaults to true when there is no profile row", () => {
        expect(widgetsEnabledFromProfile(null)).toBe(true);
        expect(widgetsEnabledFromProfile(undefined)).toBe(true);
    });

    test("defaults to true when the column is absent", () => {
        expect(
            widgetsEnabledFromProfile(withoutColumn("widgets_enabled")),
        ).toBe(true);
    });

    test("honours an explicit opt-out", () => {
        expect(
            widgetsEnabledFromProfile(profile({ widgets_enabled: false })),
        ).toBe(false);
        expect(
            widgetsEnabledFromProfile(profile({ widgets_enabled: true })),
        ).toBe(true);
    });
});

describe("alcoholTrackingEnabledFromProfile", () => {
    test("defaults to FALSE when there is no profile row — alcohol is opt-in", () => {
        // CONTRACT §7. Flipping this default to true turns the opt-in into an
        // opt-out and surfaces alcohol — including the trace alcohol recipe
        // exports carry — to users who never asked to see it.
        expect(alcoholTrackingEnabledFromProfile(null)).toBe(false);
        expect(alcoholTrackingEnabledFromProfile(undefined)).toBe(false);
    });

    test("defaults to false when the column is absent", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                withoutColumn("alcohol_tracking_enabled"),
            ),
        ).toBe(false);
    });

    test("an existing profile that never opted in stays off", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                profile({ alcohol_tracking_enabled: false }),
            ),
        ).toBe(false);
    });

    test("honours an explicit opt-in", () => {
        expect(
            alcoholTrackingEnabledFromProfile(
                profile({ alcohol_tracking_enabled: true }),
            ),
        ).toBe(true);
    });
});

describe("preferredDrinkUnitFromProfile", () => {
    test("returns null when there is no profile row or no preference", () => {
        expect(preferredDrinkUnitFromProfile(null)).toBeNull();
        expect(preferredDrinkUnitFromProfile(undefined)).toBeNull();
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: null }),
            ),
        ).toBeNull();
        expect(
            preferredDrinkUnitFromProfile(
                withoutColumn("preferred_drink_unit"),
            ),
        ).toBeNull();
    });

    test("returns a saved preference", () => {
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: "us" }),
            ),
        ).toBe("us");
        expect(
            preferredDrinkUnitFromProfile(
                profile({ preferred_drink_unit: "uk" }),
            ),
        ).toBe("uk");
    });

    test("degrades unrecognised column values to null", () => {
        // The isDrinkUnit guard is what keeps junk out of the
        // Record<DrinkUnit, …> lookups in src/alcohol.ts, where an unguarded
        // value would surface as NaN grams per drink rather than as a missing
        // preference.
        for (const junk of ["US", "UK", "pints", "", "usa", 1, true, {}]) {
            expect(
                preferredDrinkUnitFromProfile(
                    profile({
                        preferred_drink_unit: junk as never,
                    }),
                ),
            ).toBeNull();
        }
    });
});

describe("no-profile defaults, together", () => {
    test("a user with no profile row gets widgets on, alcohol off, no drink unit", () => {
        // The exact triple buildMcpServer derives from one getProfile call.
        expect({
            widgets: widgetsEnabledFromProfile(null),
            alcohol: alcoholTrackingEnabledFromProfile(null),
            drinkUnit: preferredDrinkUnitFromProfile(null),
        }).toEqual({ widgets: true, alcohol: false, drinkUnit: null });
    });
});

// #99: profiles.timezone is nullable specifically so "never chosen" is
// representable. Unlike the three preferences above, a profile ROW existing
// is not by itself evidence of a choice here — set_weight_unit,
// set_widget_display and set_alcohol_tracking all upsert a profile without
// ever touching timezone, so callers must key "configured" off this
// function's return value, never off `profile !== null`.
describe("timezoneFromProfile", () => {
    test("returns null when there is no profile row", () => {
        expect(timezoneFromProfile(null)).toBeNull();
        expect(timezoneFromProfile(undefined)).toBeNull();
    });

    // The realistic path into #99: a profile row exists (created by some
    // other set_* tool) but timezone was never explicitly set.
    test("returns null for an existing profile whose timezone was never set", () => {
        expect(timezoneFromProfile(profile({ timezone: null }))).toBeNull();
    });

    test("returns a saved timezone", () => {
        expect(timezoneFromProfile(profile({ timezone: "Asia/Tokyo" }))).toBe(
            "Asia/Tokyo",
        );
    });
});

// ---------- export storage keys ----------

// Deleting an account must not leave the export archive behind: it holds the
// user's entire history, `storage.remove` reports a missing path as success,
// and the signed URL they were handed keeps resolving for the rest of its
// hour. So the deletion list is asserted against the path the writer actually
// uses — the two were spelled out separately once, and renaming the archive
// from meals.csv to the .zip silently orphaned a full copy of everyone's data.
describe("exportStoragePaths", () => {
    test("covers the archive the exporter writes", () => {
        expect(exportStoragePaths("u1")).toContain(exportArchivePath("u1"));
    });

    test("keeps the pre-ZIP meals.csv so old exports are still cleaned up", () => {
        expect(exportStoragePaths("u1")).toContain("u1/meals.csv");
    });

    test("scopes every key to the user's own folder", () => {
        for (const path of exportStoragePaths("u1")) {
            expect(path.startsWith("u1/")).toBe(true);
        }
    });

    // The guard above is only worth anything if deletion actually routes
    // through it; inlining a path there again is the regression.
    test("deleteAllUserData removes exactly this list", async () => {
        const src = await Bun.file("./src/supabase.ts").text();
        const body = src.slice(
            src.indexOf("export async function deleteAllUserData"),
        );
        expect(body).toContain("exportStoragePaths(userId)");
    });
});

// ---------- fetchAllPages (issue #66: the meal export silently truncated at
// PostgREST's default db-max-rows of 1000, since getAllMeals had no .range()
// pagination) ----------

/** An in-memory paged source, standing in for a `.range(from, to)` query. */
function paged<T>(rows: T[]) {
    const calls: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number): Promise<T[]> => {
        calls.push([from, to]);
        return rows.slice(from, to + 1);
    };
    return { fetchPage, calls };
}

describe("fetchAllPages", () => {
    test("returns everything when it all fits in one short page", async () => {
        const rows = Array.from({ length: 5 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        expect(await fetchAllPages(fetchPage, 1000)).toEqual(rows);
        // A page shorter than pageSize is itself proof there is no more —
        // one fetch should be enough, not a second empty-page round trip.
        expect(calls).toEqual([[0, 999]]);
    });

    test("empty source returns an empty array from a single fetch", async () => {
        const { fetchPage, calls } = paged<number>([]);
        expect(await fetchAllPages(fetchPage, 1000)).toEqual([]);
        expect(calls).toEqual([[0, 999]]);
    });

    test("pages through a total larger than one page (the reported bug)", async () => {
        // 1500 rows with the default 1000-row page: the original unbounded
        // select returned only the first 1000 and silently dropped the rest.
        const rows = Array.from({ length: 1500 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 1000);
        expect(result).toEqual(rows);
        expect(result).toHaveLength(1500);
        expect(calls).toEqual([
            [0, 999],
            [1000, 1999],
        ]);
    });

    test("total an exact multiple of pageSize still terminates", async () => {
        // A full last page is indistinguishable from "there might be more"
        // until the next fetch comes back empty — this pins that the loop
        // does make that extra call, and does stop once it does.
        const rows = Array.from({ length: 2000 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 1000);
        expect(result).toEqual(rows);
        expect(calls).toEqual([
            [0, 999],
            [1000, 1999],
            [2000, 2999],
        ]);
    });

    test("honours a custom page size", async () => {
        const rows = Array.from({ length: 25 }, (_, i) => i);
        const { fetchPage, calls } = paged(rows);
        const result = await fetchAllPages(fetchPage, 10);
        expect(result).toEqual(rows);
        expect(calls).toEqual([
            [0, 9],
            [10, 19],
            [20, 29],
        ]);
    });

    test("preserves row order across page boundaries", async () => {
        // getAllMeals sorts by logged_at then id before paging; fetchAllPages
        // must not reorder or interleave what each page hands back.
        const rows = Array.from({ length: 12 }, (_, i) => ({
            id: i,
            logged_at: `2026-01-${String(i + 1).padStart(2, "0")}`,
        }));
        const { fetchPage } = paged(rows);
        const result = await fetchAllPages(fetchPage, 5);
        expect(result.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    });
});

describe("timezoneLevels", () => {
    // Sizes the landing-page world map, and is the privacy boundary in front of
    // the exact per-timezone counts: /api/stats is public and unauthenticated,
    // so only these buckets are ever served.

    test("never leaks a count — only levels 1..5 come out", () => {
        const levels = timezoneLevels({
            "Europe/Berlin": 38,
            "America/New_York": 11,
            "Pacific/Apia": 1,
        });
        for (const value of Object.values(levels)) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(1);
            expect(value).toBeLessThanOrEqual(TZ_LEVEL_THRESHOLDS.length + 1);
        }
        expect(Object.keys(levels).sort()).toEqual([
            "America/New_York",
            "Europe/Berlin",
            "Pacific/Apia",
        ]);
    });

    test("a lone profile and the busiest timezone land in different buckets", () => {
        // The whole point of the change: with one radius for everything the map
        // said nothing. 1 of 273 must not read the same as 38 of 273.
        const levels = timezoneLevels({ big: 38, small: 1, rest: 234 });
        // Asserted as exact levels rather than `big > small`: under
        // noUncheckedIndexedAccess a lookup is number | undefined, and
        // toBeGreaterThan would not accept that as its argument.
        expect(levels.small).toBe(1);
        expect(levels.big).toBe(TZ_LEVEL_THRESHOLDS.length + 1);
    });

    test("levels are shares, not ranks — scaling everything changes nothing", () => {
        const small = timezoneLevels({ a: 1, b: 2, c: 4, d: 8, e: 85 });
        const large = timezoneLevels({
            a: 100,
            b: 200,
            c: 400,
            d: 800,
            e: 8500,
        });
        expect(large).toEqual(small);
    });

    test("threshold boundaries are inclusive", () => {
        // 1 in 100 is exactly the first threshold (0.01) and must step up.
        const levels = timezoneLevels({ edge: 1, rest: 99 });
        expect(levels.edge).toBe(2);
        // a hair under stays at level 1
        const under = timezoneLevels({ edge: 1, rest: 100 });
        expect(under.edge).toBe(1);
    });

    test("the largest possible share saturates at the top level", () => {
        const levels = timezoneLevels({ only: 5 });
        expect(levels.only).toBe(TZ_LEVEL_THRESHOLDS.length + 1);
    });

    test("no profiles yields no dots rather than a divide by zero", () => {
        expect(timezoneLevels({})).toEqual({});
        expect(timezoneLevels({ a: 0 })).toEqual({});
    });

    test("zero and malformed counts are dropped, not plotted at level 1", () => {
        // A timezone with no profiles must not appear on the map at all, and a
        // non-numeric value from the DB must not poison the total.
        const levels = timezoneLevels({
            real: 10,
            empty: 0,
            negative: -3,
            junk: undefined as unknown as number,
        });
        expect(Object.keys(levels)).toEqual(["real"]);
    });
});
