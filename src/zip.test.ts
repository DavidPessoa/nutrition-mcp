import { test, expect } from "bun:test";
import { buildZip, crc32, type ZipEntry } from "./zip.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytes = (s: string) => encoder.encode(s);

// ---------- A parse-back reader ----------
//
// Deliberately written against the spec rather than against `buildZip`, and
// deliberately reading the archive the way a strict tool does: seek the End Of
// Central Directory record, walk the central directory, and follow each
// record's stored offset to the local header. Asserting on the bytes
// `buildZip` happens to emit would pass just as happily with a wrong offset in
// the central directory — the exact defect that makes an archive open in one
// unzipper and fail in another.

interface ReadEntry {
    name: string;
    content: string;
    byteLength: number;
    crc: number;
    localOffset: number;
}

interface ReadArchive {
    entries: ReadEntry[];
    /** Entry count as claimed by the EOCD, not as recovered. */
    declaredCount: number;
    /** Local file headers found by scanning the whole buffer for signatures. */
    localHeaderCount: number;
}

function readZip(buf: Uint8Array): ReadArchive {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    expect(eocd).toBeGreaterThanOrEqual(0);

    const declaredCount = view.getUint16(eocd + 10, true);
    expect(view.getUint16(eocd + 8, true)).toBe(declaredCount);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    // The central directory must end exactly where the EOCD begins.
    expect(centralOffset + centralSize).toBe(eocd);

    const entries: ReadEntry[] = [];
    let p = centralOffset;
    for (let i = 0; i < declaredCount; i++) {
        expect(view.getUint32(p, true)).toBe(0x02014b50);
        expect(view.getUint16(p + 8, true) & 0x0800).toBe(0x0800);
        expect(view.getUint16(p + 10, true)).toBe(0); // stored
        const crc = view.getUint32(p + 16, true);
        const compSize = view.getUint32(p + 20, true);
        const uncompSize = view.getUint32(p + 24, true);
        expect(compSize).toBe(uncompSize);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const localOffset = view.getUint32(p + 42, true);
        const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;

        // Follow the offset to the local header and cross-check every field
        // that is duplicated there.
        expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
        expect(view.getUint32(localOffset + 14, true)).toBe(crc);
        expect(view.getUint32(localOffset + 18, true)).toBe(compSize);
        expect(view.getUint32(localOffset + 22, true)).toBe(uncompSize);
        const localNameLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        expect(localNameLen).toBe(nameLen);
        const localName = decoder.decode(
            buf.subarray(localOffset + 30, localOffset + 30 + localNameLen),
        );
        expect(localName).toBe(name);

        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = buf.subarray(dataStart, dataStart + compSize);
        expect(crc32(data)).toBe(crc);

        entries.push({
            name,
            content: decoder.decode(data),
            byteLength: compSize,
            crc,
            localOffset,
        });
    }
    expect(p).toBe(eocd);

    let localHeaderCount = 0;
    for (let i = 0; i + 4 <= centralOffset; i++) {
        if (view.getUint32(i, true) === 0x04034b50) localHeaderCount++;
    }

    return { entries, declaredCount, localHeaderCount };
}

const FIXED_DATE = new Date("2026-03-14T15:09:26.000Z");

// ---------- CRC-32 ----------

test("crc32 matches the standard IEEE test vectors", () => {
    expect(crc32(bytes(""))).toBe(0x00000000);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(
        0x414fa339,
    );
});

test("crc32 returns an unsigned 32-bit value", () => {
    // "a" hashes to 0xE8B7BE43, whose sign bit is set — the classic place a
    // missing `>>> 0` turns the result negative.
    expect(crc32(bytes("a"))).toBe(0xe8b7be43);
    for (const s of ["", "a", "hello", "Café ☕", "x".repeat(1000)]) {
        expect(crc32(bytes(s))).toBeGreaterThanOrEqual(0);
        expect(crc32(bytes(s))).toBeLessThanOrEqual(0xffffffff);
    }
});

// ---------- Round trip ----------

test("round-trips every entry's name and content", () => {
    const entries: ZipEntry[] = [
        { name: "meals.csv", data: "id,calories\n1,420\n" },
        { name: "water.csv", data: "" },
        { name: "weight.csv", data: "logged_at,weight\r\n2026-01-01,80\r\n" },
        {
            name: "goals.csv",
            data: 'field,value\ndescription,"Café ☕, ""large"""\n',
        },
        { name: "profile.csv", data: "timezone,Europe/Kyiv\n" },
        { name: "README.txt", data: "Your nutrition-mcp export.\n" },
    ];

    const zip = buildZip(entries, FIXED_DATE);
    const read = readZip(zip);

    expect(read.declaredCount).toBe(entries.length);
    expect(read.entries.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(read.entries.map((e) => e.content)).toEqual(
        entries.map((e) => e.data),
    );
});

test("an empty entry occupies no data bytes but still gets a record", () => {
    const read = readZip(
        buildZip([{ name: "empty.csv", data: "" }], FIXED_DATE),
    );
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]!.byteLength).toBe(0);
    expect(read.entries[0]!.crc).toBe(0);
    expect(read.entries[0]!.content).toBe("");
});

test("an archive with no entries is still a valid empty archive", () => {
    const zip = buildZip([], FIXED_DATE);
    expect(zip).toHaveLength(22);
    const read = readZip(zip);
    expect(read.declaredCount).toBe(0);
    expect(read.entries).toHaveLength(0);
});

