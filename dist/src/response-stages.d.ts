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
                confidence: number;
                probabilities: {
                    [x: string]: number;
                    [x: number]: number;
                };
            };
            outcome: {
                type: "choice";
                choice: "unknown" | "reported_shortfall" | "acknowledged_success";
                confidence: number;
                probabilities: {
                    [x: string]: number;
                    [x: number]: number;
                };
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
            score: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
        };
        deliverableFit: {
            type: "score";
            confidence: number;
            score: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
        };
        consistency: {
            type: "choice";
            choice: "contradicted" | "not_assessable" | "consistent";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
    };
    feedback: {
        target: {
            type: "choice";
            choice: "delivery" | "mixed" | "unclear" | "current_answer" | "earlier_behavior" | "proactive_action" | "external" | "new_work";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        feedbackType: {
            type: "choice";
            choice: "mixed" | "unrelated" | "unclear" | "acceptance" | "correction" | "continuation";
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
        annoyance: {
            type: "noul";
            noul: number;
        };
        frustration: {
            type: "noul";
            noul: number;
        };
        sentiment: {
            type: "choice";
            choice: "satisfied" | "dissatisfied" | "mixed" | "neutral" | "unrelated" | "unclear";
            confidence: number;
            probabilities: {
                [x: string]: number;
                [x: number]: number;
            };
        };
        dissatisfactionIntensity: {
            type: "score";
            confidence: number;
            score: number;
            probabilities: {
                "0": number;
                "1": number;
                "2": number;
                "3": number;
            };
        };
    }>;
}>;
