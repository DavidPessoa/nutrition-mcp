import { test, expect } from "bun:test";
import type { MealInput } from "./supabase.js";
import { runImport } from "./import.js";
import {
    parseCsv,
    decodeBytes,
    stripBom,
    sniffDelimiter,
    sniffDecimalSeparator,
    normalizeHeader,
    parseNumber,
    splitAmount,
    findColumn,
    isBlankCell,
    isTotalsRow,
    isDeletedRow,
} from "./csv.js";

// ---------- RFC 4180 core ----------

test("parses quoted fields containing delimiters, quotes and newlines", () => {
    // The case that forbids splitting on newlines first: a note column with an
    // embedded newline, which MyFitnessPal and Cronometer both emit.
    const csv = [
        "Date,Food,Note",
        '2026-01-15,"Rice, cooked","line one',
        'line two"',
        '2026-01-16,"He said ""hi""",plain',
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.headers).toEqual(["Date", "Food", "Note"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual([
        "2026-01-15",
        "Rice, cooked",
        "line one\nline two",
    ]);
    expect(t.rows[1]).toEqual(["2026-01-16", 'He said "hi"', "plain"]);
});

test("source line numbers survive a quoted newline", () => {
    // The row after a multi-line field must report its real file line, or
    // source_line provenance silently drifts for the rest of the file.
    const csv = [
        "Date,Note", // line 1
        '2026-01-15,"a', // line 2
        'b"', // line 3
        "2026-01-16,plain", // line 4
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.sourceLines).toEqual([2, 4]);
});

test("handles CRLF without leaving carriage returns in the last cell", () => {
    // Untreated, "120\r" makes Number() return NaN and "snack\r" fails to match
    // any meal type — a silently-wrong import rather than a loud failure.
    const t = parseCsv("Date,Meal,Calories\r\n2026-01-15,snack,120\r\n");
    expect(t.rows[0]).toEqual(["2026-01-15", "snack", "120"]);
    expect(parseNumber(t.rows[0]![2])).toBe(120);
});

test("handles a final row with no trailing newline", () => {
    const t = parseCsv("A,B\n1,2");
    expect(t.rows).toEqual([["1", "2"]]);
});

test("skips blank rows and trailing blank lines", () => {
    const t = parseCsv("A,B\n1,2\n\n3,4\n\n\n");
    expect(t.rows).toEqual([
        ["1", "2"],
        ["3", "4"],
    ]);
    expect(t.skippedBlankRows).toBe(3);
});

test("pads ragged rows and warns", () => {
    const t = parseCsv("A,B,C\n1,2\n1,2,3,4");
    expect(t.rows[0]).toEqual(["1", "2", ""]);
    expect(t.rows[1]).toEqual(["1", "2", "3"]);
    expect(t.warnings.some((w) => /different number of columns/.test(w))).toBe(
        true,
    );
});

test("an empty or header-only file yields no rows", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("").warnings.some((w) => /no data/.test(w))).toBe(true);
    expect(parseCsv("A,B\n").rows).toEqual([]);
});

// ---------- encoding ----------

test("decodeBytes honours the BOM, including UTF-16", () => {
    const utf8 = new TextEncoder().encode("Fat");
    expect(decodeBytes(utf8)).toEqual({ text: "Fat", encoding: "utf-8" });

    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
    const decodedBom = decodeBytes(withBom);
    expect(decodedBom.text).toBe("Fat");
    expect(decodedBom.encoding).toBe("utf-8-bom");

    // "Hi" little-endian, then big-endian. Decoded as UTF-8 these would be
    // NUL-interleaved gibberish that still "parses".
    const le = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(decodeBytes(le)).toEqual({ text: "Hi", encoding: "utf-16le" });
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
    expect(decodeBytes(be)).toEqual({ text: "Hi", encoding: "utf-16be" });
});

test("a UTF-8 BOM does not become part of the first header name", () => {
    // MyFitnessPal exports carry one; unstripped, the first column is named
    // "﻿Date" and never matches a "date" alias.
    const bytes = new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode("Date,Meal\n2026-01-15,snack\n"),
    ]);
    const t = parseCsv(bytes);
    expect(t.headers[0]).toBe("Date");
    expect(findColumn(t.headers, ["date"])).toBe(0);
});

