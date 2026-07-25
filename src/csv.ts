// CSV parsing for bulk meal import.
//
// Lives here rather than inline in the widget template so it can be unit-tested
// against real export quirks: a parser facing arbitrary user files is the
// riskiest part of the import, and inline template JS is only ever checked for
// syntactic validity (src/widgets.test.ts). The widget inlines the compiled
// output via an @include partial.
//
// Written as a character-level state machine because line-splitting first is
// wrong: MyFitnessPal and Cronometer both emit note columns containing quoted
// newlines, so "split on newline" corrupts those rows and every row after them.
//
// Quirks handled, each observed in a real export:
//   - UTF-8 BOM (MyFitnessPal) and UTF-16 LE/BE (some Excel "save as" paths)
//   - CRLF line endings (any Windows Excel export)
//   - quoted fields containing the delimiter, quotes ("" escape), or newlines
//   - ; delimiter with , as the decimal separator (European Excel locale)
//   - duplicate header names (Cronometer repeats "Amount") -> columns are keyed
//     by INDEX; header text is a label only
//   - blank-ish cells: empty, "n/a" (Lose It!), "-", "null"
//   - trailing blank lines and interior blank rows
//   - totals / subtotal rows (MyFitnessPal daily exports end with one)

/** Values real exports use to mean "no value". */
const BLANK_TOKENS = new Set(["", "-", "--", "n/a", "na", "null", "none"]);

/** Leading words that mark an aggregate row rather than a food row. */
const TOTALS_ROW_PREFIXES = [
    "total",
    "totals",
    "daily total",
    "grand total",
    "subtotal",
    "sub-total",
    "average",
    "averages",
];

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];
export type DecimalSeparator = "." | ",";

export interface ParsedTable {
    /** Header labels by column index. May contain duplicates or empties. */
    headers: string[];
    /** Data rows, each padded/truncated to headers.length. */
    rows: string[][];
    /** 1-based line number in the ORIGINAL text for each row in `rows`. */
    sourceLines: number[];
    delimiter: Delimiter;
    decimalSeparator: DecimalSeparator;
    encoding: string;
    /** Rows recognised as totals/aggregates and excluded from `rows`. */
    skippedTotalsRows: number;
    /** Blank rows excluded from `rows`. */
    skippedBlankRows: number;
    warnings: string[];
}

// ---------- decoding ----------

/**
 * Decode file bytes to text, honouring the BOM.
 *
 * Necessary because Blob.text() always assumes UTF-8: a UTF-16 export decodes to
 * NUL-interleaved gibberish that then "parses" into garbage rather than failing.
 */
export function decodeBytes(bytes: Uint8Array): {
    text: string;
    encoding: string;
} {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return {
            text: new TextDecoder("utf-16").decode(bytes.subarray(2)),
            encoding: "utf-16le",
        };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        // "utf-16" is the spec alias for little-endian and is the widest-typed
        // name available, so swap the byte pairs and decode as LE.
        const body = bytes.subarray(2);
        const swapped = new Uint8Array(body.length);
        for (let i = 0; i + 1 < body.length; i += 2) {
            swapped[i] = body[i + 1]!;
            swapped[i + 1] = body[i]!;
        }
        return {
            text: new TextDecoder("utf-16").decode(swapped),
            encoding: "utf-16be",
        };
    }
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
    ) {
        return {
            text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
            encoding: "utf-8-bom",
        };
    }
    return {
        text: new TextDecoder("utf-8").decode(bytes),
        encoding: "utf-8",
    };
}

/** Strip a UTF-8 BOM that survived decoding as a character. */
export function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------- sniffing ----------

/**
 * Pick the delimiter by counting candidates OUTSIDE quoted regions on the first
 * few lines and choosing the one with the most consistent per-line count.
 * Counting naively would pick "," for a semicolon-delimited file whose text
 * fields contain commas.
 */
export function sniffDelimiter(text: string): Delimiter {
    const sample = firstLogicalLines(text, 5);
    if (sample.length === 0) return ",";

    let best: Delimiter = ",";
    let bestScore = -1;
    for (const d of CANDIDATE_DELIMITERS) {
        const counts = sample.map((line) => countOutsideQuotes(line, d));
        const first = counts[0]!;
        if (first === 0) continue;
        // Prefer delimiters whose count is identical on every sampled line;
        // break ties by how many columns they produce.
        const consistent = counts.every((c) => c === first);
        const score = (consistent ? 1000 : 0) + first;
        if (score > bestScore) {
            bestScore = score;
            best = d;
        }
    }
    return best;
}

/**
 * Decide whether numbers use a comma decimal separator. Only meaningful when the
 * delimiter is not itself a comma. Getting this wrong scales every macro by
 * 1000x while still producing valid-looking numbers.
 */
