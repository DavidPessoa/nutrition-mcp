# Nutrient Accuracy & Micronutrient Expansion — Handoff

**Branch:** `claude/nutrient-accuracy-d3e306` (git worktree)
**Updated:** 2026-08-20 (session 2)
**Status:** All eight builder tracks BUILT. Independent verification ran once and
returned **FAIL** with three findings; **all three are now fixed, none has been
re-verified**. The epic is NOT done: the one thing still owed on the code is a
second independent verification pass, and every database-dependent gate remains
BLOCKED. See "Where it actually stands".

**Working tree is CLEAN.** Everything is committed; nothing is half-finished.

Read `docs/nutrient-epic/CONTRACT.md` FIRST — names, units, provenance shape,
source precedence, file ownership, landmines. Do not re-derive any of it.
`FEATURE_REQUEST.md` (same directory) holds the per-agent acceptance criteria,
the six E2E scenarios and the Definition of Done that CONTRACT deliberately
does not duplicate.

---

## START HERE

### 1. Environment

`bun` is **not installed on this machine** and is not on PATH. Every session
must do this first or every command fails:

```bash
export PATH="/private/tmp/claude-501/-Users-davidparreira-Documents-Git-Personal-nutrition-mcp--claude-worktrees-nutrient-accuracy-d3e306/9081a337-d677-4dfe-9499-a8e59d6191ce/scratchpad/node_modules/.bin:$PATH"
bun --version   # expect 1.3.14
```

If that scratchpad is gone, reinstall it somewhere outside the repo:
`npm i bun --prefix /tmp/bun-host` then PATH `/tmp/bun-host/node_modules/.bin`.
Do not install bun into the repo and do not add it to package.json.

`.env` exists, is gitignored, and holds a real `USDA_FDC_API_KEY` and
`OFF_USER_AGENT`. Bun auto-loads it. **Never print the key or commit it.**
There is **no** `SUPABASE_URL` / `SUPABASE_SECRET_KEY`, which is why every
database-dependent gate below is unmet.

Confirm the baseline before changing anything:

```bash
bun run format:check && bun run typecheck && bun test
```

Expect clean, clean, **1015 pass** (30 files). Baseline before this epic was
698 tests.

### 2. Orchestration model that has been working

You are the orchestrator. Delegate to subagents; you own git. Rules that
earned their place:

- **One writer per file.** Give each agent an explicit file list and name the
  files another agent currently holds. Two agents on `src/mcp.ts` (4,700
  lines) is how a silent merge mistake happens.
- **Subagents must not run git.** They leave changes in the working tree; you
  inspect, run the gate, and commit selectively with `git add <paths>`.
- **Builders do not verify their own work.** Every real bug in this epic was
  found by an agent auditing someone else's code, and every one of them had
  passed the builder's own suite first.
- **A verifier that finds nothing is suspect.** Tell agents to report defects
  rather than silently patch them, and to state what they tried when they
  find nothing.
- Agents have been cut off mid-run by session limits. Their partial work was
  coherent and salvageable both times — inspect the tree and run the gate
  before assuming anything is lost.

---

## Where it actually stands

### Commits on this branch (newest first)

```
2327c36  fix(import): the importer refused nothing, and a row chose its own provenance
a161298  fix(import): the widget was dropping every micronutrient it could already read
2f592fc  docs(nutrient-epic): hand over with the verification failure stated plainly
c721a15  fix(summaries): scale a micronutrient target to the range it is judged over
cdfca38  fix(validation): stop the validators editing the evidence they validate
9a2fb4a  feat(summaries): fold per-nutrient confidence into the coverage payload
713fd79  feat(widgets): show micronutrients without letting a partial total look whole
636f295  fix(import): an empty cell was becoming a real zero, and micros never arrived
cad6774  fix(export): goals.csv was silently dropping every micronutrient goal
b729637  fix(insights): a zero floor is not a target, and coverage counts calories
69de2fd  feat(nutrients): coverage-aware summaries, micronutrient goals, import/export
0ddc9df  feat(usda): read Atwater energy when a Foundation record has no 208
bc3d350  fix(usda): validate against live FoodData Central, and stop losing to parens
fb4f7c1  fix(nutrients): make the resolution result the only authority on a write
b7ced28  feat(nutrients): source precedence and the expanded model through MCP
e273f8e  feat(usda): FoodData Central provider for generic whole foods
7e3fd30  test(off): cover the micronutrient mapping with fixtures and live validation
06b8052  feat(nutrients): canonical nutrient model, provenance and unit normalization
```

