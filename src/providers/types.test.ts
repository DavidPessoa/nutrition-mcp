import { test, expect } from "bun:test";
import { NUTRIENT_FIELDS } from "../nutrients.js";
import {
    emptyNutrientValues,
    type FoodNutrition,
    type ServingBasis,
    type NutritionProvider,
} from "./types.js";

test("emptyNutrientValues sets every canonical nutrient field to null", () => {
    const values = emptyNutrientValues();
    for (const field of NUTRIENT_FIELDS) {
        expect(values[field]).toBeNull();
    }
});

test("emptyNutrientValues has exactly the canonical fields, no extras", () => {
    const values = emptyNutrientValues();
    expect(Object.keys(values).sort()).toEqual([...NUTRIENT_FIELDS].sort());
});

test("ServingBasis distinguishes per_100g from per_serving with a known gram weight", () => {
    const per100g: ServingBasis = { kind: "per_100g" };
    const perServingKnown: ServingBasis = {
        kind: "per_serving",
        grams: 42,
        label: "1 bar (42 g)",
    };
    const perServingUnknown: ServingBasis = {
        kind: "per_serving",
        grams: null,
        label: "1 slice",
    };

    expect(per100g.kind).toBe("per_100g");
    expect(perServingKnown.kind).toBe("per_serving");
    expect(perServingKnown.grams).toBe(42);
    expect(perServingUnknown.grams).toBeNull();
});

test("FoodNutrition can be constructed with every canonical field plus provider metadata", () => {
    const food: FoodNutrition = {
        ...emptyNutrientValues(),
        calories: 52,
        potassium_mg: 358,
        name: "Banana",
        brand: null,
        serving: { kind: "per_100g" },
        source: "usda_fdc",
        sourceId: "fdc:173944",
    };
    expect(food.calories).toBe(52);
    expect(food.sodium_mg).toBeNull(); // backfilled by emptyNutrientValues
    expect(food.serving.kind).toBe("per_100g");
    expect(food.source).toBe("usda_fdc");
});

test("NutritionProvider allows a lookup-only provider with no search", () => {
    const barcodeOnly: NutritionProvider = {
        async lookup(id: string) {
            if (id !== "737628064502") return null;
            return {
                ...emptyNutrientValues(),
                name: "Test Product",
                brand: null,
                serving: { kind: "per_100g" },
                source: "open_food_facts",
                sourceId: id,
            };
        },
    };
    expect(barcodeOnly.search).toBeUndefined();
});

test("NutritionProvider.lookup returns null for a well-formed but unknown id", async () => {
    const provider: NutritionProvider = {
        async lookup() {
            return null;
        },
    };
    expect(await provider.lookup("does-not-exist")).toBeNull();
});
