import { SQL } from "bun";
import { createHash, createHmac, timingSafeEqual as tse } from "node:crypto";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const PGRST_NO_ROWS = "PGRST116";
const IDENT = /^[a-z_][a-z0-9_]*$/i;

type Filter =
    | {
          kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "ilike";
          col: string;
          val: unknown;
      }
    | { kind: "in"; col: string; val: unknown[] };

type Order = { col: string; ascending: boolean };

type QueryResult = {
    data: unknown;
    error: { message: string; code?: string } | null;
    count: number | null;
};

export function isPostgresBackend(): boolean {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    const supabaseKey = process.env.SUPABASE_SECRET_KEY?.trim();
    return Boolean(databaseUrl) && !supabaseKey;
}

function exportsDir(): string {
    return process.env.EXPORTS_DIR || "./exports";
}

function exportSecret(): string {
    const secret = process.env.OAUTH_CLIENT_SECRET;
    if (!secret) throw new Error("Missing OAUTH_CLIENT_SECRET");
    return secret;
}

// OAUTH_CLIENT_SECRET signs these as well as OAuth material, so the signed
// input carries what it is for. Without it, one key authenticates two different
// grammars and a string that parses as both would be valid in either.
const EXPORT_TOKEN_CONTEXT = "nutrition-mcp/export-download/v1";

function exportTokenSignature(payload: string, secret: string): string {
    return createHmac("sha256", secret)
        .update(`${EXPORT_TOKEN_CONTEXT}.${payload}`)
        .digest("base64url");
}

export function signExportToken(
    path: string,
    expiresAtMs: number,
    secret: string,
): string {
    const payload = `${Buffer.from(path, "utf8").toString("base64url")}.${expiresAtMs}`;
    return `${payload}.${exportTokenSignature(payload, secret)}`;
}

export function verifyExportToken(
    token: string,
    secret: string,
    now = Date.now(),
): { path: string } | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [pathB64, expStr, sig] = parts;
    if (!pathB64 || !expStr || !sig) return null;
    const expected = exportTokenSignature(`${pathB64}.${expStr}`, secret);
    if (expected.length !== sig.length) return null;
    if (!timingSafeEqual(expected, sig)) return null;
    const expiresAtMs = Number(expStr);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < now) return null;
    try {
        return { path: Buffer.from(pathB64, "base64url").toString("utf8") };
    } catch {
        return null;
    }
}

function timingSafeEqual(a: string, b: string): boolean {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);
    if (aa.length !== bb.length) return false;
    return tse(aa, bb);
}

let _sql: InstanceType<typeof SQL> | undefined;

function sql(): InstanceType<typeof SQL> {
    if (!_sql) {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("Missing DATABASE_URL");
        _sql = new SQL(url);
    }
    return _sql;
}

function ident(name: string) {
    if (!IDENT.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
    return sql()(name);
}

function pgError(err: unknown): { message: string; code?: string } {
    if (err && typeof err === "object") {
        const o = err as { message?: unknown; code?: unknown };
        const message = typeof o.message === "string" ? o.message : String(err);
        const code = typeof o.code === "string" ? o.code : undefined;
        return { message, code };
    }
    return { message: String(err) };
}

/**
 * Columns Postgres hands back as strings because they are `numeric`, and that
 * the app expects as JS numbers (PostgREST parses them for us).
 *
 * This is an allow-list of the numeric columns rather than a deny-list of the
 * text ones on purpose. Coercing anything that merely *looks* numeric silently
 * turns a new all-digits text column into a number — `food_cache.source_id`
 * holds `String(fdcId)` and is one rename away from being exactly that. An
 * unrecognized column now stays a string, which is the harmless direction.
 */
const NUMERIC_COLUMN = /_(g|mg|mcg|ml|ms|days)$|^(daily_)?calories$/;

export function mapRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        if (v instanceof Date) {
            out[k] = v.toISOString();
            continue;
        }
        if (typeof v === "string" && v !== "" && NUMERIC_COLUMN.test(k)) {
            const n = Number(v);
            out[k] = Number.isFinite(n) ? n : v;
            continue;
        }
        out[k] = v;
    }
    return out;
}

