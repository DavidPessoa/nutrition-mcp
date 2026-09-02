// Micronutrient section builder — shared by every widget whose payload carries
// `nutrient_coverage` (get_nutrition_summary and get_goal_progress today).
//
// Renders ONE collapsible section that a widget drops inside its single
// `.panel` BELOW the macro strip, because the epic's hierarchy is calories and
// macros first, micronutrients grouped underneath. Pairs with
// shared/micros.css. Requires fmt(n, decimals) and esc(s) in the widget scope,
// exactly like shared/macros.js.
//
// WHY THIS IS NOT A MACROS ENTRY. The strip lays itself out by `role` over a
// `vals` object of day totals (see shared/macros.js), and a micronutrient has
// no entry there to lay out: it does not appear in TOTALS_ITEM at all. It
// arrives as its own array — NUTRIENT_COVERAGE_ITEM rows from
// nutrientCoveragePayload() in src/mcp.ts — one row per nutrient the user has
// data or a target for, each carrying its own coverage denominator. So this
// section is driven by the DATA, with no hardcoded key list anywhere in it
// (even the labels are derived from the field names): a thirteenth
// micronutrient added server-side appears here with no widget change, and a
// user with none gets no section at all and a widget identical to today's.
//
// A row of the payload:
//   { nutrient, unit, known_total, known_meals, total_meals, known_calories,
//     total_calories, coverage, complete, target, target_days, direction }
//   plus an OPTIONAL `confidence` — see microProv().
//
// `target` is ALREADY SCALED to the same span as `known_total` — the daily
// goal times `target_days` — so `known_total` vs `target` is a like-for-like
// comparison at any range length, and target_days only ever changes the
// wording ("over 3 days"). Do not divide either one by it.
//
// ---------------------------------------------------------------------------
// THE SIX STATES THIS SECTION EXISTS TO KEEP APART
//
//   not recorded  known_meals === 0. The figure slot is an em dash, never a
//                 number, and the tag reads "not recorded". No bar fill, and
//                 the rail is DASHED so an unmeasured nutrient does not look
//                 like a measured zero sitting at 0%.
//   zero          known_total === 0 with coverage complete: a real
//                 measurement. Full-strength figure "0", solid rail, tag
//                 "measured 0". This is the pair the epic is really about —
//                 "Iron: 0 mg" must be unmistakably different from silence.
//   partial       recorded on some meals only. The figure is prefixed "≥"
//                 (it is a FLOOR on the day, not the day), the fill is
//                 HATCHED rather than solid, and the tag says in words how
//                 many meals it covers and that the true total is higher.
//   complete      every meal recorded it. Solid fill, tag "all N meals".
//   estimated /   from the row's optional `confidence`: a badge reading
//   authoritative "estimated" in --warn vs "measured" in --accent (and "you
//                 said" for user_provided). Absent field → no badge, rather
//                 than a guessed one.
//
// AND THE RULE THAT OUTRANKS ALL OF THEM: a conclusion may only be coloured
// when it survives the missing meals. `known_total` is a lower bound, so
// growing it can flip "under your sodium limit" to false but can never flip
// "over your sodium limit" or "calcium target met". See microVerdict().
// ---------------------------------------------------------------------------

// Field name → display label, derived rather than tabulated so a new nutrient
// needs no widget edit. The trailing unit token goes (the row carries `unit`),
// and a one-letter word is an initial: vitamin_a_mcg → "Vitamin A".
const MICRO_UNIT_SUFFIXES = ["g", "mg", "mcg", "kcal"];

function microLabel(field) {
    const parts = String(field || "").split("_");
    if (MICRO_UNIT_SUFFIXES.indexOf(parts[parts.length - 1]) >= 0) parts.pop();
    return parts
        .map((w, i) =>
            w.length === 1
                ? w.toUpperCase()
                : i === 0
                  ? w.charAt(0).toUpperCase() + w.slice(1)
                  : w,
        )
        .join(" ");
}

// Micronutrient figures span 0.1 mcg to 3,000 mg, so the precision is the
// PAYLOAD's — nutrientCoveragePayload() has already rounded every total and
// target to a tenth, and rounding again here by magnitude put "≥25 g" above a
// caption reading "4.5 g over limit" off the same two numbers. fmt() round-trips
// through Number(), so a whole figure never grows a ".0" and an explicit zero
// still prints "0".
function microNum(v) {
    return fmt(v, Number.isInteger(v) ? 0 : 1);
}

