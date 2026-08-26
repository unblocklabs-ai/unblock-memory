# Unblock Memory Enhancements — August 25

Status: proposed

This plan adds named corpora and searchable OpenClaw sessions without adopting
OpenClaw's fixed `memory | sessions | wiki | all` corpus model.

## Decisions

- Replace the current top-level `paths` configuration with named `corpora`.
- There is no legacy migration. Nobody is using the plugin yet, so we should
  change the configuration cleanly instead of carrying compatibility code.
- Keep one QMD database per agent.
- Use the Unblock Labs QMD fork: `@unblocklabs/qmd`, currently pinned to
  `unblocklabs-ai/qmd#0a6b15d`.
- Treat filesystem content and OpenClaw sessions as different corpus kinds.
- Read OpenClaw's per-agent SQLite database directly through a narrow,
  schema-versioned, read-only adapter. Do not depend on its transcript SDK.
- Materialize one derived Markdown document per session in plugin-owned storage.
- Organize derived sessions by provider, chat type, account, and conversation so
  the private corpus remains easy to inspect without flattening unrelated chats.
- Add a human-readable timestamp and speaker label to every projected message.
- Synchronize sessions every 12 hours through launchd and expose an agent tool
  for manual sync. Both entry points use the same sync implementation.
- Initially index only `channel` and `group` chats. Direct messages must be an
  explicit future opt-in.
- Keep semantic chunking plus vector search as the default retrieval path. We
  have already found it better for this use case than hybrid search plus a
  reranker, so we should not add the latter without new evidence.
- Defer time-period clustering. The session metadata added here will support it
  later without requiring separate indexes.

## Configuration

```json5
{
  corpora: [
    {
      name: "memory",
      kind: "files",
      paths: ["MEMORY.md", "USER.md", "memory/**/*.md"],
    },
    {
      name: "skills",
      kind: "files",
      paths: ["skills/**/*.md"],
    },
    {
      name: "sessions",
      kind: "sessions",
      chatTypes: ["channel", "group"],
    },
  ],
}
```

Proposed types:

```ts
type FileCorpusConfig = {
  name: string;
  kind: "files";
  paths: readonly string[];
};

type SessionCorpusConfig = {
  name: "sessions";
  kind: "sessions";
  chatTypes?: readonly ("channel" | "group" | "direct")[];
};

type CorpusConfig = FileCorpusConfig | SessionCorpusConfig;

type UnblockMemoryConfig = {
  corpora: readonly CorpusConfig[];
  analysis: { executable?: string };
};
```

Configuration rules:

- When `corpora` is omitted, synthesize only the default `memory` file corpus.
- When `corpora` is supplied, require exactly one explicit `memory` corpus.
- Corpus names must be non-empty and unique.
- Reserve `all`; it is a query selector, not a valid corpus name.
- Reserve `sessions` for the session corpus kind.
- Require non-empty `paths` for file corpora.
- Default session `chatTypes` to `["channel", "group"]`. `direct` must be
  explicitly configured.
- Do not accept the old top-level `paths` property.

A named file corpus is a logical grouping. Internally, each configured path can
continue to map to its own QMD collection, with the corpus maintaining the
collection allowlist used during search.

## Session source

OpenClaw's per-agent SQLite database is the canonical source. In the default
layout it lives at:

```text
<openclaw-state>/agents/<agent-id>/agent/openclaw-agent.sqlite
```

The database already contains the normalized inventory needed for projection:

- `session_windows`: retained session generations, session key, chat type,
  channel provider, account, conversation, and timestamps
- `conversations`: stable provider conversation identity, native channel and
  direct-user IDs, thread ID, and optional human-readable label
- `transcript_events`: persisted JSON transcript events
- `session_transcript_active_events`: the ordered events on the currently
  visible branch
- `transcript_rewrite_watermarks`: the source generation for each persisted
  transcript

`session_participants` can enrich known human identities when present, but it is
not part of the required schema. The live fleet has schema-v17 databases where
the populated agent has this table and empty agents do not. `session_members`
is a separate optional identity-membership table and is not a replacement for
transcript sender metadata.

Use a narrow `OpenClawSqliteReader` owned by this plugin. It must:

