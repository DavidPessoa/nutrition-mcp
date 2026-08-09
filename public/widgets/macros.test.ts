// Behaviour tests for the shared macro-panel partial and for the import
// widget's alcohol gate.
//
// Widget code is inline template JS, so it has no import surface: `macros.js` is
// evaluated here the way the assembler splices it into a page — with the fmt/esc
// helpers each template supplies — and the caption strings are asserted against
// real values. Without this the wording is pinned by nothing at all.
import { test, expect } from "bun:test";

const SRC = "./public/widgets/src";

// The same fmt/esc every template defines before including macros.js.
function fmt(n: number, decimals?: number) {
    if (n == null || isNaN(n)) return "0";
    const r = decimals ? n.toFixed(decimals) : Math.round(n);
    return Number(r).toLocaleString();
}
const esc = (s: unknown) => String(s);

type Bits = { goalLine: string; over: boolean; pct: number | null };
type Macro = { key: string; direction?: string };
type Vals = Record<string, number | null>;
const macrosApi = await (async () => {
    const src = await Bun.file(`${SRC}/shared/macros.js`).text();
    // `document`/`window` are left undefined so the partial's delegated event
    // wiring (guarded by `typeof document`) stays out of the way.
    const factory = new Function(
        "fmt",
        "esc",
        `${src}\nreturn { macroBits, MACROS, macroPanel, macroStat, macroCtxOf, dayHasData };`,
    );
    return factory(fmt, esc) as {
        macroBits: (
            m: Macro,
            vals: Record<string, number>,
            goal: Record<string, number> | null,
            wording?: { under?: string; over?: string },
        ) => Bits;
        MACROS: Macro[];
        macroPanel: (
            vals: Vals,
            goal?: Vals | null,
            wording?: { under?: string; over?: string },
            meals?: unknown[],
            opts?: { drinkUnit?: string },
        ) => string;
        macroStat: (m: Macro, ctx: unknown) => string;
        macroCtxOf: (
            vals: Vals,
            goal?: Vals | null,
            wording?: unknown,
            meals?: unknown[],
            opts?: { drinkUnit?: string },
        ) => unknown;
        dayHasData: (day: Vals) => boolean;
    };
})();

const macroOf = (key: string) => {
    const m = macrosApi.MACROS.find((x) => x.key === key);
    if (!m) throw new Error(`no MACROS entry for ${key}`);
    return m;
};
const line = (
    key: string,
    val: number,
    target: number | null,
    wording?: { under?: string; over?: string },
) =>
    macrosApi.macroBits(
        macroOf(key),
        { [key]: val },
        target === null ? null : { [key]: target },
        wording,
    ).goalLine;

// A ceiling is a limit to stay under, never a budget with something "left" in
// it — the wording a user trying to drink less reads as permission, and which
// says nothing at all averaged over a week.
test("a ceiling under its limit reads as being under it, not as budget left", () => {
    expect(line("alcohol_g", 0, 20)).toBe("limit 20 g · 20 g under");
    expect(line("sugar_g", 31.9, 45)).toBe("limit 45 g · 13.1 g under");
    expect(line("alcohol_g", 0, 20)).not.toContain("left");
});

test("a ceiling exceeded reads as over, and is flagged", () => {
    expect(line("sugar_g", 58.1, 45)).toBe("limit 45 g · 13.1 g over");
    expect(
        macrosApi.macroBits(
            macroOf("sugar_g"),
            { sugar_g: 58.1 },
            { sugar_g: 45 },
        ).over,
    ).toBe(true);
});

test("exactly at a ceiling is its own state, not '0 g under'", () => {
    expect(line("alcohol_g", 20, 20)).toBe("limit 20 g · at limit");
});

// The most likely alcohol limit there is. A floor of 0 stays meaningless.
test("a ceiling target of 0 is a real limit", () => {
    expect(line("alcohol_g", 0, 0)).toBe("limit 0 g · at limit");
    expect(line("alcohol_g", 5.2, 0)).toBe("limit 0 g · 5.2 g over");
    const b = macrosApi.macroBits(
        macroOf("alcohol_g"),
        { alcohol_g: 5.2 },
        { alcohol_g: 0 },
    );
    expect(b.over).toBe(true);
    // Percent of zero must not reach the caption as Infinity/NaN.
    expect(Number.isFinite(b.pct)).toBe(true);
});