function prepareInsert(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        if (v === undefined) continue;
        if (
            v !== null &&
            typeof v === "object" &&
            !(v instanceof Date) &&
            !Array.isArray(v)
        ) {
            out[k] = JSON.stringify(v);
            continue;
        }
        out[k] = v;
    }
    return out;
}

function whereFragment(filters: Filter[]) {
    const s = sql();
    let where = s`TRUE`;
    for (const f of filters) {
        if (f.kind === "in") {
            if (f.val.length === 0) {
                where = s`${where} AND FALSE`;
                continue;
            }
            where = s`${where} AND ${ident(f.col)} IN ${s(f.val)}`;
            continue;
        }
        const col = ident(f.col);
        switch (f.kind) {
            case "eq":
                where = s`${where} AND ${col} = ${f.val}`;
                break;
            case "neq":
                where = s`${where} AND ${col} <> ${f.val}`;
                break;
            case "gt":
                where = s`${where} AND ${col} > ${f.val}`;
                break;
            case "gte":
                where = s`${where} AND ${col} >= ${f.val}`;
                break;
            case "lt":
                where = s`${where} AND ${col} < ${f.val}`;
                break;
            case "lte":
                where = s`${where} AND ${col} <= ${f.val}`;
                break;
            case "ilike":
                where = s`${where} AND ${col} ILIKE ${f.val}`;
                break;
        }
    }
    return where;
}

function orderFragment(orders: Order[]) {
    const s = sql();
    if (orders.length === 0) return s``;
    let frag = s`ORDER BY`;
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]!;
        const dir = o.ascending ? s`ASC` : s`DESC`;
        frag =
            i === 0
                ? s`${frag} ${ident(o.col)} ${dir}`
                : s`${frag}, ${ident(o.col)} ${dir}`;
    }
    return frag;
}

function selectList(columns: string) {
    const s = sql();
    if (columns.trim() === "*") return s`*`;
    const names = columns
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    let frag = s`${ident(names[0]!)}`;
    for (let i = 1; i < names.length; i++) {
        frag = s`${frag}, ${ident(names[i]!)}`;
    }
    return frag;
}

function conflictTargets(onConflict: string) {
    return onConflict
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
}

class Query {
    private table: string;
    private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    private columns = "*";
    private filters: Filter[] = [];
    private orders: Order[] = [];
    private payload: Record<string, unknown> = {};
    private onConflict: string | null = null;
    private returning = false;
    private resultMode: "many" | "single" | "maybeSingle" = "many";
    private countExact = false;
    private head = false;
    private limitTo: number | null = null;
    private offsetBy: number | null = null;

    constructor(table: string) {
        this.table = table;
    }

    select(cols?: string, opts?: { count?: string; head?: boolean }) {
        if (cols) this.columns = cols;
        if (
            this.op === "insert" ||
            this.op === "update" ||
            this.op === "delete" ||
            this.op === "upsert"
        ) {
            this.returning = true;
        } else {
            this.op = "select";
        }
        if (opts?.count === "exact") this.countExact = true;
        if (opts?.head) this.head = true;
        return this;
    }