test("stripBom only removes a leading BOM", () => {
    expect(stripBom("﻿A")).toBe("A");
    expect(stripBom("A﻿B")).toBe("A﻿B");
});

// ---------- delimiter and decimal sniffing ----------

test("sniffs a semicolon delimiter even when text fields contain commas", () => {
    // European Excel locale. Counting commas naively would pick "," and produce
    // one giant mis-split column.
    const csv = [
        "Datum;Mahlzeit;Kalorien",
        "2026-01-15;Reis, gekocht;120",
        "2026-01-16;Brot, dunkel;240",
    ].join("\n");
    expect(sniffDelimiter(csv)).toBe(";");

    const t = parseCsv(csv);
    expect(t.delimiter).toBe(";");
    expect(t.rows[0]).toEqual(["2026-01-15", "Reis, gekocht", "120"]);
});

test("sniffs tab-delimited files", () => {
    const t = parseCsv("A\tB\n1\t2");
    expect(t.delimiter).toBe("\t");
    expect(t.rows[0]).toEqual(["1", "2"]);
});

test("detects a comma decimal separator and parses it correctly", () => {
    // The 1000x error: 62,5 g of fat read as 625 g still validates.
    const csv = [
        "Datum;Fett;Protein",
        "2026-01-15;62,5;120,25",
        "2026-01-16;58,0;110,5",
    ].join("\n");
    const t = parseCsv(csv);
    expect(t.decimalSeparator).toBe(",");
    expect(parseNumber(t.rows[0]![1], t.decimalSeparator)).toBe(62.5);
    expect(parseNumber(t.rows[0]![2], t.decimalSeparator)).toBe(120.25);

    // A comma-delimited file never uses a comma decimal.
    expect(sniffDecimalSeparator([["1,5"]], ",")).toBe(".");
});

// ---------- numbers and cells ----------

test("parseNumber distinguishes absent from zero", () => {
    // MyFitnessPal writes 0.0 for untracked nutrients, but an EMPTY cell must
    // stay absent rather than being recorded as a real zero.
    expect(parseNumber("")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber("n/a")).toBeNull(); // Lose It!
    expect(parseNumber("N/A")).toBeNull();
    expect(parseNumber("-")).toBeNull();
    expect(parseNumber("0")).toBe(0);
    expect(parseNumber("0.0")).toBe(0);
});

test("parseNumber strips units and thousands separators", () => {
    expect(parseNumber("120 kcal")).toBe(120);
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("2.5g")).toBe(2.5);
    expect(parseNumber("-3.5")).toBe(-3.5);
    expect(parseNumber("1.234,5", ",")).toBe(1234.5);
    expect(parseNumber("abc")).toBeNull();
});

test("isBlankCell recognises the tokens real exports use", () => {
    for (const v of ["", "  ", "n/a", "N/A", "na", "-", "--", "null", "none"]) {
        expect(isBlankCell(v)).toBe(true);
    }
    expect(isBlankCell("0")).toBe(false);
    expect(isBlankCell("Oatmeal")).toBe(false);
});

test("splitAmount unpacks Cronometer's value-plus-unit cell", () => {
    expect(splitAmount("58.00 g")).toEqual({ value: 58, unit: "g" });
    expect(splitAmount("1.00 cup")).toEqual({ value: 1, unit: "cup" });
    expect(splitAmount('2 medium (7" long)')).toEqual({
        value: 2,
        unit: 'medium (7" long)',
    });
    expect(splitAmount("120")).toEqual({ value: 120, unit: null });
    expect(splitAmount("")).toEqual({ value: null, unit: null });
    expect(splitAmount("58,00 g", ",")).toEqual({ value: 58, unit: "g" });
});

// ---------- headers ----------

