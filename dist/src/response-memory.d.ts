import type { ResolvedSource } from "./sources.js";
import type { ResponseEpisode } from "./response-episodes.js";
/** Current-index investigation only. No QMD manager startup, re-indexing or historical claims. */
export declare function responseMemoryCandidates(indexPath: string, sources: readonly ResolvedSource[], episode: ResponseEpisode): {
    path: string;
    text: string;
    hash: string;
}[];
