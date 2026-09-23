import { Type, type Static } from "typebox";
import type { TrainingInput } from "./training-input.js";
export declare const TRAINING_TEACHER_MODEL = "openai/gpt-6-luna";
export declare const TRAINING_TEACHER_VERSION = "query-teacher-v3-xhigh";
export declare const TRAINING_TEACHER_PROMPT_VERSION = "query-teacher-prompt-v3";
export declare const TRAINING_TEACHER_PROMPT: string;
export declare function trainingTeacherMessage(input: TrainingInput): string;
declare const usageSchema: Type.TObject<{
    input_tokens: Type.TInteger;
    output_tokens: Type.TInteger;
}>;
export type TeacherResult = {
    queries: string[];
    model: string;
    usage: Static<typeof usageSchema> | null;
    promptVersion?: string;
};
/** Host owns credentials and routing. No fallback model, tools, workspace prompt or session history. */
export declare function trainingTeacher(runtime: unknown, agentId: string): (input: TrainingInput) => Promise<TeacherResult>;
export {};
