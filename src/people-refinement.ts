import { readPersonSessionEvidence, type PersonSessionEvidence } from "./people-evidence.js";
import type { PeopleStore, Person, PersonDossier, PersonIdentity } from "./people-store.js";

export type PeopleRefinementPacket = {
  person: Person;
  identities: PersonIdentity[];
  currentDossier?: PersonDossier;
  evidence: PersonSessionEvidence[];
};

export function nextPeopleRefinement(params: {
  store: PeopleStore;
  agentId: string;
  agentDatabasePath: string;
  evidenceLimit?: number;
}): PeopleRefinementPacket | undefined {
  const evidenceLimit = Math.max(1, Math.min(50, Math.floor(params.evidenceLimit ?? 20)));

  for (const person of params.store.listActivePeople()) {
    const identities = params.store.listIdentities(person.id);
    const processed = params.store.listProcessedEvidenceLocators(person.id, "session");
    const evidence = identities
      .filter((identity) => identity.provider === "slack")
      .flatMap((identity) =>
        readPersonSessionEvidence({
          databasePath: params.agentDatabasePath,
          agentId: params.agentId,
          accountScope: identity.accountScope,
          externalId: identity.externalId,
          limit: evidenceLimit,
          excludeLocators: processed,
        }),
      )
      .filter(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.locator === entry.locator) === index,
      )
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, evidenceLimit);
    if (evidence.length === 0) continue;

    return {
      person,
      identities,
      currentDossier: params.store.getDossier(person.id)?.dossier,
      evidence,
    };
  }
  return undefined;
}
