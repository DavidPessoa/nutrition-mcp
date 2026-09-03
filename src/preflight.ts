import { isPostgresBackend } from "./supabase.js";

/**
 * Cheap PostgREST probe shape — injectable so tests need no credentials.
 * Mirrors the migration check in scripts/e2e-nutrients.ts without importing it.
 */
export type PreflightClient = {
    from: (table: string) => {
        select: (cols: string) => {
            limit: (n: number) => PromiseLike<{
                error: { code?: string; message: string } | null;
            }>;
        };
    };
};

/**
 * When the hosted Supabase project is missing either micronutrient migration,
 * meal writes name those columns and fail with an opaque PostgREST error.
 * Warn at boot — do not throw: crashing here would take down OAuth, the
 * landing page and /health. Gated on !isPostgresBackend() because the
 * Postgres shim never propagates SQLSTATE 42703.
 */
export async function warnIfMicronutrientMigrationsMissing(
    client: PreflightClient,
): Promise<void> {
    if (isPostgresBackend()) return;

    // limit(0): PostgREST still validates the select list (so 42703 fires on a
    // missing column) without pulling a real user row.
    await probe(
        client.from("meals").select("sodium_mg").limit(0),
        "supabase/migrations/20260819120000_micronutrient_expansion.sql",
    );
    await probe(
        client.from("nutrition_goals").select("max_sodium_mg").limit(0),
        "supabase/migrations/20260819130000_micronutrient_goals.sql",
    );
}

async function probe(
    query: PromiseLike<{ error: { code?: string; message: string } | null }>,
    migration: string,
): Promise<void> {
    const { error } = await query;
    if (!error) return;
    // 42703 = undefined_column. Anything else (unreachable DB, auth, …) is
    // ignored so boot does not misreport a missing migration.
    if (error.code === "42703") {
        console.error(
            `Micronutrient migration missing: apply ${migration}. log_meal writes will fail until it is applied.`,
        );
    }
}
