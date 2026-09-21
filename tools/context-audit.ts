/**
 * context_audit custom tool.
 *
 * Audits which context fillers (skills, MCP servers, rules, agents) actually
 * get used across recent session transcripts, what each costs per session in
 * prompt tokens, and applies disable actions on request:
 * - `hide_skill`: sets `hide: true` in SKILL.md frontmatter — skill stays
 *   reachable via `skill://` and `/skill:<name>`, but stops being listed.
 * - `disable_mcp` / `enable_mcp`: toggles the user mcp.json `disabledServers`
 *   denylist.
 *
 * Approval: report-only runs are read-tier; runs carrying `actions` are
 * write-tier so omp's approval gate prompts before config edits land.
 */
import { runAudit } from "../src/audit";
import { applyActions, type ActionResult } from "../src/apply";
import { resolveAuditPaths } from "../src/paths";
import { renderReport } from "../src/report";
import { redact } from "../src/redact";
import type { AuditAction, AuditOptions } from "../src/types";
import type { CustomToolAPI, CustomToolFactory } from "../src/omp-types";

const factory: CustomToolFactory = (pi: CustomToolAPI) => {
	const t = pi.arktype;
	const parameters = t({
		"days?": t("number").describe("lookback window in days (default 30)"),
		"top?": t("number").describe("max rows per report table (default 25)"),
		"probe?": t("boolean").describe("connect to enabled MCP servers to measure tool-schema token cost (slower)"),
		"scope?": t("'all'|'project'").describe("scan all session transcripts or only the current project's (default all)"),
		"actions?": t({
			action: t("'hide_skill'|'unhide_skill'|'disable_mcp'|'enable_mcp'"),
			name: t("string"),
		})
			.array()
			.describe("disable/enable actions to apply (report-only when omitted)"),
	});

	return {
		name: "context_audit",
		label: "Context Audit",
		description:
			"Audit context-filler usage vs cost: scans session transcripts for actual use of skills (skill:// reads), MCP servers (mcp__ tool calls), rules, and task agents; estimates the prompt tokens each fills per session (skills listing, rule content, MCP tool schemas when probed); ranks unused/rare high-cost items; and applies disable actions (hide_skill keeps skill:// working, disable_mcp edits the mcp.json denylist). Use when the user wants to cut context/token burn, prune skills or MCP servers, or see what a filler actually costs.",
		parameters,
		strict: true,
		approval: ((args: { actions?: unknown }) =>
			Array.isArray(args?.actions) && args.actions.length > 0
				? { tier: "write", reason: "edits SKILL.md frontmatter and the user mcp.json denylist" }
				: { tier: "read" }) as unknown,
		async execute(toolCallId, params, onUpdate, ctx) {
			const options: AuditOptions = {
				days: typeof params.days === "number" ? params.days : 30,
				top: typeof params.top === "number" ? params.top : 25,
				probe: params.probe === true,
				scope: params.scope === "project" ? "project" : "all",
			};
			const paths = resolveAuditPaths(pi.cwd);
			const result = await runAudit(paths, options);

			const actionLines: string[] = [];
			if (params.actions && params.actions.length > 0) {
				const results: ActionResult[] = applyActions(paths, result.skills, params.actions as AuditAction[]);
				actionLines.push("", "## Actions applied");
				for (const r of results) {
					actionLines.push(
						`- ${r.ok ? "OK" : "FAIL"} ${r.action.action} ${r.action.name}: ${r.detail}${r.backup ? ` (backup: ${r.backup})` : ""}`,
					);
				}
				actionLines.push("", "_Effective next session (the system prompt is built at session start)._");
			}

			const report = redact(renderReport(result, options) + actionLines.join("\n"));
			return { content: [{ type: "text" as const, text: report }] };
		},
	};
};

export default factory;