test("normalizeHeader folds unit suffixes and the micro sign", () => {
    expect(normalizeHeader("Fat (g)")).toBe("fat_g");
    expect(normalizeHeader("fat_g")).toBe("fat_g");
    expect(normalizeHeader("  FAT  ")).toBe("fat");
    expect(normalizeHeader("Energy (kcal)")).toBe("energy_kcal");
    // Greek mu and the micro sign both fold to u, so ug and µg match.
    expect(normalizeHeader("B12 (µg)")).toBe(normalizeHeader("B12 (ug)"));
    expect(normalizeHeader("B12 (μg)")).toBe(normalizeHeader("B12 (ug)"));
});

test("duplicate header names are kept positional and warned about", () => {
    // Cronometer repeats "Amount". Keying data by name would silently drop one.
    const t = parseCsv("Food,Amount,Amount\nRice,58.00 g,1 cup");
    expect(t.headers).toEqual(["Food", "Amount", "Amount"]);
    expect(t.rows[0]).toEqual(["Rice", "58.00 g", "1 cup"]);
    expect(t.warnings.some((w) => /Duplicate column/.test(w))).toBe(true);
    // findColumn returns the FIRST match; callers wanting the second use index.
    expect(findColumn(t.headers, ["amount"])).toBe(1);
});

test("findColumn matches across alias spellings and reports absence", () => {
    const headers = ["Date", "Meal", "Carbohydrates (g)", "Protein (g)"];
    expect(findColumn(headers, ["carbs_g", "carbohydrates_g"])).toBe(2);
    expect(findColumn(headers, ["protein", "protein_g"])).toBe(3);
    expect(findColumn(headers, ["fat_g"])).toBe(-1);
});

// ---------- aggregate and deleted rows ----------

test("totals rows are excluded rather than imported as a phantom meal", () => {
    // A MyFitnessPal daily export ends with one; imported, it doubles the day.
    const csv = [
        "Date,Meal,Calories",
        "2026-01-15,Breakfast,300",
        "2026-01-15,Lunch,700",
        "Totals,,1000",
    ].join("\n");
    const t = parseCsv(csv);
    expect(t.rows).toHaveLength(2);
    expect(t.skippedTotalsRows).toBe(1);
    expect(t.warnings.some((w) => /totals\/average row/.test(w))).toBe(true);

    // Recoverable when a caller genuinely wants them.
    expect(parseCsv(csv, { keepTotalsRows: true }).rows).toHaveLength(3);
});

test("isTotalsRow does not fire on a food that merely starts with the word", () => {
    expect(isTotalsRow(["Total", "", "1000"])).toBe(true);
    expect(isTotalsRow(["Totals:", "", "1000"])).toBe(true);
    expect(isTotalsRow(["Average", "", "900"])).toBe(true);
    expect(isTotalsRow(["Total Cereal, 1 cup", "", "120"])).toBe(false);
    expect(isTotalsRow(["", "", ""])).toBe(false);
});

test("isDeletedRow reads a Lose It! style Deleted column", () => {
    // Importing deleted rows resurrects food the user removed on purpose, and no
    // control total would catch it.
    const t = parseCsv(
        "Date,Name,Deleted,Calories\n2026-01-15,Apple,false,95\n2026-01-15,Cake,true,400",
    );
    const del = findColumn(t.headers, ["deleted"]);
    expect(del).toBe(2);
    expect(isDeletedRow(t.rows[0]!, del)).toBe(false);
    expect(isDeletedRow(t.rows[1]!, del)).toBe(true);
    // No such column: nothing is deleted.
    expect(isDeletedRow(t.rows[0]!, -1)).toBe(false);
});

// ---------- realistic export shapes ----------

test("parses a MyFitnessPal-shaped export (meal-level rows, BOM, CRLF)", () => {
    const body =
        "Date,Meal,Calories,Fat (g),Saturated Fat,Carbohydrates (g),Protein (g),Note\r\n" +
        "2026-01-15,Breakfast,300,8,2,45,12,\r\n" +
        "2026-01-15,Lunch,700,20,6,80,35,busy day\r\n" +
        "Totals,,1000,28,8,125,47,\r\n";
    const bytes = new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(body),
    ]);

    const t = parseCsv(bytes);
    expect(t.encoding).toBe("utf-8-bom");
    expect(t.delimiter).toBe(",");
    expect(t.rows).toHaveLength(2);
    expect(t.skippedTotalsRows).toBe(1);
    // No Food column at all — the aggregation-level problem, visible here.
    expect(findColumn(t.headers, ["food", "food_name"])).toBe(-1);
    expect(findColumn(t.headers, ["meal"])).toBe(1);
    expect(parseNumber(t.rows[1]![2])).toBe(700);
});