export function sniffDecimalSeparator(
    rows: string[][],
    delimiter: Delimiter,
): DecimalSeparator {
    if (delimiter === ",") return ".";
    let commaDecimals = 0;
    let dotDecimals = 0;
    for (const row of rows.slice(0, 50)) {
        for (const cell of row) {
            const v = cell.trim();
            if (/^-?\d+,\d+$/.test(v)) commaDecimals++;
            else if (/^-?\d+\.\d+$/.test(v)) dotDecimals++;
        }
    }
    return commaDecimals > dotDecimals ? "," : ".";
}

/** Count `delimiter` occurrences outside quoted regions. */
function countOutsideQuotes(line: string, delimiter: string): number {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') i++;
            else inQuotes = !inQuotes;
        } else if (ch === delimiter && !inQuotes) {
            count++;
        }
    }
    return count;
}

/** First N logical lines, respecting quoted newlines. */
function firstLogicalLines(text: string, n: number): string[] {
    const out: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < text.length && out.length < n; i++) {
        const ch = text[i]!;
        if (ch === '"') {
            if (inQuotes && text[i + 1] === '"') {
                current += '""';
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            current += ch;
            continue;
        }
        if (!inQuotes && (ch === "\n" || ch === "\r")) {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            out.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    if (out.length < n && current.trim() !== "") out.push(current);
    return out;
}

// ---------- the parser ----------

interface RawRow {
    fields: string[];
    /** 1-based line where the row STARTED in the original text. */
    line: number;
}

/**
 * Tokenize the whole text into rows of fields.
 *
 * Line numbers count physical newlines, so a row containing a quoted newline
 * reports the line it began on and subsequent rows keep the original file's
 * numbering — which is what makes source_line meaningful for provenance.
 */
function tokenize(text: string, delimiter: string): RawRow[] {
    const rows: RawRow[] = [];
    let fields: string[] = [];
    let field = "";
    let inQuotes = false;
    let line = 1;
    let rowStartLine = 1;
    let sawAnyChar = false;

    const endField = () => {
        fields.push(field);
        field = "";
    };
    const endRow = () => {
        endField();
        rows.push({ fields, line: rowStartLine });
        fields = [];
        rowStartLine = line;
        sawAnyChar = false;
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                if (ch === "\n") line++;
                field += ch;
            }
            continue;
        }

        if (ch === '"' && field === "") {
            inQuotes = true;
            sawAnyChar = true;
            continue;
        }
        if (ch === delimiter) {
            endField();
            sawAnyChar = true;
            continue;
        }
        if (ch === "\r") {
            if (text[i + 1] === "\n") i++;
            line++;
            endRow();
            rowStartLine = line;
            continue;
        }
        if (ch === "\n") {
            line++;
            endRow();
            rowStartLine = line;
            continue;
        }
        field += ch;
        sawAnyChar = true;
    }

    // Trailing row without a terminating newline.
    if (field !== "" || fields.length > 0 || sawAnyChar) endRow();

    return rows;
}

export interface ParseCsvOptions {
    delimiter?: Delimiter;
    decimalSeparator?: DecimalSeparator;
    /** Keep totals/average rows instead of excluding them. */
    keepTotalsRows?: boolean;
}

export function parseCsv(
    input: string | Uint8Array,
    options: ParseCsvOptions = {},
): ParsedTable {
    const warnings: string[] = [];
    let encoding = "utf-8";
    let text: string;
    if (typeof input === "string") {
        text = stripBom(input);
    } else {
        const decoded = decodeBytes(input);
        text = stripBom(decoded.text);
        encoding = decoded.encoding;
    }

    const delimiter = options.delimiter ?? sniffDelimiter(text);
    const raw = tokenize(text, delimiter);

    // Header = first row that is not blank.
    let headerIdx = raw.findIndex((r) => !isBlankRow(r.fields));
    if (headerIdx === -1) {
        return {
            headers: [],
            rows: [],
            sourceLines: [],
            delimiter,
            decimalSeparator: options.decimalSeparator ?? ".",
            encoding,
            skippedTotalsRows: 0,
            skippedBlankRows: 0,
            warnings: ["The file contains no data."],
        };
    }
    const headers = raw[headerIdx]!.fields.map((h) => h.trim());

    const seenHeaders = new Map<string, number>();
    for (const h of headers) {
        const k = normalizeHeader(h);
        seenHeaders.set(k, (seenHeaders.get(k) ?? 0) + 1);
    }
    const duplicated = [...seenHeaders.entries()]
        .filter(([k, n]) => n > 1 && k !== "")
        .map(([k]) => k);
    if (duplicated.length > 0) {
        warnings.push(
            `Duplicate column name(s): ${duplicated.join(", ")}. Columns are matched by position, so pick the one you want by index.`,
        );
    }

    const rows: string[][] = [];
    const sourceLines: number[] = [];
    let skippedTotalsRows = 0;
    let skippedBlankRows = 0;
    let raggedRows = 0;

    for (const r of raw.slice(headerIdx + 1)) {
        if (isBlankRow(r.fields)) {
            skippedBlankRows++;
            continue;
        }
        if (!options.keepTotalsRows && isTotalsRow(r.fields)) {
            skippedTotalsRows++;
            continue;
        }
        if (r.fields.length !== headers.length) raggedRows++;
        const padded = headers.map((_, i) => (r.fields[i] ?? "").trim());
        rows.push(padded);
        sourceLines.push(r.line);
    }

    if (raggedRows > 0) {
        warnings.push(
            `${raggedRows} row(s) had a different number of columns than the header; missing cells were treated as empty.`,
        );
    }
    if (skippedTotalsRows > 0) {
        warnings.push(
            `${skippedTotalsRows} totals/average row(s) were skipped rather than imported as meals.`,
        );
    }

    const decimalSeparator =
        options.decimalSeparator ?? sniffDecimalSeparator(rows, delimiter);

    return {
        headers,
        rows,
        sourceLines,
        delimiter,
        decimalSeparator,
        encoding,
        skippedTotalsRows,
        skippedBlankRows,
        warnings,
    };
}

