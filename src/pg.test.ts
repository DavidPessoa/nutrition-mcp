import { test, expect, describe } from "bun:test";
import {
    hashedGoogleNonce,
    isPostgresBackend,
    mapRow,
    signExportToken,
    verifyExportToken,
    verifyGoogleClaims,
} from "./pg.js";

describe("isPostgresBackend", () => {
    test("DATABASE_URL without a Supabase key is Postgres mode", () => {
        const prevUrl = process.env.DATABASE_URL;
        const prevKey = process.env.SUPABASE_SECRET_KEY;
        process.env.DATABASE_URL = "postgres://localhost/nutrition";
        delete process.env.SUPABASE_SECRET_KEY;
        try {
            expect(isPostgresBackend()).toBe(true);
        } finally {
            restore("DATABASE_URL", prevUrl);
            restore("SUPABASE_SECRET_KEY", prevKey);
        }
    });

    test("a set SUPABASE_SECRET_KEY keeps the hosted Supabase path", () => {
        const prevUrl = process.env.DATABASE_URL;
        const prevKey = process.env.SUPABASE_SECRET_KEY;
        process.env.DATABASE_URL = "postgres://localhost/nutrition";
        process.env.SUPABASE_SECRET_KEY = "service-role";
        try {
            expect(isPostgresBackend()).toBe(false);
        } finally {
            restore("DATABASE_URL", prevUrl);
            restore("SUPABASE_SECRET_KEY", prevKey);
        }
    });

    test("an empty SUPABASE_SECRET_KEY does not block Postgres mode", () => {
        const prevUrl = process.env.DATABASE_URL;
        const prevKey = process.env.SUPABASE_SECRET_KEY;
        process.env.DATABASE_URL = "postgres://localhost/nutrition";
        process.env.SUPABASE_SECRET_KEY = "";
        try {
            expect(isPostgresBackend()).toBe(true);
        } finally {
            restore("DATABASE_URL", prevUrl);
            restore("SUPABASE_SECRET_KEY", prevKey);
        }
    });
});

describe("export download tokens", () => {
    const secret = "test-oauth-client-secret";

    test("round-trips a storage path", () => {
        const exp = Date.now() + 60_000;
        const token = signExportToken(
            "abc/nutrition-mcp-export.zip",
            exp,
            secret,
        );
        expect(verifyExportToken(token, secret, Date.now())).toEqual({
            path: "abc/nutrition-mcp-export.zip",
        });
    });

    test("rejects an expired token", () => {
        const token = signExportToken("abc/file.zip", Date.now() - 1, secret);
        expect(verifyExportToken(token, secret, Date.now())).toBeNull();
    });

    test("rejects a tampered path", () => {
        const exp = Date.now() + 60_000;
        const token = signExportToken("abc/file.zip", exp, secret);
        const [pathB64, expStr, sig] = token.split(".");
        const tampered = `${Buffer.from("../etc/passwd").toString("base64url")}.${expStr}.${sig}`;
        expect(pathB64).toBeTruthy();
        expect(verifyExportToken(tampered, secret)).toBeNull();
    });

    test("rejects the wrong secret", () => {
        const token = signExportToken(
            "abc/file.zip",
            Date.now() + 60_000,
            secret,
        );
        expect(verifyExportToken(token, "other")).toBeNull();
    });
});

describe("hashedGoogleNonce", () => {
    test("is the SHA-256 hex digest oauth.ts sends to Google", () => {
        expect(hashedGoogleNonce("raw-nonce")).toBe(
            new Bun.CryptoHasher("sha256").update("raw-nonce").digest("hex"),
        );
    });
});

describe("verifyGoogleClaims", () => {
    const CLIENT = "client.apps.googleusercontent.com";
    const RAW = "raw-nonce";
    const valid = () => ({
        aud: CLIENT,
        email: "user@example.com",
        email_verified: "true",
        sub: "10769150350006150715",
        nonce: hashedGoogleNonce(RAW),
    });

    test("accepts a token minted for us, for this attempt", () => {
        expect(verifyGoogleClaims(valid(), CLIENT, RAW)).toEqual({
            ok: true,
            email: "user@example.com",
            sub: "10769150350006150715",
        });
    });

    test("accepts email_verified as a real boolean", () => {
        expect(
            verifyGoogleClaims(
                { ...valid(), email_verified: true },
                CLIENT,
                RAW,
            ).ok,
        ).toBe(true);
    });

    test("accepts the raw nonce as well as its digest", () => {
        expect(
            verifyGoogleClaims({ ...valid(), nonce: RAW }, CLIENT, RAW).ok,
        ).toBe(true);
    });

    test("rejects a token minted for another client", () => {
        expect(verifyGoogleClaims(valid(), "someone-else", RAW).ok).toBe(false);
    });

    // An unverified address is enough to claim the matching local account, so
    // this is the check standing between a Workspace admin's arbitrary email
    // claim and someone else's meals.
    test("rejects an unverified email", () => {
        expect(
            verifyGoogleClaims(
                { ...valid(), email_verified: "false" },
                CLIENT,
                RAW,
            ).ok,
        ).toBe(false);
        const { email_verified: _omitted, ...noClaim } = valid();
        expect(verifyGoogleClaims(noClaim, CLIENT, RAW).ok).toBe(false);
    });

    test("rejects a token carrying another attempt's nonce", () => {
        expect(
            verifyGoogleClaims(
                { ...valid(), nonce: hashedGoogleNonce("other") },
                CLIENT,
                RAW,
            ).ok,
        ).toBe(false);
    });

    // We always ask Google for a nonce, so a token without one was minted for
    // a different flow and is being replayed at us.
    test("rejects a token with no nonce at all", () => {
        const { nonce: _omitted, ...noNonce } = valid();
        expect(verifyGoogleClaims(noNonce, CLIENT, RAW).ok).toBe(false);
    });
});

describe("mapRow", () => {
    test("parses numeric columns Postgres returns as strings", () => {
        expect(
            mapRow({
                protein_g: "31.5",
                sodium_mg: "480",
                vitamin_d_mcg: "2",
                amount_ml: "500",
                calories: "620",
                daily_calories: "2200",
                duration_ms: "12",
            }),
        ).toEqual({
            protein_g: 31.5,
            sodium_mg: 480,
            vitamin_d_mcg: 2,
            amount_ml: 500,
            calories: 620,
            daily_calories: 2200,
            duration_ms: 12,
        });
    });

    // The reason the coercion is an allow-list: source_id holds String(fdcId),
    // and a digits-in, number-out rule would hand the cache a key that no
    // longer equals the one it was stored under.
    test("leaves all-digit text columns alone", () => {
        expect(
            mapRow({
                source_id: "2341752",
                google_sub: "10769150350006150715",
                idempotency_key: "12345",
                description: "100",
            }),
        ).toEqual({
            source_id: "2341752",
            google_sub: "10769150350006150715",
            idempotency_key: "12345",
            description: "100",
        });
    });

    test("renders timestamps as ISO strings and passes null through", () => {
        expect(
            mapRow({
                logged_at: new Date("2026-03-01T12:00:00.000Z"),
                notes: null,
                fiber_g: null,
            }),
        ).toEqual({
            logged_at: "2026-03-01T12:00:00.000Z",
            notes: null,
            fiber_g: null,
        });
    });

    test("keeps a non-numeric value in a numeric column as-is", () => {
        expect(mapRow({ protein_g: "" })).toEqual({ protein_g: "" });
        expect(mapRow({ protein_g: "NaN" })).toEqual({ protein_g: "NaN" });
    });
});

function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}
