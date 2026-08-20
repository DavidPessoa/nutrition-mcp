import {
    getSupabase,
    exportArchivePath,
    getAllMeals,
    getAllWater,
    getAllWeight,
    getNutritionGoals,
    getProfile,
    timezoneFromProfile,
    MICRONUTRIENT_GOAL_FIELDS,
    type Meal,
    type NutritionGoals,
    type Profile,
    type WaterEntry,
    type WeightEntry,
} from "./supabase.js";
import { formatLocalDateTime } from "./tz.js";
import { fromGrams, isWeightUnit, type WeightUnit } from "./units.js";
import { buildZip, type ZipEntry } from "./zip.js";

const EXPORT_BUCKET = "exports";
// Signed link lifetime. The cleanup sweep ages files out on the same horizon.
const EXPORT_TTL_SECONDS = 60 * 60; // 60 minutes
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

/**
 * Column order for the export. This list and the positional row builder in
 * `buildMealsCsv` are parallel arrays: adding a column here without adding the
 * matching `csvEscape(...)` at the same index silently shifts every later field
 * in every row. `src/export.test.ts` guards the alignment — keep it that way.
 *
 * Header names deliberately match the importer's column aliases (`protein_g`,
 * `carbs_g`, `fiber_g`, …) so an export can be re-imported without remapping.
 */
const CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "meal_type",
    "description",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugar_g",
    "alcohol_g",
    // Milligrams, and the header says so. Every other nutrient column here is
    // grams, so a bare "caffeine" header is exactly how a re-import — ours or
    // anyone else's — turns 180 mg into 180 g.
    "caffeine_mg",
    // The twelve micronutrients, each carrying its unit in the header for the
    // same reason caffeine_mg does — these columns do NOT all agree, and the
    // importer reads a bare "Sodium" as milligrams by convention rather than
    // by anything the file said. Spelling them as the canonical field names
    // makes the round trip exact instead of conventional.
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
    "notes",
    // Per-nutrient provenance as one JSON object per row.
    //
    // JSON in a cell, rather than three more columns per nutrient: provenance
    // is a {source, source_id, confidence} record PER nutrient, so a flat
    // rendering would add up to sixty columns to a file whose whole job is to
    // be re-importable, and the importer maps columns one at a time. One
    // opaque cell round-trips byte-exactly through JSON.parse, stays empty
    // (not "{}") for the overwhelming majority of rows that have none, and
    // costs a reader nothing who only wants the numbers. csvEscape quotes it
    // and doubles its quotes, which is plain RFC-4180 and what every parser
    // here and elsewhere already undoes.
    "nutrient_provenance",
] as const;

/**
 * Quote a CSV field only when it contains a delimiter, quote, or newline.
 *
 * Booleans are in the union for profile.csv's toggles. The `== null` guard is
 * loose about null/undefined only, so `false` renders as the word and not as an
 * empty cell — an empty cell in this file means "never set", which is a
 * different fact from "set to off".
 */
