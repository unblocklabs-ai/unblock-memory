import type { ResponseJudgment, judgeResponseFollowup } from "./response-judge.js";
export declare const RESPONSE_REPORT_VERSION = "response-report-v4";
/** Compose observed evidence, not a factual-verification or causal agent grade.
 * Narrow admissions take precedence over praise; missing evidence stays unknown. */
export declare function responseOutcome(result: ResponseJudgment & {
    retrospective: Awaited<ReturnType<typeof judgeResponseFollowup>>;
}): {
    status: "reported_shortfall";
    basis: string[];
    reasons: string[];
    reasonDetails: {
        reason: string;
        strength: number;
        measure: "choice_confidence" | "yes_probability";
        source: string;
    }[];
    reasonStatus: "uncertain" | "classified";
} | {
    status: "acknowledged_success";
    basis: string[];
    reasons: never[];
    reasonDetails: never[];
    reasonStatus: "not_applicable";
} | {
    status: "unknown";
    basis: never[];
    reasons: never[];
    reasonDetails: never[];
    reasonStatus: "not_applicable";
};
