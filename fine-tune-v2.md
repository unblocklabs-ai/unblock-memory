# Fine-tune v2: lex and vector queries

**Status:** Local plugin implementation complete; reviewed MHC trainer patch staged locally pending remote application approval. Replace the v1 code path in place; no parallel v1 mode or compatibility parser. Implementing this document does not authorize paid collection, fine-tuning, or deployment.

## Goal

Train the small Memory Whisperer model to produce one object per resolved, eligible conversation:

```json
{"lex":"discriminating BM25 keywords","vec":"natural-language vector query"}
```

Each field has a distinct job. `lex` targets discriminating keywords, names, and identifiers; `vec` targets semantic similarity. The existing lexical adapter splits terms and joins them with `OR`: quotation marks do not enable exact-phrase matching. Keep that implementation unchanged and teach useful terms, not special search syntax. Do not add HyDE or multiple outputs per field without evidence that they help.

## Shared conversation window and passage rendering

Training and runtime must use the same input preparation and passage renderer:

- Cap the serialized conversation (`history` plus `currentRequest`) at **8,192 tokens**, measured with the pinned LFM tokenizer, rather than a fixed message count. Initially retain the existing **24,000 UTF-8-byte guard** as an additional limit in both paths; bytes are not tokens.
- Preserve the whole current request and the most recent whole visible user/assistant messages. Drop oldest history messages until both limits fit; respect session/compaction boundaries and exclude tool/thinking payloads. If the current request alone exceeds either limit, skip automatic Whisperer and flag the corresponding training example rather than cutting the request.
- Supply exactly this conversation to the recall gate, Luna teacher, LFM student, and passage judge. Only the offline revision round additionally receives its lane's earlier queries and scores.
- Use the runtime's same complete-excerpt rendering and **1,200-character passage limit** for training retrieval and judgment. Preserve source/identity/time context; do not train against oversized passages runtime would discard.
  The v2 Whisperer renderer uses this fixed character budget, independent of QMD's embedding-tokenizer expansion setting; ordinary manual search keeps its existing token-based setting.

