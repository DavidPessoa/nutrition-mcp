import { test, expect } from "bun:test";

// The public pages are the only place the product describes ITSELF, and they
// are the surface that goes stale first: a nutrient ships across the server,
// the widgets, the importer and the tool descriptions, and the landing page
// keeps listing the old set. Caffeine did exactly that — README.md,
// public/llms.txt and public/tools.html named it while public/index.html and
// the generated comparison pages still enumerated the tracked set without it,
// so a visitor read "caffeine is not tracked" while their assistant was told
// it was. These tests pin the enumerations, not the prose around them.

const normalize = (s: string) =>
    s
        .replace(/\s+/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&rsquo;/g, "'")
        .trim();

const index = await Bun.file("./public/index.html").text();

// The FAQ answer exists twice: once as JSON-LD, which is what Google indexes
// and may surface as a rich result, and once as the visible <details> a human
// reads. Two copies of one sentence is a drift generator — this is the guard.
function trackAnswers() {
    const jsonLd = index.match(
        /"name": "What can I track\?",\s*"acceptedAnswer": \{\s*"@type": "Answer",\s*"text": "([^"]+)"/,
    )?.[1];
    const visible = index.match(
        /<summary>What can I track\?<\/summary>\s*<p>([\s\S]*?)<\/p>/,
    )?.[1];
    return { jsonLd, visible };
}

test("the landing page's two 'What can I track?' answers say the same thing", () => {
    const { jsonLd, visible } = trackAnswers();
    expect(jsonLd).toBeTruthy();
    expect(visible).toBeTruthy();
    expect(normalize(visible!)).toBe(normalize(jsonLd!));
});

test("both name caffeine, and name it in milligrams", () => {
    const { jsonLd, visible } = trackAnswers();
    for (const answer of [jsonLd!, visible!]) {
        const t = normalize(answer);
        expect(t).toContain("Caffeine");
        expect(t).toContain("milligrams");
    }
});

// The two feature cards that enumerate what is logged and what limits can be
// set. The barcode card is deliberately excluded: Open Food Facts' caffeine
// path is out of scope, so lookup_barcode still leaves caffeine null and the
// card must keep saying so by omission.
test("the landing page's feature cards list caffeine where they list nutrients", () => {
    const cards = [
        ...index.matchAll(/<h3>([^<]+)<\/h3>\s*<p>([\s\S]*?)<\/p>/g),
    ];
    const byTitle = new Map(
        cards.map((m) => [normalize(m[1]!), normalize(m[2]!)]),
    );

    const meals = byTitle.get("Meals in plain language");
    expect(meals).toBeTruthy();
    expect(meals).toContain("caffeine");

    const goals = byTitle.get("Goals & progress");
    expect(goals).toBeTruthy();
    expect(goals).toContain("caffeine");

    // And the one that must NOT claim it.
    const barcode = byTitle.get("Scan a barcode");
    expect(barcode).toBeTruthy();
    expect(barcode).not.toContain("caffeine");
});

// The comparison pages are generated. Editing the HTML directly is silently
// undone by the next `bun run scripts/gen-alternatives.ts`, so the copy has to
// be right in the generator AND regenerated — this asserts both halves landed.
const generator = await Bun.file("./scripts/gen-alternatives.ts").text();

test("the comparison-page generator names caffeine in the tracked set", () => {
    expect(generator).toContain("caffeine");
    // The shared right-hand column and the shared feature card, which every
    // page carries verbatim.
    expect(generator).toContain(
        "calories, macros, fiber, sugar &amp; caffeine estimated for you",
    );
});

test("every generated comparison page is in step with it", async () => {
    const files = [
        "cronometer",
        "myfitnesspal",
        "lose-it",
        "macrofactor",
        "yazio",
        "lifesum",
    ];
    for (const slug of files) {
        const html = await Bun.file(
            `./public/alternatives/${slug}.html`,
        ).text();
        expect(html.toLowerCase(), `${slug}.html omits caffeine`).toContain(
            "caffeine",
        );
    }
});

// Cronometer is the one export in the list that actually ships a
// "Caffeine (mg)" column, which the importer's ALIASES table auto-maps — so
// its page is the one that would be actively wrong, not merely incomplete,
// if it kept telling switchers their caffeine history stays behind.
test("the Cronometer page says its caffeine column crosses over", async () => {
    const html = normalize(
        await Bun.file("./public/alternatives/cronometer.html").text(),
    );
    expect(html).toContain("Caffeine (mg) column");
    // And the 1000x guard is explained rather than left as a blank row.
    expect(html).toContain("headed in grams is left unmapped");
    // The out-of-scope claim is still not made anywhere on the page.
    expect(html).not.toContain("caffeine from Open Food Facts");
});