    insert(row: Record<string, unknown>) {
        this.op = "insert";
        this.payload = row;
        return this;
    }

    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
        this.op = "upsert";
        this.payload = row;
        this.onConflict = opts?.onConflict ?? null;
        return this;
    }

    update(row: Record<string, unknown>) {
        this.op = "update";
        this.payload = row;
        return this;
    }

    delete() {
        this.op = "delete";
        return this;
    }

    eq(col: string, val: unknown) {
        this.filters.push({ kind: "eq", col, val });
        return this;
    }

    neq(col: string, val: unknown) {
        this.filters.push({ kind: "neq", col, val });
        return this;
    }

    gt(col: string, val: unknown) {
        this.filters.push({ kind: "gt", col, val });
        return this;
    }

    gte(col: string, val: unknown) {
        this.filters.push({ kind: "gte", col, val });
        return this;
    }

    lt(col: string, val: unknown) {
        this.filters.push({ kind: "lt", col, val });
        return this;
    }

    lte(col: string, val: unknown) {
        this.filters.push({ kind: "lte", col, val });
        return this;
    }

    in(col: string, val: unknown[]) {
        this.filters.push({ kind: "in", col, val });
        return this;
    }

    ilike(col: string, val: unknown) {
        this.filters.push({ kind: "ilike", col, val });
        return this;
    }

    order(col: string, opts?: { ascending?: boolean }) {
        this.orders.push({ col, ascending: opts?.ascending !== false });
        return this;
    }

    range(from: number, to: number) {
        this.offsetBy = from;
        this.limitTo = to - from + 1;
        return this;
    }

    limit(n: number) {
        this.limitTo = n;
        return this;
    }

    maybeSingle() {
        this.resultMode = "maybeSingle";
        return this.execute();
    }

    single() {
        this.resultMode = "single";
        return this.execute();
    }

    then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?:
            ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:
            ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected);
    }

    private finish(
        rows: Record<string, unknown>[],
        count: number | null,
    ): QueryResult {
        if (this.resultMode === "maybeSingle") {
            if (rows.length > 1) {
                return {
                    data: null,
                    error: {
                        message: "Multiple rows returned",
                        code: "PGRST116",
                    },
                    count,
                };
            }
            return { data: rows[0] ?? null, error: null, count };
        }
        if (this.resultMode === "single") {
            if (rows.length !== 1) {
                return {
                    data: null,
                    error: {
                        message:
                            rows.length === 0
                                ? "JSON object requested, multiple (or no) rows returned"
                                : "Multiple rows returned",
                        code: PGRST_NO_ROWS,
                    },
                    count,
                };
            }
            return { data: rows[0], error: null, count };
        }
        return { data: rows, error: null, count };
    }

    private async countRows(): Promise<number> {
        const s = sql();
        const [row] = await s`
            SELECT COUNT(*)::int AS n
            FROM ${ident(this.table)}
            WHERE ${whereFragment(this.filters)}
        `;
        return Number((row as { n: number } | undefined)?.n ?? 0);
    }

    private async execute(): Promise<QueryResult> {
        const s = sql();
        try {
            if (this.op === "select") {
                if (this.head && this.countExact) {
                    return {
                        data: null,
                        error: null,
                        count: await this.countRows(),
                    };
                }
                const limitFrag =
                    this.limitTo == null ? s`` : s`LIMIT ${this.limitTo}`;
                const offsetFrag =
                    this.offsetBy == null ? s`` : s`OFFSET ${this.offsetBy}`;
                const rows = (await s`
                    SELECT ${selectList(this.columns)}
                    FROM ${ident(this.table)}
                    WHERE ${whereFragment(this.filters)}
                    ${orderFragment(this.orders)}
                    ${limitFrag}
                    ${offsetFrag}
                `) as Record<string, unknown>[];
                // count is the number of matching rows, not the number
                // returned. Reporting the page length instead would defeat the
                // reconciliation in getAllMeals, whose whole job is to notice a
                // paged read that came back short.
                return this.finish(
                    rows.map(mapRow),
                    this.countExact ? await this.countRows() : null,
                );
            }

            if (this.op === "insert") {
                if (this.table === "registered_clients") {
                    const name = this.payload.client_name ?? null;
                    const uris = Array.isArray(this.payload.redirect_uris)
                        ? this.payload.redirect_uris
                        : [];
                    if (this.returning) {
                        const rows = (await s`
                            INSERT INTO registered_clients (client_name, redirect_uris)
                            VALUES (${name}, ${s.array(uris as string[])})
                            RETURNING *
                        `) as Record<string, unknown>[];
                        return this.finish(rows.map(mapRow), null);
                    }
                    await s`
                        INSERT INTO registered_clients (client_name, redirect_uris)
                        VALUES (${name}, ${s.array(uris as string[])})
                    `;
                    return { data: null, error: null, count: null };
                }
                const row = prepareInsert(this.payload);
                if (this.returning) {
                    const rows = (await s`
                        INSERT INTO ${ident(this.table)} ${s(row)}
                        RETURNING *
                    `) as Record<string, unknown>[];
                    return this.finish(rows.map(mapRow), null);
                }
                await s`INSERT INTO ${ident(this.table)} ${s(row)}`;
                return { data: null, error: null, count: null };
            }

            if (this.op === "upsert") {
                const row = prepareInsert(this.payload);
                const targets = this.onConflict
                    ? conflictTargets(this.onConflict)
                    : [];
                if (targets.length === 0) {
                    throw new Error("upsert requires onConflict");
                }
                const update: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(row)) {
                    if (!targets.includes(k)) update[k] = v;
                }
                let conflict = s`${ident(targets[0]!)}`;
                for (let i = 1; i < targets.length; i++) {
                    conflict = s`${conflict}, ${ident(targets[i]!)}`;
                }
                const returningFrag = this.returning ? s`RETURNING *` : s``;
                const rows = (
                    Object.keys(update).length === 0
                        ? await s`
                              INSERT INTO ${ident(this.table)} ${s(row)}
                              ON CONFLICT (${conflict}) DO NOTHING
                              ${returningFrag}
                          `
                        : await s`
                              INSERT INTO ${ident(this.table)} ${s(row)}
                              ON CONFLICT (${conflict}) DO UPDATE SET ${s(update)}
                              ${returningFrag}
                          `
                ) as Record<string, unknown>[];
                return this.returning
                    ? this.finish(rows.map(mapRow), null)
                    : { data: null, error: null, count: null };
            }

            if (this.op === "update") {
                const row = prepareInsert(this.payload);
                const returningFrag = this.returning ? s`RETURNING *` : s``;
                const rows = (await s`
                    UPDATE ${ident(this.table)}
                    SET ${s(row)}
                    WHERE ${whereFragment(this.filters)}
                    ${returningFrag}
                `) as Record<string, unknown>[];
                return this.returning
                    ? this.finish(rows.map(mapRow), null)
                    : { data: null, error: null, count: null };
            }

            const returningFrag = this.returning
                ? this.columns.trim() === "*"
                    ? s`RETURNING *`
                    : s`RETURNING ${selectList(this.columns)}`
                : s``;
            const rows = (await s`
                DELETE FROM ${ident(this.table)}
                WHERE ${whereFragment(this.filters)}
                ${returningFrag}
            `) as Record<string, unknown>[];
            return this.returning
                ? this.finish(rows.map(mapRow), null)
                : { data: null, error: null, count: null };
        } catch (err) {
            return { data: null, error: pgError(err), count: null };
        }
    }
}

