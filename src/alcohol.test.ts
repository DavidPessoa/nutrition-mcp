import { test, expect } from "bun:test";
import {
    gramsFromDrink,
    toDrinks,
    fromDrinks,
    formatAlcohol,
    isDrinkUnit,
    mlFromFlOz,
    DRINK_UNITS,
    ETHANOL_DENSITY_G_PER_ML,
    US_STANDARD_DRINK_G,
    UK_UNIT_G,
    ML_PER_US_FL_OZ,
} from "./alcohol.js";

test("ethanol density is the CRC value, not the 0.8 shorthand", () => {
    // 0.8 inflates every figure by 1.4% and breaks the NIAAA test below.
    expect(ETHANOL_DENSITY_G_PER_ML).toBe(0.789);
});

test("all three NIAAA standard drinks compute to 14 g of ethanol", () => {
    // NIAAA defines the US standard drink three ways; they must agree.
    expect(gramsFromDrink(mlFromFlOz(12), 5)).toBe(14); // beer
    expect(gramsFromDrink(mlFromFlOz(5), 12)).toBe(14); // wine
    expect(gramsFromDrink(mlFromFlOz(1.5), 40)).toBe(14); // spirits
    expect(US_STANDARD_DRINK_G).toBe(14);
});

test("mlFromFlOz uses the US fluid ounce", () => {
    expect(ML_PER_US_FL_OZ).toBe(29.5735);
    expect(mlFromFlOz(12)).toBeCloseTo(354.882, 3);
});

test("a 330 mL 5% beer is 13.02 g — 0.93 US drinks but 1.65 UK units", () => {
    // The whole reason grams are canonical: one drink, two very different counts.
    const grams = gramsFromDrink(330, 5);
    expect(grams).toBe(13.02);
    expect(toDrinks(grams, "us")).toBe(0.93);
    expect(toDrinks(grams, "uk")).toBe(1.65);
});

test("UK units reproduce the NHS volumetric formula (ABV x mL / 1000)", () => {
    // This is the cross-check on UK_UNIT_G = 7.893: the NHS publishes units as a
    // pure volume shortcut, and our grams-based path has to land on the same
    // number to within a hundredth of a unit. At 0.8 g/mL it would not.
    expect(UK_UNIT_G).toBe(7.893);
    const drinks: [number, number][] = [
        [330, 5], // bottle of lager
        [568, 4], // pint of bitter
        [750, 13.5], // bottle of wine
        [25, 40], // single measure of spirits
        [175, 12], // medium glass of wine
        [440, 5.2], // can of strong lager
    ];
    for (const [ml, abv] of drinks) {
        const nhs = (abv * ml) / 1000;
        const ours = toDrinks(gramsFromDrink(ml, abv), "uk");
        expect(Math.abs(ours - nhs)).toBeLessThan(0.01);
    }
});

test("gramsFromDrink treats ABV as a percentage, not a fraction", () => {
    // 40 must mean a spirit, not a 0.4% near-beer.
    expect(gramsFromDrink(100, 40)).toBe(31.56);
    expect(gramsFromDrink(100, 0.4)).toBe(0.32);
});

test("zero alcohol and zero volume both yield zero grams", () => {
    expect(gramsFromDrink(330, 0)).toBe(0); // alcohol-free beer
    expect(gramsFromDrink(0, 40)).toBe(0);
    expect(toDrinks(0, "us")).toBe(0);
    expect(toDrinks(0, "uk")).toBe(0);
});

test("gramsFromDrink rejects nonsensical volumes and ABVs", () => {
    expect(() => gramsFromDrink(NaN, 5)).toThrow(/Invalid drink volume/);
    expect(() => gramsFromDrink(Infinity, 5)).toThrow(/Invalid drink volume/);
    expect(() => gramsFromDrink(-330, 5)).toThrow(/Invalid drink volume/);
    expect(() => gramsFromDrink(330, NaN)).toThrow(/Invalid ABV/);
    expect(() => gramsFromDrink(330, -1)).toThrow(/Invalid ABV/);
    expect(() => gramsFromDrink(330, 101)).toThrow(/Invalid ABV/);
    // 96% Spirytus is a real product, so the bound is inclusive at both ends.
    expect(gramsFromDrink(330, 100)).toBe(260.37);
    expect(gramsFromDrink(50, 96)).toBe(37.87);
});

test("fromDrinks is the inverse of toDrinks", () => {
    expect(fromDrinks(1, "us")).toBe(14);
    expect(fromDrinks(2, "us")).toBe(28);
    expect(fromDrinks(1, "uk")).toBe(7.89);
    for (const unit of DRINK_UNITS) {
        for (const n of [0.5, 1, 2, 3.5]) {
            expect(toDrinks(fromDrinks(n, unit), unit)).toBe(n);
        }
    }
});

test("formatAlcohol leads with grams and glosses with drinks", () => {
    expect(formatAlcohol(28, "us")).toBe("28 g (2.0 US drinks)");
    expect(formatAlcohol(28, "uk")).toBe("28 g (3.5 UK units)");
    expect(formatAlcohol(13.02, "us")).toBe("13 g (0.9 US drinks)");
    expect(formatAlcohol(13.02, "uk")).toBe("13 g (1.6 UK units)");
    expect(formatAlcohol(0, "us")).toBe("0 g (0.0 US drinks)");
});

test("formatAlcohol rounds grams to 1 decimal, matching the macro fields", () => {
    expect(formatAlcohol(17.94, "us")).toBe("17.9 g (1.3 US drinks)");
    expect(formatAlcohol(17.96, "us")).toBe("18 g (1.3 US drinks)");
});

test("isDrinkUnit guards us/uk only", () => {
    expect(isDrinkUnit("us")).toBe(true);
    expect(isDrinkUnit("uk")).toBe(true);
    expect(isDrinkUnit("US")).toBe(false);
    expect(isDrinkUnit("au")).toBe(false);
    expect(isDrinkUnit("")).toBe(false);
    expect(isDrinkUnit(undefined)).toBe(false);
    for (const u of DRINK_UNITS) expect(isDrinkUnit(u)).toBe(true);
});
