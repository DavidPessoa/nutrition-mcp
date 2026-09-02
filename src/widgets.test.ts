import { test, expect } from "bun:test";
import { getWidgetHtml, WIDGET_TEMPLATES } from "./widgets.js";

const KEYS = Object.keys(WIDGET_TEMPLATES);
const SRC = "./public/widgets/src";
const INCLUDE_RE = /\/\*@include\s+([^\s@]+)\s*@\*\//g;

// Every widget must assemble from its source partials into a self-contained
// document — no unresolved @include markers, valid inline JS, single style/script.
test.each(KEYS)("%s assembles into a self-contained widget", async (key) => {
    const html = await getWidgetHtml(key);

    // No include marker left behind (the real marker, not the word in prose).
    expect(html.match(/\/\*@include/g)).toBeNull();
    // Same for the TS-inlining marker: an unresolved one would ship a widget
    // whose script silently lacks whole functions.
    expect(html.match(/\/\*@inlinets/g)).toBeNull();
    // Module syntax must not survive into the inline <script>.
    expect(html).not.toMatch(/^export\s/m);

    // Structure: one inlined stylesheet + one inlined script, no external refs.
    expect((html.match(/<style>/g) ?? []).length).toBe(1);
    expect((html.match(/<script>/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.trimStart().startsWith("<!doctype html>")).toBe(true);

    // Shared bridge got inlined and the widget wires itself to it exactly once.
    expect(html).toContain("function initWidget(config)");
    expect((html.match(/initWidget\(\{/g) ?? []).length).toBe(1);

    // Shared design tokens got inlined.
    expect(html).toContain("--accent: #4a7c59");

    // The inlined <script> is syntactically valid JS.
    const script = html.slice(
        html.indexOf("<script>") + "<script>".length,
        html.indexOf("</script>"),
    );
    expect(() =>
        new Bun.Transpiler({ loader: "js" }).transformSync(script),
    ).not.toThrow();
});

// Guard against a partial being inlined incompletely (e.g. an extraction that
// truncates a component's CSS mid-block): every @include'd partial's full text
// must appear verbatim in the assembled output.
test.each(KEYS)("%s inlines each @include'd partial in full", async (key) => {
    const template = await Bun.file(
        `${SRC}/templates/${WIDGET_TEMPLATES[key]}`,
    ).text();
    const includes = [...template.matchAll(INCLUDE_RE)].map((m) => m[1]!);
    expect(includes.length).toBeGreaterThan(0);

    const html = await getWidgetHtml(key);
    for (const rel of includes) {
        const partial = (await Bun.file(`${SRC}/${rel}`).text()).trim();
        expect(html).toContain(partial);
    }
});

test("unknown widget key throws", async () => {
    expect(getWidgetHtml("nope")).rejects.toThrow(/unknown widget/);
});

// ---------------------------------------------------------------------------
// The micronutrient section (public/widgets/src/shared/micros.js).
//
// Widget code has no import surface, so the partial is evaluated here the way
// the assembler splices it into a page — with the fmt/esc helpers every
// template defines above its includes — and the rendered HTML is asserted
// directly. These are the states the epic exists to keep apart; without this
// they are pinned by nothing at all.
// ---------------------------------------------------------------------------

function fmt(n: number, decimals?: number) {
    if (n == null || isNaN(n)) return "0";
    const r = decimals ? n.toFixed(decimals) : Math.round(n);
    return Number(r).toLocaleString();
}
const esc = (s: unknown) =>
    String(s).replace(
        /[&<>"]/g,
        (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    );

type CoverageRow = {
    nutrient: string;
    unit: string;
    known_total: number | null;
    known_meals: number;
    total_meals: number;
    known_calories: number;
    total_calories: number;
    coverage: number;
    complete: boolean;
    target: number | null;
    direction: "minimum" | "maximum" | null;
    confidence?: string;
};

const micros = await (async () => {
    const src = await Bun.file(`${SRC}/shared/micros.js`).text();
    const factory = new Function(
        "fmt",
        "esc",
        `${src}\nreturn { microSection, microLabel, microState, microVerdict };`,
    );
    return factory(fmt, esc) as {
        microSection: (
            rows: unknown,
            opts?: { openUpTo?: number; title?: string },
        ) => string;
        microLabel: (field: string) => string;
        microState: (r: unknown) => string;
        microVerdict: (r: unknown) => { text: string; tone: string } | null;
    };
})();

// Fills in the uninteresting half of a row so each case states only what makes
// it different. Defaults to a nutrient nothing recorded, over 3 meals.
const row = (o: Partial<CoverageRow>): CoverageRow => ({
    nutrient: "sodium_mg",
    unit: "mg",
    known_total: null,
    known_meals: 0,
    total_meals: 3,
    known_calories: 0,
    total_calories: 1800,
    coverage: 0,
    complete: false,
    target: null,
    direction: null,
    ...o,
});

const ALL_TWELVE: CoverageRow[] = [
    ["saturated_fat_g", "g"],
    ["trans_fat_g", "g"],
    ["added_sugar_g", "g"],
    ["sodium_mg", "mg"],
    ["potassium_mg", "mg"],
    ["cholesterol_mg", "mg"],
    ["calcium_mg", "mg"],
    ["iron_mg", "mg"],
    ["magnesium_mg", "mg"],
    ["vitamin_a_mcg", "mcg"],
    ["vitamin_c_mg", "mg"],
    ["vitamin_d_mcg", "mcg"],
].map(([nutrient, unit]) =>
    row({
        nutrient,
        unit,
        known_total: 12.5,
        known_meals: 3,
        known_calories: 1800,
        coverage: 1,
        complete: true,
    }),
);

test("all twelve micronutrients render one row each, labelled from the field name", () => {
    const html = micros.microSection(ALL_TWELVE, { openUpTo: 99 });
    expect((html.match(/<li class="mic-row/g) ?? []).length).toBe(12);
    // Labels are derived, not tabulated: the unit suffix goes and a
    // one-letter word is an initial.
    expect(micros.microLabel("saturated_fat_g")).toBe("Saturated fat");
    expect(micros.microLabel("vitamin_a_mcg")).toBe("Vitamin A");
    expect(micros.microLabel("sodium_mg")).toBe("Sodium");
    expect(html).toContain(">Vitamin D<");
    expect(html).toContain("12 tracked");
});

// The whole section is additive: a user with no micronutrient data gets a
// widget byte-identical to the one they had before this feature existed.
test("no micronutrient data renders nothing at all", () => {
    expect(micros.microSection([])).toBe("");
    expect(micros.microSection(undefined)).toBe("");
    expect(micros.microSection(null)).toBe("");
});

test("a partial total is a floor, and says so three ways", () => {
    const html = micros.microSection([
        row({
            nutrient: "sodium_mg",
            known_total: 1780,
            known_meals: 2,
            known_calories: 1200,
            coverage: 0.67,
            complete: false,
            target: 2300,
            direction: "maximum",
        }),
    ]);
    // 1. the figure carries "≥" — it is a lower bound, not the day
    expect(html).toContain("≥1,780");
    // 2. the row is in the partial state, which is what hatches the bar
    expect(html).toContain('class="mic-row st-partial');
    // 3. and it says so in words, with the denominator and the calorie share
    expect(html).toContain("recorded meals only · 2 of 3");
    expect(html).toContain("% of calories");
});

// THE RULE. known_total is a floor, so a conclusion may only be coloured when
// more meals cannot overturn it.
test("under a ceiling on partial coverage is never painted as met", () => {
    const partialUnder = row({
        known_total: 1780,
        known_meals: 2,
        known_calories: 1200,
        target: 2300,
        direction: "maximum",
    });
    expect(micros.microVerdict(partialUnder)).toEqual({
        text: "520 mg under limit so far",
        tone: "none",
    });
    const html = micros.microSection([partialUnder]);
    expect(html).not.toContain("tone-ok");
    expect(html).toContain("so far");
});

test("a conclusion the missing meals cannot overturn IS coloured", () => {
    // Already over a ceiling: more sodium keeps it over.
    expect(
        micros.microVerdict(
            row({
                known_total: 2600,
                known_meals: 2,
                known_calories: 1200,
                target: 2300,
                direction: "maximum",
            }),
        ),
    ).toEqual({ text: "300 mg over limit", tone: "over" });
    // Floor already reached on partial coverage: more calcium keeps it met.
    expect(
        micros.microVerdict(
            row({
                nutrient: "calcium_mg",
                known_total: 1100,
                known_meals: 2,
                known_calories: 1200,
                target: 1000,
                direction: "minimum",
            }),
        ),
    ).toEqual({ text: "target met", tone: "ok" });
});

test("complete coverage under a ceiling is allowed to read as met", () => {
    const complete = row({
        known_total: 1780,
        known_meals: 3,
        known_calories: 1800,
        coverage: 1,
        complete: true,
        target: 2300,
        direction: "maximum",
    });
    expect(micros.microVerdict(complete)).toEqual({
        text: "520 mg under limit",
        tone: "ok",
    });
    const html = micros.microSection([complete]);
    expect(html).toContain("tone-ok");
    expect(html).toContain("all 3 meals");
    expect(html).not.toContain("so far");
});

// The pair the epic is really about: an explicit 0 and silence must not look
// remotely alike.
test("an explicitly measured zero is a number; an unrecorded nutrient is not", () => {
    const zeroRow = row({
        nutrient: "iron_mg",
        known_total: 0,
        known_meals: 3,
        known_calories: 1800,
        coverage: 1,
        complete: true,
        target: 18,
        direction: "minimum",
    });
    const unrecordedRow = row({
        nutrient: "iron_mg",
        target: 18,
        direction: "minimum",
    });
    expect(micros.microState(zeroRow)).toBe("zero");
    expect(micros.microState(unrecordedRow)).toBe("none");
    const zero = micros.microSection([zeroRow]);
    expect(zero).toContain('class="mic-row st-zero');
    expect(zero).toContain("measured 0");
    expect(zero).toContain('mic-val">0<');
    expect(zero).not.toContain("mic-dash");

    const unrecorded = micros.microSection([unrecordedRow]);
    expect(unrecorded).toContain('class="mic-row st-none');
    expect(unrecorded).toContain("not recorded");
    expect(unrecorded).toContain("mic-dash");
    // The one thing this row must never do.
    expect(unrecorded).not.toMatch(/mic-val">[^<]*\d/);
    expect(unrecorded).not.toContain("measured 0");
});

test("an estimated figure is badged amber, an authoritative one is not", () => {
    const est = micros.microSection([
        row({
            nutrient: "vitamin_c_mg",
            known_total: 75,
            known_meals: 3,
            known_calories: 1800,
            coverage: 1,
            complete: true,
            confidence: "estimated",
        }),
    ]);
    expect(est).toContain('class="mic-prov p-est">estimated<');

    const auth = micros.microSection([
        row({
            nutrient: "vitamin_a_mcg",
            unit: "mcg",
            known_total: 610,
            known_meals: 3,
            known_calories: 1800,
            coverage: 1,
            complete: true,
            confidence: "authoritative",
        }),
    ]);
    expect(auth).toContain('class="mic-prov p-auth">measured<');
    expect(auth).not.toContain("p-est");

    // A row whose provenance we were NOT told gets no badge — an invented
    // "measured" is exactly the claim this section exists to prevent.
    expect(
        micros.microSection([
            row({
                known_total: 610,
                known_meals: 3,
                known_calories: 1800,
                complete: true,
            }),
        ]),
    ).not.toContain("mic-prov");
});

// A summary for a historical date is the same data structure as today's, and
// the section must not acquire any dependence on the current date (no "today",
// no clock reads) — the same rows render identically whenever they are asked
// for.
test("the section is date-free, so a historical day renders like any other", () => {
    const rows = [
        row({
            known_total: 1780,
            known_meals: 2,
            known_calories: 1200,
            target: 2300,
            direction: "maximum",
        }),
    ];
    const a = micros.microSection(rows);
    const b = micros.microSection(rows);
    expect(a).toBe(b);
    expect(a).not.toMatch(/today|yesterday/i);
});

test("the collapsed summary states what is inside without claiming anything green", () => {
    const html = micros.microSection(
        [
            row({
                known_total: 2600,
                known_meals: 2,
                known_calories: 1200,
                target: 2300,
                direction: "maximum",
            }),
            row({ nutrient: "iron_mg", target: 18, direction: "minimum" }),
            ...ALL_TWELVE,
        ],
        { openUpTo: 1 },
    );
    // Long lists start collapsed; the headline still names the problem.
    expect(html).not.toContain('<details class="micros psec" open');
    expect(html).toContain("1 partial");
    expect(html).toContain("1 not recorded");
    expect(html).toContain('class="mic-over">1 over limit<');
});

// Both widgets whose payload carries nutrient_coverage must actually render
// it, and must pull in the shared partial rather than forking it.
test.each(["nutrition-summary", "goal-progress"])(
    "%s renders the micronutrient section from the shared partial",
    async (key) => {
        const html = await getWidgetHtml(key);
        expect(html).toContain("function microSection(coverage, opts)");
        expect(html).toContain("microSection(data.nutrient_coverage)");
        expect(html).toContain(".mic-row");
    },
);

// ---------------------------------------------------------------------------
// The import widget's own mapping path (public/widgets/src/templates/import-meals.html).
//
// The rows this widget posts to bulk_import_meals are built entirely inside the
// assembled document, so nothing outside it could see that all twelve
// micronutrients and every provenance cell were being dropped — the server
// accepted them, the CSV module could resolve them, and the browser mapper
// simply never asked. So the document is evaluated here the way the iframe
// runs it (no host: window.parent === window) with a DOM stub, and driven
// through a real file: file -> buildRows -> the rows that would be sent.
// ---------------------------------------------------------------------------

async function importWidget() {
    const html = await getWidgetHtml("import-meals");
    const script = html.slice(
        html.indexOf("<script>") + "<script>".length,
        html.indexOf("</script>"),
    );
    // render() bails on a missing #root, so a stub that owns up to having no
    // elements is all the DOM this needs.
    const doc = {
        getElementById: () => null,
        querySelectorAll: () => [],
        documentElement: { style: {}, setAttribute() {} },
        body: {},
        createElement: () => ({ style: {} }),
        addEventListener() {},
    };
    const win: Record<string, unknown> = {
        addEventListener() {},
        innerWidth: 400,
    };
    win.parent = win; // no host -> the standalone path, no postMessage
    const factory = new Function(
        "window",
        "document",
        "ResizeObserver",
        `${script}\nreturn { S, loadFile, buildRows, microColumns, microRefused, microAssumed, mapStep, previewStep };`,
    );
    return factory(win, doc, undefined) as {
        S: { rows: Record<string, unknown>[]; micro: unknown[]; step: string };
        loadFile: (f: unknown) => Promise<void>;
        buildRows: () => void;
        microColumns: () => { header: string; unit: string | null }[];
        microRefused: () => { header: string }[];
        microAssumed: () => { header: string }[];
        mapStep: () => string;
        previewStep: () => string;
    };
}

/** Feed the widget a CSV exactly as the file input does. */
async function widgetRows(csv: string) {
    const w = await importWidget();
    const bytes = new TextEncoder().encode(csv);
    await w.loadFile({
        name: "export.csv",
        arrayBuffer: async () => bytes.buffer,
    });
    w.buildRows();
    return w;
}

const MICRO_FIXTURE = await Bun.file(
    "./src/fixtures/import/micronutrients.csv",
).text();

test("the widget maps micronutrient columns into the rows it sends", async () => {
    const w = await widgetRows(MICRO_FIXTURE);
    expect(w.S.rows).toHaveLength(4);
    const first = w.S.rows[0]!;

    // Values travel in the FILE's unit with the unit named alongside, so the
    // conversion happens once, server-side: 0.39 g of potassium is still 0.39.
    expect(first.potassium_mg).toBe(0.39);
    expect(first.sodium_mg).toBe(180);
    expect(first.nutrient_units).toMatchObject({
        potassium_mg: "g",
        sodium_mg: "mg",
        cholesterol_mg: "mg", // bare header, canonical unit assumed
        vitamin_d_mcg: "mcg",
    });

    // "Vitamin A (IU)" is not sent under any unit.
    expect("vitamin_a_mcg" in first).toBe(false);
    expect((first.nutrient_units as Record<string, string>).vitamin_a_mcg).toBe(
        undefined,
    );

    // Blank vs zero survives the browser: null is "not recorded", 0 is a
    // measurement, and neither becomes the other.
    expect(w.S.rows[1]!.potassium_mg).toBeNull();
    expect(w.S.rows[2]!.iron_mg).toBe(0);
    expect(w.S.rows[3]!.trans_fat_g).toBeNull();
});

test("the widget passes our export's nutrient_provenance through verbatim", async () => {
    const prov = JSON.stringify({
        sodium_mg: {
            source: "nutrition_label",
            source_id: null,
            confidence: "authoritative",
        },
    });
    const csv = [
        "id,logged_at,timezone,meal_type,description,calories,sodium_mg,nutrient_provenance",
        `11111111-1111-4111-8111-111111111111,2026-07-01 08:30:00,Europe/Kyiv,breakfast,Toast,320,610,"${prov.replace(/"/g, '""')}"`,
    ].join("\n");
    const w = await widgetRows(csv);
    const r = w.S.rows[0]!;
    // Verbatim: re-deriving it here would replace the label's own claim with
    // "import" and silently downgrade every restored meal.
    expect(r.nutrient_provenance).toBe(prov);
    expect(r.source_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(r.timezone).toBe("Europe/Kyiv");
    expect(r.sodium_mg).toBe(610);
});

test("a file with no micronutrient columns is sent exactly as before", async () => {
    const csv = [
        "Date,Meal,Food,Calories,Protein (g),Carbohydrates (g),Fat (g)",
        "2026-07-01,Breakfast,Oatmeal,320,12,54,6",
    ].join("\n");
    const w = await widgetRows(csv);
    expect(w.S.micro).toEqual([]);
    // No nutrient key, and — the part that matters for an untouched import —
    // no nutrient_units either, which would otherwise be an empty object on
    // every row of every foreign export.
    const sent = JSON.parse(JSON.stringify(w.S.rows[0]));
    expect(Object.keys(sent).sort()).toEqual([
        "calories",
        "carbs_g",
        "description",
        "fat_g",
        "logged_at",
        "meal_type",
        "protein_g",
        "source_line",
    ]);
});

test("the widget says which units it assumed and which columns it refused", async () => {
    const w = await widgetRows(MICRO_FIXTURE);
    expect(w.microColumns().map((c) => c.header)).toContain("Sodium (mg)");
    expect(w.microAssumed().map((c) => c.header)).toEqual([
        "Saturated Fat",
        "Trans Fat",
        "Cholesterol",
        "Calcium",
        "Magnesium",
    ]);
    expect(w.microRefused().map((c) => c.header)).toEqual(["Vitamin A (IU)"]);

    const map = w.mapStep();
    // The assumption is stated, not silent...
    expect(map).toContain("Stating no unit, so read as g: Saturated Fat");
    expect(map).toContain("mg: Cholesterol, Calcium, Magnesium");
    // ...and the refusal explains itself instead of leaving a blank column.
    expect(map).toContain("Vitamin A (IU) will not be imported");
    expect(map).toContain("those values are in IU");

    // And the preview — the screen the user confirms — shows the values, so
    // nothing is written that was never displayed. The column header carries
    // the unit the column is actually in.
    const preview = w.previewStep();
    expect(preview).toContain("Potassium (g)");
    expect(preview).toContain("Vitamin C (mg)");
    expect(preview).toContain("Saturated fat (g)");
    expect(preview).toContain("0.39");
});
