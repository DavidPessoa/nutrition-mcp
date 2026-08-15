/**
 * A minimal, dependency-free ZIP writer.
 *
 * Store-only (method 0, no deflate): the archive holds a handful of small CSVs
 * and a README, so a compression dependency buys a few kilobytes in exchange
 * for a supply-chain surface on a server that mostly moves text. Every ZIP
 * reader in existence handles stored entries.
 *
 * The format is unforgiving in a specific way: readers disagree about which
 * copy of the metadata they trust. Some walk the local file headers front to
 * back, others seek the End Of Central Directory record and read only the
 * central directory. A wrong offset or size therefore produces a file that
 * opens fine in one tool and is rejected as corrupt by the next, so both
 * copies are written from the same computed numbers rather than assembled
 * independently.
 */

export interface ZipEntry {
    name: string;
    data: string;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;

/** PKZIP 2.0 — the floor for a stored entry with no extras. */
const VERSION_NEEDED = 20;

/**
 * General-purpose bit 11: filenames and text content are UTF-8. Without it a
 * reader is entitled to decode names as IBM Code Page 437, which mangles any
 * non-ASCII filename — and, more subtly, tells nothing about the payload, so
 * a CSV holding "Café" is at the reader's mercy.
 */
const FLAG_UTF8 = 0x0800;

const encoder = new TextEncoder();

let crcTable: Uint32Array | undefined;

/**
 * CRC-32 lookup table for the reflected IEEE 802.3 polynomial (0xEDB88320).
 * Built on first use rather than at module load: `src/zip.ts` is imported by
 * the MCP wiring regardless of whether anyone ever exports, and 1 KB of table
 * plus 2048 shifts is pure waste for a process that never zips anything.
 */
function getCrcTable(): Uint32Array {
    if (crcTable) return crcTable;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let bit = 0; bit < 8; bit++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    crcTable = table;
    return table;
}

/**
 * CRC-32 of `data`, as an unsigned 32-bit value.
 *
 * The `>>> 0` at the end is not decoration: JS bitwise ops yield signed 32-bit
 * ints, so the final XOR produces a negative number for most inputs, and
 * `DataView.setUint32` would then be handed something it has to coerce.
 */
export function crc32(data: Uint8Array): number {
    const table = getCrcTable();
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS date/time, the only timestamp a base ZIP record carries.
 *
 * Three quirks, all of which silently produce a plausible-looking wrong date:
 * the year is an offset from 1980 (and anything earlier is unrepresentable —
 * clamped, not wrapped, because a negative offset would roll into a far-future
 * year), the month is 1-based where `Date.getUTCMonth()` is 0-based, and the
 * seconds field holds *two-second* units, so odd seconds are simply lost.
 *
 * Read in UTC deliberately. DOS timestamps are zone-less local wall clock, so
 * using the host's local components would make the same `Date` produce
 * different bytes on a laptop and on the deploy box — and byte-for-byte
 * determinism for a given `Date` is something the tests rely on.
 */
function dosDateTime(d: Date): { time: number; date: number } {
    const year = d.getUTCFullYear();
    if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01 00:00
    const time =
        (d.getUTCHours() << 11) |
        (d.getUTCMinutes() << 5) |
        (d.getUTCSeconds() >> 1);
    const date =
        ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    return { time, date };
}

interface PreparedEntry {
    name: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
}

/**
 * Build a ZIP archive containing `entries`, in the order given.
 *
 * Pure: no I/O, no shared state beyond the lazily-built CRC table. Passing an
 * explicit `modifiedAt` makes the output byte-for-byte reproducible.
 */
export function buildZip(
    entries: ZipEntry[],
    modifiedAt: Date = new Date(),
): Uint8Array {
    const { time: dosTime, date: dosDate } = dosDateTime(modifiedAt);

    // Encode first, then size the buffer from the encoded lengths. Sizes and
    // offsets are BYTE counts: a single multi-byte character anywhere in a
    // name or a payload would, if measured with `String.length`, understate
    // every subsequent local-header offset and desynchronise the whole file.
    const prepared: PreparedEntry[] = [];
    let offset = 0;
    let centralSize = 0;
    for (const entry of entries) {
        const name = encoder.encode(entry.name);
        const data = encoder.encode(entry.data);
        prepared.push({ name, data, crc: crc32(data), offset });
        offset += LOCAL_HEADER_SIZE + name.length + data.length;
        centralSize += CENTRAL_HEADER_SIZE + name.length;
    }
    const centralOffset = offset;

    const out = new Uint8Array(centralOffset + centralSize + EOCD_SIZE);
    const view = new DataView(out.buffer);

    // ZIP is little-endian throughout; the `true` on every write is what says so.
    let p = 0;
    for (const entry of prepared) {
        view.setUint32(p, LOCAL_HEADER_SIG, true);
        view.setUint16(p + 4, VERSION_NEEDED, true);
        view.setUint16(p + 6, FLAG_UTF8, true);
        view.setUint16(p + 8, 0, true); // method 0 = stored
        view.setUint16(p + 10, dosTime, true);
        view.setUint16(p + 12, dosDate, true);
        view.setUint32(p + 14, entry.crc, true);
        // Stored, so compressed and uncompressed sizes are the same number.
        view.setUint32(p + 18, entry.data.length, true);
        view.setUint32(p + 22, entry.data.length, true);
        view.setUint16(p + 26, entry.name.length, true);
        view.setUint16(p + 28, 0, true); // no extra field
        p += LOCAL_HEADER_SIZE;
        out.set(entry.name, p);
        p += entry.name.length;
        out.set(entry.data, p);
        p += entry.data.length;
    }

    for (const entry of prepared) {
        view.setUint32(p, CENTRAL_HEADER_SIG, true);
        // "Version made by": the high byte is the host system, and 0 (MS-DOS /
        // FAT) is what keeps the zeroed external attributes below meaningful —
        // claiming Unix (3) there would declare file mode 0000.
        view.setUint16(p + 4, VERSION_NEEDED, true);
        view.setUint16(p + 6, VERSION_NEEDED, true);
        view.setUint16(p + 8, FLAG_UTF8, true);
        view.setUint16(p + 10, 0, true);
        view.setUint16(p + 12, dosTime, true);
        view.setUint16(p + 14, dosDate, true);
        view.setUint32(p + 16, entry.crc, true);
        view.setUint32(p + 20, entry.data.length, true);
        view.setUint32(p + 24, entry.data.length, true);
        view.setUint16(p + 28, entry.name.length, true);
        view.setUint16(p + 30, 0, true); // extra field length
        view.setUint16(p + 32, 0, true); // file comment length
        view.setUint16(p + 34, 0, true); // disk number start
        view.setUint16(p + 36, 0, true); // internal attributes
        view.setUint32(p + 38, 0, true); // external attributes
        view.setUint32(p + 42, entry.offset, true);
        p += CENTRAL_HEADER_SIZE;
        out.set(entry.name, p);
        p += entry.name.length;
    }

    view.setUint32(p, EOCD_SIG, true);
    view.setUint16(p + 4, 0, true); // this disk
    view.setUint16(p + 6, 0, true); // disk holding the central directory
    // Entries on this disk and entries in total — identical for a single-disk
    // archive, but both must be written; a zero in either makes readers that
    // trust the count report an empty archive for a file full of data.
    view.setUint16(p + 8, prepared.length, true);
    view.setUint16(p + 10, prepared.length, true);
    view.setUint32(p + 12, centralSize, true);
    view.setUint32(p + 16, centralOffset, true);
    view.setUint16(p + 20, 0, true); // no archive comment

    return out;
}
