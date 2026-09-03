import { test, expect, describe, afterEach } from "bun:test";

process.env.OAUTH_CLIENT_ID ||= "test-client-id";
process.env.OAUTH_CLIENT_SECRET ||= "test-client-secret";

const { app, setShuttingDownForTest } = await import("./index.js");

afterEach(() => {
    setShuttingDownForTest(false);
});

describe("the shutdown gate", () => {
    test("is inert until shutdown begins", async () => {
        const r = await app.request("http://x/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(r.status).toBe(401);
    });

    test("runs before authenticateBearer on /mcp", async () => {
        setShuttingDownForTest(true);
        const r = await app.request("http://x/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(r.status).toBe(503);
        expect(r.headers.get("Retry-After")).toBe("1");
    });

    test("answers /mcp in the JSON-RPC envelope a client can surface", async () => {
        setShuttingDownForTest(true);
        const r = await app.request("http://x/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        const body = (await r.json()) as {
            jsonrpc?: string;
            id?: unknown;
            error?: { code?: number; message?: string };
        };
        expect(body.jsonrpc).toBe("2.0");
        expect(body.id).toBeNull();
        expect(body.error?.code).toBe(-32000);
        expect(body.error?.message).toContain("shutting down");
    });

    test("runs before the OAuth router and the landing page", async () => {
        setShuttingDownForTest(true);
        for (const path of ["/", "/authorize", "/api/stats"]) {
            const r = await app.request(`http://x${path}`);
            expect({ path, status: r.status }).toEqual({ path, status: 503 });
            expect(r.headers.get("Retry-After")).toBe("1");
            expect(await r.json()).toEqual({ error: "shutting_down" });
        }
    });

    test("gates /health too, so the load balancer stops routing here", async () => {
        setShuttingDownForTest(true);
        const r = await app.request("http://x/health");
        expect(r.status).toBe(503);
    });

    test("sits after cors, so the refusal still carries Allow-Origin", async () => {
        setShuttingDownForTest(true);
        const r = await app.request("http://x/mcp", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                Origin: "http://localhost:3000",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        expect(r.status).toBe(503);
        expect(r.headers.get("Access-Control-Allow-Origin")).toBe(
            "http://localhost:3000",
        );
    });

    test("lets cors answer preflights itself, gate or no gate", async () => {
        setShuttingDownForTest(true);
        const r = await app.request("http://x/mcp", {
            method: "OPTIONS",
            headers: {
                Origin: "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Mcp-Param-Foo",
            },
        });
        expect(r.status).toBe(204);
    });
});

describe("CORS allow-headers", () => {
    test("reflects the requested headers, covering the Mcp-Param-* family", async () => {
        const r = await app.request("http://x/mcp", {
            method: "OPTIONS",
            headers: {
                Origin: "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers":
                    "Mcp-Param-Foo, Mcp-Method, Authorization",
            },
        });
        expect(r.status).toBe(204);
        expect(r.headers.get("Access-Control-Allow-Headers")).toBe(
            "Mcp-Param-Foo,Mcp-Method,Authorization",
        );
    });

    test("reflects mcp-method and mcp-name", async () => {
        const r = await app.request("http://x/mcp", {
            method: "OPTIONS",
            headers: {
                Origin: "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "mcp-method, mcp-name",
            },
        });
        expect(r.status).toBe(204);
        expect(r.headers.get("Access-Control-Allow-Headers")).toBe(
            "mcp-method,mcp-name",
        );
    });

    test("refuses an origin outside the allowlist", async () => {
        const r = await app.request("http://x/mcp", {
            method: "OPTIONS",
            headers: {
                Origin: "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        });
        expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
});
