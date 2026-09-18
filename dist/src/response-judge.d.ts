import { Type, type Static } from "typebox";
import type { ResponseEpisode } from "./response-episodes.js";
export declare const RESPONSE_RUBRIC_VERSION = "jev-1.13.0:response-v10";
export declare const RESPONSE_STAGE_VERSIONS: {
    readonly quality: "quality-v9";
    readonly feedback: "feedback-v9";
    readonly sentiment: "sentiment-v10";
    readonly retrospective: "retrospective-v9";
    readonly memory: "memory-v1";
};
declare const qualitySchema: Type.TObject<{
    answers: Type.TObject<{
        taskType: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("action" | "question" | "artifact" | "discussion" | "other")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        assessability: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("assessable" | "not_assessable")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        fitAssessability: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("assessable" | "not_assessable")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        underdelivery: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        failureReason: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("none_or_unclear" | "missing_requested_work" | "wrong_deliverable" | "missed_constraint" | "insufficient_answer_depth" | "unnecessary_deferral")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        fulfillment: Type.TObject<{
            type: Type.TLiteral<"score">;
            score: Type.TNumber;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                "0": Type.TNumber;
                "1": Type.TNumber;
                "2": Type.TNumber;
                "3": Type.TNumber;
            }>;
        }>;
        deliverableFit: Type.TObject<{
            type: Type.TLiteral<"score">;
            score: Type.TNumber;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                "0": Type.TNumber;
                "1": Type.TNumber;
                "2": Type.TNumber;
                "3": Type.TNumber;
            }>;
        }>;
        consistency: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("not_assessable" | "consistent" | "contradicted")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
    }>;
}>;
declare const sentimentSchema: Type.TObject<{
    sentiment: Type.TObject<{
        type: Type.TLiteral<"choice">;
        choice: Type.TEnum<("satisfied" | "dissatisfied" | "mixed" | "neutral" | "unrelated" | "unclear")[]>;
        confidence: Type.TNumber;
        probabilities: Type.TObject<{
            [k: string]: Type.TNumber;
        }>;
    }>;
    annoyance: Type.TObject<{
        type: Type.TLiteral<"noul">;
        noul: Type.TNumber;
    }>;
    frustration: Type.TObject<{
        type: Type.TLiteral<"noul">;
        noul: Type.TNumber;
    }>;
    dissatisfactionIntensity: Type.TObject<{
        type: Type.TLiteral<"score">;
        score: Type.TNumber;
        confidence: Type.TNumber;
        probabilities: Type.TObject<{
            "0": Type.TNumber;
            "1": Type.TNumber;
            "2": Type.TNumber;
            "3": Type.TNumber;
        }>;
    }>;
}>;
declare const feedbackSchema: Type.TObject<{
    answers: Type.TObject<{
        feedbackType: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("mixed" | "unrelated" | "unclear" | "acceptance" | "correction" | "continuation")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        target: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("delivery" | "mixed" | "unclear" | "current_answer" | "earlier_behavior" | "proactive_action" | "external" | "new_work")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        avoidableRework: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        repeatedConstraint: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        memoryGap: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
    }>;
}>;
type ResponseQuality = Static<typeof qualitySchema>["answers"];
type ResponseFeedback = Static<typeof feedbackSchema>["answers"] & Partial<Static<typeof sentimentSchema>>;
export type ResponseJudgment = {
    quality: ResponseQuality;
    feedback: ResponseFeedback;
};
export type ResponseStages = {
    quality: ResponseQuality;
    feedback: Static<typeof feedbackSchema>["answers"];
    sentiment: Static<typeof sentimentSchema>;
    retrospective: Awaited<ReturnType<typeof judgeResponseFollowup>>;
    memory: Awaited<ReturnType<typeof judgeMemoryOpportunity>>;
};
type StageCache = Partial<ResponseStages> & {
    begin: (stages: (keyof ResponseStages)[]) => void;
    save: <K extends keyof ResponseStages>(stage: K, result: ResponseStages[K]) => void;
};
/** Separate requests are deliberate: later feedback must not leak into the original quality grade. */
export declare function judgeResponse(episode: ResponseEpisode, params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}, sentimentEnabled?: boolean, cache?: StageCache): Promise<ResponseJudgment>;
declare const retrospectiveSchema: Type.TObject<{
    answers: Type.TObject<{
        correction: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        deliveryAdmission: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        regression: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        scopeClarification: Type.TObject<{
            type: Type.TLiteral<"noul">;
            noul: Type.TNumber;
        }>;
        outcome: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("unknown" | "reported_shortfall" | "acknowledged_success")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
        reason: Type.TObject<{
            type: Type.TLiteral<"choice">;
            choice: Type.TEnum<("none_or_unclear" | "missing_requested_work" | "unnecessary_deferral" | "regression" | "incorrect_claim" | "wrong_scope" | "failed_delivery")[]>;
            confidence: Type.TNumber;
            probabilities: Type.TObject<{
                [k: string]: Type.TNumber;
            }>;
        }>;
    }>;
}>;
/** Later evidence is kept in a third request and never changes the original grade. */
export declare function judgeResponseFollowup(episode: ResponseEpisode, params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}): Promise<{
    status: ResponseEpisode["followup"]["status"];
    judgment: Static<typeof retrospectiveSchema>["answers"] | null;
}>;
export declare function judgeMemoryOpportunity(episode: ResponseEpisode, candidates: readonly {
    path: string;
    text: string;
    hash: string;
}[], params: {
    apiKey: string;
    timeoutMs: number;
    signal: AbortSignal;
}): Promise<{
    path: string;
    hash: string;
    usefulness: number;
    basis: string;
}[]>;
export {};