- Open the normal per-agent database read-only. Never open the separate
  incognito database.
- Resolve the configured OpenClaw state directory rather than assuming `~`.
- Verify `PRAGMA user_version`, the `schema_meta` row whose `meta_key` is
  `primary`, and every required table/column before reading. Other
  `schema_meta` rows can describe one-off migrations and have unrelated schema
  versions.
- Support only explicitly tested schema versions. Fail with an actionable
  unsupported-schema error instead of guessing after a migration.
- Read under a SQLite snapshot transaction so one sync sees a consistent
  database while the Gateway continues writing through WAL.
- Use a bounded busy timeout and close the read connection after projection.
- Never copy only the main SQLite file while ignoring its WAL and SHM files.
- Use the runtime SQLite API's explicit read-only mode rather than shelling out
  to the host `sqlite3` CLI. The inspected host's bundled CLI did not provide a
  usable read-only flag, while Node's SQLite runtime safely opened the live WAL
  database with `readOnly: true`.
- Parse every `event_json` through strict runtime validation; persisted JSON text
  is not automatically trusted TypeScript data.

Enumerate retained generations from `session_windows`, not only current rows in
`session_nodes`. For each generation, join `session_transcript_active_events` to
`transcript_events` and order by `active_position`. Reading every raw transcript
event would incorrectly include abandoned branches, rewound messages, or other
events OpenClaw no longer considers visible.

Do not depend on `previous_session_id` to enumerate history. On the inspected
fleet it was null for every window even though 17 historical generations were
retained. Group windows by `session_key` and use
`session_nodes.current_session_id` only to distinguish the current generation
from older ones.

Use `transcript_rewrite_watermarks.generation` as the primary incremental source
revision. Every transcript-bearing live session had exactly one watermark, and
the generation changes when OpenClaw rewrites the active transcript. Event count
and maximum sequence remain useful diagnostics but are not sufficient identity
for a rewrite.

This deliberately accepts coupling to OpenClaw's database schema because the
fleet and host versions are controlled. The coupling remains explicit,
version-checked, read-only, and covered by schema fixtures.

### Live schema checkpoint — 2026-08-25

A read-only inspection of `billsmacmini` established the initial fleet fixture
target:

- OpenClaw `2026.8.1-beta.2`, `PRAGMA user_version = 17`, WAL journal mode
- four per-agent databases in the default layout; only `main` was populated
- 1,690 session windows across 1,673 session keys
- 928 windows with transcripts, 13,728 raw events, 12,791 active events, and
  12,596 active message events
- 1,539 windows allowed by the proposed chat-type policy, of which 817 had
  active transcript events; empty eligible windows must not create documents
- 928 inactive `session` header events plus nine genuinely inactive assistant
  messages across seven sessions, confirming that the active-event join is
  required
- active and message positions were dense and zero-based for every transcript
- every transcript-bearing window had one 32-character rewrite generation

The populated database was approximately 1.42 GB, but `transcript_events`
occupied only about 58 MB; most space belonged to OpenClaw's existing memory
embedding cache. Keep source queries narrow and indexed rather than treating the
whole database size as transcript cost.

## Storage model

QMD's current public SDK indexes filesystem collections and then stores indexed
documents, chunks, and vectors in its SQLite database. For the current API, the
simplest supported design is:

1. Read schema-validated active transcript events from OpenClaw SQLite.
2. Project each eligible session with retained user or assistant content into
   one Markdown file; do not create empty documents for windows without active
   projectable messages.
3. Store those derived files under the plugin's private per-agent data
   directory, outside the agent workspace, using the hierarchy described below.
4. Point a dedicated QMD collection at that directory.
5. Run QMD update and semantic embedding for changed session documents.

The Markdown file is a disposable projection, not canonical session data and
not user-authored memory. OpenClaw remains the source of truth. The QMD database
and projected session directory can both be rebuilt.

This provides the useful split:

- Large projected text remains easy to inspect, replace atomically, and delete
  as files.
- QMD SQLite stores its normal search index and embeddings.
- A small atomic projection manifest can store source revision, output path,
  projector version, and session metadata without storing a second transcript
  copy. Add a queryable metadata database only when pre-ranking filters require
  it.

