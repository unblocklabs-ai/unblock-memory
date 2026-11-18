export declare function shiftDate(day: string, days: number): string;
export declare function reviewWindow(now: number, timezone: string, kind: "nightly" | "weekly", day?: string): {
    localDay: string;
    timezone: string;
    since: number;
    until: number;
};
