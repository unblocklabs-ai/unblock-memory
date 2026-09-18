/** Loggie's v1 Markdown is persisted source data, never instructions. */
type Meeting = {
    text: string;
    key?: string;
    hash?: string;
    sequence?: number;
    complete: boolean;
};
export declare function projectLoggieMessage(text: string, accountId?: string): Meeting | undefined;
export declare function meetingRevisionAnnotation(content: string, position: number): string | undefined;
/** Spans stay in source coordinates; headings and assistant replies stop expansion. */
export declare function meetingSpeakerSpans(content: string, position: number, end?: number): {
    header: string;
    start: number;
    message: {
        start: number;
        end: number;
    };
    turn: {
        start: number;
        end: number;
    };
} | undefined;
export {};
