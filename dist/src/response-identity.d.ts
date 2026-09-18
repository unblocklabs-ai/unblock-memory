import type { ResponseEpisode } from "./response-episodes.js";
export type ResponseHuman = {
    key: string;
    provider: "slack";
    accountScope: string;
    senderId: string;
    personId: string | null;
};
/** Identity is trusted metadata, never inferred from names or transcript text. */
export declare class ResponsePeople {
    #private;
    constructor(path?: string);
    resolve(e: ResponseEpisode): ResponseHuman;
    close(): void;
}