// ---------- cell helpers ----------

export function isBlankRow(fields: string[]): boolean {
    return fields.every((f) => f.trim() === "");
}

/** A totals/average row: an aggregate label with no other identifying text. */
export function isTotalsRow(fields: string[]): boolean {
    const firstNonEmpty = fields.find((f) => f.trim() !== "");
    if (firstNonEmpty === undefined) return false;
    const v = firstNonEmpty.trim().toLowerCase().replace(/:$/, "");
    return TOTALS_ROW_PREFIXES.includes(v);
}

/** Whether a cell means "no value" rather than a value. */
export function isBlankCell(raw: string | undefined): boolean {
    if (raw === undefined) return true;
    return BLANK_TOKENS.has(raw.trim().toLowerCase());
}

/**
 * Header text reduced to a comparison key: lowercase, unit suffixes and
 * punctuation removed, micro sign normalized. Lets "Fat (g)", "fat_g" and
 * "Fat" match without keying data by name.
 */
export function normalizeHeader(header: string): string {
    return header
        .trim()
        .toLowerCase()
        .replace(/µ|μ/g, "u") // micro sign / Greek mu -> u (ug)
        .replace(/\(([^)]*)\)/g, " $1 ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, "_");
}

/**
 * Parse a numeric cell. Returns null for blank-ish cells rather than 0, so an
 * untracked nutrient stays absent instead of being recorded as a real zero.
 */
export function parseNumber(
    raw: string | undefined,
    decimalSeparator: DecimalSeparator = ".",
): number | null {
    if (isBlankCell(raw)) return null;
    let v = raw!.trim();

    // Strip currency-ish and unit noise but keep sign, digits and separators.
    v = v.replace(/[^0-9,.\-+eE]/g, "");
    if (v === "" || v === "-" || v === "+") return null;

    if (decimalSeparator === ",") {
        // 1.234,5 -> 1234.5
        v = v.replace(/\./g, "").replace(",", ".");
    } else {
        // 1,234.5 -> 1234.5 (thousands separators only)
        if (/,\d{3}(\D|$)/.test(v) || /^\d{1,3}(,\d{3})+$/.test(v)) {
            v = v.replace(/,/g, "");
        } else {
            v = v.replace(/,/g, ".");
        }
    }

    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Cronometer packs an amount and its unit into one cell ("58.00 g", "1.00 cup").
 * Returns the numeric part and the trailing unit text.
 */
export function splitAmount(
    raw: string | undefined,
    decimalSeparator: DecimalSeparator = ".",
): { value: number | null; unit: string | null } {
    if (isBlankCell(raw)) return { value: null, unit: null };
    const m = /^\s*([-+]?[\d.,]+)\s*(.*)$/.exec(raw!.trim());
    if (!m) return { value: null, unit: null };
    const unit = (m[2] ?? "").trim();
    return {
        value: parseNumber(m[1], decimalSeparator),
        unit: unit === "" ? null : unit,
    };
}

/**
 * Column index for the first header matching any of `aliases` (compared with
 * normalizeHeader). Returns -1 when absent. Index-based so duplicate header
 * names cannot silently collide.
 */
export function findColumn(headers: string[], aliases: string[]): number {
    const wanted = new Set(aliases.map(normalizeHeader));
    for (let i = 0; i < headers.length; i++) {
        if (wanted.has(normalizeHeader(headers[i]!))) return i;
    }
    return -1;
}

/**
 * True when a Lose It!-style "Deleted" column marks the row as deleted. Those
 * rows must be skipped: importing them resurrects food the user deliberately
 * removed, and no control total would catch it.
 */
export function isDeletedRow(row: string[], deletedColumn: number): boolean {
    if (deletedColumn < 0) return false;
    const v = (row[deletedColumn] ?? "").trim().toLowerCase();
    return v === "true" || v === "yes" || v === "1";
}