test("a floor target of 0 is still no goal", () => {
    expect(line("protein_g", 40, 0)).toBe("no goal set");
    expect(line("protein_g", 40, null)).toBe("no goal set");
});

// Floors keep the wording they always had, including the caller override that
// trends uses for its averages.
test("floors are unchanged, and only floors take the wording override", () => {
    expect(line("protein_g", 145, 160)).toBe("of 160 g · 15 g left");
    expect(line("protein_g", 175, 160)).toBe("of 160 g · 15 g over");
    expect(line("protein_g", 145, 160, { under: "under" })).toBe(
        "of 160 g · 15 g under",
    );
    // A ceiling ignores it: "left" must not be reachable through the override.
    expect(line("sugar_g", 31.9, 45, { under: "left" })).toBe(
        "limit 45 g · 13.1 g under",
    );
});

// ---- interactive tiles: the accessible name -------------------------------
//
// `role="button"` makes a tile's children presentational, so the ring's own
// aria-label, the macro name and the goal caption all vanish from the
// accessibility tree. A tile that discloses something must therefore carry its
// value and goal state in its OWN name, or a screen-reader user hears the
// action and no numbers at all — while the static tile next to it reads them
// out in full. Verified against a real a11y-tree snapshot; pinned here.
const VALS = {
    calories: 2035,
    protein_g: 148,
    carbs_g: 205,
    fat_g: 74,
    fiber_g: 26.4,
    sugar_g: 58.2,
    alcohol_g: 12.5,
    caffeine_mg: 185,
    water_ml: 2100,
};
const GOALS = {
    calories: 2200,
    protein_g: 160,
    carbs_g: 220,
    fat_g: 70,
    fiber_g: 30,
    sugar_g: 45,
    alcohol_g: 20,
    caffeine_mg: 400,
    water_ml: 2500,
};
const MEALS = [
    { description: "Porridge", calories: 400, protein_g: 12, carbs_g: 60 },
];

// Every tile that is a button, by macro key → its accessible name.
function tileLabels(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(
        /data-macro="([^"]+)"[^>]*aria-label="([^"]*)"/g,
    ))
        out[m[1]!] = m[2]!;
    return out;
}

test("an interactive tile names its value and goal state, then the action", () => {
    const labels = tileLabels(
        macrosApi.macroPanel(VALS, GOALS, undefined, MEALS),
    );
    expect(labels.calories).toBe(
        "Calories 2,035 kcal, of 2,200 kcal, 165 kcal left. Show the meals that contributed.",
    );
    expect(labels.carbs_g).toBe(
        "Carbs 205 g, of 220 g, 15 g left. Show fiber and sugar, and the meals that contributed.",
    );
});

// The panel trends builds: no meals, so carbs is a button only because of its
// sub-components — and its panel was fully static (fully readable) before.
test("a tile made interactive by sub-components alone still names its value", () => {
    const labels = tileLabels(macrosApi.macroPanel(VALS, GOALS));
    expect(Object.keys(labels)).toEqual(["carbs_g"]);
    expect(labels.carbs_g).toBe(
        "Carbs 205 g, of 220 g, 15 g left. Show fiber and sugar.",
    );
});

test("no goal is still a value, not a bare action", () => {
    const labels = tileLabels(
        macrosApi.macroPanel(VALS, null, undefined, MEALS),
    );
    expect(labels.protein_g).toBe(
        "Protein 148 g, no goal set. Show the meals that contributed.",
    );
});

// A regression net over every shape the panel can take: whatever the wording
// ends up being, the number must be in the name.
test("every interactive tile carries its formatted value, and none is spoken as '·'", () => {
    const cases: Array<[Vals, Vals | null, { under?: string } | undefined]> = [
        [VALS, GOALS, undefined],
        [VALS, GOALS, { under: "under" }],
        [VALS, null, undefined],
        [{ ...VALS, fat_g: 0, calories: 4120 }, GOALS, undefined],
    ];
    for (const [vals, goal, wording] of cases) {
        const labels = tileLabels(
            macrosApi.macroPanel(vals, goal, wording, MEALS),
        );
        expect(Object.keys(labels).length).toBeGreaterThan(0);
        for (const [key, label] of Object.entries(labels)) {
            const m = macroOf(key) as Macro & { label: string; unit: string };
            // Hero and ring tiles — the only interactive ones — are whole
            // numbers, so the value reads exactly as it does on screen.
            expect(
                label.startsWith(`${m.label} ${fmt(vals[key]!, 0)} ${m.unit},`),
            ).toBe(true);
            // "·" is decoration a screen reader either skips or calls
            // "middle dot"; the spoken name separates with a comma.
            expect(label).not.toContain("·");
        }
    }
});