### Builder tracks

| #   | Track              | State                                                                      |
| --- | ------------------ | -------------------------------------------------------------------------- |
| 1   | schema + storage   | BUILT, verifier PASS                                                       |
| 2   | units / conversion | BUILT, verifier PASS                                                       |
| 3   | Open Food Facts    | BUILT, live-validated, verifier PASS (re-validated independently)          |
| 4   | USDA FDC           | BUILT, live-validated, verifier PASS                                       |
| 5   | resolution + MCP   | BUILT, PASS on log_meal/update_meal; Finding 3 → **fixed** in 2327c36      |
| 6   | summaries + goals  | BUILT; verifier FAIL (Finding 1) → **fixed** in c721a15                    |
| 7   | import / export    | BUILT; verifier FAIL (Finding 2) → **fixed** in a161298                    |
| 8   | widgets            | BUILT; rendered Finding 1's false verdict → **fixed** in c721a15           |
| 9   | verification       | Ran once, returned FAIL. **Must run again** after the open findings close. |

---

## OPEN — what the next orchestrator must do

### 1. Finding 3 — CLOSED in 2327c36, and the residual is deliberate

Also closed this session: `resolveNutrientWrite` treated `{field: undefined}`
as an explicit clear (7b333ac — now absent, as CONTRACT §0.1 requires), the
`target_days` gap in STYLE_GUIDE.md, and the duplicated export->row mapper,
now `src/csv-export-map.ts` (c204a12).

An end-to-end release runner was started and is NOT in the repo: it lives at
`<scratchpad>/e2e-nutrients.WIP.ts` and is roughly half written (preflight,
migration probe, throwaway-user lifecycle, MCP JSON-RPC client with 429
retry, server spawn — but none of the six scenarios and no main). Its design
is worth keeping: it drives the REAL tool surface over `/mcp` with a minted
`oauth_tokens` row, so tool descriptions, zod schemas, outputSchema
validation, analytics and the resolution policy are all in the path. It also
needs a `e2e:nutrients` entry in package.json, which was never added.

`bulk_import_meals` consulted no part of the resolution policy. It now refuses
the one thing CONTRACT §0.2 refuses everywhere else: a micronutrient whose row
declares it `model_estimate` is **not stored** — absent rather than null, so the
column is untouched rather than claimed to be a measured zero — and the count is
reported in the batch warnings instead of vanishing. A genuine export loses
nothing, because `log_meal` refuses to store such a value in the first place, so
no exported micronutrient can carry that source.

**The other half was left open on purpose.** A row claiming a source that
outranks `import` (`nutrition_label`, `usda_fdc`) is still honoured, so a model
that states a source it knows to be false can still land an invented value at
precedence 1. Clamping it was tried and reverted within the hour: it breaks the
export/re-import round trip, which is the whole reason the importer trusts the
file, and it failed the round-trip test immediately (a synthetic non-uuid meal
id made every gate on `source_id` misfire — the gate was also coupling two
unrelated things). Nothing in a row distinguishes a real restore from an
invented claim; there is no signal to gate on. The boundary is therefore carried
by the tool description, which now says outright that this is a restore path,
that every value must be transcribed from the file, that a micronutrient must
never be estimated here, and that `nutrient_provenance` must never be composed —
`log_meal` is the honest path and it refuses.

If a future verifier wants that hole closed anyway, the only shapes that do not
cost the round trip are a per-account "imports may not claim authoritative
sources" preference, or a distinct tool for restores that the model cannot see.
Both are larger than this epic.

