import { Type, type Static } from "typebox";
export declare const PERSON_DOSSIER_SCHEMA: Type.TObject<{
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
export type PersonDossier = Static<typeof PERSON_DOSSIER_SCHEMA>;
export type PersonDossierChange = {
    id: string;
    personId: string;
    action: "replace" | "delete";
    beforeDossier: PersonDossier | null;
    afterDossier: PersonDossier | null;
    reason: string;
    changedAt: string;
};
export type PersonDossierChangeSummary = Omit<PersonDossierChange, "beforeDossier" | "afterDossier"> & {
    beforeDossierBytes: number | null;
    afterDossierBytes: number | null;
};
export type Person = {
    id: string;
    displayName: string;
    preferredName: string | null;
    status: "active" | "unavailable" | "archived";
    companyId: string | null;
    injectionEnabled: boolean;
    lastSeenAt: string | null;
    createdAt: string;
    updatedAt: string;
};
export type PersonIdentity = {
    personId: string;
    provider: string;
    accountScope: string;
    externalId: string;
    displayName: string | null;
    realName: string | null;
    handle: string | null;
    avatarUrl: string | null;
    title: string | null;
    isBot: boolean | null;
    isDeactivated: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    lastSyncedAt: string | null;
};
export type PeopleTodo = {
    id: string;
    deduplicationKey: string;
    kind: string;
    context: unknown;
    status: "open" | "resolved" | "overflow";
    occurrenceCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    resolvedAt: string | null;
    resolutionNote: string | null;
};
export type Company = {
    id: string;
    name: string;
    primaryDomain: string | null;
    status: "active" | "archived";
    createdAt: string;
    updatedAt: string;
};
export declare class PeopleStore {
    #private;
    constructor(path: string, options: {
        maxOpenTodos: number;
        maxBlurbChars: number;
    });
    close(): void;
    upsertIdentity(input: {
        provider: string;
        accountScope: string;
        externalId: string;
        displayName?: string;
        realName?: string;
        handle?: string;
        avatarUrl?: string;
        title?: string;
        isBot?: boolean;
        isDeactivated?: boolean;
        seenAt?: string;
        syncedAt?: string;
    }): {
        person: Person;
        identity: PersonIdentity;
        created: boolean;
    };
    findPersonByIdentity(provider: string, accountScope: string, externalId: string): Person | undefined;
    getPerson(personId: string): Person | undefined;
    listIdentities(personId: string): PersonIdentity[];
    getCompany(companyId: string): Company | undefined;
    setCompany(personId: string, input: {
        name: string;
        primaryDomain?: string;
    }): Company | undefined;
    listActivePeople(limit?: number, offset?: number): Person[];
    findIdentity(provider: string, accountScope: string, externalId: string): PersonIdentity | undefined;
    setInjection(personId: string, enabled: boolean): Person | undefined;
    replaceDossier(personId: string, reasonInput: string, input: unknown): PersonDossier;
    deleteDossier(personId: string, reasonInput: string): boolean;
    getWhisperReceipt(threadKey: string, personId: string): {
        runId: string;
        contribution: string;
        injectedAt: string;
    } | undefined;
    recordWhisperReceipt(input: {
        threadKey: string;
        personId: string;
        runId: string;
        contribution: string;
    }): {
        runId: string;
        contribution: string;
        injectedAt: string;
    };
    getDossier(personId: string): {
        dossier: PersonDossier;
        reviewedAt: string;
    } | undefined;
    getDossierReviewedAt(personId: string): string | undefined;
    listDossierChanges(personId: string, limit?: number, offset?: number): PersonDossierChangeSummary[];
    getDossierChange(personId: string, changeId: string): PersonDossierChange | undefined;
    getDossierBlurb(personId: string): string | undefined;
    softDeletePerson(personId: string): Person | undefined;
    restorePerson(personId: string): Person | undefined;
    resolveTodoByKey(deduplicationKey: string, note?: string): PeopleTodo | undefined;
    upsertTodo(input: {
        deduplicationKey: string;
        kind: string;
        context?: unknown;
    }): PeopleTodo;
    listTodos(limit?: number): PeopleTodo[];
}
export declare class PeopleStores {
    #private;
    constructor(options: {
        stateRoot?: string;
        maxOpenTodos: number;
        maxBlurbChars: number;
    });
    get(agentId: string): PeopleStore;
    closeAll(): void;
}
