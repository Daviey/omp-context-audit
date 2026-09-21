# omp-context-audit

An [oh-my-pi](https://github.com/can1357/oh-my-pi) plugin that audits which context fillers — skills, MCP servers, rules, task agents — actually get **used**, what each one **costs per session** in prompt tokens, and disables the idle ones.

Every omp session pays a fixed prompt tax: one `- name: description` line per listed skill, full content for `alwaysApply` rules, and the tool schemas of every enabled MCP server. On a machine with hundreds of accumulated skills that tax reaches tens of thousands of tokens per session. This plugin measures the tax against actual usage mined from session transcripts and produces a ranked savings plan.

## What it ships

| Surface | What it does |
|---|---|
| `context_audit` tool | Runs the audit; optionally applies disable actions |
| `/audit-context` command | Prompt wrapper: run audit → present savings → ask before applying |

## Install

```sh
omp plugin install github:Daviey/omp-context-audit
```

or from a checkout:

```sh
omp plugin link /path/to/omp-context-audit
```

## The report

```
# Context audit — 2026-09-21
Window: 30d · 1803 sessions scanned (2250 on disk) · coverage 2026-08-22→2026-09-21

## Idle context cost per session (estimate)
- skills: 644 listed ≈ 32.3k tokens — 21.1k from UNUSED
- MCP: 13 servers enabled, 1 unused in window ≈ 26.2k tokens of tool schemas (probed)
- rules: 0 tokens
- agents: 12 defined, 3 never spawned — no idle cost, paid per spawn
- total idle ≈ 58.4k tokens/session; acting on the plan below saves ≈ 21.1k tokens/session

## Savings plan (top N)
| saves/session | uses | sessions | last used | verdict | name |
|---|---|---|---|---|---|
| 117 | 0 | 0 | never | UNUSED | some-never-used-skill |
...
```

### How usage is mined

Session transcripts (`~/.omp/agent/sessions/**/*.jsonl`, or `<agentDir>/sessions` for profile users) are scanned for tool-call events inside the lookback window:

- `read` calls on `skill://<name>` → skill usage
- `read` calls on `rule://<name>` → rule usage
- tool calls named `mcp__<server>_<tool>` → MCP server usage
- `read`/`write` calls on `xd://mcp__<server>_<tool>` device-dispatch paths → MCP server usage (the only pattern after omp's device-route migration; without it every server looks frozen at the migration date)
- `mcp://<server>/...` resource reads → MCP server usage
- `task` calls carrying `tasks[].agent` → agent usage

Server attribution resolves the longest matching prefix against the configured server-name list (dashes normalized to underscores — server names themselves may contain underscores), so `mcp__arxiv_mcp_server_get_abstract` attributes to `arxiv-mcp-server`, not `arxiv`. Unattributable names land in an "unattributed" section instead of a wrong server.

Timestamps come from the entry's own `timestamp` field with the session file's mtime as fallback. Subagent and advisor transcripts under the sessions root count as usage too — anything that consumed the filler counts.

### How cost is estimated

Chars/4 (documented estimate, not a tokenizer):

- skills: the exact rendered system-prompt line `- name: description`
- rules: full body when `alwaysApply`, else the one-line summary
- MCP servers: sum of `JSON({name, description, inputSchema})` per tool — measured by connecting (`probe: true`), HTTP handshake included (`Mcp-Session-Id` honored); stdio servers are spawned
- agents: definition size, but **per spawn** — agents cost nothing idle, so they are reported for pruning guidance only

MCP configs are read from the same four paths omp's builtin provider reads (project `.omp/mcp.json` + `.omp/.mcp.json`, user `<agentDir>/mcp.json` + `<agentDir>/.mcp.json`, plus root `.mcp.json` defensively) and plugin `.mcp.json` files. The agent dir honors `PI_CODING_AGENT_DIR` and `OMP_PROFILE`/`PI_PROFILE`.

### Verdicts

| Verdict | Rule |
|---|---|
| `UNUSED` | zero use in any scanned session in the window |
| `RARE` | used in < 1% of scanned sessions |
| `ACTIVE` | everything else |
| `DISABLED` | already hidden (skill) or denylisted (MCP) |

Only `UNUSED` items enter the actionable savings plan; `RARE` items are listed for human review — occasionally-used ≠ waste.

### Reading the savings number honestly

The savings figure is the **steady-state** per-session win. Any bulk hide/disable rewrites the system prompt, so the first session afterwards re-pays full input once (prompt-cache fracture). Skills-block reorderings have the same effect even without disabling anything.

## Parameters

| Param | Default | Meaning |
|---|---|---|
| `days` | 30 | transcript lookback window |
| `top` | 25 | max rows per table |
| `probe` | false | connect to enabled MCP servers to measure schema cost (adds ~30–60s; spawns stdio servers) |
| `scope` | `all` | `project` restricts the scan to the current project's sessions (exact slug dir + nested subdirs; sibling projects with prefixing slugs are excluded) |
| `actions` | — | array of actions to apply (report-only when omitted) |

## Actions

```json
[
  { "action": "hide_skill", "name": "some-skill" },
  { "action": "disable_mcp", "name": "scopus" }
]
```

| Action | Effect | Reversible by |
|---|---|---|
| `hide_skill` | sets `hide: true` in the SKILL.md frontmatter — the skill drops out of the system-prompt listing but stays reachable via `skill://<name>` and `/skill:<name>` | `unhide_skill` |
| `disable_mcp` | adds the server to `disabledServers` in the user mcp.json (highest-precedence denylist) | `enable_mcp` |

Every mutation backs up the original under `~/.omp/agent/cache/context-audit-backups/<runId>/`. Runs carrying `actions` are write-approval-tier — omp's approval gate prompts before config edits land; report-only runs are read-tier. Changes take effect on the **next** session (the system prompt is built at session start).

## Secret safety

The audit reads credential-bearing mcp.json files but never emits their contents: every string in the report and in action results passes through a redaction barrier (Authorization/bearer values, key-laden URL query params, URL userinfo, provider-style API keys). Test fixtures use placeholder credentials only.

## Notes

- Rules and agents have no `hide` mechanism; the report lists their usage so you can delete the files yourself.
- omp's built-in rules ship with the binary and are not user-removable, so they are not inventoried.
- MCP schema-token figures only appear with `probe: true`; unprobed runs show usage without per-server cost.

## Development

```sh
bun install
bun test    # contract tests: miner (incl. xd:// route, sibling-slug scoping), inventory, apply round-trips, redaction, report
```