async function signUp(email: string, password: string) {
    const hash = await Bun.password.hash(password);
    const s = sql();
    try {
        const [row] = await s`
            INSERT INTO users (email, password_hash)
            VALUES (${email}, ${hash})
            RETURNING id
        `;
        if (!row)
            return {
                data: { user: null },
                error: { message: "Sign-up failed" },
            };
        return {
            data: { user: { id: (row as { id: string }).id } },
            error: null,
        };
    } catch (err) {
        const e = pgError(err);
        if (e.code === "23505") {
            return {
                data: { user: null },
                error: { message: "User already registered" },
            };
        }
        return { data: { user: null }, error: e };
    }
}

async function signInWithPassword(email: string, password: string) {
    const s = sql();
    const [row] = await s`
        SELECT id, password_hash FROM users WHERE lower(email) = lower(${email})
    `;
    if (!row || !(row as { password_hash: string | null }).password_hash) {
        return {
            data: { user: null },
            error: { message: "Invalid login credentials" },
        };
    }
    const ok = await Bun.password.verify(
        password,
        (row as { password_hash: string }).password_hash,
    );
    if (!ok) {
        return {
            data: { user: null },
            error: { message: "Invalid login credentials" },
        };
    }
    return { data: { user: { id: (row as { id: string }).id } }, error: null };
}

export function hashedGoogleNonce(rawNonce: string): string {
    return createHash("sha256").update(rawNonce).digest("hex");
}

export type GoogleClaims = {
    aud?: string;
    email?: string;
    email_verified?: string | boolean;
    sub?: string;
    nonce?: string;
};

