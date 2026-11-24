# `@unblocklabs/decisions` — SDK Spec & Migration Plan

## 1. Design Goals

- **Zero vendor/model lock-in:** Standardize all naming, config keys, errors, and telemetry around **decision model** (`decisionModel`), never `typesafe`, `jev`, or `liquid`.
- **Simple operator contract:** A user configures just **`endpoint`**, **`model`**, and **`apiKey` / `apiKeyFile`** (plus optional `timeoutMs`).
- **Tiny, zero-native-dependency package:** Pure TypeScript ESM (`Node >= 22`, zero `node-llama-cpp`, zero `better-sqlite3`, zero `zod`). One optional runtime dep (`typebox` or zero deps with hand-written strict guards — **zero runtime deps** is cleanest so both `zod`-based and `typebox`-based repos can depend on it with zero bloat!).
- **Battle-tested security & reliability baked in once:**
  - HTTPS-only (except loopback `localhost` / `127.0.0.1` / `[::1]` HTTP), no credentials/query/fragment/whitespace in URLs, `redirect: "error"`.
  - Strict provider credential isolation (no cross-origin ambient env leaks).
  - Exact wire-dialect adaptation (`state: [state]` on OpenRouter/Codex `/decisions` vs bare object `state` on legacy `/systemone`).
  - Strict response validation (exact declared answer keys, dated-snapshot model matching, option-count-scaled probability rounding tolerance, sanitized errors that never leak tokens or raw provider bodies).
- **Separate primitives for Decisions vs Extractions:**
  - `decide()` → `POST .../decisions` (or legacy `.../systemone`) with `{ model, state, questions }` (`noul` | `choice` | `score` | `box`).
  - `extract()` → `POST .../extractions` with `{ model, state, assets?, fields }` (`text` | `number` | `date` | `estimate` | `list`), matching OpenRouter's separate Extractions API without polluting `decide()`.

---

## 2. Exact `@unblocklabs/decisions` Public API

### 2.1 Configuration & Credentials

```ts
export interface DecisionModelConfig {
  /** Decision endpoint URL (HTTPS, or loopback HTTP for local testing). */
  endpoint: string;
  /** Model identifier sent in request body (e.g. "liquid/d1.2-ultra", "jev-1.13.0"). */
  model: string;
  /** Inline bearer token (mutually exclusive with apiKeyFile). */
  apiKey?: string;
  /** Absolute path to a raw token or dotenv file (mutually exclusive with apiKey). */
  apiKeyFile?: string;
  /** Optional explicit extractions endpoint. If omitted, derived by replacing trailing /decisions with /extractions. */
  extractionsEndpoint?: string;
  /** Per-request timeout in ms (1..60000). */
  timeoutMs?: number;
  /**
   * Wire dialect. "auto" (default) uses "systemone" when endpoint path ends with
   * "/systemone" and "decisions" (array-wrapped object state) otherwise.
   */
  dialect?: "auto" | "decisions" | "systemone";
  /**
   * Optional env var name(s) allowed for ambient/dotenv fallback (explicit opt-in by caller).
   * Example: ["CODEX_LB_API_KEY"] for codex.unblocklabs.ai, ["TYPESAFE_API_KEY"] for api.typesafe.ai.
   * Unlisted/custom origins never inherit ambient process.env.
   */
  envKeys?: readonly string[];
}

export interface ResolvedDecisionConfig {
  endpoint: string;
  extractionsEndpoint?: string;
  model: string;
  apiKey?: string;
  apiKeyFile?: string;
  timeoutMs: number;
  dialect: "decisions" | "systemone";
  envKeys: readonly string[];
}

/** Validates URL (HTTPS or loopback HTTP, no userinfo/query/fragment/whitespace), model, and key exclusivity. */
export function resolveDecisionConfig(input: Partial<DecisionModelConfig>): ResolvedDecisionConfig;

/**
 * Resolves the bearer token: inline apiKey > apiKeyFile (raw or dotenv filtered by envKeys) > ambient envKeys.
 * Returns undefined if apiKeyFile is missing (ENOENT) or empty; throws sanitized DecisionError on unreadable/malformed file.
 */
export function resolveDecisionApiKey(config: ResolvedDecisionConfig): Promise<string | undefined>;

/** Stable cache/cohort scope key: clean model name on canonical routes, `${model}@${endpoint}` on custom routes. */
export function decisionModelScope(model: string, endpoint: string, canonicalRoutes?: ReadonlyMap<string, string>): string;

/** Matches exact model, dated snapshot (`${model}-YYYYMMDD` / `-YYYY-MM-DD`), or `jev-latest` -> `jev-X.Y.Z`. */
export function matchesDecisionModel(returned: unknown, requested: string): returned is string;

/** Fast conservative token estimator for pre-flight state budgeting. */
export function estimateStateTokens(value: unknown): number;
```

