import { test, expect, describe } from "bun:test";
import {
    hashedGoogleNonce,
    isPostgresBackend,
    signExportToken,
    verifyExportToken,
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

function restore(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}