function csvEscape(
    value: string | number | boolean | null | undefined,
): string {
    if (value == null) return "";
    const str = String(value);
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Build a CSV from meals. `logged_at` is rendered in `tz` (the user's timezone,
 * or "UTC" when none is set), and the `timezone` column records which zone the
 * timestamp is expressed in so the file is self-describing.
 */
export function buildMealsCsv(meals: Meal[], tz: string): string {
    const rows = [CSV_COLUMNS.join(",")];
    for (const m of meals) {
        rows.push(
            [
                csvEscape(m.id),
                csvEscape(formatLocalDateTime(m.logged_at, tz)),
                csvEscape(tz),
                csvEscape(m.meal_type),
                csvEscape(m.description),
                csvEscape(m.calories),
                csvEscape(m.protein_g),
                csvEscape(m.carbs_g),
                csvEscape(m.fat_g),
                csvEscape(m.fiber_g),
                csvEscape(m.sugar_g),
                csvEscape(m.alcohol_g),
                csvEscape(m.caffeine_mg),
                csvEscape(m.saturated_fat_g),
                csvEscape(m.trans_fat_g),
                csvEscape(m.added_sugar_g),
                csvEscape(m.sodium_mg),
                csvEscape(m.potassium_mg),
                csvEscape(m.cholesterol_mg),
                csvEscape(m.calcium_mg),
                csvEscape(m.iron_mg),
                csvEscape(m.magnesium_mg),
                csvEscape(m.vitamin_a_mcg),
                csvEscape(m.vitamin_c_mg),
                csvEscape(m.vitamin_d_mcg),
                csvEscape(m.notes),
                // Empty cell — not "{}" and not "null" — when there is no
                // provenance, so it reads as "nothing recorded here" exactly
                // like every other empty cell in this file.
                csvEscape(
                    m.nutrient_provenance
                        ? JSON.stringify(m.nutrient_provenance)
                        : null,
                ),
            ].join(","),
        );
    }
    return rows.join("\n");
}

/**
 * Column order for water.csv. Same parallel-array contract as CSV_COLUMNS
 * above: this list and the positional row builder below must be edited
 * together, or an inserted column silently shifts every later field.
 *
 * The unit rides in the header (`amount_ml`) for the same reason `caffeine_mg`
 * does — a bare "amount" leaves whoever reads this file back guessing between
 * millilitres, litres and ounces.
 */
const WATER_CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "amount_ml",
    "notes",
] as const;

/** Build a CSV from water entries, timestamps rendered in `tz`. */
export function buildWaterCsv(entries: WaterEntry[], tz: string): string {
    const rows = [WATER_CSV_COLUMNS.join(",")];
    for (const e of entries) {
        rows.push(
            [
                csvEscape(e.id),
                csvEscape(formatLocalDateTime(e.logged_at, tz)),
                // The zone travels next to the wall clock in every file. An
                // offset-less timestamp with no zone beside it re-resolves
                // against whatever timezone the account has later — #97.
                csvEscape(tz),
                csvEscape(e.amount_ml),
                csvEscape(e.notes),
            ].join(","),
        );
    }
    return rows.join("\n");
}

/**
 * Column order for weight.csv. Parallel array with the row builder below.
 *
 * Three weight columns rather than one: `weight_g` is what the DB actually
 * stores (canonical integer grams), and it is unreadable — nobody keeps a
 * weight log in grams. `weight_display` is the same number through `fromGrams`
 * in the user's preferred unit and `weight_unit` names that unit, so the
 * readable column can never be read as the wrong unit.
 */
const WEIGHT_CSV_COLUMNS = [
    "id",
    "logged_at",
    "timezone",
    "weight_g",
    "weight_display",
    "weight_unit",
    "notes",
] as const;

/**
 * Build a CSV from weight entries. `unit` is the display unit for
 * `weight_display`; callers coalesce a never-chosen preference to "kg" (this is
 * a display path, so guessing is safe here in a way it never is on a write).
 */
export function buildWeightCsv(
    entries: WeightEntry[],
    tz: string,
    unit: WeightUnit,
): string {
    const rows = [WEIGHT_CSV_COLUMNS.join(",")];
    for (const e of entries) {
        rows.push(
            [
                csvEscape(e.id),
                csvEscape(formatLocalDateTime(e.logged_at, tz)),
                csvEscape(tz),
                csvEscape(e.weight_g),
                csvEscape(fromGrams(e.weight_g, unit)),
                csvEscape(unit),
                csvEscape(e.notes),
            ].join(","),
        );
    }
    return rows.join("\n");
}

/**
 * Column order for goals.csv. Parallel array with the row builder below.
 *
 * `daily_caffeine_mg` is milligrams while its neighbours are grams, and
 * `daily_water_ml` millilitres, and `target_weight_g` canonical grams — the
 * unit is in the name at every layer for the same reason it is in meals.csv.
 */