### 2.2 Decision Primitives (`decide`)

Questions are typed via tiny helper builders so TypeScript **infers the exact return type** of `result.answers` with zero manual TypeBox/Zod boilerplate at every call site!

```ts
export type QuestionInstructions = string | Record<string, unknown>;

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: QuestionInstructions;
  readonly criteria?: { true: string; false: string };
}

export interface ChoiceQuestion<K extends string = string> {
  readonly type: "choice";
  readonly instructions: QuestionInstructions;
  readonly criteria: Record<K, unknown>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: QuestionInstructions;
  readonly criteria: readonly unknown[]; // ordered rubric levels 0..N-1
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type QuestionMap = Record<string, DecisionQuestion>;

// Typed builders (preserve literal keys on choice criteria)
export function noul(instructions: QuestionInstructions, criteria?: { true: string; false: string }): NoulQuestion;
export function choice<const C extends Record<string, unknown>>(
  instructions: QuestionInstructions,
  criteria: C,
): ChoiceQuestion<Extract<keyof C, string>>;
export function score(instructions: QuestionInstructions, criteria: readonly unknown[]): ScoreQuestion;

// Inferred answer types (strictly projected — no extra unvalidated provider fields)
export interface NoulAnswer {
  type: "noul";
  noul: number; // finite [0, 1]
}

export interface ChoiceAnswer<K extends string = string> {
  type: "choice";
  choice: K;
  confidence: number;
  probabilities: Record<K, number>; // exact keys only, sum validated with option-count tolerance
}

export interface ScoreAnswer {
  type: "score";
  score: number; // finite [0, criteria.length - 1]
  confidence: number;
  probabilities: Record<string, number>; // exact "0".."N-1" keys, expected-value validated
}

export type AnswerFor<Q extends DecisionQuestion> =
  Q extends NoulQuestion ? NoulAnswer :
  Q extends ChoiceQuestion<infer K> ? ChoiceAnswer<K> :
  Q extends ScoreQuestion ? ScoreAnswer :
  never;

export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface DecisionResult<Q extends QuestionMap> {
  model: string; // validated via matchesDecisionModel
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: DecisionUsage | null;
}

export interface RequestOverrides {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Default true: validate returned payload.model against configured model. */
  validateModel?: boolean;
}
```

### 2.3 Extraction Primitives (`extract`)

Kept cleanly separate from `decide()` — hits `extractionsEndpoint` with `{ model, state, assets?, fields }`:

```ts
export interface TextField {
  readonly type: "text";
  readonly instructions?: QuestionInstructions;
  readonly null_threshold: number; // required > 0 on d1.2
}

export interface NumberField {
  readonly type: "number";
  readonly instructions?: QuestionInstructions;
  readonly decimals?: number;
  readonly null_threshold: number; // required > 0 on d1.2
}

export interface DateField {
  readonly type: "date";
  readonly instructions?: QuestionInstructions;
  readonly null_threshold: number; // required > 0 on d1.2
}

export interface EstimateField {
  readonly type: "estimate";
  readonly instructions?: QuestionInstructions;
  readonly unit?: string;
}

export interface ListField {
  readonly type: "list";
  readonly instructions?: QuestionInstructions;
  readonly items?: unknown;
}

export type ExtractionField = TextField | NumberField | DateField | EstimateField | ListField;
export type FieldMap = Record<string, ExtractionField>;

export interface ExtractionAsset {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string; // base64 or data URL
}

export interface ExtractionResult<F extends FieldMap> {
  model: string;
  fields: { [K in keyof F]: unknown }; // strictly projected to declared keys
  usage: DecisionUsage | null;
}
```

### 2.4 Client Object & Error Contract

