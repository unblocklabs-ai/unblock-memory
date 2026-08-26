OpenClaw base search sucks:

### Almost no search-time filtering

- Cannot filter by date range.
- Cannot filter Slack vs iMessage.
- Cannot filter Slack channel, sender, thread, DM/group, or session kind.
- Only corpus, query, result limit, and score threshold are exposed.
- I can join results against the session registry and discard unwanted providers/dates afterward.
- But irrelevant older/Slack results may already have crowded desired recent/iMessage results out of the ranked result limit.

### Search results drop useful routing metadata

- Hits contain session UUID/path, snippet, score, generic provenance, and timestamp.
- They do not directly include provider, channel ID, thread ID, sender, or session key.
- Recovering those requires a separate registry join.

### Slack channel names require another lookup

- The session registry generally stores channel IDs, not names such as `#proj-openclaw`.
- Human-readable attribution requires Slack metadata resolution.

### Speaker attribution is inconsistent

- Every message is labeled `User:`, but the actual person is only present when embedded in the transcript text.
- Sender identity is not a reliable structured result field.

### Session snippets are lossy

- Source is JSONL, but search returns a flattened `User:` / `Assistant:` text snippet.
- It preserves some Markdown, but truncates context and does not expose the original structured event.

### Two disconnected retrieval systems

- `memory_search` provides semantic + BM25 recall but weak metadata and currently times out.
- `sessions_search`/`history`/`list` preserve session context and routing better, but topic search is primarily textual rather than semantic.
- Using them well requires a manual multi-tool pipeline.

### Corpus behavior/naming is muddy

- Results are basically labeled memory or sessions.
- Selectors also include `wiki` and `all`, while configured sources influence what `all` actually covers.
- That contract is harder to reason about than it should be.

---

**The ideal fix:** Searchable structured session documents with provider, channel, sender, timestamp, thread, and session-kind filters applied before hybrid ranking—plus a timeout above real p95 latency or, better, search performance below a few seconds.

Cannot create my own corpus. I should be able to save skills as its own corpus if i want to.

Todo:
- send subagent to review openclaw installation specifically regarding how they are taking session data and creating it as plain text, we will need to do the same for embedding. But also we will need to hydrate before embedding with speaker labels. It should be:

Bek: lorem ipsum
Bill: dollar sum

Potentially, agent should be able to create clusters by time period, like last 30 days, to analyze. But that can be later.
