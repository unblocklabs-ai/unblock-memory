import { type PersonSessionEvidence } from "./people-evidence.js";
import type { PeopleStore, Person, PersonDossier, PersonIdentity } from "./people-store.js";
export type PeopleRefinementPacket = {
    person: Person;
    identities: PersonIdentity[];
    currentDossier?: PersonDossier;
    evidence: PersonSessionEvidence[];
};
export declare function nextPeopleRefinement(params: {
    store: PeopleStore;
    agentId: string;
    agentDatabasePath: string;
    evidenceLimit?: number;
}): PeopleRefinementPacket | undefined;