We should not insert documents directly into QMD's internal SQLite tables. If a
future benchmark shows filesystem projection is the bottleneck, add a supported
virtual-document ingestion API to the Unblock Labs QMD fork instead.

## Derived session directory layout

Organize the private session projection provider-first, followed by chat type,
account, conversation, and session:

```text
sessions/
├── slack/
│   ├── channel/
│   │   └── <account-id>/
│   │       └── C123--proj-openclaw/
│   │           ├── 2026-08-25T18-32-09Z--<session-id>.md
│   │           └── 2026-08-25T21-14-03Z--<session-id>.md
│   └── group/
│       └── <account-id>/
│           └── <conversation-id>/
│               └── 2026-08-25T19-03-11Z--<session-id>.md
├── imessage/
│   └── group/
│       └── <account-id>/
│           └── <hashed-chat-id>--family/
│               └── 2026-08-25T20-17-42Z--<session-id>.md
└── unknown/
    └── channel/
        └── 2026-08-25T20-21-06Z--<session-id>.md
```

Use provider-first rather than a generic top-level `channels` directory.
`channel` is a Slack-style chat type, while providers such as iMessage usually
contain group and direct conversations. The provider-first hierarchy avoids
using the same word for an integration and a conversation type.

Path rules:

- Index the entire tree as one logical `sessions` corpus and one QMD collection
  with the pattern `**/*.md`.
- Omit `direct` directories while the session corpus excludes direct messages.
- Include the provider account or workspace identifier so conversation IDs from
  separate installations cannot collide.
- Use the stable provider conversation ID as canonical identity. For inspected
  Slack channel rows, use `native_channel_id ?? peer_id`; `peer_id` was present
  for every eligible channel even when `native_channel_id` was absent. Treat the
  resulting value as opaque rather than assuming every channel ID starts with
  `C`.
- A readable slug such as `C123--proj-openclaw` is decorative. Do not rename or
  move a folder solely because `conversations.label` changed: the live database
  had 52 stable Slack channel IDs but 628 labels, and one ID accumulated 217
  labels. Only an authoritative provider-level channel name should drive a
  decorative slug refresh.
- Name session files `<session-start-utc>--<session-id>.md` for chronological
  browsing and stable uniqueness. Use `started_at ?? created_at`; 744 of 1,690
  inspected windows had no `started_at` but all had `created_at`.
- Sanitize every generated path component and apply conservative length limits.
- Never place phone numbers, email addresses, access tokens, or other sensitive
  identifiers in paths. Hash iMessage chat identifiers and include a readable
  group slug only when it is explicitly available and safe.
- Keep provider, chat type, account, and conversation identity in structured
  metadata as well. Paths are an inspectable projection, not the authority for
  filtering or authorization.
- When the channel provider is unavailable but the allowed chat type is known,
  retain the session under `unknown/<chat-type>`. Skip a session whose chat type
  cannot be shown to satisfy the corpus allowlist.

## Session document format

Use one stable document per session within the directory layout above. Session
identity comes from the agent/session IDs; human-readable path slugs must not be
treated as identity.

Example:

```md
# Session

- Session ID: `9c5c...`
- Provider: Slack
- Channel: `#proj-openclaw` (`C123`)
- Chat type: channel

## Transcript

2026-08-25 14:32:09 EDT — Bek: Can you review the memory implementation?

2026-08-25 14:33:02 EDT — Alfie: Yes. The current search path only uses vector retrieval.