### 2. Verifier B's report — 10 CONFIRMED defects in the CSV mapper, ALL FIXED, NONE RE-VERIFIED

**Status update (session 3):** all ten are fixed in ccd3a22, each with a
regression test written as the input that produced the wrong number. The list
below is kept verbatim as the record of what was wrong and why, because the
fixes are NOT independently verified: a re-verification pass was launched
against the fixed code and killed before it reported anything. Re-run it, and
brief it to attack the nine fixes themselves — the interior-qualifier strip, the
looping unit peel, the three-digit decimal rule and the totals-row heuristic all
widened behaviour and could plausibly have broken a header or a row that used to
work.

Also landed in session 3: `bun run e2e:nutrients --test-project`
(scripts/e2e-nutrients.ts), which runs all six release scenarios through the
real MCP tool surface. It has never been executed — there is still no test
database — so expect to fix something on its first real run.

ORIGINAL REPORT (all ten now fixed):

Verification was re-run as five independent adversarial passes. **Only one
finished** (the browser-side CSV mapper); the other four — summaries/coverage,
the import write path, providers/units, and the MCP tool surface — were killed
mid-run and produced nothing. They were launched a second time in session 3 and
killed again, still with nothing. Those four areas have never been
independently verified at all.

The one that finished came back FAIL with ten confirmed defects, every one
reproduced by driving the REAL assembled widget. Nothing below is fixed. They
share two root causes, and the first two lines of fix close five of them.

**Root cause 1 — `normalizeHeader` deletes `%` before anything can refuse it**
(`src/csv.ts:443`, with `UNSUPPORTED_UNIT_TOKENS` at :934).

1. HIGH — a `%DV` micronutrient column ("Iron (%)") imports as canonical mass:
   20 %DV of iron becomes 20 mg, previewed under a fabricated "Iron (mg)"
   header, with a reassuring "read as mg" notice. An IU column IS refused; a
   percent column is not. Fix: in `normalizeHeader`, `.replace(/%/g, " pct ")`
   before the `[^a-z0-9]+` sweep — `pct` is already an unsupported token, so
   the existing refusal path lights up with no other change.
2. HIGH — with both "Iron (%)" and "Iron (mg)" present, the percent column
   wins on header order and the real 3.6 mg is discarded as a `duplicate`
   (`src/csv.ts:1174`). Same one-line fix.
3. MEDIUM — the same `%` deletion auto-maps "Protein (%)" / "Carbs (%)" /
   "Fat (%)" percent-of-energy columns straight into the gram fields: a 600
   kcal bowl stored as 30 g protein / 45 g carbs / 25 g fat. Same fix.

**Root cause 2 — sniffers and peels that stop one step too early**

4. HIGH — `Energy (kJ)` never auto-maps (`import-meals.html:288`,
   `ALIASES.calories` has no kJ spelling), so every row is sent with NO
   calories at all AND `expected_total_kcal` is omitted, which silently
   disables the server-side control total that would have caught the loss.
   Fix: add `energy_kj`, `kj`, `kilojoules`, `energie_kj`; `sniffEnergyUnit`
   already returns `"kj"` for those headers.
5. HIGH — `sniffDecimalSeparator` (`src/csv.ts:160`) reads a thousands group
   (`1,240`) as evidence of a comma decimal, so a dot-decimal file with
   thousands-separated micronutrients has every decimal multiplied by 10 and
   every thousands number divided by 1000 — protein 12.5 → 125, sodium 1,240
   → 1.24. Silent: the date format and energy unit each get a user-editable
   control precisely because a silent sniff is dangerous; this one gets
   neither a control nor a readout. Fix: require a non-three-digit fraction,
   `/^-?\d+,\d{1,2}$|^-?\d+,\d{4,}$/`, and show the chosen separator on the
   map step.
