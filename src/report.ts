/**
 * Verdicts + markdown report.
 *
 * Verdict thresholds (documented in README):
 * - UNUSED: never used in any scanned session inside the window
 * - RARE:   used in < 5% of scanned sessions
 * - ACTIVE: everything else
 * - DISABLED: already hidden (skills) or denylisted (MCP)
 *
 * Candidates for the savings plan: listed skills rated UNUSED/RARE (action:
 * `hide_skill`), enabled MCP servers rated UNUSED (action: `disable_mcp`).
 * Rules and agents are reported with usage but their removal is manual.
 */
import { estTokens, type AuditOptions, type AuditResult, type Verdict } from "./types";

export function verdictFor(
	usage: { calls: number; sessions: number },
	sessionsScanned: number,
	disabled: boolean,
): Verdict {
	if (disabled) return "DISABLED";
	if (usage.sessions === 0) return "UNUSED";
	const ratio = sessionsScanned > 0 ? usage.sessions / sessionsScanned : 1;
	if (ratio < 0.01) return "RARE";
	return "ACTIVE";
}

function fmtDate(iso?: string): string {
	return iso ? iso.slice(0, 10) : "never";
}

function fmtTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

interface Row {
	kind: "skill" | "mcp" | "rule" | "agent";
	name: string;
	tokens: number;
	usage: { calls: number; sessions: number; lastUsed?: string };
	verdict: Verdict;
	action?: string;
}

export interface ReportData {
	headline: {
		listedSkills: number;
		skillTokens: number;
		hideCandidateTokens: number;
		mcpEnabled: number;
		mcpUnused: number;
		mcpProbeTokens?: number;
		ruleTokens: number;
		agentsDefined: number;
		agentsUnused: number;
	};
	plan: Row[];
	skills: Row[];
	mcp: Row[];
	rules: Row[];
	agents: Row[];
	planActions: Array<{ action: "hide_skill" | "disable_mcp"; name: string }>;
}

export function buildReportData(result: AuditResult, options: AuditOptions): ReportData {
	const listed = result.skills.filter(skill => skill.listed);
	const skillTokens = listed.reduce((sum, skill) => sum + estTokens(skill.lineChars), 0);
	const hideCandidates = listed.filter(
		skill => verdictFor(skill.usage, result.sessionsScanned, false) === "UNUSED",
	);
	const hideCandidateTokens = hideCandidates.reduce((sum, skill) => sum + estTokens(skill.lineChars), 0);

	const mcpEnabled = result.mcp.filter(server => server.enabled);
	const mcpUnused = mcpEnabled.filter(
		server => verdictFor(server.usage, result.sessionsScanned, false) === "UNUSED",
	);
	const mcpProbeTokens = mcpEnabled.some(server => server.probe?.ok)
		? mcpEnabled.reduce((sum, server) => sum + (server.probe?.ok ? server.probe.schemaTokens : 0), 0)
		: undefined;

	const ruleTokens = result.rules.reduce((sum, rule) => sum + estTokens(rule.injectedChars), 0);
	const agentsUnused = result.agents.filter(
		agent => verdictFor(agent.usage, result.sessionsScanned, false) === "UNUSED",
	);

	const skillRow = (skill: AuditResult["skills"][number]): Row => ({
		kind: "skill",
		name: skill.name,
		tokens: estTokens(skill.lineChars),
		usage: skill.usage,
		verdict: verdictFor(skill.usage, result.sessionsScanned, !skill.listed),
		action: "hide_skill",
	});
	const mcpRow = (server: AuditResult["mcp"][number]): Row => ({
		kind: "mcp",
		name: server.name,
		tokens: server.probe?.ok ? server.probe.schemaTokens : 0,
		usage: server.usage,
		verdict: verdictFor(server.usage, result.sessionsScanned, !server.enabled),
		action: "disable_mcp",
	});
	const ruleRow = (rule: AuditResult["rules"][number]): Row => ({
		kind: "rule",
		name: rule.name,
		tokens: estTokens(rule.injectedChars),
		usage: rule.usage,
		verdict: verdictFor(rule.usage, result.sessionsScanned, false),
	});
	const agentRow = (agent: AuditResult["agents"][number]): Row => ({
		kind: "agent",
		name: agent.name,
		tokens: estTokens(agent.contentChars),
		usage: agent.usage,
		verdict: verdictFor(agent.usage, result.sessionsScanned, false),
	});

	// Only zero-use skills make the actionable plan; RARE ones are surfaced in
	// the skills table for human review instead (used occasionally ≠ waste).
	const skillCandidates = listed
		.map(skillRow)
		.filter(row => row.verdict === "UNUSED")
		.sort((a, b) => b.tokens - a.tokens);
	const mcpCandidates = mcpEnabled
		.map(mcpRow)
		.filter(row => row.verdict === "UNUSED")
		.sort((a, b) => b.tokens - a.tokens);

	const plan = [...skillCandidates, ...mcpCandidates]
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, options.top);
	const planActions = plan.map(row => ({ action: row.action as "hide_skill" | "disable_mcp", name: row.name }));

	const byWorst = (rows: Row[]) =>
		[...rows].sort(
			(a, b) => (b.verdict === "UNUSED" ? 1 : 0) - (a.verdict === "UNUSED" ? 1 : 0) || b.tokens - a.tokens,
		);

	return {
		headline: {
			listedSkills: listed.length,
			skillTokens,
			hideCandidateTokens,
			mcpEnabled: mcpEnabled.length,
			mcpUnused: mcpUnused.length,
			mcpProbeTokens,
			ruleTokens,
			agentsDefined: result.agents.length,
			agentsUnused: agentsUnused.length,
		},
		plan,
		skills: byWorst(listed.map(skillRow)).slice(0, options.top),
		mcp: byWorst(result.mcp.map(mcpRow)),
		rules: byWorst(result.rules.map(ruleRow)).slice(0, options.top),
		agents: byWorst(result.agents.map(agentRow)).slice(0, options.top),
		planActions,
	};
}

