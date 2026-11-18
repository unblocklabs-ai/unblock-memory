import { Type, type Static } from "typebox";
export declare const PEOPLE_LEARNING_SCHEMA: Type.TObject<{
    agents: Type.TOptional<Type.TRecord<"^.*$", Type.TObject<{
        enabled: Type.TOptional<Type.TBoolean>;
        nightly: Type.TOptional<Type.TBoolean>;
        weekly: Type.TOptional<Type.TBoolean>;
        nightlySchedule: Type.TOptional<Type.TString>;
        weeklySchedule: Type.TOptional<Type.TString>;
        timezone: Type.TOptional<Type.TString>;
        legacyJobIds: Type.TOptional<Type.TArray<Type.TString>>;
    }>>>;
    enabled: Type.TOptional<Type.TBoolean>;
    nightly: Type.TOptional<Type.TBoolean>;
    weekly: Type.TOptional<Type.TBoolean>;
    nightlySchedule: Type.TOptional<Type.TString>;
    weeklySchedule: Type.TOptional<Type.TString>;
    timezone: Type.TOptional<Type.TString>;
    legacyJobIds: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export type PeopleLearningConfig = Static<typeof PEOPLE_LEARNING_SCHEMA>;
export declare const DEFAULT_LEARNING: {
    enabled: boolean;
    nightly: boolean;
    weekly: boolean;
    nightlySchedule: string;
    weeklySchedule: string;
    agents: {};
};
export declare function resolvePeopleLearning(value: unknown, enabled: boolean): PeopleLearningConfig;
export declare function learningForAgent(config: PeopleLearningConfig, agentId: string): {
    enabled: boolean;
    nightly: boolean;
    weekly: boolean;
    nightlySchedule: string;
    weeklySchedule: string;
    timezone?: string | undefined;
    legacyJobIds?: string[] | undefined;
    agents: {};
};