6. MEDIUM — the qualifier peel runs BEFORE the unit peel
   (`src/csv.ts:1068`), so `Vitamin A, RAE (mcg)`, `Sodium total (mg)` and
   `Calcium, total (mg)` resolve to nothing and are dropped with NO notice at
   all. Also unmapped: USDA's own `Fatty acids, total saturated (g)` /
   `total trans (g)` / `Fat, saturated (g)`, and the element-symbol forms
   `Calcium, Ca (mg)`, `Iron, Fe (mg)`, `Potassium, K (mg)`,
   `Magnesium, Mg (mg)`. Fix: run the qualifier peel again after the unit
   peel, plus those aliases.
7. MEDIUM — `isTotalsRow` (`src/csv.ts:410`) tests only the first non-empty
   cell, so in any export whose first column is a date or id — i.e. every
   export this widget targets — a MyFitnessPal-style totals row is imported
   as an extra meal and the day is double-counted.
8. MEDIUM — `tokenize` (`src/csv.ts:266`) only honours a quote that is the
   field's first character, so `, "Beans, baked", 250` splits into corrupted
   fields, truncates the description and loses the calories.
9. LOW — `parseNumber` turns a censored value into a definite one: `<1` → 1,
   `>2000` → 2000. Should be null, or a counted rejection.
10. LOW/SUSPECTED — the bridge appends its "you can disable these widgets"
    footer inside `paint()`, but this widget's interactions assign
    `innerHTML` directly, so the footer disappears the moment a file is
    picked.

Two coverage gaps it named, worth closing while in there: the "inlines each
partial in full" test walks only the template's own includes (a nested
include inside a partial would be unguarded), and `@inlinets` completeness is
not asserted at all.

Found CLEAN and re-provable: `nutrient_units` is only ever g/mg/mcg; IU
columns ARE refused and demoted correctly; a blank cell arrives as null and a
real 0 as 0; 49 nutrient names x 6 unit suffixes all land on the right field
(no sodium/salt, no total/added sugar confusion); BOM, NBSP, CRLF, casing,
quoted newlines, duplicate headers, `source_line` integrity, preview-vs-sent
agreement, and the European `;` + comma-decimal + DD.MM.YYYY file end to end.
Widget height reporting is still UNPROVEN — no render path calls `sendSize()`
explicitly, all three interactive widgets rely on the bridge's
`ResizeObserver`, and a real layout cannot be executed outside a browser. The
in-app browser is blocked from the harness by a client policy in this
environment, so this needs a real host or a headless Chrome.

### 3. Re-run independent verification

Findings 1, 2 and 3 are fixed, but **no verifier has seen any of those
fixes** — they were written by the same builders whose work failed. Re-run a
full adversarial pass once Finding 3 closes. Attack the range-scaling shape
(`target_days`) and the widget's new browser-side CSV mapper hardest; both
are new logic written under time pressure at the end of a session. Brief it with the three bugs already found in this epic as
calibration — they are listed in "Bugs this epic actually found" below.

### 4. Small, known, unfixed

