---
description: Audit context filler usage (skills, MCP servers, rules, agents) vs per-session token cost
---
Run a context audit with the `context_audit` tool.

Arguments: "$ARGUMENTS" — parse them as: `days=<number>` (default 30), `probe` (also measure MCP tool-schema cost by connecting to servers), `project` (restrict the transcript scan to this project).

After the report returns:
1. Show the headline (idle tokens per session, savings available) and the top 10 savings-plan rows verbatim.
2. Call out anything surprising (very expensive single skills, MCP servers never used).
3. Ask which actions to apply. Only after explicit user confirmation, call `context_audit` again with the chosen `actions` array (hide_skill / disable_mcp entries from the plan). Do not apply actions unilaterally.
