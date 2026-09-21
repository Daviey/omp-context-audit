/**
 * Audit orchestrator: inventory + transcript mining + optional MCP probe,
 * merged into one AuditResult.
 */
import { collectAgents, collectMcpConfigs, collectMcpEntries, collectRules, collectSkills } from "./inventory";
import type { AuditPaths } from "./paths";
import { probeServer } from "./probe";
import type { AuditOptions, AuditResult } from "./types";
import { scanSessions, sessionSlugForCwd, toUsageStat } from "./usage";

export async function runAudit(paths: AuditPaths, options: AuditOptions): Promise<AuditResult> {
	const skills = collectSkills(paths);
	const rules = collectRules(paths);
	const agents = collectAgents(paths);
	const mcp = collectMcpEntries(paths);
	const { servers } = collectMcpConfigs(paths);

	const scan = await scanSessions(paths.sessionsRoot, paths.home, paths.cwd, [...servers.keys()], {
		days: options.days,
		projectSlug: options.scope === "project" ? sessionSlugForCwd(paths.home, paths.cwd) : undefined,
	});

	for (const skill of skills) skill.usage = toUsageStat(scan.acc.skills.get(skill.name));
	for (const rule of rules) rule.usage = toUsageStat(scan.acc.rules.get(rule.name));
	for (const agent of agents) agent.usage = toUsageStat(scan.acc.agents.get(agent.name));
	for (const server of mcp) server.usage = toUsageStat(scan.acc.mcp.get(server.name));

	if (options.probe) {
		const enabled = mcp.filter(server => server.enabled);
		const BATCH = 4;
		for (let i = 0; i < enabled.length; i += BATCH) {
			await Promise.all(
				enabled.slice(i, i + BATCH).map(async server => {
					const raw = servers.get(server.name)?.raw ?? {};
					server.probe = await probeServer(server, raw as Parameters<typeof probeServer>[1]);
				}),
			);
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		windowDays: options.days,
		sessionsScanned: scan.sessionsScanned,
		sessionsTotal: scan.sessionsTotal,
		oldest: scan.oldest,
		newest: scan.newest,
		skills,
		mcp,
		rules,
		agents,
		unknownMcpTools: scan.acc.unknownMcpTools,
		parseErrors: scan.parseErrors,
	};
}
