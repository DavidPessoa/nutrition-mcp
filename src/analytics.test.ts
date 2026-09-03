import {
    test,
    expect,
    mock,
    beforeEach,
    afterEach,
    afterAll,
    spyOn,
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

const { withAnalytics } = await import("./analytics.js");

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