// The static tiles are the reason the button ones needed fixing — they were
// always readable, and must stay that way.
test("a static tile keeps its ring label and goal caption exposed", () => {
    const html = macrosApi.macroPanel(VALS, GOALS);
    expect(html).toContain('aria-label="Protein 148 g"');
    expect(html).toContain("of 160 g · 12 g left");
    // …and is not a button, so those children are not presentational.
    expect(html).not.toContain('data-macro="protein_g"');
});

// ---- caffeine: milligrams, a ceiling, and no invented zero ----------------
//
// The one nutrient not measured in grams, and the one with no profile opt-in to
// hide it — so the null in the payload is the whole display gate.
const caffeineStat = (vals: Vals, goal: Vals | null) =>
    macrosApi.macroStat(
        macroOf("caffeine_mg"),
        macrosApi.macroCtxOf(vals, goal),
    );

test("caffeine reads in whole milligrams against a ceiling", () => {
    expect(line("caffeine_mg", 320, 400)).toBe("limit 400 mg · 80 mg under");
    expect(line("caffeine_mg", 470, 400)).toBe("limit 400 mg · 70 mg over");
    // Whole milligrams even though the payload rounds to a tenth like its
    // siblings: a tenth of a milligram is below anything anyone can act on.
    expect(line("caffeine_mg", 95.4, 400)).toBe("limit 400 mg · 305 mg under");
});

// "None today" is a limit people really set, the same way it is for alcohol.
test("a caffeine limit of 0 is a real limit", () => {
    expect(line("caffeine_mg", 0, 0)).toBe("limit 0 mg · at limit");
    expect(line("caffeine_mg", 95, 0)).toBe("limit 0 mg · 95 mg over");
});

// The trap from issue #78: most meals predate the column and carry NULL, so a
// user who has never recorded caffeine must not be congratulated on being
// 400 mg under a limit they never went near.
test("caffeine never recorded renders nothing; a recorded 0 stays", () => {
    expect(caffeineStat({ caffeine_mg: null }, GOALS)).toBe("");
    expect(caffeineStat({ caffeine_mg: 0 }, GOALS)).toContain("none logged");
    expect(
        macrosApi.macroPanel({ ...VALS, caffeine_mg: null }, GOALS),
    ).not.toContain("Caffeine");
    expect(macrosApi.macroPanel(VALS, GOALS)).toContain("Caffeine");
});

test("caffeine is milligrams alone — the drink gloss is alcohol's only", () => {
    const html = caffeineStat({ caffeine_mg: 185 }, GOALS);
    expect(html).toContain('185<span class="ssub">mg</span>');
    expect(html).not.toContain("drinks");
    expect(
        macrosApi.macroStat(
            macroOf("alcohol_g"),
            macrosApi.macroCtxOf({ alcohol_g: 28 }, GOALS),
        ),
    ).toContain("US drinks");
});

// Caffeine carries zero kcal, so it is a stat line and nothing else: never a
// ring, never a segment of one, and never evidence that a day was logged.
test("caffeine is a stat line, not a macro", () => {
    const m = macroOf("caffeine_mg") as Macro & {
        role: string;
        parent?: string;
    };
    expect(m.role).toBe("stat");
    expect(m.parent).toBeUndefined();
    expect(macrosApi.macroPanel(VALS, GOALS, undefined, MEALS)).not.toContain(
        'data-macro="caffeine_mg"',
    );
    expect(macrosApi.dayHasData({ caffeine_mg: 185 })).toBe(false);
});

