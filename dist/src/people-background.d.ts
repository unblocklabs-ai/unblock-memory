import type { PersonDossier } from "./people-store.js";
/** Keep identity brief; interaction preferences are stored separately with evidence. */
export declare const PEOPLE_BACKGROUND_MAX_WORDS = 70;
export declare function backgroundWordCount(text: string): number;
export declare function renderPeopleDossier(dossier: PersonDossier, now?: number): string;
