import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const overrides = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  nightly: Type.Optional(Type.Boolean()),
  weekly: Type.Optional(Type.Boolean()),
  nightlySchedule: Type.Optional(Type.String({ pattern: "\\S" })),
  weeklySchedule: Type.Optional(Type.String({ pattern: "\\S" })),
  timezone: Type.Optional(Type.String({ pattern: "\\S" })),
  legacyJobIds: Type.Optional(Type.Array(Type.String({ pattern: "\\S" }))),
}, { additionalProperties: false });

export const PEOPLE_LEARNING_SCHEMA = Type.Object({
  ...overrides.properties,
  agents: Type.Optional(Type.Record(Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" }), overrides, { additionalProperties: false })),
}, { additionalProperties: false });
export type PeopleLearningConfig = Static<typeof PEOPLE_LEARNING_SCHEMA>;
export const DEFAULT_LEARNING = { enabled: false, nightly: true, weekly: true,
  nightlySchedule: "10 3 * * *", weeklySchedule: "0 4 * * 0", agents: {} };

export function resolvePeopleLearning(value: unknown, enabled: boolean): PeopleLearningConfig {
  if (value !== undefined && !Value.Check(PEOPLE_LEARNING_SCHEMA, value)) throw new Error("Invalid people.learning configuration");
  const input = value as PeopleLearningConfig | undefined;
  for (const options of [input, ...Object.values(input?.agents ?? {})]) {
    if (options?.timezone) new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
    for (const expr of [options?.nightlySchedule, options?.weeklySchedule]) {
      if (expr && expr.trim().split(/\s+/u).length !== 5) throw new Error("people.learning schedules require five-field cron expressions");
    }
  }
  return { ...DEFAULT_LEARNING, enabled, ...input };
}

export function learningForAgent(config: PeopleLearningConfig, agentId: string) {
  const { agents, ...base } = config;
  const options = { ...DEFAULT_LEARNING, ...base, ...agents?.[agentId] };
  return { ...options, enabled: config.enabled !== false && options.enabled };
}
