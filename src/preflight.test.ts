import { test, expect, mock, afterEach, beforeEach } from "bun:test";

// isPostgresBackend is read from the env at call time; restore after each case.
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSecretKey = process.env.SUPABASE_SECRET_KEY;

beforeEach(() => {
    // Supabase mode for every case unless a test opts into Postgres.
    delete process.env.DATABASE_URL;
    process.env.SUPABASE_SECRET_KEY = "test-secret";
});

afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalSecretKey === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = originalSecretKey;
    mock.restore();
});

function stubClient(
    responses: Array<{ code?: string; message: string } | null>,
) {
    let i = 0;
    return {
        from: (_table: string) => ({
            select: (_cols: string) => ({
                limit: async (_n: number) => {
                    const error = responses[i++] ?? null;
                    return { error };
                },
            }),
        }),
    };
}

test("warns and names the right migration file on 42703", async () => {
    const { warnIfMicronutrientMigrationsMissing } =
        await import("./preflight.js");
    const errors: string[] = [];
    const err = mock((msg: string) => {
        errors.push(msg);
    });
    const original = console.error;
    console.error = err as typeof console.error;
    try {
        await warnIfMicronutrientMigrationsMissing(
            stubClient([
                { code: "42703", message: 'column "sodium_mg" does not exist' },
                {
                    code: "42703",
                    message: 'column "max_sodium_mg" does not exist',
                },
            ]),
        );
    } finally {
        console.error = original;
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(
        "supabase/migrations/20260819120000_micronutrient_expansion.sql",
    );
    expect(errors[0]).toContain("log_meal writes will fail");
    expect(errors[1]).toContain(
        "supabase/migrations/20260819130000_micronutrient_goals.sql",
    );
});

test("silent on success", async () => {
    const { warnIfMicronutrientMigrationsMissing } =
        await import("./preflight.js");
    const err = mock(() => {});
    const original = console.error;
    console.error = err as typeof console.error;
    try {
        await warnIfMicronutrientMigrationsMissing(stubClient([null, null]));
    } finally {
        console.error = original;
    }
    expect(err).not.toHaveBeenCalled();
});

test("silent on an unrelated error", async () => {
    const { warnIfMicronutrientMigrationsMissing } =
        await import("./preflight.js");
    const err = mock(() => {});
    const original = console.error;
    console.error = err as typeof console.error;
    try {
        await warnIfMicronutrientMigrationsMissing(
            stubClient([
                { code: "PGRST301", message: "connection refused" },
                { code: "57014", message: "timeout" },
            ]),
        );
    } finally {
        console.error = original;
    }
    expect(err).not.toHaveBeenCalled();
});

test("no-ops in Postgres mode", async () => {
    process.env.DATABASE_URL = "postgres://localhost/test";
    delete process.env.SUPABASE_SECRET_KEY;

    const { warnIfMicronutrientMigrationsMissing } =
        await import("./preflight.js");
    let called = false;
    const client = {
        from: () => {
            called = true;
            return {
                select: () => ({
                    limit: async () => ({ error: null }),
                }),
            };
        },
    };
    const err = mock(() => {});
    const original = console.error;
    console.error = err as typeof console.error;
    try {
        await warnIfMicronutrientMigrationsMissing(client);
    } finally {
        console.error = original;
    }
    expect(called).toBe(false);
    expect(err).not.toHaveBeenCalled();
});