The [LFM2.5-230M-Base model card](https://huggingface.co/LiquidAI/LFM2.5-230M-Base) documents **32,768 context tokens**; the config's `max_position_embeddings: 128000` is not a supported 128K-context claim. Reserve prompt/template and output space within the documented limit. [TypeSafe `jev-1.13.0`](https://docs.typesafe.ai/models) allows **32K tokens for state plus one question**; its 64K combined-request limit does not enlarge our one-question window. The 8K conversation ceiling leaves headroom, but tokenizers differ: inspect TypeSafe's reported usage rather than treating LFM token counts as Jev token counts.

## One shared passage grader

Reuse the runtime `judgeTypeSafeMemories` prompt and criteria from `src/typesafe.ts`, with the same pinned TypeSafe model and one shared, versioned implementation for training and runtime. Replace the separate training-only four-level rubric; do not copy the runtime prompt into a second implementation.

The grader asks whether a careful assistant would use a specific factual detail from the passage when answering the original `currentRequest`. Repetition of supplied facts, a matching name, or a similar topic alone does not count. It returns a **0–1 usefulness probability** (`noul`). Any future prompt/criteria changes apply to both paths together.

- Each distinct eligible passage gets its own request containing the original conversation and only that passage. **Ten distinct eligible matches means ten passage-grading requests**, which can run concurrently.
- Do not show the judge the generated query, backend, rank, retrieval score, or other candidates. Judge against the original request, not the search query.
- Reuse a judgment only when the conversation, rendered passage/metadata, model, and grader version are identical. A passage found by multiple queries or rounds need not be judged again.
- The existing recall gate remains a separate decision about whether seeking memory would help, not a second passage-scoring mechanism.

## Offline dataset recipe

1. Reuse the current historical-conversation extraction and TypeSafe recall gate (**>=0.7**), using the shared window above. The input is the visible conversation **before** the user turn's answer. Search only the originating agent's time-filtered historical corpus; never use the later answer as a label or show it to Luna. Enforce historical cutoffs in code. The existing evaluator uses prefixes of currently retained sessions, not a reconstruction of the original index; it excludes time-unversioned files and Loggie projections and cannot undo later edits/deletions. Retain its coverage/exclusion counts.
2. Run **two independent lanes**, with **five candidates per lane per round**. For `lex`, ask isolated GPT-6 Luna for BM25 queries and retrieve each through BM25 only. For `vec`, ask for semantic queries and retrieve each through vector search only. Retrieve ten matches per candidate in its lane, using the same scope, depth, and passage rendering as the intended Memory Whisperer runtime. Runtime depth is ten across approved collections per backend, not ten per collection.
3. Use the shared passage grader. Score each query by the **arithmetic mean of its three highest passage usefulness probabilities**, computed in code. With one or two matches, average the available matches; empty retrieval scores zero. Use raw probabilities without thresholding or converting to another grading scale. Failed judgments leave the evaluation unresolved rather than becoming zeros or silently disappearing from the average.
4. Run one **revision round per lane**. Give Luna the same historical input and lane-specific instructions, plus only that lane's previous query texts and their TypeSafe-derived scores. Do **not** provide retrieved passages, inferred answer terms, or the later assistant response. Retrieve and judge the new candidates the same way.
5. Independently select the highest-scoring `lex` and `vec` query across both rounds, with stable tie-breaking that preserves candidate order. Do not optimize the pair jointly. The goal is the best training targets, regardless of whether improvements come from feedback or additional attempts; no equal-budget fresh-candidate control experiment is required.

Keep valid, fully evaluated query examples even when neither lane finds useful evidence. A good query need not have a relevant fact available in the historical corpus. Always select each lane's highest-scoring query, including low scores or empty retrieval; all-zero ties preserve the original candidate order. The runtime usefulness threshold (default 0.7) controls live hint injection only, not query-training eligibility. The separate recall gate remains unchanged.

Flag failed evaluations, malformed teacher outputs, and unavailable historical snapshots for **case-by-case review**. Preserve their results and leave them out of training until resolved; a failed request is not an empty or zero-score retrieval. A provider failure affects its example, not the entire evaluation pass: continue unrelated work without automatically retrying failed requests. Storage/lease failures still stop the run. If failures become frequent, inspect the actual cases before changing the design. Export can recover completed v2 examples previously excluded only for no useful evidence by reselecting from their saved scores, without new Luna/TypeSafe calls or resetting checkpoints.

Use the existing private `training.sqlite` for versioned generation, retrieval, judgment, score, and selection checkpoints. Reuse identical passage judgments across queries and rounds. Only v2 identities are used for query work, status, and exports; no v1 execution or migration of old labels into v2. Existing private rows may remain untouched as inert audit data; implementing v2 does not require deleting datasets or model weights. Keep all exports private. Preserve lazy historical-index construction on resume.

## Fine-tune and validation

Export one `{lex, vec}` target for each resolved example. Keep the existing input format, tokenizer/chat template, assistant-only loss, privacy screening, and session/identical-input-grouped train/validation split, with the shared window above. Update the target schema, model prompt, local worker parser, and retrieval routing together. At runtime, route `lex` only to BM25 and `vec` only to vectors, then deduplicate and judge the combined passages with the shared grader. Keep the existing runtime usefulness threshold, cooldown, and two-hint injection limit; the top-three average selects offline query targets, not the number of runtime hints. The deployed model still generates once; both search-and-revision rounds are offline dataset work.

Update the existing validation workflow for the v2 schema and evaluate on held-out historical requests: useful evidence found, answer coverage, duplicate/incorrect evidence, cost, and runtime latency. Keep the evaluation cohort fixed, including requests unresolved during target generation, and manually review flagged cases. Retaining or running v1 is not a prerequisite. This is normal validation of the update, not a new experiment to re-prove that LFM can learn query generation.

Preparation takes frozen recall-gate exports via `--cohort` and builds session/identical-input groups before reading successful targets. `validation-eval.jsonl` retains safe held-out sources even without a target; SFT files include only resolved targets. Oversized output targets are quarantined against the worker's 256-token generation budget rather than truncated.