/**
 * Accept a Google ID token's claims, or say why not. `tokeninfo` has already
 * checked the signature, issuer and expiry, so what is left is the three things
 * only we can check: that the token was minted for *this* client, that it
 * belongs to this sign-in attempt, and that Google actually owns the address.
 *
 * `email_verified` is load-bearing rather than belt-and-braces: an unverified
 * address on a Workspace or federated account would otherwise be enough to
 * claim the matching local account below.
 */
export function verifyGoogleClaims(
    claims: GoogleClaims,
    clientId: string,
    rawNonce: string,
): { ok: true; email: string; sub: string } | { ok: false; reason: string } {
    if (claims.aud !== clientId) return { ok: false, reason: "aud mismatch" };
    if (!claims.email || !claims.sub) {
        return { ok: false, reason: "missing email or sub" };
    }
    if (claims.email_verified !== true && claims.email_verified !== "true") {
        return { ok: false, reason: "email not verified by Google" };
    }
    // A token with no nonce is rejected, not waved through: we always request
    // one, so its absence means this token was minted for some other flow and
    // is being replayed here.
    if (
        claims.nonce !== hashedGoogleNonce(rawNonce) &&
        claims.nonce !== rawNonce
    ) {
        return { ok: false, reason: "nonce mismatch" };
    }
    return { ok: true, email: claims.email, sub: claims.sub };
}

async function signInWithIdToken(opts: {
    provider: string;
    token: string;
    nonce: string;
}) {
    const fail = (reason: string) => {
        console.warn(`Google sign-in rejected: ${reason}`);
        return {
            data: { user: null },
            error: { message: "Google sign-in failed" },
        };
    };

    if (opts.provider !== "google") {
        return {
            data: { user: null },
            error: { message: "Unsupported provider" },
        };
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        return {
            data: { user: null },
            error: { message: "Google sign-in is not configured" },
        };
    }
    const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(opts.token)}`,
    );
    if (!res.ok) return fail(`tokeninfo returned ${res.status}`);

    const verified = verifyGoogleClaims(
        (await res.json()) as GoogleClaims,
        clientId,
        opts.nonce,
    );
    if (!verified.ok) return fail(verified.reason);

    const s = sql();
    const [bySub] =
        await s`SELECT id FROM users WHERE google_sub = ${verified.sub}`;
    if (bySub) {
        return {
            data: { user: { id: (bySub as { id: string }).id } },
            error: null,
        };
    }
    // Matching on email alone would be an account takeover: sign-up here needs
    // no email confirmation, so anyone can register someone else's address with
    // a password of their choosing and then inherit them the moment the real
    // owner arrives via Google. Adopt the row only when it has no password to
    // inherit — which is exactly the Google-created row whose `sub` we somehow
    // lost. Otherwise refuse and leave the password login as the way in.
    const [byEmail] = await s`
        SELECT id, password_hash FROM users WHERE lower(email) = lower(${verified.email})
    `;
    if (byEmail) {
        const existing = byEmail as {
            id: string;
            password_hash: string | null;
        };
        if (existing.password_hash) {
            return fail(
                "email already registered with a password; refusing to link",
            );
        }
        await s`UPDATE users SET google_sub = ${verified.sub} WHERE id = ${existing.id}`;
        return { data: { user: { id: existing.id } }, error: null };
    }
    const [created] = await s`
        INSERT INTO users (email, google_sub)
        VALUES (${verified.email}, ${verified.sub})
        RETURNING id
    `;
    if (!created) return fail("insert returned no row");
    return {
        data: { user: { id: (created as { id: string }).id } },
        error: null,
    };
}

async function deleteUser(userId: string) {
    const s = sql();
    try {
        await s`DELETE FROM users WHERE id = ${userId}`;
        return { data: { user: null }, error: null };
    } catch (err) {
        return { data: { user: null }, error: pgError(err) };
    }
}

function filePathFor(key: string): string {
    return join(exportsDir(), ...key.split("/").filter(Boolean));
}

function storageFrom(_bucket: string) {
    return {
        async upload(
            path: string,
            body: Uint8Array | ArrayBuffer | Blob,
            _opts?: unknown,
        ) {
            try {
                const full = filePathFor(path);
                await mkdir(dirname(full), { recursive: true });
                const bytes =
                    body instanceof Uint8Array
                        ? body
                        : body instanceof ArrayBuffer
                          ? new Uint8Array(body)
                          : new Uint8Array(await body.arrayBuffer());
                await Bun.write(full, bytes);
                return { error: null };
            } catch (err) {
                return { error: pgError(err) };
            }
        },
        async createSignedUrl(path: string, expiresInSeconds: number) {
            try {
                const expiresAtMs = Date.now() + expiresInSeconds * 1000;
                const token = signExportToken(
                    path,
                    expiresAtMs,
                    exportSecret(),
                );
                const base = (
                    process.env.PUBLIC_BASE_URL ||
                    `http://127.0.0.1:${process.env.PORT || "8080"}`
                ).replace(/\/$/, "");
                return {
                    data: {
                        signedUrl: `${base}/exports/${encodeURIComponent(token)}`,
                    },
                    error: null,
                };
            } catch (err) {
                return { data: null, error: pgError(err) };
            }
        },
        async list(prefix: string, _opts?: { limit?: number }) {
            try {
                const root = exportsDir();
                const dir = prefix ? join(root, prefix) : root;
                let entries: string[];
                try {
                    entries = await readdir(dir);
                } catch {
                    return { data: [], error: null };
                }
                const data = [];
                for (const name of entries) {
                    const st = await stat(join(dir, name));
                    data.push({
                        name,
                        created_at: st.birthtime.toISOString(),
                        updated_at: st.mtime.toISOString(),
                    });
                }
                return { data, error: null };
            } catch (err) {
                return { data: null, error: pgError(err) };
            }
        },
        async remove(paths: string[]) {
            try {
                for (const p of paths) {
                    const full = filePathFor(p);
                    try {
                        await unlink(full);
                    } catch {
                        // missing path is success, matching Storage
                    }
                    // A bucket has no directories, so the per-user folder this
                    // file lived in is an artifact of storing it on a disk.
                    // Leaving it behind would accumulate one empty directory
                    // per user who ever exported. rmdir only succeeds when the
                    // directory is empty, which is the check we want.
                    const parent = dirname(full);
                    if (resolve(parent) !== resolve(exportsDir())) {
                        try {
                            await rmdir(parent);
                        } catch {
                            // not empty, or not ours to remove
                        }
                    }
                }
                return { error: null };
            } catch (err) {
                return { error: pgError(err) };
            }
        },
    };
}