```ts
export type DecisionErrorCode =
  | "missing_credential"
  | "invalid_credential"
  | "invalid_config"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "http_error"
  | "invalid_response";

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly status?: number;
  /** True only when a confirmed pre-dispatch 503 + Retry-After was received. */
  readonly retryAfter?: boolean;
}

export interface DecisionClient {
  readonly config: ResolvedDecisionConfig;
  /** Canonical cache scope string for this client's (model, endpoint). */
  readonly scope: string;
  /** Resolve and check credential availability without making a network call. */
  resolveApiKey(): Promise<string | undefined>;
  /** Typed decision call (POST /decisions or /systemone). */
  decide<const Q extends QuestionMap>(
    state: unknown,
    questions: Q,
    overrides?: RequestOverrides,
  ): Promise<DecisionResult<Q>>;
  /** Typed extraction call (POST /extractions). Validates d1.2 modality/null_threshold rules before dispatch. */
  extract<const F extends FieldMap>(
    state: unknown,
    fields: F,
    overrides?: RequestOverrides & { assets?: readonly ExtractionAsset[] },
  ): Promise<ExtractionResult<F>>;
}

export function createDecisionClient(config: Partial<DecisionModelConfig>): DecisionClient;
```

### 2.5 Usage Example (Before vs After)

```ts
import { createDecisionClient, noul, choice } from "@unblocklabs/decisions";

const client = createDecisionClient({
  endpoint: "https://codex.unblocklabs.ai/v1/decisions",
  model: "liquid/d1.2-ultra",
  apiKeyFile: "/home/you/.openclaw/secrets/unblock-memory-decisions.env",
  timeoutMs: 1500,
});

const result = await client.decide(
  { conversation, candidate },
  {
    useful: noul("Does `candidate` help answer `conversation.currentRequest`?"),
    route: choice("Primary target?", { current_answer: "...", external: "..." }),
  },
  { signal },
);

// Fully typed, strictly validated, extra keys stripped, rounding-safe:
result.answers.useful.noul;          // number [0..1]
result.answers.route.choice;         // "current_answer" | "external"
result.answers.route.probabilities;  // { current_answer: number; external: number }
```

---

## 3. Phased Migration Plan

### Phase 1 — Create & publish `@unblocklabs/decisions` (v0.1.0)
1. **Scaffold repo** (`unblocklabs-ai/decisions`): pure TypeScript ES2023, zero runtime dependencies, Node 22+ `node:test`, `knip`, `tsc --noEmit`.
2. **Port battle-tested core** from `unblock-memory/src/typesafe-client.ts`, `src/config.ts` (URL validation), and `src/response-judge.ts` (distribution sum/expected-value validation):
   - URL enforcement (HTTPS / loopback HTTP, no userinfo/query/fragment/whitespace).
   - Credential resolver (inline `apiKey`, raw/dotenv `apiKeyFile`, origin-isolated `envKeys`).
   - `decide()` with `noul`/`choice`/`score` strict validators + exact field projection.
   - `extract()` with `text`/`number`/`date`/`estimate`/`list` validators + `d1.2` pre-flight guards (`null_threshold > 0`, image assets only on `estimate`).
   - `DecisionError` with sanitized messages and `retryAfter` support.
3. **Publish** `@unblocklabs/decisions@0.1.0` to npm (or link locally during Phase 2–3 verification).

### Phase 2 — Migrate `@unblocklabs/qmd` (v3.1.0)
1. **Replace QMD's stale `src/typesafe-query.ts`** with `@unblocklabs/decisions`:
   - Delete QMD's hardcoded `https://api.typesafe.ai/v1/systemone`, `jev-1.13.0`, and manual `queryApiKey` / `fetch` / `zod` validation.
   - Rename `SearchOptions.typesafe` → `SearchOptions.decisionModel` (keeping `typesafe` as a deprecated alias mapping to `decisionModel` for backward compatibility).
   - Default standalone `qmd search` to the same `endpoint` / `model` / `apiKey` / `apiKeyFile` contract (with env fallback for `CODEX_LB_API_KEY` on Codex LB and `TYPESAFE_API_KEY` on `api.typesafe.ai`).