// Which of the four coverage states a row is in.
function microState(r) {
    if (!r || r.known_meals === 0 || r.known_total == null) return "none";
    if (!r.complete) return "partial";
    return r.known_total === 0 ? "zero" : "complete";
}

// The verdict against the target, and whether it may be coloured.
//
// `known_total` is a FLOOR on the real intake: the meals that recorded nothing
// contributed an unknown, non-negative amount. So a conclusion is safe to
// state in colour only if it stays true as that total grows —
//
//   ceiling exceeded → still exceeded → --over, at any coverage
//   floor reached    → still reached  → --accent, at any coverage
//   under a ceiling  → may be false   → dim, and only with "so far" on it
//   short of a floor → may be false   → dim
//
// which is why an incomplete row can never paint a green "under your sodium
// limit": tone "ok" on a ceiling requires `complete`. That is the invariant,
// not a styling preference.
function microVerdict(r) {
    const t = r.target;
    const v = r.known_total;
    if (t == null || v == null) return null;
    const unit = r.unit ? ` ${r.unit}` : "";
    const ceiling = r.direction === "maximum";
    if (ceiling) {
        if (v > t) {
            return {
                text: `${microNum(v - t)}${unit} over limit`,
                tone: "over",
            };
        }
        if (v === t) {
            // Exactly at a ceiling is its own state — the same one the macro
            // strip spells out, because "0 g under" reads as room left.
            return r.complete
                ? { text: "at limit", tone: "over" }
                : { text: "at limit so far", tone: "none" };
        }
        const room = `${microNum(t - v)}${unit} under limit`;
        return r.complete
            ? { text: room, tone: "ok" }
            : { text: `${room} so far`, tone: "none" };
    }
    if (v >= t) return { text: "target met", tone: "ok" };
    const short = `${microNum(t - v)}${unit} short`;
    return {
        text: r.complete ? short : `${short} so far`,
        tone: "none",
    };
}

// The optional per-nutrient confidence badge. The field is not in
// NUTRIENT_COVERAGE_ITEM yet (see the note in the widget README / the agent
// report); when it is absent nothing is rendered, because inventing
// "measured" for a value whose provenance we were not told is exactly the
// class of claim this section exists to prevent.
const MICRO_CONFIDENCE = {
    authoritative: { cls: "p-auth", text: "measured" },
    user_provided: { cls: "p-user", text: "you said" },
    estimated: { cls: "p-est", text: "estimated" },
    mixed: { cls: "p-mixed", text: "mixed sources" },
};

function microProv(r) {
    const c = MICRO_CONFIDENCE[r && r.confidence];
    return c ? `<span class="mic-prov ${c.cls}">${c.text}</span>` : "";
}