// ---------- Byte lengths, not string lengths ----------

test("sizes and offsets are byte lengths, not string lengths", () => {
    // "Café ☕" is 6 UTF-16 code units but 9 UTF-8 bytes. If the writer sized
    // anything with String.length, the second entry's local header would start
    // three bytes early and the reader would find garbage there.
    const multi = "description\nCafé ☕\n";
    const entries: ZipEntry[] = [
        { name: "one.csv", data: multi },
        { name: "two.csv", data: "plain ascii\n" },
    ];

    const read = readZip(buildZip(entries, FIXED_DATE));
    expect(multi.length).toBe(19);
    expect(read.entries[0]!.byteLength).toBe(22);
    expect(read.entries[0]!.byteLength).toBe(bytes(multi).length);
    expect(read.entries[0]!.content).toBe(multi);
    expect(read.entries[1]!.content).toBe("plain ascii\n");

    // The second entry starts after the first entry's *bytes*.
    expect(read.entries[1]!.localOffset).toBe(
        30 + bytes("one.csv").length + bytes(multi).length,
    );
});

test("a multi-byte filename is sized in bytes too", () => {
    const name = "café ☕.csv";
    const read = readZip(
        buildZip(
            [
                { name, data: "a\n" },
                { name: "after.csv", data: "b\n" },
            ],
            FIXED_DATE,
        ),
    );
    expect(read.entries[0]!.name).toBe(name);
    expect(read.entries[1]!.localOffset).toBe(30 + bytes(name).length + 2);
    expect(read.entries[1]!.content).toBe("b\n");
});

// ---------- Determinism ----------

test("the same entries and the same Date produce identical bytes", () => {
    const entries: ZipEntry[] = [
        { name: "meals.csv", data: "id,calories\n1,420\n" },
        { name: "README.txt", data: "Café ☕\r\n" },
    ];
    const a = buildZip(entries, FIXED_DATE);
    const b = buildZip(entries, new Date(FIXED_DATE.getTime()));
    expect(a).toEqual(b);
});

test("a different timestamp changes the bytes but not the content", () => {
    const entries: ZipEntry[] = [{ name: "meals.csv", data: "id\n1\n" }];
    const a = buildZip(entries, FIXED_DATE);
    const b = buildZip(entries, new Date("2020-01-02T03:04:05.000Z"));
    expect(a).not.toEqual(b);
    expect(readZip(a).entries[0]!.content).toBe(readZip(b).entries[0]!.content);
});

test("DOS date and time encode the timestamp, halving the seconds", () => {
    const zip = buildZip([{ name: "a", data: "" }], FIXED_DATE);
    const view = new DataView(zip.buffer);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    // 2026-03-14 15:09:26 UTC → seconds are stored in two-second units.
    expect(time >> 11).toBe(15);
    expect((time >> 5) & 0x3f).toBe(9);
    expect((time & 0x1f) * 2).toBe(26);
    expect(1980 + (date >> 9)).toBe(2026);
    expect((date >> 5) & 0x0f).toBe(3);
    expect(date & 0x1f).toBe(14);
    // The central directory copy must agree with the local header copy.
    const eocdOffset = zip.length - 22;
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    expect(view.getUint16(centralOffset + 12, true)).toBe(time);
    expect(view.getUint16(centralOffset + 14, true)).toBe(date);
});

test("a pre-1980 timestamp clamps instead of wrapping into the future", () => {
    const zip = buildZip([{ name: "a", data: "" }], new Date("1975-06-01"));
    const view = new DataView(zip.buffer);
    expect(1980 + (view.getUint16(12, true) >> 9)).toBe(1980);
});

// ---------- Structural counts ----------

test("local headers, central directory records and the EOCD count agree", () => {
    for (const n of [1, 2, 6, 11]) {
        const entries: ZipEntry[] = Array.from({ length: n }, (_, i) => ({
            name: `file-${i}.csv`,
            data: `row,${i}\n`.repeat(i),
        }));
        const read = readZip(buildZip(entries, FIXED_DATE));
        expect(read.declaredCount).toBe(n);
        expect(read.entries).toHaveLength(n);
        expect(read.localHeaderCount).toBe(n);
    }
});

test("entries keep their given order", () => {
    const names = ["z.csv", "a.csv", "m.csv"];
    const read = readZip(
        buildZip(
            names.map((name) => ({ name, data: name })),
            FIXED_DATE,
        ),
    );
    expect(read.entries.map((e) => e.name)).toEqual(names);
    // Offsets must increase in the same order the entries were given.
    const offsets = read.entries.map((e) => e.localOffset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
});

test("the archive starts with a local header and the UTF-8 flag", () => {
    const zip = buildZip([{ name: "meals.csv", data: "a\n" }], FIXED_DATE);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true)).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0); // stored, never deflated
});

test("a payload larger than one header's worth of bytes survives intact", () => {
    // Guards the size fields against a 16-bit truncation: 70 000 bytes does not
    // fit in a uint16, so a `setUint16` where a `setUint32` belongs shows up.
    const big = "x".repeat(70000);
    const read = readZip(
        buildZip(
            [
                { name: "big.csv", data: big },
                { name: "small.csv", data: "tail\n" },
            ],
            FIXED_DATE,
        ),
    );
    expect(read.entries[0]!.byteLength).toBe(70000);
    expect(read.entries[0]!.content).toBe(big);
    expect(read.entries[1]!.content).toBe("tail\n");
});