2. **While touching QMD, close the top `unblock-memory` integration friction points** (from the QMD audit):
   - Re-export `exportEmbeddedSnapshot` (plus `readEmbeddedSnapshot(dbPath)` + `createMemoryStore(snapshot)`) from `index.ts`.
   - Add `virtual: true` collection support + `upsertDocument` / `deactivateDocument` on `QMDStore`.
   - Serialize native `node-llama-cpp` calls inside `LlamaCpp` / `Store` (so callers never monkey-patch `internal.searchVec`).
   - Expose `embedDocuments` / `embedQuery` / `countTokens`, `getChunkStrategy()`, `purgeCollection(name)`, and `Maintenance` options (`secureDelete`, `walCheckpoint`).
   - *(Optional v4.0)* Split `@unblocklabs/qmd-core` from CLI / MCP / `tree-sitter-*` / `yaml` / `zod` so plugin installs stay tiny and native-build-light.

### Phase 3 — Migrate `@unblocklabs/unblock-memory` (v0.13.0)
1. **Swap transport layer to `@unblocklabs/decisions`:**
   - Replace [src/typesafe-client.ts](../../src/typesafe-client.ts) with a thin adapter (`src/decision-client.ts`) wrapping `createDecisionClient(...)` with `unblock-memory`'s default endpoint (`https://codex.unblocklabs.ai/v1/decisions`), default model (`liquid/d1.2-ultra`), legacy inference (`api.typesafe.ai` → `jev-1.13.0`), and provider-isolated env bindings.
   - Simplify callers across [src/typesafe.ts](../../src/typesafe.ts), [src/typesafe-review.ts](../../src/typesafe-review.ts), [src/response-judge.ts](../../src/response-judge.ts), [src/training-gate.ts](../../src/training-gate.ts), [src/inside-out.ts](../../src/inside-out.ts), [src/people-primer.ts](../../src/people-primer.ts), [src/my-turn.ts](../../src/my-turn.ts), and [src/safety-whisperer.ts](../../src/safety-whisperer.ts) — removing ~250+ lines of duplicated TypeBox schemas and manual `Object.keys`/`Object.hasOwn`/distribution checks!
2. **Rename config key cleanly (zero-breakage deprecation):**
   - Introduce **`decisionModel`** in [openclaw.plugin.json](../../openclaw.plugin.json) and [src/config.ts](../../src/config.ts):
     ```json
     {
       "decisionModel": {
         "enabled": true,
         "endpoint": "https://codex.unblocklabs.ai/v1/decisions",
         "model": "liquid/d1.2-ultra",
         "apiKeyFile": "/home/you/.openclaw/secrets/unblock-memory-decisions.env",
         "timeoutMs": 1500
       }
     }
     ```
   - Keep `typesafe` accepted as a **deprecated alias** in `openclaw.plugin.json` and `resolveConfig()` (rejecting configs that set *both* `decisionModel` and `typesafe` simultaneously, and logging a one-time deprecation notice when `typesafe` is used).
   - Keep SQLite cache/cohort keys (`decisionModelScope`) byte-identical so **zero existing SQLite caches, cohorts, or baselines invalidate** on upgrade!
3. **Update operator tooling & docs:**
   - Rename `scripts/typesafe-fleet*.mjs` → `scripts/decision-fleet*.mjs` (leaving thin re-export shims if desired) and patch `decisionModel` on v0.13+ targets.
   - Optional Phase 3b: wire `client.extract(...)` for structured session-extraction experiments (e.g. fast `d1.2` field/entity pre-extraction alongside or instead of Luna).
4. **Drop deprecated `typesafe` alias in v1.0.0** once all fleet nodes are migrated.

---

## 4. Key Decisions to Confirm Before Building

1. **Package name & repo:** `@unblocklabs/decisions` (under `unblocklabs-ai/decisions`) or `@loggie/decisions`?
2. **Zero runtime dependencies:** Agree on zero runtime deps (hand-written strict runtime validators inside `@unblocklabs/decisions`) so neither `zod` nor `typebox` is forced on consumers?
3. **Default `extractionsEndpoint` derivation:** Auto-derive `/v1/extractions` from `/v1/decisions` when `extractionsEndpoint` is omitted (so once Codex LB exposes `https://codex.unblocklabs.ai/v1/extractions`, it works out of the box), or require `extractionsEndpoint` to be configured explicitly?
4. **Config rename timing in `unblock-memory`:** Ship `decisionModel` + deprecated `typesafe` alias in the next release (`v0.13.0`), or wait until `@unblocklabs/decisions` is published first?
