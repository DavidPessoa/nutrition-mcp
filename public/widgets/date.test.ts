// Behaviour tests for the shared calendar-day partial.
//
// Widget code is inline template JS, so it has no import surface: `date.js` is
// evaluated here the way the assembler splices it into a page.
import { test, expect } from "bun:test";

const SRC = "./public/widgets/src";

const dateApi = await (async () => {
    const src = await Bun.file(`${SRC}/shared/date.js`).text();
    const factory = new Function(`${src}\nreturn { shortDate, isToday };`);
    return factory() as {
        shortDate: (iso: string) => string;
        isToday: (iso: string) => boolean;
    };
})();

test("shortDate formats a valid ISO calendar day", () => {
    expect(dateApi.shortDate("2026-07-11")).toBe("11 Jul");
    expect(dateApi.shortDate("2026-01-05")).toBe("5 Jan");
});

test("shortDate passes through a non-date-shaped string untouched", () => {
    expect(dateApi.shortDate("not-a-date")).toBe("not-a-date");
    expect(dateApi.shortDate("2026-7-11")).toBe("2026-7-11");
    expect(dateApi.shortDate("")).toBe("");
});

test("isToday is true for the viewer's local calendar day", () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    expect(dateApi.isToday(`${y}-${m}-${d}`)).toBe(true);
});

test("isToday is false for a fixed past date", () => {
    expect(dateApi.isToday("2020-01-01")).toBe(false);
});