- The import widget's height re-report after its now-wider preview table was
  NOT verified in a real host iframe — `bun run harness`'s sandboxed iframe is
  blocked by a browser client policy in this environment. The sizing path
  itself is unchanged (bridge.js's ResizeObserver), but it is unproven.
- The import preview table is ~1850px wide with full nutrient names. It
  scrolls inside the existing `.tscroll`; abbreviations would be kinder.
- `scripts/validate-usda.ts` reads its "per 100 g (source)" column from the
  app's own `normalizeFdcFood` output, so it validates the scaling arithmetic
  only — the nutrient-number → field → unit mapping is compared against
  itself. The verifier closed that gap by hand for three foods (see
  `validation/usda/README.md`); the script is still weak.
- OFF nutrient 539 (added sugars) has never appeared in a real payload;
  `added_sugar_g` from USDA is mapped from the INFOODS tagname only.

---

## BLOCKED — needs a database, and nothing else will unblock it

**All six E2E release scenarios, the clean-database migration test, and Agent
1's real round-trip gate are formally UNMET**, and no amount of code work
changes that. Every one of them writes a meal and reads it back.

Two migrations have **never been applied to any database**:

```
supabase/migrations/20260819120000_micronutrient_expansion.sql   (12 columns + nutrient_provenance jsonb)
supabase/migrations/20260819130000_micronutrient_goals.sql       (10 min_/max_ goal columns)
```

To unblock, put a **test** Supabase project (never production) in `.env`:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service key>
```

apply both migrations, then work through `validation/e2e/README.md`, which
already lists the six scenarios and the evidence format. Do not record any of
them as passed on the strength of unit tests — they exist precisely because
unit tests cannot see a `numeric` column's precision or a jsonb round trip.

What IS proven without a database, and re-verified independently today:

```bash
bun run validate:off     # 3 real barcodes, live, every value hand-derived
bun run validate:usda    # 5 real FDC records, live, scaling checked outside the scaler
```

Both pass. `validate:usda --capture` refreshes fixtures; without the flag it
leaves them alone (it used to rewrite the evidence it was validating).

---

## Bugs this epic actually found — use these to calibrate a verifier

Each passed the builder's own test suite first. This is the calibre of defect
to hunt for:

1. **The resolution policy was decorative.** The write was built as
   `{ ...args, ...resolved }`, so a REFUSED value was merely absent from the
   overlay and the caller's original survived underneath it. A meal stored an
   estimated 900 mg sodium and rendered "Sodium: 900 mg" five lines above
   "(Not stored: sodium_mg)". On update it stored a rejected number while the
   provenance still said `open_food_facts / authoritative` — a model-invented
   figure labelled authoritative, which is worse than either half alone.
2. **`z.coerce.number().parse("")` is `0`.** `Number("")` is 0 and Zod coerces
   before validating, so a blank CSV cell became a confident zero — on fields
   that had shipped months earlier.
3. **A stored goal of `0` on a MINIMUM** leaked into structuredContent as a
   real target the text output denied existed, and every progress ratio
   divides by it.
4. **A range total judged against a daily target** (Finding 1): three ordinary
   days read as "over limit"; on a floor, a third of the target read as "met".
5. **The import widget dropped every micronutrient** (Finding 2) while
   `src/csv.ts` had a complete tested resolver inlined into that very widget,
   referenced only from a test file.

The pattern worth internalising: **the response text was reassuring while the
row was wrong.** Assert on what reached storage, not on what the tool said.

---

## LANDMINES (unchanged, still true)

1. **The frozen idempotency digest.** `mealIdempotencyKey` (`src/supabase.ts`)
   and `rowContentDigest` (`src/import.ts`) hash a POSITIONAL, deliberately
   INCOMPLETE field array. **Never add a nutrient field to either.** Both
   carry warning comments and regression tests.
2. **`null` != `0`, everywhere.** Assert null-ness separately from numeric
   tolerance — "within 0.1 of zero" must never pass for an unrecorded
   nutrient.
3. **Widening a shared type breaks distant fixtures.** Patch the shared
   factory, not each call site, and let `bun run typecheck` adjudicate.
4. **Cache backfill.** A newly added field must be explicitly backfilled to
   `null` in `getCachedFood`, or cached rows deserialize `undefined` and fail
   `.nullable()` structuredContent validation.
5. **Vitamin A/D in IU cannot be converted** to µg RAE / µg. Sources
   reporting IU must leave the field null. Both OFF and USDA carry IU entries
   beside the µg ones — this is real, not theoretical.
6. **USDA energy** appears as 208 (kcal), 268 (kJ) and 957/958 (Atwater
   kcal). Order is 208 → 957 → 958, and the unit is checked on every
   candidate. 4 of 5 validated records carry the kJ entry too.
7. **api.data.gov intermittently 400s any URL containing a parenthesis** —
   `%28` fails as often as a literal `(`. USDA search therefore uses POST
   with a JSON body. A test asserts no parenthesis reaches the URL.
8. **`.nullable()` in Zod = REQUIRED** with `anyOf[type,null]`. A missing key
   makes a widget render nothing, silently.
9. **Widgets must re-report height** via `ui/notifications/size-changed` after
   every re-render, including a toggle, or the host clips them.
