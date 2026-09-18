import type { ResponseEpisode } from "./response-episodes.js";
import type { ResponseAuditStore } from "./response-store.js";
export declare function assessResponseStages(store: ResponseAuditStore, cohort: string, e: ResponseEpisode, params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}, sentimentEnabled: boolean, usage: {
    stageAttempts: number;
    stageCacheHits: number;
}): Promise<{
    retrospective: {
        status: ResponseEpisode["followup"]["status"];
        judgment: import("typebox").Static<import("typebox").TObject<{
            answers: import("typebox").TObject<{
                correction: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"noul">;
                    noul: import("typebox").TNumber;
                }>;
                deliveryAdmission: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"noul">;
                    noul: import("typebox").TNumber;
                }>;
                regression: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"noul">;
                    noul: import("typebox").TNumber;
                }>;
                scopeClarification: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"noul">;
                    noul: import("typebox").TNumber;
                }>;
                outcome: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"choice">;
                    choice: import("typebox").TEnum<("unknown" | "reported_shortfall" | "acknowledged_success")[]>;
                    confidence: import("typebox").TNumber;
                    probabilities: import("typebox").TObject<{
                        [k: string]: import("typebox").TNumber;
                    }>;
                }>;
                reason: import("typebox").TObject<{
                    type: import("typebox").TLiteral<"choice">;
                    choice: import("typebox").TEnum<("none_or_unclear" | "missing_requested_work" | "unnecessary_deferral" | "regression" | "incorrect_claim" | "wrong_scope" | "failed_delivery")[]>;
                    confidence: import("typebox").TNumber;
                    probabilities: import("typebox").TObject<{
                        [k: string]: import("typebox").TNumber;
                    }>;
                }>;
            }>;
        }>>["answers"] | null;
    };
    quality: {
        taskType: {
            type: "choice";
            choice: "action" | "question" | "artifact" | "discussion" | "other";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        assessability: {
            type: "choice";
            choice: "assessable" | "not_assessable";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        fitAssessability: {
            type: "choice";
            choice: "assessable" | "not_assessable";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        underdelivery: {
            type: "noul";
            noul: number;
        };
        failureReason: {
            type: "choice";
            choice: "none_or_unclear" | "missing_requested_work" | "wrong_deliverable" | "missed_constraint" | "insufficient_answer_depth" | "unnecessary_deferral";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        fulfillment: {
            type: "score";
            confidence: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            score: number;
        };
        deliverableFit: {
            type: "score";
            confidence: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            score: number;
        };
        consistency: {
            type: "choice";
            choice: "not_assessable" | "consistent" | "contradicted";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
    };
    feedback: {
        feedbackType: {
            type: "choice";
            choice: "mixed" | "unrelated" | "unclear" | "acceptance" | "correction" | "continuation";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        target: {
            type: "choice";
            choice: "delivery" | "mixed" | "unclear" | "current_answer" | "earlier_behavior" | "proactive_action" | "external" | "new_work";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        avoidableRework: {
            type: "noul";
            noul: number;
        };
        repeatedConstraint: {
            type: "noul";
            noul: number;
        };
        memoryGap: {
            type: "noul";
            noul: number;
        };
    } & Partial<{
        sentiment: {
            type: "choice";
            choice: "satisfied" | "dissatisfied" | "mixed" | "neutral" | "unrelated" | "unclear";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        annoyance: {
            type: "noul";
            noul: number;
        };
        frustration: {
            type: "noul";
            noul: number;
        };
        dissatisfactionIntensity: {
            type: "score";
            confidence: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            score: number;
        };
    }>;
}>;