test("parses a Cronometer-shaped export (Day/Time, packed Amount, dup columns)", () => {
    const csv = [
        "Day,Time,Group,Food Name,Amount,Energy (kcal),Carbs (g),Fat (g),B12 (µg),Category",
        '2026-01-15,9:15 AM,Breakfast,"Oats, rolled",58.00 g,220,37.5,4.1,0.00,Cereal Grains',
        '2026-01-15,1:00 PM,Lunch,"Chicken breast, roasted",120.00 g,198,0,4.3,0.30,Poultry',
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.rows).toHaveLength(2);
    expect(findColumn(t.headers, ["day", "date"])).toBe(0);
    expect(findColumn(t.headers, ["food_name"])).toBe(3);
    expect(splitAmount(t.rows[0]![4])).toEqual({ value: 58, unit: "g" });
    expect(t.rows[0]![3]).toBe("Oats, rolled");
    // The micro sign in the header still matches a plain-ASCII alias.
    expect(findColumn(t.headers, ["b12_ug"])).toBe(8);
});

test("parses a Lose It!-shaped export (MM/DD/YYYY, n/a, Deleted)", () => {
    const csv = [
        "Date,Name,Icon,Type,Quantity,Units,Calories,Deleted,Fat (g),Protein (g)",
        "01/15/2026,Apple,fruit,Snacks,1,Fruit,95,false,0.3,0.5",
        "01/15/2026,Cake,dessert,Snacks,1,Slice,400,true,18,4",
        "01/16/2026,Oatmeal,grain,Breakfast,1,Cup,150,false,n/a,5",
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.rows).toHaveLength(3);
    const del = findColumn(t.headers, ["deleted"]);
    const kept = t.rows.filter((r) => !isDeletedRow(r, del));
    expect(kept).toHaveLength(2);
    // "n/a" is absent, not zero.
    const fat = findColumn(t.headers, ["fat_g"]);
    expect(parseNumber(kept[1]![fat])).toBeNull();
    // The date format is ambiguous here; that is resolveLoggedAt's problem, but
    // the parser must hand it over untouched rather than guessing.
    expect(kept[0]![0]).toBe("01/15/2026");
});

test("parses a MacroFactor-shaped export whose header contains a comma", () => {
    // "B12, Cobalamin (mcg)" is a single quoted header; a naive split makes
    // every subsequent column off by one.
    const csv = [
        'Date,Time,Food Name,Serving Size,Calories (kcal),"B12, Cobalamin (mcg)",Protein (g)',
        "2026-01-15,08:30,Yogurt,1 cup,150,1.2,12",
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.headers).toHaveLength(7);
    expect(t.headers[5]).toBe("B12, Cobalamin (mcg)");
    expect(findColumn(t.headers, ["protein_g"])).toBe(6);
    expect(t.rows[0]).toEqual([
        "2026-01-15",
        "08:30",
        "Yogurt",
        "1 cup",
        "150",
        "1.2",
        "12",
    ]);
});