function table(rows: Row[], tokenHeader: string): string {
	if (rows.length === 0) return "_none_\n";
	const header = `| ${tokenHeader} | uses | sessions | last used | verdict | name |`;
	const sep = `|---|---|---|---|---|---|`;
	const body = rows
		.map(
			row =>
				`| ${fmtTokens(row.tokens)} | ${row.usage.calls} | ${row.usage.sessions} | ${fmtDate(row.usage.lastUsed)} | ${row.verdict} | ${row.name} |`,
		)
		.join("\n");
	return `${header}\n${sep}\n${body}\n`;
}

export function renderReport(result: AuditResult, options: AuditOptions): string {
	const data = buildReportData(result, options);
	const h = data.headline;
	const lines: string[] = [];

	lines.push(`# Context audit — ${result.generatedAt.slice(0, 10)}`);
	lines.push(
		`Window: ${options.days}d · ${result.sessionsScanned} sessions scanned (${result.sessionsTotal} on disk)` +
			(result.oldest ? ` · coverage ${result.oldest.slice(0, 10)}→${result.newest?.slice(0, 10)}` : ""),
	);
	lines.push("");
	lines.push("## Idle context cost per session (estimate)");
	lines.push(
		`- skills: ${h.listedSkills} listed ≈ ${fmtTokens(h.skillTokens)} tokens — ${fmtTokens(h.hideCandidateTokens)} from UNUSED`,
	);
	lines.push(
		`- MCP: ${h.mcpEnabled} servers enabled, ${h.mcpUnused} unused in window` +
			(h.mcpProbeTokens !== undefined
				? ` ≈ ${fmtTokens(h.mcpProbeTokens)} tokens of tool schemas (probed)`
				: " (schema cost unmeasured — re-run with probe:true)"),
	);
	lines.push(`- rules: ${fmtTokens(h.ruleTokens)} tokens`);
	lines.push(`- agents: ${h.agentsDefined} defined, ${h.agentsUnused} never spawned — no idle cost, paid per spawn`);
	const totalIdle = h.skillTokens + h.ruleTokens + (h.mcpProbeTokens ?? 0);
	lines.push(
		`- total idle ≈ ${fmtTokens(totalIdle)} tokens/session; acting on the plan below saves ≈ ${fmtTokens(h.hideCandidateTokens)} tokens/session`,
	);
	lines.push("");
	lines.push(`## Savings plan (top ${data.plan.length})`);
	lines.push(table(data.plan, "saves/session"));
	if (data.planActions.length > 0) {
		lines.push("Ready-to-apply (call again with `actions`):");
		lines.push("```json");
		lines.push(JSON.stringify(data.planActions.slice(0, 15)));
		lines.push("```");
	}
	lines.push("");
	lines.push(
		`## Skills (top ${data.skills.length} of ${h.listedSkills} listed; ${result.skills.length - h.listedSkills} hidden/unlisted)`,
	);
	lines.push(table(data.skills, "tok/session"));
	lines.push("");
	lines.push("## MCP servers (all)");
	lines.push(table(data.mcp, "schema tok"));
	lines.push("");
	lines.push(`## Rules (top ${data.rules.length} of ${result.rules.length})`);
	lines.push(table(data.rules, "tok/session"));
	lines.push("");
	lines.push(`## Agents (top ${data.agents.length} of ${h.agentsDefined}; cost is per spawn)`);
	lines.push(table(data.agents, "tok/spawn"));

	const unknown = [...result.unknownMcpTools.entries()].sort((a, b) => b[1] - a[1]);
	if (unknown.length > 0) {
		lines.push("");
		lines.push(`## Unattributed mcp__ tools (${unknown.length}; servers missing from configs)`);
		lines.push(unknown.slice(0, 10).map(([name, count]) => `- ${name} (${count})`).join("\n"));
	}
	if (result.parseErrors > 0) {
		lines.push("");
		lines.push(`_skipped ${result.parseErrors} unparseable transcript line(s)_`);
	}
	lines.push("");
	lines.push(
		"_Token figures are chars/4 estimates. Changes take effect on the next session (system prompt is built at session start). `hide_skill` keeps `skill://<name>` and `/skill:<name>` working; `disable_mcp` adds the server to `disabledServers` in the user mcp.json._",
	);

	return lines.join("\n");
}