// ---- import widget: the alcohol opt-in ------------------------------------
//
// The map step is evaluated the way the assembler ships it: the real assembled
// widget (bridge + the transpiled csv.ts + the template) is run as one script
// with only the `initWidget({…})` bootstrap cut off, because that line is the
// one that reaches for window.parent. Everything below therefore exercises the
// same code a host runs, not a paraphrase of it.
const importWidget = await (async () => {
    const { getWidgetHtml } = await import("../../src/widgets");
    const html = await getWidgetHtml("import-meals");
    const script = html.slice(
        html.lastIndexOf("<script>") + "<script>".length,
        html.lastIndexOf("</script>"),
    );
    const boot = script.indexOf("initWidget({");
    if (boot === -1) throw new Error("import-meals bootstrap not found");
    const factory = new Function(
        `${script.slice(0, boot)}
         return {
             S,
             setDrinkUnit: (u) => { CFG = Object.assign({}, CFG, { drink_unit: u }); },
             autoMap,
             mapStep,
             buildRows,
             previewStep,
         };`,
    );
    return factory() as {
        S: Record<string, unknown> & {
            mapping: Record<string, number>;
            rows: Record<string, unknown>[];
        };
        setDrinkUnit: (u: string | null) => void;
        autoMap: () => void;
        mapStep: () => string;
        buildRows: () => void;
        previewStep: () => string;
    };
})();

// Render the map step over a one-row file. Returns its HTML.
function mapStepFor(
    headers: string[],
    row: string[],
    drinkUnit: string | null,
) {
    const w = importWidget;
    w.setDrinkUnit(drinkUnit);
    w.S.table = {
        headers,
        rows: [row],
        sourceLines: [2],
        encoding: "utf-8",
        delimiter: ",",
        decimalSeparator: ".",
        warnings: [],
        skippedTotalsRows: 0,
        skippedBlankRows: 0,
    };
    w.S.sourceApp = "";
    w.S.dateFormat = "iso";
    w.S.dateAmbiguous = false;
    w.S.energyUnit = "kcal";
    w.autoMap();
    return w.mapStep();
}

const WITH_ALCOHOL = [
    ["Date", "Food Name", "Energy (kcal)", "Alcohol (g)"],
    ["2026-07-18", "Pinot noir", "610", "17.4"],
] as const;
const NO_ALCOHOL = [
    ["Date", "Food Name", "Energy (kcal)", "Protein (g)"],
    ["2026-07-18", "Porridge", "310", "9.2"],
] as const;

// The gate is silent by design, and alcohol_g sits outside the import digest
// (CONTRACT §2) — so importing with tracking off and re-running the file after
// turning it on dedupes to a no-op that back-fills nothing. Unrecoverable and
// unannounced is the combination this notice exists to break.
test("a file with alcohol data says so when tracking is off", () => {
    const html = mapStepFor(WITH_ALCOHOL[0], WITH_ALCOHOL[1], null);
    expect(html).toContain("alcohol tracking is off");
    expect(html).toContain("will not be imported");
    // Names the column — the user's own header text — so they can tell which
    // one is meant, and names the way to keep it.
    expect(html).toContain("This file has an alcohol column (Alcohol (g))");
    expect(html).toContain("set_alcohol_tracking");
    // But never a parsed figure: suppressing those is the whole point of the
    // opt-in, and the gate must not be undone by the notice about it.
    expect(html).not.toContain("17.4");
    // Nor is the column offered for mapping while tracking is off.
    expect(html).not.toContain('data-field="alcohol_g"');
});

test("no notice when the user tracks alcohol — the column just imports", () => {
    const html = mapStepFor(WITH_ALCOHOL[0], WITH_ALCOHOL[1], "us");
    expect(html).not.toContain("alcohol tracking is off");
    expect(html).toContain('data-field="alcohol_g"');
});

test("no notice when the file has no alcohol column", () => {
    const html = mapStepFor(NO_ALCOHOL[0], NO_ALCOHOL[1], null);
    expect(html).not.toContain("alcohol tracking is off");
    expect(html).not.toContain("alcohol column");
});

// The wording is a claim about presence, so it must not fire on a header that
// merely looks alcoholic. Sugar alcohols are polyols and ABV is a percentage,
// neither of which is grams of ethanol — both are excluded from ALIASES, and
// the notice reuses that list rather than a second one that could drift.
test("the notice reuses the gate's alias list, not a looser match", () => {
    const html = mapStepFor(
        ["Date", "Food Name", "Sugar Alcohols (g)", "ABV"],
        ["2026-07-18", "Protein bar", "4.1", "0"],
        null,
    );
    expect(html).not.toContain("alcohol tracking is off");
});

