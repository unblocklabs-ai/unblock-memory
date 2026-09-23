import type { QMDStore } from "@unblocklabs/qmd";
type Candidate = {
    file: string;
    body: string;
    bestChunk: string;
    bestChunkPos: number;
    score: number;
    explain: {
        methods: string[];
    };
};
export declare function trainingCandidates(qmd: QMDStore, query: string, collection: string, intent: string): Promise<Candidate[]>;
export {};
