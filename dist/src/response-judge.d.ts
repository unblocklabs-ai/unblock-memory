import { Type, type Static } from "typebox";
import type { ResponseEpisode } from "./response-episodes.js";
export declare function responseRubricVersion(model?: string, endpoint?: string): string;
export declare const RESPONSE_STAGE_VERSIONS: {
    readonly quality: "quality-v9";
    readonly feedback: "feedback-v9";
    readonly sentiment: "sentiment-v10";
    readonly retrospective: "retrospective-v9";
    readonly memory: "memory-v2-isolated";
};
export type ResponseJudgeParams = {
    apiKey: string;
    endpoint?: string;
    model?: string;
    timeoutMs: number;
    signal: AbortSignal;
};
declare const qualitySchema: Type.TObject<{
    taskType: Type.TObject<{
        type: Type.TLiteral<"choice">;
        choice: Type.TEnum<("action" | "question" | "other" | "artifact" | "discussion")[]>;
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
        choice: Type.TEnum<("contradicted" | "not_assessable" | "consistent")[]>;
        confidence: Type.TNumber;
        probabilities: Type.TObject<{
            [k: string]: Type.TNumber;
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
declare const retrospectiveSchema: Type.TObject<{
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
type ResponseQuality = Static<typeof qualitySchema>;
type ResponseFeedbackBase = Static<typeof feedbackSchema>;
type ResponseSentiment = Static<typeof sentimentSchema>;
type ResponseFeedback = ResponseFeedbackBase & Partial<ResponseSentiment>;
type ResponseRetrospective = Static<typeof retrospectiveSchema>;
export type ResponseJudgment = {
    quality: ResponseQuality;
    feedback: ResponseFeedback;
};
export type ResponseStages = {
    quality: ResponseQuality;
    feedback: ResponseFeedbackBase;
    sentiment: ResponseSentiment;
    retrospective: Awaited<ReturnType<typeof judgeResponseFollowup>>;
    memory: Awaited<ReturnType<typeof judgeMemoryOpportunity>>;
};
export type ResponseStageContracts = {
    quality?: undefined;
    feedback?: undefined;
    sentiment?: undefined;
    retrospective?: {
        status: ResponseEpisode["followup"]["status"];
    };
    memory?: readonly {
        path: string;
        hash: string;
    }[];
};
type JudgeStage = "quality" | "feedback" | "sentiment";
type StageCache = Partial<Pick<ResponseStages, JudgeStage>> & {
    begin: (stages: JudgeStage[]) => void;
    save: <K extends JudgeStage>(stage: K, result: ResponseStages[K]) => void;
    /** These begun stages failed on their own (not by cancellation): their attempt is spent, never refunded. */
    settle?: (stages: JudgeStage[]) => void;
};
/**
 * Begin one stage attempt and run it. A failure that is not cancellation settles the attempt (spent, never refunded);
 * a cancelled attempt stays in flight so the caller can refund it.
 */
export declare function runStageAttempt<T>(attempt: {
    begin: () => void;
    settle?: () => void;
    signal?: AbortSignal;
}, run: () => Promise<T>): Promise<T>;
export declare function validateCachedStage<K extends keyof ResponseStages>(stage: K, value: unknown, contract?: ResponseStageContracts[K]): ResponseStages[K];
/** Separate requests are deliberate: later feedback must not leak into the original quality grade. */
export declare function judgeResponse(episode: ResponseEpisode, params: ResponseJudgeParams, sentimentEnabled?: boolean, cache?: StageCache): Promise<ResponseJudgment>;
/** Later evidence is kept in a third request and never changes the original grade. */
export declare function judgeResponseFollowup(episode: ResponseEpisode, params: ResponseJudgeParams): Promise<{
    status: ResponseEpisode["followup"]["status"];
    judgment: ResponseRetrospective | null;
}>;
export declare function judgeMemoryOpportunity(episode: ResponseEpisode, candidates: readonly {
    path: string;
    text: string;
    hash: string;
}[], params: ResponseJudgeParams): Promise<{
    path: string;
    hash: string;
    usefulness: number;
    basis: string;
}[]>;
export {};