const GOALS_CSV_COLUMNS = [
    "daily_calories",
    "daily_protein_g",
    "daily_carbs_g",
    "daily_fat_g",
    "daily_fiber_g",
    "daily_sugar_g",
    // Emitted unconditionally, NOT gated on the account's
    // alcohol_tracking_enabled preference. That opt-in governs *display* — what
    // the tools and widgets surface — while the export promises to hand back
    // everything that was ever logged. Withholding a goal the user set because
    // they later hid the row would make the archive an incomplete copy of their
    // data, which is the one thing it must not be.
    "daily_alcohol_g",
    "daily_caffeine_mg",
    "daily_water_ml",
    "target_weight_g",
    // The ten micronutrient targets, spliced in from the canonical list rather
    // than spelled out, so a target added to the model cannot be silently left
    // out of the backup — which is exactly what happened to all ten of these
    // when they were added to the goals table and not to this file. The names
    // carry their direction (max_/min_) and their unit for the same reason
    // every other column here does.
    ...MICRONUTRIENT_GOAL_FIELDS.map(([goalField]) => goalField),
    "updated_at",
    "timezone",
] as const;

/**
 * Build goals.csv. A null record still emits the header row: every archive
 * contains all six files with all their headers, so whatever reads it can map
 * columns without first discovering which files happen to exist this time.
 */
export function buildGoalsCsv(
    goals: NutritionGoals | null,
    tz: string,
): string {
    const rows = [GOALS_CSV_COLUMNS.join(",")];
    if (goals) {
        rows.push(
            [
                csvEscape(goals.daily_calories),
                csvEscape(goals.daily_protein_g),
                csvEscape(goals.daily_carbs_g),
                csvEscape(goals.daily_fat_g),
                csvEscape(goals.daily_fiber_g),
                csvEscape(goals.daily_sugar_g),
                csvEscape(goals.daily_alcohol_g),
                csvEscape(goals.daily_caffeine_mg),
                csvEscape(goals.daily_water_ml),
                csvEscape(goals.target_weight_g),
                // Same list, same order as the header above — the parallel
                // arrays stay aligned because neither is hand-written.
                ...MICRONUTRIENT_GOAL_FIELDS.map(([goalField]) =>
                    csvEscape(goals[goalField]),
                ),
                csvEscape(formatLocalDateTime(goals.updated_at, tz)),
                csvEscape(tz),
            ].join(","),
        );
    }
    return rows.join("\n");
}

/**
 * Column order for profile.csv. Parallel array with the row builder below.
 */
const PROFILE_CSV_COLUMNS = [
    "timezone",
    "preferred_weight_unit",
    "preferred_drink_unit",
    "alcohol_tracking_enabled",
    "widgets_enabled",
    "created_at",
    "updated_at",
] as const;

/**
 * Build profile.csv. Header-only when the account has no profile row.
 *
 * The `timezone` column carries `tz` — the zone `created_at`/`updated_at` are
 * rendered in — rather than the raw `profile.timezone` column. The two differ
 * only when the user never ran set_timezone, and in that case "UTC" is both
 * what the timestamps here are expressed in and what every read path in the
 * server already assumes. README.txt is where the archive says whether that UTC
 * was chosen or defaulted; a bare empty cell here would leave the two
 * timestamps beside it with no zone at all.
 */
export function buildProfileCsv(profile: Profile | null, tz: string): string {
    const rows = [PROFILE_CSV_COLUMNS.join(",")];
    if (profile) {
        rows.push(
            [
                csvEscape(tz),
                csvEscape(profile.preferred_weight_unit),
                csvEscape(profile.preferred_drink_unit),
                csvEscape(profile.alcohol_tracking_enabled),
                csvEscape(profile.widgets_enabled),
                csvEscape(formatLocalDateTime(profile.created_at, tz)),
                csvEscape(formatLocalDateTime(profile.updated_at, tz)),
            ].join(","),
        );
    }
    return rows.join("\n");
}