/**
 * Every failure is the same "not found": a bad signature, an expired link and a
 * swept file are indistinguishable to the caller on purpose, so a probe learns
 * nothing about which export paths exist.
 */
export async function readLocalExport(
    token: string,
): Promise<{ ok: true; bytes: Uint8Array; filename: string } | { ok: false }> {
    const parsed = verifyExportToken(decodeURIComponent(token), exportSecret());
    if (!parsed) return { ok: false };
    const full = resolve(filePathFor(parsed.path));
    const root = resolve(exportsDir());
    const rel = relative(root, full);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
        return { ok: false };
    }
    const file = Bun.file(full);
    if (!(await file.exists())) return { ok: false };
    return {
        ok: true,
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: parsed.path.split("/").pop() || "export.zip",
    };
}

async function rpc(name: string) {
    if (name !== "public_landing_stats") {
        return { data: null, error: { message: `Unknown rpc ${name}` } };
    }
    try {
        const s = sql();
        const [row] = await s`SELECT public_landing_stats() AS stats`;
        return { data: (row as { stats: unknown }).stats, error: null };
    } catch (err) {
        return { data: null, error: pgError(err) };
    }
}

export function createPgClient() {
    return {
        from(table: string) {
            return new Query(table);
        },
        rpc,
        auth: {
            signUp: ({
                email,
                password,
            }: {
                email: string;
                password: string;
            }) => signUp(email, password),
            signInWithPassword: ({
                email,
                password,
            }: {
                email: string;
                password: string;
            }) => signInWithPassword(email, password),
            signInWithIdToken,
            admin: { deleteUser },
        },
        storage: { from: storageFrom },
    };
}
