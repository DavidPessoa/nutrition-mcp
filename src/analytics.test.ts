import {
    test,
    expect,
    mock,
    beforeEach,
    afterEach,
    afterAll,
    spyOn,
    describe,
} from "bun:test";
import * as actualSupabase from "./supabase.js";

// withAnalytics persists through getSupabase(); intercept that one export so
// these tests never touch a real backend. mock.module is process-global.
// Snapshotted BEFORE the mock is installed: `actualSupabase` is a live ESM
// namespace, so restoring with `() => actualSupabase` would hand the mock
// back to itself (same hazard as src/mcp.test.ts).

const inserts: Record<string, unknown>[] = [];
const REAL_SUPABASE = { ...actualSupabase };

mock.module("./supabase.js", () => ({
    ...REAL_SUPABASE,
    getSupabase: () => ({
        from: (_table: string) => ({
            insert: (row: Record<string, unknown>) => {
                // persistAnalytics does not await this. Capture on a microtask
                // so the tests cannot assume synchronous insert. Drop keys
                // whose value is undefined — JSON/PostgREST omit them, and
                // `{ error_category: undefined }` would otherwise still carry
                // the key.
                return Promise.resolve().then(() => {
                    inserts.push(
                        Object.fromEntries(
                            Object.entries(row).filter(
                                ([, v]) => v !== undefined,
                            ),
                        ),
                    );
                    return { error: null };
                });
            },
        }),
    }),
}));

afterAll(() => {
    mock.module("./supabase.js", () => REAL_SUPABASE);
});

const { withAnalytics, categorizeError } = await import("./analytics.js");

const ENV_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "DATABASE_URL",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

function restoreEnv() {
    for (const key of ENV_KEYS) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

async function flushPersist(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    inserts.length = 0;
    process.env.SUPABASE_URL = "http://analytics-test.invalid";
    process.env.SUPABASE_SECRET_KEY = "test-not-a-real-key";
    delete process.env.DATABASE_URL;
});

afterEach(() => {
    restoreEnv();
});

test("a handler that returns normally with no outcome option persists success", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
        const payload = { content: [{ type: "text", text: "ok" }] };
        const result = await withAnalytics("log_meal", async () => payload, {
            userId: "user-1",
            sessionId: "sess-1",
        });
        expect(result).toBe(payload);

        await flushPersist();
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toMatchObject({
            user_id: "user-1",
            tool_name: "log_meal",
            success: true,
            mcp_session_id: "sess-1",
        });
        expect(inserts[0]).not.toHaveProperty("error_category");
    } finally {
        log.mockRestore();
    }
});

test("a structured-failure payload with an outcome callback persists as a failure", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        const payload = {
            structuredContent: { status: "failed" as const },
        };
        const result = await withAnalytics(
            "bulk_import_meals",
            async () => payload,
            { userId: "user-1" },
            undefined,
            {
                // CLAUDE.md landmine: bulk_import_meals reports failure in the
                // payload rather than throwing, so without outcome the row
                // would log as a success.
                outcome: (r) =>
                    r.structuredContent.status === "failed"
                        ? { success: false, errorCategory: "import_failed" }
                        : { success: true },
            },
        );
        expect(result).toBe(payload);

        await flushPersist();
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toMatchObject({
            user_id: "user-1",
            tool_name: "bulk_import_meals",
            success: false,
            error_category: "import_failed",
        });
    } finally {
        warn.mockRestore();
    }
});

test("a throwing handler persists a categorized failure and returns error content", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
        const result = await withAnalytics(
            "log_meal",
            async (): Promise<{
                content: { type: string; text: string }[];
                isError: boolean;
            }> => {
                throw new Error("token expired");
            },
            { userId: "user-1" },
        );

        expect(result).toEqual({
            content: [
                {
                    type: "text",
                    text: "Error: token expired",
                },
            ],
            isError: true,
        });

        await flushPersist();
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toMatchObject({
            user_id: "user-1",
            tool_name: "log_meal",
            success: false,
            error_category: "auth_expired",
        });
    } finally {
        warn.mockRestore();
    }
});

