import { Type } from "typebox";
import { type PersonSessionEvidence } from "./people-evidence.js";
import { type PeopleStore, type PersonDossier, type PersonIdentity } from "./people-store.js";
export declare const REFINEMENT_OUTPUT_SCHEMA: Type.TObject<{
    results: Type.TArray<Type.TObject<{
        personId: Type.TString;
        dossier: Type.TObject<{
            schemaVersion: Type.TLiteral<1>;
            blurb: Type.TString;
            sections: Type.TArray<Type.TObject<{
                category: Type.TUnion<Type.TLiteral<"role" | "priorities" | "preferences" | "successCriteria" | "workingStyle" | "relationship" | "openLoops">[]>;
                claims: Type.TArray<Type.TObject<{
                    statement: Type.TString;
                    evidence: Type.TArray<Type.TObject<{
                        source: Type.TUnion<[Type.TLiteral<"session">, Type.TLiteral<"memory">, Type.TLiteral<"directory">, Type.TLiteral<"manual">]>;
                        locator: Type.TString;
                        observedAt: Type.TOptional<Type.TString>;
                    }>>;
                    epistemicType: Type.TUnion<[Type.TLiteral<"observed">, Type.TLiteral<"reported">, Type.TLiteral<"inferred">, Type.TLiteral<"agent_assessment">]>;
                    confidence: Type.TOptional<Type.TUnion<[Type.TLiteral<"low">, Type.TLiteral<"medium">, Type.TLiteral<"high">]>>;
                }>>;
            }>>;
        }>;
    }>>;
}>;
type PeopleRefinementInput = {
    people: Array<{
        personId: string;
        displayName: string;
        lastSeenAt: string;
        identities: PersonIdentity[];
        currentDossier?: PersonDossier;
        evidence: PersonSessionEvidence[];
    }>;
};
export type PeopleRefinementRunner = (params: {
    input: PeopleRefinementInput;
    outputSchema: typeof REFINEMENT_OUTPUT_SCHEMA;
    signal?: AbortSignal;
}) => Promise<unknown>;
export type PeopleRefinementSummary = {
    status: "ok";
    selected: number;
    refined: number;
    skippedWithoutEvidence: number;
    personIds: string[];
};
export declare function refinePeople(params: {
    store: PeopleStore;
    agentId: string;
    agentDatabasePath: string;
    maxBlurbChars: number;
    runner: PeopleRefinementRunner;
    candidateLimit?: number;
    evidenceLimit?: number;
    signal?: AbortSignal;
}): Promise<PeopleRefinementSummary>;
export type CodexCommandRunner = (params: {
    executable: string;
    args: string[];
    cwd: string;
    input: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}) => Promise<void>;
export declare function createCodexPeopleRefinementRunner(runCommand?: CodexCommandRunner, options?: {
    environment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
}): PeopleRefinementRunner;
export declare const codexPeopleRefinementRunner: PeopleRefinementRunner;
export {};
