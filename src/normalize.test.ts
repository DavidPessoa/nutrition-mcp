import { test, expect } from "bun:test";
import { decodeEscapeSequences } from "./normalize.js";

test("a literal \\uXXXX sequence decodes", () => {
    expect(decodeEscapeSequences("Domino's \\u041f\\u0456")).toBe(
        "Domino's Пі",
    );
});

test("a surrogate pair concatenates into one character", () => {
    // U+1F355 PIZZA as UTF-16 code units. fromCharCode on each unit, then
    // JS concatenates the pair into one character.
    expect(decodeEscapeSequences("\\uD83C\\uDF55")).toBe("🍕");
});

test("\\u{1f355} decodes", () => {
    expect(decodeEscapeSequences("\\u{1f355}")).toBe("🍕");
});

test("an out-of-range code point is left as the original text", () => {
    expect(decodeEscapeSequences("\\u{110000}")).toBe("\\u{110000}");
});

test("\\xXX decodes", () => {
    expect(decodeEscapeSequences("\\x41")).toBe("A");
});

test("a string with no backslash is returned untouched", () => {
    const input = "plain meal: oats and berries";
    expect(decodeEscapeSequences(input)).toBe(input);
});

test("a Windows-style path like C:\\users is left alone", () => {
    expect(decodeEscapeSequences("C:\\users")).toBe("C:\\users");
});
