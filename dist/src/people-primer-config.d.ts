import { Type, type Static } from "typebox";
import type { CorpusConfig } from "./config.js";
export declare const peoplePrimerSchema: Type.TObject<{
    enabled: Type.TBoolean;
    corpora: Type.TArray<Type.TString>;
    hitsPerQuestion: Type.TInteger;
    minScore: Type.TNumber;
    minUsefulness: Type.TNumber;
    maxEvidencePerQuestion: Type.TInteger;
    timeoutMs: Type.TInteger;
}>;
export type PeoplePrimerConfig = Static<typeof peoplePrimerSchema>;
export declare function resolvePeoplePrimer(value: unknown, corpora: readonly CorpusConfig[], peopleEnabled: boolean): PeoplePrimerConfig;
