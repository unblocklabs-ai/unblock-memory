# LFM training

Implementation status: [collection, query generation, historical
QMD evaluation and target export](docs/memory-training.md) are implemented locally.

You’re building a **small, context-aware query generator**, trained to produce the best available queries—not merely copying the queries agents happen to write, and not requiring every question to have an answer in memory.

## 1. Build the training dataset

Across all nodes:

1. **Extract eligible conversation points**
   - Exclude cron sessions.
   - Find each user turn followed by an assistant reply or tool action before the next user turn; delivery mirrors count too.
   - Do not require enriched human/owner metadata on older turns; exclude explicit bots and internal messages.
   - Capture that user message plus preceding conversation turns, within the LFM model’s 32k context budget.

2. **Keep inputs where historical memory would help**
   - Use TypeSafe's saved recall judgment: probability **>= 0.7** qualifies.
   - Keep negative labels for audit, but do not generate queries or export query targets for them. Greetings such as “hi” should not force invented searches.
   - Missing, failed or ambiguous judgments must be completed before the input qualifies.
   - This judges whether seeking memory is useful, not whether the corpus contains an answer.

3. **Generate candidate queries for recall-positive inputs**
   - Ask **GPT-6 Luna with xhigh reasoning** to generate **10 distinct memory-search queries** from the existing conversation context.
   - Persist the input and candidates in a separate training SQLite database managed by the plugin, reusing unchanged checkpoints.

4. **Test the candidates against real memory**
   - Run each exact query through `qmd query` against its **originating node’s memory corpus**.
   - Retrieve 10 vector + 10 BM25 matches, keeping every unique eligible passage without a merged count cap.
   - Grade passages with the tested conversation-only TypeSafe utility rubric, withholding queries and retrieval scores.
   - Cache each distinct judgment and preserve full provenance.

5. **Select training targets**
   - Keep the **best 3 queries** for each example.
   - Rank by the sum of each query's five highest conversation-only passage grades; ties preserve teacher order.
   - Do not require a minimum usefulness score, an answer, or different evidence for each query. The objective is query quality, not answer availability.
   - Fine-tune LFM2.5-230M-Base on:
     - **Input:** preceding conversation + latest user message.
     - **Target:** the selected high-performing queries.

The key is that **retrieval results determine the labels**, rather than assuming the stronger model’s queries are good.

## 2. Use the trained model during automatic recall

When a user message arrives, start two branches concurrently:

- **TypeSafe:** “Would additional memory help?”
- **Small model:** request 3 queries, keep usable strings and drop exact duplicates → retrieve 10 vector + 10 BM25 matches per query and approved collection → deduplicate passages → TypeSafe judges their usefulness against the original conversation. Generated queries and retrieval scores are never sent to the judge.

If the first judgment says **yes**, inject the retrieved context through the existing Memory Whisperer mechanism once results are ready. If **no**, discard the speculative retrieval results.

This runtime injection decision is separate from the training-data gate. Positive-only
query training does not teach the small model when to abstain; keep the runtime
TypeSafe decision before using its results. This flow is opt-in through
`memoryWhisperer.mlx`; without it the existing vector-only Whisperer is unchanged.
Negative recall cancels/discards speculative work immediately without waiting for
retrieval or injecting late results. Gate failure/timeout also emits no hint.

You’re aiming to overlap the work to reduce latency; which branch finishes first remains something to measure.

**One important dataset constraint:** the subsequent assistant reply identifies an eligible example, but must not enter the query-generator input. Ideally, retrieval evaluation also excludes memories created *after* that user message, so future answers don’t leak into the training labels.