describe("categorizeError", () => {
    test.each([
        [
            'logged_at is invalid ("yesterday evening"): unrecognized format. Use "YYYY-MM-DD" for a date with no known time.',
            "invalid_date_format",
        ],
        [
            "logged_at is in the future (2026-08-27T16:30:49). Log the time the entry was actually recorded.",
            "invalid_date_format",
        ],
        [
            'logged_at is in the future (2026-08-27T16:30:49). "2026-08-27T16:30:49" carries no UTC offset and this account has no timezone set, so it was read as UTC. Set one with set_timezone.',
            "invalid_date_format",
        ],
        ["Invalid date string: 2026-99-99", "invalid_date_format"],
        [
            "Invalid timezone: Mars/Olympus_Mons. Use an IANA identifier like 'America/Los_Angeles' or 'Europe/London'.",
            "invalid_timezone",
        ],
        [
            "5000 kg is outside the plausible body-weight range (20–500 kg / 44–1102 lb). Double-check the number and unit.",
            "invalid_numeric_value",
        ],
        ["Invalid weight value: NaN", "invalid_numeric_value"],
        ["Invalid drink volume (mL): -50", "invalid_numeric_value"],
        [
            "Invalid ABV (expected a percentage between 0 and 100): 250",
            "invalid_numeric_value",
        ],
        [
            "Invalid weight unit: stone. Use 'kg', 'lb', or null to clear.",
            "invalid_param_value",
        ],
        [
            "No weight unit given and no preference set. Pass unit ('kg' or 'lb'), or set a default first with set_weight_unit.",
            "missing_required_param",
        ],
        ["Failed to update meal: meal not found", "record_not_found"],
        ["Failed to update weight: entry not found", "record_not_found"],
        [
            "Missing DATABASE_URL (Postgres) or SUPABASE_URL / SUPABASE_SECRET_KEY",
            "service_misconfigured",
        ],
        [
            "Missing SUPABASE_URL or SUPABASE_SECRET_KEY",
            "service_misconfigured",
        ],
        [
            "OFF_USER_AGENT is not configured — Open Food Facts requires a User-Agent like 'nutrition-mcp (you@example.com)'",
            "service_misconfigured",
        ],
        ["@inlinets source not found: src/missing.ts", "internal_asset_error"],
        [
            "widget source partial not found: shared/missing.js",
            "internal_asset_error",
        ],
        ["@include cycle: a.html -> b.html -> a.html", "internal_asset_error"],
        ["unknown widget: not-a-real-widget", "internal_asset_error"],
        ["Failed to upload export: storage quota exceeded", "export_error"],
        ["Failed to create download link: unknown error", "export_error"],
        [
            "getAllMeals: fetched 5 meals but countMeals reported 10 — export would be truncated",
            "export_error",
        ],
        ["Failed to insert meal: connection reset", "supabase_error"],
        ["Failed to store token: duplicate key value", "supabase_error"],
        ["Failed to delete auth codes: connection reset", "supabase_error"],
        ["Failed to look up meal: connection reset", "supabase_error"],
        ["Failed to count water: connection reset", "supabase_error"],
        ["Failed to check existing meals: connection reset", "supabase_error"],
        ["Failed to save profile: connection reset", "supabase_error"],
        ["JWT expired", "auth_expired"],
        ["Auth session missing!", "auth_expired"],
        ["Open Food Facts request failed: 429", "rate_limited"],
        ["Open Food Facts request failed: 500", "unknown"],
        ["fetch failed", "network_error"],
        ["connect ECONNREFUSED 127.0.0.1:5432", "network_error"],
        ["The operation was aborted due to timeout", "network_error"],
        ["Cannot read properties of undefined (reading 'x')", "unknown"],
    ])("categorizes %j as %s", (message, expected) => {
        expect(categorizeError(new Error(message))).toBe(expected);
    });

    test("non-Error values fall back to unknown", () => {
        expect(categorizeError("plain string")).toBe("unknown");
        expect(categorizeError(42)).toBe("unknown");
        expect(categorizeError(new Error(""))).toBe("unknown");
    });
});