/**
 * The archive's contents, in order. Exported so callers that describe the
 * export to a human — the tool's response text, the site copy and its test —
 * pin their claim to this list instead of restating it and drifting from it.
 */
export const EXPORT_ARCHIVE_FILES = [
    "meals.csv",
    "water.csv",
    "weight.csv",
    "goals.csv",
    "profile.csv",
    "README.txt",
] as const;

type ExportArchiveFile = (typeof EXPORT_ARCHIVE_FILES)[number];

/**
 * The plain-text README shipped inside the archive. It is the first thing a
 * human opens, so it answers the questions the CSVs cannot: which zone the wall
 * clocks are in and whether that zone was actually chosen, which columns are in
 * milligrams rather than grams, and which of these files can be fed back in.
 */
export function buildExportReadme(opts: {
    generatedAt: Date;
    tz: string;
    tzConfigured: boolean;
    weightUnit: WeightUnit;
    counts: { meals: number; water: number; weight: number };
}): string {
    const { generatedAt, tz, tzConfigured, weightUnit, counts } = opts;
    const rows = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

    // Stated outright rather than left to inference: an unconfigured timezone
    // silently means UTC everywhere in this server, and someone reading their
    // own wall clocks back needs to know whether the times they are looking at
    // are theirs or UTC's before they interpret a single one of them.
    const tzNote = tzConfigured
        ? `Every timestamp in this archive is a local wall clock in ${tz}, the timezone set on your account. Each file repeats it in a "timezone" column so no file has to be read next to this one.`
        : `No timezone has ever been set on this account, so every timestamp in this archive is expressed in UTC (that is also what the server assumes when it buckets your days). Set one with set_timezone and export again if you want your own wall clock. Each file repeats the zone in a "timezone" column.`;

    return [
        "Nutrition MCP — full data export",
        "================================",
        "",
        `Generated ${formatLocalDateTime(generatedAt, tz)} (${tz}).`,
        "",
        tzNote,
        "",
        "Files",
        "-----",
        `meals.csv    ${rows(counts.meals)} — every meal you have logged: time, description, calories, macros and micronutrients.`,
        `water.csv    ${rows(counts.water)} — every water entry, in millilitres.`,
        `weight.csv   ${rows(counts.weight)} — every weigh-in, as stored grams and as ${weightUnit}.`,
        "goals.csv    your current daily targets — one row, or a header alone if you have never set goals.",
        "profile.csv  your settings: timezone, preferred units, and display toggles — one row, or a header alone if you have no profile yet.",
        "README.txt   this file.",
        "",
        "Units",
        "-----",
        "The unit is part of every column name, because these columns do not all agree:",
        "  * _g columns are grams; alcohol_g and daily_alcohol_g are grams of pure ethanol, not the volume of the drink.",
        "  * caffeine_mg and daily_caffeine_mg are MILLIGRAMS, unlike every gram column beside them. A cup of coffee is about 95 mg.",
        "  * sodium_mg, potassium_mg, cholesterol_mg, calcium_mg, iron_mg, magnesium_mg and vitamin_c_mg are MILLIGRAMS; vitamin_a_mcg (micrograms RAE) and vitamin_d_mcg are MICROGRAMS — a thousandth of a milligram.",
        "  * saturated_fat_g, trans_fat_g and added_sugar_g are grams. added_sugar_g is its own figure, not part of sugar_g and not subtracted from it: sugar_g is TOTAL sugars, including what is naturally in fruit and milk.",
        "  * amount_ml and daily_water_ml are millilitres.",
        `  * weight_g and target_weight_g are grams — the canonical form the server stores. weight.csv also gives weight_display in ${weightUnit}, with weight_unit naming it, so you do not have to divide anything by hand.`,
        "  * calories are kcal.",
        "An empty cell means nothing was ever recorded there. It does not mean zero — a meal logged before caffeine tracking existed has an empty caffeine_mg, not a 0.",
        "",
        "Where the numbers came from",
        "---------------------------",
        "nutrient_provenance holds one JSON object per meal, keyed by nutrient, saying where that nutrient's value came from and how much to trust it — for example:",
        '  {"sodium_mg":{"source":"usda_fdc","source_id":"fdc:173410","confidence":"authoritative"}}',
        "source is one of nutrition_label, open_food_facts, usda_fdc, restaurant_published, user_provided, import or model_estimate; confidence is authoritative, user_provided or estimated. It is per nutrient, not per meal: one meal can hold a barcode-scanned figure beside an estimated one. The cell is empty when nothing was recorded, and it survives an export and re-import unchanged.",
        "",
        "Re-importing",
        "------------",
        "Only meals.csv can be read back in. Hand it to start_meal_import (which parses it in your browser) or to bulk_import_meals; its column names are exactly the ones the importer expects, and re-importing the same file twice is a no-op rather than a set of duplicates.",
        "water.csv, weight.csv, goals.csv and profile.csv are export-only for now — there is no import path for them, so keep this archive if you want that history back.",
        "",
    ].join("\n");
}

