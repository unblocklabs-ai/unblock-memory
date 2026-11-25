# Decision-provider keys over SSH

Deploy Codex LB keys over SSH. Requires Node 22+, existing SSH aliases/known
hosts, OpenClaw on each target's PATH, and an `unblock-memory` manifest that
accepts `decisionModel`. The script also checks common Homebrew, `.local/bin` and
`.npm-global/bin` paths.
One row targets one user's default OpenClaw installation; multiple profiles on the
same SSH endpoint are deliberately unsupported. The `agent` column is a label.
Authored config must be JSON with the plugin entry in that file (the format written
by OpenClaw). JSON5 syntax or include-only plugin entries fail before any write.
Verification reads authored values privately on the host; `config get` redacts key
paths, so its displayed placeholder is not used to compare credentials.

1. Create a private copy outside the repo/cloud-synced folders:

   ```sh
   mkdir -p "$HOME/.config/unblock-memory"
   chmod 700 "$HOME/.config/unblock-memory"
   install -m 600 scripts/decision-fleet.example.csv "$HOME/.config/unblock-memory/decision-fleet.csv"
   ```

2. Fill its `api_key` cells with **Codex LB keys**. Add/remove host rows as needed.
   Blank keys skip that row. Do not paste keys into
   chat or command arguments. CSV quotes/CRLF/BOM are supported. Restore `chmod 600`
   if your editor changes it.
3. Preview (contacts hosts, but does not deploy keys, patch config or restart):

   ```sh
   node scripts/decision-fleet.mjs "$HOME/.config/unblock-memory/decision-fleet.csv"
   ```

4. Apply after inspecting the plan:

   ```sh
   node scripts/decision-fleet.mjs "$HOME/.config/unblock-memory/decision-fleet.csv" --apply --restart
   ```

`--apply` without `--restart` writes configuration but leaves required restarts to
you. With `--restart`, only changed config triggers a restart; `--wait 0` waits for
active work rather than forcing it to stop. Our subprocess wait is bounded at 60
seconds: a timeout reports `restart: pending`; inspect the host before retrying.
Unchanged config never triggers a restart, including on a rerun after a restart
failure: restart/check that host manually. Configuration writes may also trigger
OpenClaw's own reload behavior.

## What changes

- A dedicated `<config directory>/secrets/unblock-memory-decisions.env` (`CODEX_LB_API_KEY`),
  mode 600 in a mode-700 directory. The key is transmitted through encrypted SSH stdin, not
  arguments/environment/logs. Atomic replacement supports subsequent rotations.
- Under `plugins.entries.unblock-memory.config`, write `decisionModel` with
  `enabled: true`, the Codex LB endpoint and the new `apiKeyFile`. Clear any
  inline `apiKey` and model pins tied to another endpoint. Remove the retired
  config section, preserving only its timeout when the new section lacks one.
  Other plugin settings and audit approvals are preserved.
- Native `openclaw config patch` validates before writing. If the upgraded
  manifest rejects only the retired config key, the script validates a private
  temporary replacement before atomically replacing the config on apply. A private
  `secrets/decision-backup-UUID/` retains the previous config and previous managed
  key when present. Backups can contain secrets; keep them private and remove when
  no longer needed. The script never automatically restores old config over newer
  edits. Partial failures are reported, not described as a rollback.
- Existing arbitrary `apiKeyFile` files are not overwritten or deleted. Only this
  script's dedicated key file is managed. Symlink targets/ancestors are refused.
- **This enables the configured decision provider for already enabled plugin functionality.**
  It does not enable response auditing, add approved senders, install/enable the
  plugin, or submit conversation data for testing. Any already-approved scheduled
  audit may resume once credentials become available. No decision-model API request
  validates the key, so `configured` means local configuration verified, not provider acceptance.

JSON-lines output contains labels/status only, never keys or raw CLI diagnostics.
Exit 1 means a host failed (others still processed); failures in CSV/duplicate-target
preflight stop before remote deployment. Lost SSH connections can leave partial
changes: inspect before retrying. `configChanged`/`keyChanged` on a dry-run describe
the plan; on apply they describe confirmed writes. A failed CLI may have written
before failing, so do not assume `false` proves nothing changed.

Keep the CSV local with mode 600; avoid spreadsheets that cloud-sync it. The repo
ignores `*-fleet*.csv` except the blank example. Delete the populated CSV
after deployment or retain it only in encrypted storage. Never check secrets into
Git, even when a filename is ignored.
