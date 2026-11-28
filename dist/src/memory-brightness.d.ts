import { DatabaseSync } from "node:sqlite";
export declare const BRIGHTNESS_RECIPES: readonly ["off", "actr_v1", "outcome_v1", "emotion_v1"];
export type BrightnessRecipe = typeof BRIGHTNESS_RECIPES[number];
export type BrightnessConfig = {
    recipe: BrightnessRecipe;
    weight: number;
    decayRate: number;
    lookbackDays: number;
    maxBoost: number;
    emotionDecayStretch?: number;
    emotionMaxBonus?: number;
};
export declare const EMOTION_BRIGHTNESS_LIMITS: {
    readonly emotionDecayStretch: 3;
    readonly emotionMaxBonus: 0.35;
};
export declare const DEFAULT_BRIGHTNESS_CONFIG: Required<BrightnessConfig>;
export type BrightnessScore = {
    score: number;
    normalized: number;
    recipe: BrightnessRecipe;
    samples: number;
};
export declare function brightnessRecipeHash(recipe: BrightnessRecipe): string;
export declare function memorySubjectId(_corpus: string, path: string): string;
/** Missing or unavailable evidence is neutral. Never initialize or migrate a ledger on the search path. */
export declare function computeBrightnessMap(dbOrPath: DatabaseSync | string, options: Pick<BrightnessConfig, "recipe"> & Partial<Pick<BrightnessConfig, "decayRate" | "lookbackDays" | "emotionDecayStretch" | "emotionMaxBonus">> & {
    agentId: string;
    subjects: readonly string[];
    nowMs?: number;
    /** Prior intensity grades a person needs before relative intensity counts (`insideOut.baselineMinInteractions`). */
    baselineMinInteractions?: number;
}): Map<string, BrightnessScore>;