export interface FullExportResult {
    counts: { meals: number; water: number; weight: number };
    goals: boolean;
    profile: boolean;
    /** Absent only when the account has nothing at all to export. */
    url?: string;
}

/**
 * Build the whole-account archive — every log, the goals and the profile —
 * upload it to the private `exports` bucket under a fixed per-user path (so
 * each export overwrites the previous one), and return a signed download link
 * valid for EXPORT_TTL_SECONDS. This is the only export path: a meals-only CSV
 * tool used to sit beside it, and the archive absorbed it, which is why
 * `buildMealsCsv` still emits exactly the columns the importer reads.
 */
export async function exportAllData(userId: string): Promise<FullExportResult> {
    // One round of five independent queries rather than five awaited in turn:
    // an account with years of history pages through meals, water and weight,
    // and serialising those pushes the tool past the point where a host gives
    // up on it.
    const [meals, water, weight, goals, profile] = await Promise.all([
        getAllMeals(userId),
        getAllWater(userId),
        getAllWeight(userId),
        getNutritionGoals(userId),
        getProfile(userId),
    ]);

    const counts = {
        meals: meals.length,
        water: water.length,
        weight: weight.length,
    };

    // Both preferences come off the profile row already in hand. The
    // getUserTimezone / getPreferredWeightUnit wrappers each run their own
    // `select * from profiles` (src/supabase.ts says so explicitly), so calling
    // them here would repeat an identical query twice for no new information.
    const configuredTz = timezoneFromProfile(profile);
    const tz = configuredTz ?? "UTC";
    // Display path: coalesce a never-chosen preference to kg rather than
    // refusing, the way pickWriteUnit does for writes. weight_g is beside it
    // and is unambiguous, so a wrong guess here is cosmetic, not lossy.
    const weightUnit: WeightUnit = isWeightUnit(profile?.preferred_weight_unit)
        ? profile.preferred_weight_unit
        : "kg";

    // Nothing logged, no goals and no profile row at all: hand back empty
    // counts and no link rather than uploading six headers and a README. Any
    // data whatsoever — including a lone profile row — produces the full
    // six-file archive, so the shape never depends on which tables were empty.
    if (
        counts.meals === 0 &&
        counts.water === 0 &&
        counts.weight === 0 &&
        !goals &&
        !profile
    ) {
        return { counts, goals: false, profile: false };
    }

    const generatedAt = new Date();
    // Keyed by the exported constant, so a file added to the archive without
    // being named in EXPORT_ARCHIVE_FILES (or the reverse) is a type error
    // rather than a README that describes an archive nobody ships.
    const contents: Record<ExportArchiveFile, string> = {
        // The one re-importable file in the archive, and the reason
        // buildMealsCsv is still its own builder: its headers are the
        // importer's column aliases, so a column renamed for the look of it
        // here breaks a re-import silently.
        "meals.csv": buildMealsCsv(meals, tz),
        "water.csv": buildWaterCsv(water, tz),
        "weight.csv": buildWeightCsv(weight, tz, weightUnit),
        "goals.csv": buildGoalsCsv(goals, tz),
        "profile.csv": buildProfileCsv(profile, tz),
        "README.txt": buildExportReadme({
            generatedAt,
            tz,
            tzConfigured: configuredTz !== null,
            weightUnit,
            counts,
        }),
    };
    const entries: ZipEntry[] = EXPORT_ARCHIVE_FILES.map((name) => ({
        name,
        data: contents[name],
    }));
    const archive = buildZip(entries, generatedAt);

    // Fixed per-user path: each export overwrites the last, so a user cannot
    // accumulate archives of their whole history in a bucket the sweep only
    // visits every ten minutes. Shared with deleteAllUserData rather than
    // spelled out twice — the two drifting apart is how a deleted account left
    // its archive behind.
    const path = exportArchivePath(userId);
    const storage = getSupabase().storage.from(EXPORT_BUCKET);

    const { error: uploadErr } = await storage.upload(path, archive, {
        contentType: "application/zip",
        upsert: true,
    });
    if (uploadErr)
        throw new Error(`Failed to upload export: ${uploadErr.message}`);

    const { data, error: signErr } = await storage.createSignedUrl(
        path,
        EXPORT_TTL_SECONDS,
    );
    if (signErr || !data)
        throw new Error(
            `Failed to create download link: ${signErr?.message ?? "unknown error"}`,
        );

    return {
        counts,
        goals: goals !== null,
        profile: profile !== null,
        url: data.signedUrl,
    };
}

