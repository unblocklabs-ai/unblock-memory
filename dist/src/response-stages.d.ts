import type { ResponseEpisode } from "./response-episodes.js";
import { type ResponseJudgeParams } from "./response-judge.js";
import type { ResponseAuditStore } from "./response-store.js";
export declare function assessResponseStages(store: ResponseAuditStore, cohort: string, e: ResponseEpisode, params: ResponseJudgeParams, sentimentEnabled: boolean, usage: {
    stageAttempts: number;
    stageCacheHits: number;
}): Promise<{
    retrospective: {
        status: ResponseEpisode["followup"]["status"];
        judgment: {
            reason: {
                type: "choice";
                choice: "none_or_unclear" | "missing_requested_work" | "unnecessary_deferral" | "regression" | "incorrect_claim" | "wrong_scope" | "failed_delivery";
                probabilities: {
                    [x: string]: number;
                    [x: number]: number;
                };
                confidence: number;
            };
            outcome: {
                type: "choice";
                choice: "unknown" | "reported_shortfall" | "acknowledged_success";
                probabilities: {
                    [x: string]: number;
                    [x: number]: number;
                };
                confidence: number;
            };
            correction: {
                type: "noul";
                noul: number;
            };
            deliveryAdmission: {
                type: "noul";
                noul: number;
            };
            regression: {
                type: "noul";
                noul: number;
            };
            scopeClarification: {
                type: "noul";
                noul: number;
            };
        } | null;
    };
    quality: {
        taskType: {
            type: "choice";
            choice: "action" | "question" | "other" | "artifact" | "discussion";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
        assessability: {
            type: "choice";
            choice: "assessable" | "not_assessable";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
        fitAssessability: {
            type: "choice";
            choice: "assessable" | "not_assessable";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
        underdelivery: {
            type: "noul";
            noul: number;
        };
        failureReason: {
            type: "choice";
            choice: "none_or_unclear" | "missing_requested_work" | "wrong_deliverable" | "missed_constraint" | "insufficient_answer_depth" | "unnecessary_deferral";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
        fulfillment: {
            type: "score";
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            confidence: number;
            score: number;
        };
        deliverableFit: {
            type: "score";
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            confidence: number;
            score: number;
        };
        consistency: {
            type: "choice";
            choice: "contradicted" | "not_assessable" | "consistent";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
    };
    feedback: {
        target: {
            type: "choice";
            choice: "delivery" | "mixed" | "unclear" | "current_answer" | "earlier_behavior" | "proactive_action" | "external" | "new_work";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
        };
        feedbackType: {
            type: "choice";
            choice: "mixed" | "unrelated" | "unclear" | "acceptance" | "correction" | "continuation";
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
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
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
            confidence: number;
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
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
            confidence: number;
            score: number;
        };
    }>;
}>;