// The importer parses the file in the browser, so its gate cannot be exercised
// from here; what is pinned is the part that made the leak possible, namely
// which way an absent drink_unit defaults.
test("the importer defaults to alcohol tracking OFF", async () => {
    const html = await Bun.file(`${SRC}/templates/import-meals.html`).text();
    const cfg = html.slice(html.indexOf("let CFG = {"));
    expect(cfg.slice(0, cfg.indexOf("};"))).toContain("drink_unit: null");
    // Only the two values the server's schema can emit turn it on.
    expect(html).toContain(
        'CFG.drink_unit === "us" || CFG.drink_unit === "uk"',
    );
    // Nothing leaves the browser unless it is on.
    expect(html).toContain("alcohol_g: alcoholTracked()");
});

// ---- import widget: caffeine is milligrams, and the header has to say so ---
//
// The whole naming contract exists to stop one specific import: a column headed
// "Caffeine (g)" binding to the milligram field and storing 0.18 where the
// user's own label reads 180 mg — legal, silent, and reported as a clean
// import. The guard is three parts (an ALIASES list carrying no _g spelling,
// CAFFEINE_GRAMS_RE, and the notice that explains the blank row), so all three
// are pinned here; deleting any one of them left every test passing.
const CAF_MG = [
    ["Date", "Food Name", "Energy (kcal)", "Caffeine (mg)"],
    ["2026-07-18", "Flat white", "120", "185"],
] as const;
const CAF_G = [
    ["Date", "Food Name", "Energy (kcal)", "Caffeine (g)"],
    ["2026-07-18", "Flat white", "120", "0.185"],
] as const;

test("a milligram caffeine column auto-maps, with no opt-in to satisfy", () => {
    // Both drink_unit states, because caffeine deliberately has no
    // alcohol-style gate: the alcohol opt-in must not reach it in either
    // direction.
    for (const unit of [null, "us"]) {
        const html = mapStepFor(CAF_MG[0], CAF_MG[1], unit);
        // The row is always rendered, so the selected index is what proves the
        // column bound — and the sample cell is what the user sees confirm it.
        expect(html).toContain('data-field="caffeine_mg"');
        expect(importWidget.S.mapping.caffeine_mg).toBe(3);
        expect(html).toContain(
            '<div class="map-src">Caffeine (mg)</div><div class="map-sample">e.g. 185</div>',
        );
        expect(html).not.toContain("is in grams");
    }
});

test("a bare 'Caffeine' header maps too — the unit is only ever mg", () => {
    const html = mapStepFor(
        ["Date", "Food Name", "Energy (kcal)", "Caffeine"],
        ["2026-07-18", "Flat white", "120", "185"],
        null,
    );
    expect(html).toContain('data-field="caffeine_mg"');
    expect(importWidget.S.mapping.caffeine_mg).toBe(3);
});

test("a caffeine column headed in GRAMS is refused, and the notice says why", () => {
    const html = mapStepFor(CAF_G[0], CAF_G[1], null);
    // Never auto-mapped — this is the 1000x error the contract is about.
    expect(importWidget.S.mapping.caffeine_mg).toBe(-1);
    expect(html).toContain("is in grams");
    // Names the user's own header text, like the alcohol notice, so they can
    // tell which column is meant.
    expect(html).toContain("caffeine column (Caffeine (g))");
    // And says the loss is permanent: caffeine_mg sits outside the import
    // digest, so a re-import of the corrected file dedupes to a no-op.
    expect(html).toContain("will not fill it in");
    expect(html).toContain("before importing, not after");
});

test("caffeine reaches the row only when a column is mapped to it", () => {
    mapStepFor(CAF_MG[0], CAF_MG[1], null);
    importWidget.buildRows();
    expect(importWidget.S.rows[0]!.caffeine_mg).toBe(185);
    // And the user sees it before confirming, in milligrams. The preview
    // column is data-driven like fiber and sugar — not gated on an opt-in.
    const preview = importWidget.previewStep();
    expect(preview).toContain("Caf mg");
    expect(preview).toContain("185");

    // No caffeine column at all: the key is absent rather than a fabricated 0,
    // which is what keeps a pre-feature-shaped export out of the averages.
    mapStepFor(NO_ALCOHOL[0], NO_ALCOHOL[1], null);
    importWidget.buildRows();
    expect(importWidget.S.rows[0]!.caffeine_mg).toBeUndefined();
    expect(importWidget.previewStep()).not.toContain("Caf mg");

    // And a grams-headed column stays out of the payload entirely.
    mapStepFor(CAF_G[0], CAF_G[1], null);
    importWidget.buildRows();
    expect(importWidget.S.rows[0]!.caffeine_mg).toBeUndefined();
});
