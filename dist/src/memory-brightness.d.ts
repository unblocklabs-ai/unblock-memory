import { DatabaseSync } from "node:sqlite";
export type BrightnessRecipe = "off" | "actr_v1" | "outcome_v1";
export declare const BRIGHTNESS_RECIPES: readonly ["off", "actr_v1", "outcome_v1"];
export type BrightnessConfig = {
    recipe: BrightnessRecipe;
    weight: number;
    decayRate: number;
    lookbackDays: number;
    maxBoost: number;
};
export declare const DEFAULT_BRIGHTNESS_CONFIG: BrightnessConfig;
export type BrightnessScore = {
    score: number;
    normalized: number;
    recipe: BrightnessRecipe;
    samples: number;
};
export declare function brightnessRecipeHash(recipe: BrightnessRecipe): string;
export declare function memorySubjectId(_corpus: string, path: string): string;
/** Missing or unavailable evidence is neutral. Never initialize or migrate a ledger on the search path. */
export declare function computeBrightnessMap(dbOrPath: DatabaseSync | string, options: {
    agentId: string;
    recipe: BrightnessRecipe;
    subjects: readonly string[];
    nowMs?: number;
    decayRate?: number;
    lookbackDays?: number;
}): Map<string, BrightnessScore>;
