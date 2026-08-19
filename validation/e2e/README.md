# End-to-end release validation

The six scenarios the epic requires before it can be called done
(`docs/nutrient-epic/FEATURE_REQUEST.md`, "Required end-to-end release
validation"). Each one is a chain, and the point of the chain is that a
value survives every link unchanged:

| #   | Scenario                 | Chain                                                                            | Status                     |
| --- | ------------------------ | -------------------------------------------------------------------------------- | -------------------------- |
| 1   | Packaged barcode food    | barcode → OFF → normalize → MCP lookup → log → retrieve → summary → export       | BLOCKED — needs a database |
| 2   | USDA generic food        | FDC record → normalize → scale to serving → log → retrieve → summary → export    | BLOCKED — needs a database |
| 3   | Multi-food day           | ≥4 real foods, independently summed, compared to the daily total                 | BLOCKED — needs a database |
| 4   | Partial coverage         | take scenario 3, remove sodium from one meal, confirm the total reads as partial | BLOCKED — needs a database |
| 5   | Estimated meal           | vague meal → macros estimated and marked, micronutrients absent                  | BLOCKED — needs a database |
| 6   | Import/export round trip | CSV → dry run → import → retrieve → export → clean user → re-import → compare    | BLOCKED — needs a database |

## Why every row says BLOCKED

All six write and read meals, so all six need a Supabase project with the
migration applied. Nothing in this repo can meet them without one:

- `supabase/migrations/20260819120000_micronutrient_expansion.sql` has never
  been applied to any database.
- No `SUPABASE_URL` / `SUPABASE_SECRET_KEY` is configured.

The provider halves of scenarios 1 and 2 — the parts that do not touch the
database — are validated independently and do pass:

- `bun run validate:off` — real barcodes through the real Open Food Facts
  API, compared against hand-derived values. See
  `validation/open-food-facts/`.
- `bun run validate:usda` — real FDC records, with scaling checked against
  arithmetic computed outside the scaler. See `validation/usda/`.

## To unblock

Point a **test** Supabase project (never production) at the server:

```bash
# in .env, which is gitignored
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=<service key>
```

Apply every migration in `supabase/migrations/` to that project, then run
the scenarios. Record each one here as its own file using the evidence
format in `validation/README.md`: date, source, source identifier, serving
basis, source values, independently computed expectations, actual values,
difference, pass/fail.

A scenario is not passed because the code looks right. It is passed when the
numbers were compared and written down.
