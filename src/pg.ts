import { SQL } from "bun";
import { createHash, createHmac, timingSafeEqual as tse } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
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

export function signExportToken(
    path: string,
    expiresAtMs: number,
    secret: string,
): string {
    const payload = `${Buffer.from(path, "utf8").toString("base64url")}.${expiresAtMs}`;
    const sig = createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");
    return `${payload}.${sig}`;
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
    const payload = `${pathB64}.${expStr}`;
    const expected = createHmac("sha256", secret)
        .update(payload)
        .digest("base64url");
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

function mapValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return value;
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
        if (k === "id" || k === "user_id" || k === "token" || k === "code") {
            out[k] = v instanceof Date ? v.toISOString() : v;
            continue;
        }
        if (
            k === "email" ||
            k === "description" ||
            k === "notes" ||
            k === "source" ||
            k === "source_id" ||
            k === "timezone" ||
            k === "redirect_uri" ||
            k === "client_name"
        ) {
            out[k] = v;
            continue;
        }
        out[k] = mapValue(v);
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

    private async execute(): Promise<QueryResult> {
        const s = sql();
        try {
            if (this.op === "select") {
                if (this.head && this.countExact) {
                    const [row] = await s`
                        SELECT COUNT(*)::int AS n
                        FROM ${ident(this.table)}
                        WHERE ${whereFragment(this.filters)}
                    `;
                    return {
                        data: null,
                        error: null,
                        count: Number(
                            (row as { n: number } | undefined)?.n ?? 0,
                        ),
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
                return this.finish(
                    rows.map(mapRow),
                    this.countExact ? rows.length : null,
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

async function signInWithIdToken(opts: {
    provider: string;
    token: string;
    nonce: string;
}) {
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
    if (!res.ok) {
        return {
            data: { user: null },
            error: { message: "Google sign-in failed" },
        };
    }
    const claims = (await res.json()) as {
        aud?: string;
        email?: string;
        sub?: string;
        nonce?: string;
    };
    if (claims.aud !== clientId || !claims.email || !claims.sub) {
        return {
            data: { user: null },
            error: { message: "Google sign-in failed" },
        };
    }
    const wantNonce = hashedGoogleNonce(opts.nonce);
    if (
        claims.nonce &&
        claims.nonce !== wantNonce &&
        claims.nonce !== opts.nonce
    ) {
        return {
            data: { user: null },
            error: { message: "Google sign-in failed" },
        };
    }
    const s = sql();
    const [bySub] =
        await s`SELECT id FROM users WHERE google_sub = ${claims.sub}`;
    if (bySub) {
        return {
            data: { user: { id: (bySub as { id: string }).id } },
            error: null,
        };
    }
    const [byEmail] = await s`
        SELECT id FROM users WHERE lower(email) = lower(${claims.email})
    `;
    if (byEmail) {
        await s`UPDATE users SET google_sub = ${claims.sub} WHERE id = ${(byEmail as { id: string }).id}`;
        return {
            data: { user: { id: (byEmail as { id: string }).id } },
            error: null,
        };
    }
    const [created] = await s`
        INSERT INTO users (email, google_sub)
        VALUES (${claims.email}, ${claims.sub})
        RETURNING id
    `;
    if (!created) {
        return {
            data: { user: null },
            error: { message: "Google sign-in failed" },
        };
    }
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
                    try {
                        await unlink(filePathFor(p));
                    } catch {
                        // missing path is success, matching Storage
                    }
                }
                return { error: null };
            } catch (err) {
                return { error: pgError(err) };
            }
        },
    };
}

export async function readLocalExport(
    token: string,
): Promise<
    | { ok: true; bytes: Uint8Array; filename: string }
    | { ok: false; status: number; error: string }
> {
    const parsed = verifyExportToken(decodeURIComponent(token), exportSecret());
    if (!parsed) return { ok: false, status: 404, error: "not_found" };
    const full = resolve(filePathFor(parsed.path));
    const root = resolve(exportsDir());
    const rel = relative(root, full);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "") {
        return { ok: false, status: 404, error: "not_found" };
    }
    const file = Bun.file(full);
    if (!(await file.exists()))
        return { ok: false, status: 404, error: "not_found" };
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