test("a parsed export feeds straight into runImport", async () => {
    // The integration that matters: everything the widget will do client-side
    // (parse, map columns, build rows) followed by the server-side import. Proves
    // the two modules actually compose, including the local-wall-clock handoff.
    const csv = [
        "id,logged_at,timezone,meal_type,description,calories,protein_g,carbs_g,fat_g,notes",
        "abc-1,2026-01-15 08:30:00,Europe/Kyiv,breakfast,Oatmeal,300,12,45,8,",
        'abc-2,2026-01-15 13:00:00,Europe/Kyiv,lunch,"Rice, cooked",400,10,80,2,tasty',
        "abc-3,2026-01-16 19:00:00,Europe/Kyiv,dinner,Soup,250,8,30,6,",
    ].join("\n");

    const t = parseCsv(csv);
    const col = {
        logged_at: findColumn(t.headers, ["logged_at"]),
        meal_type: findColumn(t.headers, ["meal_type"]),
        description: findColumn(t.headers, ["description"]),
        calories: findColumn(t.headers, ["calories"]),
        protein_g: findColumn(t.headers, ["protein_g"]),
        carbs_g: findColumn(t.headers, ["carbs_g"]),
        fat_g: findColumn(t.headers, ["fat_g"]),
        notes: findColumn(t.headers, ["notes"]),
    };

    const num = (row: string[], i: number) => {
        const v = parseNumber(row[i], t.decimalSeparator);
        return v === null ? undefined : v;
    };
    const str = (row: string[], i: number) =>
        isBlankCell(row[i]) ? undefined : row[i]!.trim();

    const meals = t.rows.map((row, i) => ({
        source_line: t.sourceLines[i]!,
        logged_at: str(row, col.logged_at),
        meal_type: str(row, col.meal_type),
        description: str(row, col.description),
        calories: num(row, col.calories),
        protein_g: num(row, col.protein_g),
        carbs_g: num(row, col.carbs_g),
        fat_g: num(row, col.fat_g),
        notes: str(row, col.notes),
    }));

    // Control totals computed from the PARSED source, which is what the tool
    // description demands (and what the widget will do).
    const expectedKcal = meals.reduce((a, m) => a + (m.calories ?? 0), 0);

    const inserted: MealInput[] = [];
    const result = await runImport(
        {
            meals,
            expected_row_count: meals.length,
            expected_total_kcal: expectedKcal,
        },
        {
            userId: "user-1",
            tz: "Europe/Kyiv",
            nowMs: Date.parse("2026-07-25T12:00:00Z"),
            async insert(input) {
                inserted.push(input);
                return {
                    meal: { id: `m${inserted.length}`, ...input } as never,
                    deduplicated: false,
                };
            },
            async existingKeys() {
                return new Set<string>();
            },
        },
    );

    expect(result.status).toBe("success");
    expect(result.summary.created).toBe(3);
    expect(result.summary.failed).toBe(0);
    // Local wall clock resolved in the profile timezone: Kyiv is +02:00 in
    // January, so 08:30 local is 06:30Z — no client-side offset math anywhere.
    expect(inserted[0]!.logged_at).toBe("2026-01-15T06:30:00.000Z");
    expect(inserted[2]!.logged_at).toBe("2026-01-16T17:00:00.000Z");
    expect(inserted[1]!.description).toBe("Rice, cooked");
    expect(inserted[1]!.notes).toBe("tasty");
    // Provenance: real times, so nothing was inferred or synthesized.
    expect(result.results.every((r) => !r.logged_at_from_bare_date)).toBe(true);
    expect(result.results.every((r) => !r.meal_type_inferred)).toBe(true);
    expect(t.sourceLines).toEqual([2, 3, 4]);
});

test("parses the server's own export format round-trip", () => {
    // src/export.ts writes: id, logged_at (local wall clock), timezone, ...
    const csv = [
        "id,logged_at,timezone,meal_type,description,calories,protein_g,carbs_g,fat_g,notes",
        "abc-1,2026-01-15 08:30:00,Europe/Kyiv,breakfast,Oatmeal,300,12,45,8,",
        'abc-2,2026-01-15 13:00:00,Europe/Kyiv,lunch,"Rice, cooked",400,10,80,2,tasty',
    ].join("\n");

    const t = parseCsv(csv);
    expect(t.rows).toHaveLength(2);
    expect(findColumn(t.headers, ["logged_at"])).toBe(1);
    expect(findColumn(t.headers, ["description"])).toBe(4);
    expect(t.rows[1]![4]).toBe("Rice, cooked");
    // The wall-clock form is exactly what resolveLoggedAt's local-time branch
    // accepts, so an export re-imports without offset math.
    expect(t.rows[0]![1]).toBe("2026-01-15 08:30:00");
});