2026-08-25 14:35:41 EDT — Bill: What should we change first?
```

Projection rules:

- Use the agent's configured timezone for display timestamps.
- Prefer the top-level event `timestamp`, then `transcript_events.created_at`,
  then `message.timestamp`. On the live data, the event timestamp agreed with
  `created_at` to within one second for every active message, while the message
  timestamp frequently described a different time.
- Retain the exact machine timestamp separately in metadata for filtering.
- Read structured sender fields before stripping any rendered inbound envelope.
  Prefer `message.__openclaw.senderName`, `senderUsername`, and `senderId`, then
  root-level `message.senderName`, `senderLabel`, and `senderId`, then `User`.
  Root-level fields are required for providers such as Loggie: all 23 inspected
  eligible Loggie user messages used them instead of `message.__openclaw`.
- Treat sender attribution as best effort. Older and hook-modified events may not
  retain structured sender identity.
- Use the configured agent identity for assistant messages instead of the
  generic `Assistant` label.
- Accept both string content and content-block arrays. Preserve Markdown and
  meaningful line breaks from user/assistant text blocks. The live transcript
  also contained `toolCall`, `toolResult`, `thinking`, and `image` blocks, so the
  validator must discriminate block types instead of casting content to text.
- Exclude tool-only, generated, heartbeat, recalled-memory, and other internal
  transcript content.
- Skip or remove the projection when no projectable user or assistant text
  remains after filtering.
- Redact sensitive text before writing the derived document.
- Never infer a speaker identity from fuzzy text matching.
- Keep the full date at the beginning of each message line. This matches the
  Unblock Labs QMD fork's timestamp event boundary; add an integration fixture
  that verifies projected messages remain valid semantic chunk boundaries.

One document per session is intentionally simple. QMD's semantic chunker should
create the retrieval units at embedding time. A changed session requires
reprocessing only that session document; unchanged sessions are skipped using
the source revision in the projection manifest. Because QMD vectors are keyed by
the complete document content hash, appending to a session currently causes all
chunks in that session document to be re-embedded. Measure long-session cost on
the fleet; consider append-stable windows or chunk-addressed vectors only if it
becomes material.

## Session metadata

Keep structured metadata separate from the text being embedded:

```ts
type IndexedSession = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  channelProvider?: string;
  accountId?: string;
  channelId?: string;
  channelName?: string;
  threadId?: string;
  chatType: "channel" | "group" | "direct";
  sessionKind: "interactive" | "subagent" | "cron" | "heartbeat" | "unknown";
  senderIds?: readonly string[];
  startedAt?: number;
  endedAt?: number;
  sourceGeneration: string;
  activeEventCount: number;
  sizeBytes: number;
  projectionHash: string;
  documentPath: string;
};
```

Channel names are display enrichment, not identity. Filter using stable channel
IDs and let channel-name resolution happen asynchronously without blocking
session indexing.

Session-kind classification is also best effort. In the live database every
`session_windows.reason` was null, and most `session_nodes.created_via` values
were null. Use positive normalized signals such as `created_via = "spawn"` or
`"cron"` when present, otherwise retain `unknown`; do not infer kind from fuzzy
session-key or display-name text and do not reject an otherwise eligible session
merely because its kind is unknown.

## Provider enrichment

Use OpenClaw SQLite as the transcript source and first source of available
display labels:

- `conversations.label` as best-effort display text, not an authoritative
  provider channel name
- `conversations.native_channel_id`, `peer_id`, and `thread_id` for stable
  provider identities
- structured nested and root-level sender fields for message attribution

Slack API access is optional enrichment for unresolved IDs:

- `conversations.info` can fill a missing channel name.
- `users.info` can fill a missing sender display name.
- Cache results by Slack account plus stable channel/user ID.
- Rate limits, missing scopes, or network failure must not block projection.

Do not use `conversations.history` or `conversations.replies` as the primary
session source. Slack history can contain messages the agent never observed,
omit messages removed by Slack retention, and cannot reproduce OpenClaw's
session/branch semantics. A future full-workspace Slack archive should be a
separate `slack-history` corpus with its own scope and retention contract.

Do not silently extract another plugin's resolved Slack bearer token. Prefer a
public OpenClaw directory/runtime capability when one exists. Otherwise require
an explicit SecretRef owned by Unblock Memory for optional enrichment. Never
write the resolved token into the projection, manifest, logs, or launchd plist.

## Synchronization

### Shared sync worker

Build one sync implementation used by both a package CLI and the agent tool. The
CLI surface is:

```text
unblock-memory-sync --all-agents
unblock-memory-sync --agent <agent-id>
```

It must accept an explicit OpenClaw state directory, discover only configured
agents, close all OpenClaw/QMD database handles on exit, and return nonzero when
any requested agent failed.

The sync worker owns session projection and the QMD `sessions` collection. The
normal file-corpus watcher must not watch the derived sessions directory or run
a competing session embed. Ordinary file-corpus updates must also use
collection-scoped QMD operations so they do not rescan sessions.

### Scheduled launchd sync

Deploy a launchd job on the macOS fleet that invokes the CLI:

- `RunAtLoad` for an initial reconciliation
- `StartInterval` of `43200` seconds (12 hours)
- Absolute executable and state-directory paths
- A minimal explicit environment rather than reliance on an interactive shell
  `PATH`
- Private bounded logs containing status and counts, never transcript text or
  credentials

The Gateway does not need `activation.onStartup: true` or a resident sync timer.
`memory_search` reads the last successfully indexed QMD snapshot while the
external sync runs.

### Cross-process coordination

The launchd CLI and manual agent tool can overlap, so every sync writer must
acquire the same per-agent lock before changing projections or QMD:

```text
<unblock-memory-agent-state>/sync.lock
```

- Acquire the lock atomically and record PID/start time for diagnostics.
- Recover a stale lock only after validating that its process is gone.
- Permit only one projection/QMD writer per agent.
- Keep search read-only and available during sync.
- Apply a bounded wait for a manual request; return `already_running` with safe
  status when the active sync does not finish in time.
- Remove the lock in `finally`, while preserving enough status to diagnose a
  failed launchd run.

### Sync algorithm

For each configured agent:

1. Acquire the per-agent sync lock.
2. Open its normal OpenClaw database read-only and validate the supported schema.
3. Start a consistent read transaction and enumerate all retained
   `session_windows` with their `conversations` metadata.
4. Reject disallowed or unknown chat types. Apply session-kind exclusions only
   when a positive normalized signal identifies an ineligible kind; `unknown`
   alone is not a reason to drop an otherwise eligible session.
5. For each eligible session, read only its ordered active events.
6. Compare `transcript_rewrite_watermarks.generation` and projector version with
   the projection manifest; skip unchanged sessions. Retain event count and
   sequence only for diagnostics.
7. Validate and project changed events, then atomically replace their Markdown
   files with private directory/file permissions. If no projectable content
   remains, remove any prior projection for that session.
8. Sweep stale projections only after enumeration completes authoritatively. A
   partial query or schema/read failure must never be interpreted as mass
   deletion.
9. Atomically write the new projection manifest.
10. Run `update({ collections: [sessionsCollection] })`, then
    `embed({ collection: sessionsCollection, chunkStrategy: "semantic" })` on
    the Unblock Labs QMD fork.
11. Record the successful sync timestamp and counts, close handles, and release
    the lock.

The projector version must be part of sync identity so formatting, validation,
or redaction changes cause a deliberate rebuild. A failed QMD step leaves the
projection rebuildable and must not advance the last-successful-sync marker.

### Manual tool

Add a side-effecting tool:

```ts
memory_sync_sessions({ force?: boolean })
```

- With `force: false` or omitted, sync only changed sessions.
- With `force: true`, rebuild all eligible session projections.
- Scope the operation to the current agent; do not accept arbitrary agent IDs.
- Call the same shared sync worker and honor the cross-process lock used by
  launchd.
- Return counts for scanned, unchanged, updated, removed, skipped, embedded, and
  failed sessions, plus the last successful sync timestamp.
- Report per-session failures safely without printing transcript content.

## Search

The search request should support named corpus selection:

```ts
{
  query: string;
  corpora?: string[];
  maxResults?: number;
  minScore?: number;
}
```

Omitting `corpora` searches all configured corpora. A literal corpus named
`all` is not allowed.

Retrieval remains:

1. Select QMD collections for the requested logical corpora.
2. Semantically chunk documents during embedding.
3. Run vector search over the selected collections.
4. Return the exact winning chunk span, corpus name, and session metadata when
   the hit came from the session corpus.

Do not add BM25, query expansion, or reranking by default. That decision can be
revisited only with representative recall and latency evidence.

Later search-time session filters can include date, provider, channel, sender,
thread, chat type, and session kind. These filters must restrict eligible
documents before the vector result limit is applied. QMD currently prefilters
by collection but not arbitrary session metadata. When we implement these
filters, add a typed eligible-document filtering seam to the Unblock Labs QMD
fork rather than coupling the plugin to `store.internal`.

## Privacy boundary for the first fleet deployment

The initial session corpus indexes `channel` and `group`, but not `direct`.
This is a deliberate scope boundary for Bek's OpenClaw fleet, not a general
authorization solution: group and channel transcripts can still be sensitive.

Until a complete session-visibility design exists:

- `direct` remains explicit opt-in and should not be documented as generally
  safe.
- Incognito sessions remain excluded.
- The session corpus should be described as fleet-owner functionality rather
  than multi-tenant-safe private recall.
- Search and `memory_get` must not expose sessions outside the current agent's
  index.

Future private transcript recall should carry the caller's conversation
identity, apply OpenClaw-equivalent visibility before ranking, and recheck it
when retrieving the full document.

## Implementation sequence

### Phase 1: named file corpora

- Replace `paths` with typed `corpora` configuration.
- Require the `memory` corpus and support custom file corpora.
- Derive collection identity from logical corpus name plus configured path, then
  map corpora to QMD collection allowlists.
- Add corpus selection to `memory_search` and corpus identity to results.
- Update `memory_get` to resolve results across named collections.
- Scope file-corpus QMD update/embed operations to their selected collections.

### Phase 2: direct session projection and sync

- Add the read-only, schema-versioned OpenClaw SQLite adapter and fixtures.
- Enumerate retained `session_windows` and project only active transcript events.
- Add speaker and timestamp projection with focused fixtures.
- Add private derived-document storage and the sessions QMD collection.
- Add the atomic projection manifest and authoritative sweep behavior.
- Add the shared CLI, launchd job, cross-process lock, and
  `memory_sync_sessions`.
- Enforce configured `chatTypes` during ingestion.
- Add optional nonblocking Slack channel/user label enrichment only after its
  credential ownership seam is explicit.

### Phase 3: structured filtering

- Add session metadata to results.
- Add typed query filters.
- Extend the Unblock Labs QMD fork with pre-ranking eligible-document filtering.
- Benchmark representative fleet session data before tuning search timeouts.

## Focused validation

- Configuration rejects duplicate names, missing `memory`, `all`, and invalid
  kind-specific properties.
- Default configuration produces only the default `memory` corpus.
- Unsupported or incomplete OpenClaw schemas fail before any projection is
  changed.
- Schema validation selects the primary `schema_meta` row, requires rewrite
  watermarks, and permits optional tables such as `session_participants` to be
  absent.
- SQLite projection covers retained session generations and follows only the
  ordered active transcript branch without relying on `previous_session_id`.
- Session projection preserves message order, timestamps, Markdown, speakers,
  and redaction behavior, with fixtures for nested sender metadata, root-level
  sender metadata, and the `User` fallback.
- Event timestamps take precedence over divergent message timestamps, and
  session filenames fall back from `started_at` to `created_at`.
- String content and typed content-block arrays project user/assistant text while
  excluding tool calls, tool results, thinking, and internal events.
- Eligible windows without active projectable content do not create empty
  documents and remove any stale prior projection.
- `channel` and `group` sessions index while `direct` sessions do not.
- Unknown chat types and the separate incognito database never index.
- Unchanged transcript rewrite generations avoid projection and re-embedding.
- Changed and deleted sessions update their derived files and metadata.
- A failed or partial source enumeration cannot sweep existing projections.
- launchd and manual sync cannot overlap across processes.
- Manual sync reports partial failures without leaking transcript text.
- Slack enrichment failure leaves the SQLite-derived projection usable and
  never exposes resolved credentials.
- Projected timestamp lines form expected semantic event boundaries in the
  Unblock Labs QMD fork.
- Corpus-selected vector search never returns a hit from an unselected corpus.
- Session `memory_get` remains scoped to the current agent.

## Non-goals

- Compatibility with the old `paths` configuration
- Hybrid retrieval or LLM reranking
- Query expansion
- Time-period-specific databases or clusters
- Synchronous Slack channel-name lookups during indexing
- Slack history/replies as the source of the sessions corpus
- Silently reusing another plugin's resolved Slack token
- Dependence on OpenClaw's transcript SDK
- Direct-message recall in the initial fleet configuration
- A general multi-tenant transcript authorization system in this iteration
