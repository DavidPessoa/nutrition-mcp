// Map one of THIS server's own `meals.csv` exports back into importer rows.
//
// The export's headers are deliberately the importer's column aliases (see
// buildMealsCsv in src/export.ts), so the way back in is mechanical — but it is
// only mechanical if exactly one piece of code does it. This used to live in
// src/import.test.ts, where the round-trip test needed it; the release
// validation in scripts/e2e-nutrients.ts needs the same mapping, and a second
// hand-written copy would let the two disagree about a file while both passed.
//
// It is NOT the import widget's mapper. The widget maps a FOREIGN export, with
// the user choosing columns on screen, and it resolves headers through the same
// two src/csv.ts functions used below — which is what keeps the browser path and
// the model path from disagreeing. This module is the narrow case where the file
// is known to be ours.
//
// Deliberately its own module rather than part of src/csv.ts: csv.ts is
// transpiled INTO the widgets via `/*@inlinets src/csv.ts@*/`, so everything
// added there ships to every widget that inlines it, and no widget needs this.

import {
    findColumn,
    findNutrientColumns,
    parseCsv,
    parseNumber,
    readNutrientCells,
} from "./csv.js";
import type { ImportRow } from "./import.js";

export function mapExportCsvToRows(text: string): ImportRow[] {
    const table = parseCsv(text);
    const H = table.headers;
    const col = (...aliases: string[]) => findColumn(H, aliases);
    const idC = col("id");
    const atC = col("logged_at", "date");
    const tzC = col("timezone");
    const typeC = col("meal_type", "meal");
    const descC = col("description", "food");
    const notesC = col("notes", "note");
    const provC = col("nutrient_provenance");
    const macroC: Record<string, number> = {
        calories: col("calories"),
        protein_g: col("protein_g", "protein"),
        carbs_g: col("carbs_g", "carbohydrates_g", "carbs"),
        fat_g: col("fat_g"),
        fiber_g: col("fiber_g", "fiber"),
        sugar_g: col("sugar_g", "sugar"),
        alcohol_g: col("alcohol_g", "alcohol"),
        caffeine_mg: col("caffeine_mg", "caffeine"),
    };
    // Micronutrient columns are found by resolving the HEADER, not by a fixed
    // list, so a unit-qualified or foreign-language header maps itself.
    const microC = findNutrientColumns(H);

    const cell = (r: string[], i: number) => (i < 0 ? undefined : r[i]);
    return table.rows.map((r, n) => {
        const out: Record<string, unknown> = {
            source_line: table.sourceLines[n] ?? n + 2,
        };
        const put = (k: string, v: unknown) => {
            if (v !== undefined && v !== "") out[k] = v;
        };
        put("source_id", cell(r, idC));
        put("logged_at", cell(r, atC));
        put("timezone", cell(r, tzC));
        put("meal_type", cell(r, typeC));
        put("description", cell(r, descC));
        put("notes", cell(r, notesC));
        put("nutrient_provenance", cell(r, provC));
        for (const [field, i] of Object.entries(macroC)) {
            const v = parseNumber(cell(r, i));
            if (v !== null) out[field] = v;
        }
        // A blank cell is an explicit "not recorded" — null, never 0 and never
        // dropped; an IU / %DV column is refused rather than guessed.
        const micro = readNutrientCells(r, microC, table.decimalSeparator);
        Object.assign(out, micro.values);
        if (Object.keys(micro.units).length > 0)
            out.nutrient_units = micro.units;
        return out as unknown as ImportRow;
    });
}