// One row. Two lines on a phone: name + figure, then the bar, then the caption
// and the state tag.
function microRow(r) {
    const state = microState(r);
    const unit = r.unit ? esc(r.unit) : "";
    const label = esc(microLabel(r.nutrient));

    // The figure. An unmeasured nutrient gets an em dash — never a 0, and
    // never a number of any kind.
    let figure;
    if (state === "none") {
        figure = `<span class="mic-dash" aria-hidden="true">—</span>`;
    } else {
        const prefix = state === "partial" ? "≥" : "";
        figure = `${prefix}${microNum(r.known_total)}<span class="mic-unit"> ${unit}</span>`;
    }

    const verdict = microVerdict(r);
    const tone = verdict ? verdict.tone : "none";
    // The bar exists only where there is a target to scale it against; an
    // empty rail under a figure with nothing to compare it to is furniture.
    let bar = "";
    if (r.target != null && r.known_total != null) {
        const pct =
            r.target > 0
                ? Math.max(0, Math.min((r.known_total / r.target) * 100, 100))
                : r.known_total > 0
                  ? 100
                  : 0;
        bar = `<div class="mic-bar"><div class="mic-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
    } else if (state === "none") {
        bar = `<div class="mic-bar"></div>`;
    }

    // The caption is the target itself — the only place it appears — followed
    // by the verdict when there is one.
    const capParts = [];
    if (r.target != null) {
        // The span goes in the caption whenever it is more than a day, or a
        // 3-day 6,900 mg ceiling reads as a wildly generous daily one.
        const days = Number(r.target_days) || 1;
        const span = days > 1 ? ` over ${days} days` : "";
        capParts.push(
            `${r.direction === "maximum" ? "limit" : "of"} ${microNum(r.target)} ${unit}${span}`,
        );
    }
    if (verdict) capParts.push(verdict.text);
    const cap = capParts.length
        ? `<span class="mic-cap">${esc(capParts.join(" · "))}</span>`
        : "";

    // The state, in words. Never only a colour: the whole point is that a
    // reader can tell these apart without decoding a palette.
    let tag;
    if (state === "none") {
        tag = `<span class="mic-tag t-none">not recorded</span>`;
    } else if (state === "partial") {
        tag = `<span class="mic-tag t-partial">recorded meals only · ${r.known_meals} of ${r.total_meals}${microCalNote(r)}</span>`;
    } else if (state === "zero") {
        tag = `<span class="mic-tag t-zero">measured 0 · all ${r.total_meals} meal${r.total_meals === 1 ? "" : "s"}</span>`;
    } else {
        tag = `<span class="mic-tag t-complete">all ${r.total_meals} meal${r.total_meals === 1 ? "" : "s"}</span>`;
    }

    // The accessible name carries the whole row in one announcement, in the
    // same order the eye reads it, because the tag/caption/figure split is
    // visual layout rather than three separate facts.
    const spoken = [
        `${microLabel(r.nutrient)} ${state === "none" ? "not recorded" : `${state === "partial" ? "at least " : ""}${microNum(r.known_total)} ${r.unit || ""}`}`,
        capParts.join(", "),
        state === "partial"
            ? `recorded on ${r.known_meals} of ${r.total_meals} meals, the true total is higher`
            : state === "none"
              ? ""
              : `recorded on all ${r.total_meals} meals`,
    ]
        .filter(Boolean)
        .join(", ");

    return `
        <li class="mic-row st-${state} tone-${tone}" role="listitem" aria-label="${esc(spoken)}">
          <div class="mic-top">
            <span class="mic-key">${label}</span>
            <span class="mic-val">${figure}</span>
          </div>
          ${bar}
          <div class="mic-foot">${cap}${tag}${microProv(r)}</div>
        </li>`;
}

// "2 of 3 meals" hides WHICH meals, and a missing 900 kcal dinner is not the
// same claim as a missing black coffee — so the calorie share joins the tag
// whenever the payload can say it and the two numbers actually differ.
function microCalNote(r) {
    const total = Number(r.total_calories) || 0;
    if (total <= 0 || r.known_calories == null) return "";
    const pct = Math.round((Number(r.known_calories) / total) * 100);
    return ` · ${pct}% of calories`;
}

function microIsOver(r) {
    const vd = microVerdict(r);
    return !!vd && vd.tone === "over";
}

// The whole section, or "" when the payload carries no micronutrient rows at
// all — which is the case for every user who has none, and is what keeps this
// purely additive.
//
// `<details>` rather than a hand-rolled toggle: it is keyboard-accessible and
// exposed to assistive tech for free, needs no JS under a deny-all CSP, and
// its open/close changes the document height, which the bridge's
// ResizeObserver already re-reports to the host (so the iframe grows instead
// of clipping the list).
function microSection(coverage, opts) {
    const rows = Array.isArray(coverage) ? coverage.filter(Boolean) : [];
    if (rows.length === 0) return "";

    const partial = rows.filter((r) => microState(r) === "partial").length;
    const missing = rows.filter((r) => microState(r) === "none").length;
    const over = rows.filter(microIsOver).length;

    const bits = [`${rows.length} tracked`];
    if (partial) bits.push(`${partial} partial`);
    if (missing) bits.push(`${missing} not recorded`);
    const overBit = over
        ? `<span class="mic-over">${over} over limit</span>`
        : "";

    const open = rows.length <= (opts && opts.openUpTo ? opts.openUpTo : 5);
    const title = (opts && opts.title) || "Micronutrients";

    return `
      <details class="micros psec"${open ? " open" : ""} data-micros>
        <summary class="mic-sum">
          <span class="mic-title">${esc(title)}</span>
          <span class="mic-meta">${esc(bits.join(" · "))}${overBit ? " · " : ""}${overBit}</span>
        </summary>
        <div class="mic-legend">
          <span><b>—</b> not recorded</span>
          <span><b>≥</b> recorded meals only</span>
          <span><b>0</b> a measured zero</span>
        </div>
        <ul class="mic-list" role="list">${rows.map(microRow).join("")}</ul>
      </details>`;
}
