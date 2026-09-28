import { Type, type Static } from "typebox";
import type { TrainingInput } from "./training-input.js";
import type { QueryLane } from "./query-contract.js";
export declare const TRAINING_RECIPE_VERSION = "lex-vec-v2";
export declare const TRAINING_TEACHER_MODEL = "openai/gpt-6-luna";
export declare const TRAINING_TEACHER_VERSION = "lex-vec-teacher-v2-xhigh";
export type TrainingRound = 1 | 2;
export type QueryFeedback = {
    query: string;
    score: number;
};
export declare function trainingTeacherPrompt(lane: QueryLane): string;
export declare function trainingTeacherMessage(input: TrainingInput, lane: QueryLane, feedback?: readonly QueryFeedback[]): string;
declare const usageSchema: Type.TObject<{
    input_tokens: Type.TInteger;
    output_tokens: Type.TInteger;
}>;
export type TeacherResult = {
    queries: string[];
    lane: QueryLane;
    round: TrainingRound;
    model: string;
    usage: Static<typeof usageSchema> | null;
    promptVersion: string;
};
/** Host owns credentials/routing. No fallback model, tools, workspace prompt or session history. */
export declare function trainingTeacher(runtime: unknown, agentId: string): (input: TrainingInput, lane: QueryLane, feedback?: readonly QueryFeedback[]) => Promise<TeacherResult>;
export {};
