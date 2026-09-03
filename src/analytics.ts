import { getSupabase } from "./supabase.js";

interface AnalyticsRecord {
    user_id: string;
    tool_name: string;
    success: boolean;
    duration_ms: number;
    error_category?: string;
    date_range_days?: number;
    mcp_session_id?: string;
    invoked_at: string;
}

/**
 * Identity recorded for a tool call that wipes the caller's own analytics rows.
 *
 * `delete_account` deletes `tool_analytics` as its *first* step, but
 * `withAnalytics` persists its row *after* the handler resolves — and
 * `tool_analytics.user_id` is a plain varchar with no FK, so that insert
 * succeeds and resurrects a row for a user the tool just promised was gone.
 * Recording the deletion under a sentinel keeps the operational signal (how
 * often deletions run, how long they take, whether they failed) while retaining
 * no identifier for the deleted account.
 */
export const DELETED_ACCOUNT_ANALYTICS_ID = "[deleted]";

interface AnalyticsContext {
    userId: string;
    sessionId?: string;
}

/**
 * Bucket a thrown error for `tool_analytics.error_category`.
 *
 * Checked in three tiers. Tier 1 matches the *literal, fixed wording* of
 * validation/config errors this codebase throws itself — checked first so they
 * don't get swallowed by tier 3's looser keyword heuristics. Tier 2 is every
 * src/supabase.ts persistence throw, matched generically by its "Failed to
 * <verb> <noun>: <cause>" prefix — this runs *before* tier 3's auth/rate/date
 * keyword checks specifically so that a message like "Failed to store token"
 * or "Failed to delete auth codes" (which legitimately contain "token"/"auth"
 * as our own noun, not as a signal about the failure) is bucketed as
 * `supabase_error`, not `auth_expired`, before tier 3 ever sees it. Tier 3 is
 * for third-party text we didn't author where only a keyword heuristic is
 * possible.
 */
export function categorizeError(error: unknown): string {
    const msg =
        error instanceof Error ? error.message.toLowerCase() : String(error);

    // ---- Tier 1: our own fixed message wording ----

    if (
        msg.includes("logged_at is invalid") ||
        msg.includes("logged_at is in the future") ||
        msg.includes("carries no utc offset")
    )
        return "invalid_date_format";

    if (msg.includes("invalid timezone")) return "invalid_timezone";

    if (
        msg.includes("outside the plausible body-weight range") ||
        msg.includes("invalid weight value") ||
        msg.includes("invalid drink volume") ||
        msg.includes("invalid abv")
    )
        return "invalid_numeric_value";

    if (msg.includes("invalid weight unit")) return "invalid_param_value";

    if (msg.includes("no weight unit given and no preference set"))
        return "missing_required_param";

    if (msg.includes("meal not found") || msg.includes("entry not found"))
        return "record_not_found";

    if (
        msg.includes("missing supabase_url") ||
        msg.includes("missing database_url") ||
        msg.includes("off_user_agent is not configured")
    )
        return "service_misconfigured";

    if (
        msg.includes("@inlinets") ||
        msg.includes("widget source partial not found") ||
        msg.includes("@include cycle") ||
        msg.startsWith("unknown widget:")
    )
        return "internal_asset_error";

    if (
        msg.includes("failed to upload export") ||
        msg.includes("failed to create download link") ||
        msg.includes("export would be truncated")
    )
        return "export_error";

    // ---- Tier 2: every src/supabase.ts persistence throw ----

    if (msg.includes("failed to ") || msg.includes("supabase"))
        return "supabase_error";

    // ---- Tier 3: keyword heuristics for third-party error text ----

    if (
        msg.includes("auth") ||
        msg.includes("token") ||
        msg.includes("jwt") ||
        msg.includes("unauthorized") ||
        msg.includes("invalid api key") ||
        msg.includes("expired")
    )
        return "auth_expired";
    if (msg.includes("rate") || msg.includes("limit") || msg.includes("429"))
        return "rate_limited";
    if (msg.includes("date") || msg.includes("format"))
        return "invalid_date_format";
    if (msg.includes("required") || msg.includes("missing"))
        return "missing_required_param";
    if (
        msg.includes("network") ||
        msg.includes("fetch") ||
        msg.includes("econnrefused") ||
        msg.includes("timeout") ||
        msg.includes("timed out")
    )
        return "network_error";

    return "unknown";
}

function calculateDateRangeDays(
    startDate?: string,
    endDate?: string,
): number | undefined {
    if (!startDate) return undefined;

    const start = new Date(startDate);
    if (isNaN(start.getTime())) return undefined;

    if (!endDate) return 0; // single date

    const end = new Date(endDate);
    if (isNaN(end.getTime())) return undefined;

    return Math.round(
        Math.abs(end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
    );
}

function persistAnalytics(record: AnalyticsRecord): void {
    getSupabase()
        .from("tool_analytics")
        .insert(record)
        .then(({ error }) => {
            if (error) {
                console.warn(
                    `Failed to persist analytics for ${record.tool_name}:`,
                    error.message,
                );
            }
        });
}

/**
 * Wrap a tool handler with timing + analytics.
 *
 * A handler that returns normally counts as a success. Tools that report failure
 * in their own payload instead of throwing (bulk_import_meals returns a
 * structured report rather than an error, so hosts don't drop the per-row
 * detail) must pass `options.outcome`, or their failures show up as successes in
 * tool_analytics.
 */
export async function withAnalytics<T>(
    toolName: string,
    handler: () => Promise<T>,
    context: AnalyticsContext,
    args?: Record<string, unknown>,
    options?: {
        outcome?: (result: T) => { success: boolean; errorCategory?: string };
    },
): Promise<T> {
    const start = performance.now();
    const invokedAt = new Date().toISOString();
    const dateRangeDays = calculateDateRangeDays(
        args?.start_date as string | undefined,
        args?.end_date as string | undefined,
    );

    try {
        const result = await handler();
        const durationMs = Math.round(performance.now() - start);
        const outcome = options?.outcome?.(result) ?? { success: true };

        if (outcome.success) {
            console.log(
                `[analytics] ${toolName} success ${durationMs}ms user=${context.userId}`,
            );
        } else {
            console.warn(
                `[analytics] ${toolName} reported-failure=${outcome.errorCategory ?? "unknown"} ${durationMs}ms user=${context.userId}`,
            );
        }

        persistAnalytics({
            user_id: context.userId,
            tool_name: toolName,
            success: outcome.success,
            duration_ms: durationMs,
            error_category: outcome.success
                ? undefined
                : (outcome.errorCategory ?? "unknown"),
            date_range_days: dateRangeDays,
            mcp_session_id: context.sessionId,
            invoked_at: invokedAt,
        });

        return result;
    } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        const errorCategory = categorizeError(error);

        console.warn(
            `[analytics] ${toolName} error=${errorCategory} ${durationMs}ms user=${context.userId}: ${error instanceof Error ? error.message : String(error)}`,
        );

        persistAnalytics({
            user_id: context.userId,
            tool_name: toolName,
            success: false,
            duration_ms: durationMs,
            error_category: errorCategory,
            date_range_days: dateRangeDays,
            mcp_session_id: context.sessionId,
            invoked_at: invokedAt,
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        } as T;
    }
}
