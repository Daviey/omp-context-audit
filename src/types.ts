/** Shared types for the context audit. */

export interface UsageStat {
	/** Total tool-call events attributed to this filler inside the window. */
	calls: number;
	/** Distinct session files that used it inside the window. */
	sessions: number;
	/** ISO timestamp of the most recent use, undefined if never. */
	lastUsed?: string;
}

export const EMPTY_USAGE: UsageStat = { calls: 0, sessions: 0 };

export interface SkillEntry {
	name: string;
	/** Absolute path of SKILL.md. */
	path: string;
	/** Root directory the skill was found under. */
	root: string;
	level: "user" | "project" | "plugin";
	description: string;
	/** `hide`/`disable-model-invocation` frontmatter set: listed = still costs context. */
	listed: boolean;
	/** Chars of the rendered system-prompt line `- name: description` (+ newline); 0 when unlisted. */
	lineChars: number;
	usage: UsageStat;
}

export interface McpServerEntry {
	name: string;
	/** Config file the server was read from. */
	source: string;
	type: string;
	/** False when listed in a `disabledServers` denylist. */
	enabled: boolean;
	/** Where the disable came from, when disabled. */
	disabledBy?: string;
	/** Present when probed. */
	probe?: { tools: number; schemaTokens: number; ok: boolean; error?: string };
	usage: UsageStat;
}

export interface RuleEntry {
	name: string;
	path: string;
	level: "user" | "project" | "plugin";
	alwaysApply: boolean;
	/** Chars injected per session: full content when alwaysApply, else the one-line summary. */
	injectedChars: number;
	usage: UsageStat;
}

export interface AgentEntry {
	name: string;
	path: string;
	level: "user" | "project" | "plugin";
	/** Chars of the agent definition — paid per spawn, not per session. */
	contentChars: number;
	usage: UsageStat;
}

export type Verdict = "ACTIVE" | "RARE" | "STALE" | "UNUSED" | "DISABLED";

export interface AuditAction {
	action: "hide_skill" | "unhide_skill" | "disable_mcp" | "enable_mcp";
	name: string;
}

export interface AuditOptions {
	/** Lookback window in days. */
	days: number;
	/** Max rows per report table. */
	top: number;
	/** Connect to enabled MCP servers to measure their tool-schema cost. */
	probe: boolean;
	/** Restrict transcript scan to the current project's session directory. */
	scope: "all" | "project";
}

export interface AuditResult {
	generatedAt: string;
	windowDays: number;
	sessionsScanned: number;
	sessionsTotal: number;
	oldest?: string;
	newest?: string;
	skills: SkillEntry[];
	mcp: McpServerEntry[];
	rules: RuleEntry[];
	agents: AgentEntry[];
	/** MCP servers seen in transcripts but absent from every config file. */
	unknownMcpTools: Map<string, number>;
	parseErrors: number;
}

export const TOKENS_PER_CHAR = 1 / 4;

/** Rough token estimate; descriptive metadata renders mostly ASCII. */
export function estTokens(chars: number): number {
	return Math.ceil(chars * TOKENS_PER_CHAR);
}