/**
 * Delete export files older than the link TTL. Runs as a background sweep so no
 * export file outlives its signed URL by more than one sweep interval, even
 * across server restarts and for users who never export again.
 */
export async function sweepStaleExports(): Promise<void> {
    const storage = getSupabase().storage.from(EXPORT_BUCKET);
    const cutoff = Date.now() - EXPORT_TTL_SECONDS * 1000;

    // Files live under per-user folders, so list the root to enumerate folders,
    // then list each folder to reach the files (with their timestamps).
    const { data: folders, error: rootErr } = await storage.list("", {
        limit: 1000,
    });
    if (rootErr) {
        console.warn("Export sweep: failed to list bucket:", rootErr.message);
        return;
    }
    if (!folders) return;

    const stalePaths: string[] = [];
    for (const folder of folders) {
        const { data: files, error: listErr } = await storage.list(
            folder.name,
            { limit: 1000 },
        );
        if (listErr) {
            console.warn(
                `Export sweep: failed to list ${folder.name}:`,
                listErr.message,
            );
            continue;
        }
        for (const file of files ?? []) {
            const ts = file.updated_at ?? file.created_at;
            if (ts && new Date(ts).getTime() < cutoff) {
                stalePaths.push(`${folder.name}/${file.name}`);
            }
        }
    }

    if (stalePaths.length === 0) return;
    const { error: removeErr } = await storage.remove(stalePaths);
    if (removeErr) {
        console.warn(
            "Export sweep: failed to remove files:",
            removeErr.message,
        );
        return;
    }
    console.log(`Export sweep: removed ${stalePaths.length} stale file(s).`);
}

let sweepRunning = false;

/** Start the periodic export-cleanup sweep. Call once at server startup. */
export function startExportCleanup(): void {
    setInterval(() => {
        if (sweepRunning) return;
        sweepRunning = true;
        sweepStaleExports().finally(() => {
            sweepRunning = false;
        });
    }, SWEEP_INTERVAL_MS);
}
