/**
 * Transcript usage miner.
 *
 * Scans session JSONL files under the sessions root for tool-call events and
 * attributes them to context fillers:
 * - `read` calls with `skill://<name>` paths → skill usage
 * - `read` calls with `rule://<name>` paths → rule usage
 * - tool names `mcp__<server>_<tool>` (server dashes normalized to underscores)
 *   and `read` of `mcp://<server>/...` URIs → MCP server usage
 * - `task` calls carrying `tasks[].agent` / top-level `agent` → agent usage
 *
 * Attribution needs the configured server-name set to split `mcp__` prefixes
 * (server names may contain underscores themselves), so the longest matching
 * configured prefix wins; unattributable names land in `unknownMcpTools`.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import type { UsageStat } from "./types";

interface MutableUsage {
	calls: number;
	sessions: Set<string>;
	lastUsed?: string;
}

export interface UsageAccumulators {
	skills: Map<string, MutableUsage>;
	rules: Map<string, MutableUsage>;
	mcp: Map<string, MutableUsage>;
	agents: Map<string, MutableUsage>;
	unknownMcpTools: Map<string, number>;
}

export function newAccumulators(): UsageAccumulators {
	return {
		skills: new Map(),
		rules: new Map(),
		mcp: new Map(),
		agents: new Map(),
		unknownMcpTools: new Map(),
	};
}

/** Snapshot a mutable usage record into the report-facing shape. */
export function toUsageStat(record: MutableUsage | undefined): UsageStat {
	if (!record) return { calls: 0, sessions: 0 };
	return { calls: record.calls, sessions: record.sessions.size, lastUsed: record.lastUsed };
}

function bump(map: Map<string, MutableUsage>, key: string, sessionFile: string, timestamp?: string): void {
	let record = map.get(key);
	if (!record) {
		record = { calls: 0, sessions: new Set() };
		map.set(key, record);
	}
	record.calls++;
	record.sessions.add(sessionFile);
	if (timestamp && (!record.lastUsed || timestamp > record.lastUsed)) record.lastUsed = timestamp;
}

/** Strip selector/subpath/query from an internal-URI first segment. */
export function skillNameFromUri(uri: string): string {
	const rest = uri.replace(/^skill:\/\//, "");
	let end = rest.length;
	for (const sep of ["/", ":", "?"]) {
		const idx = rest.indexOf(sep);
		if (idx >= 0 && idx < end) end = idx;
	}
	return rest.slice(0, end);
}

/** Server-name candidates sorted for longest-prefix matching. */
export function serverPrefixTable(serverNames: string[]): Array<{ prefix: string; server: string }> {
	return serverNames
		.map(name => ({ prefix: `mcp__${name.replace(/-/g, "_")}_`, server: name }))
		.sort((a, b) => b.prefix.length - a.prefix.length);
}

export function attributeMcpTool(
	toolName: string,
	prefixes: Array<{ prefix: string; server: string }>,
): string | undefined {
	for (const { prefix, server } of prefixes) {
		if (toolName.startsWith(prefix)) return server;
	}
	return undefined;
}

function* contentToolCalls(parsed: {
	message?: { role?: string; content?: unknown };
}): Generator<{ name: string; args: Record<string, unknown> }> {
	if (parsed.message?.role !== "assistant") return;
	const content = parsed.message.content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type !== "toolCall" || typeof record.name !== "string") continue;
		const args =
			record.arguments && typeof record.arguments === "object"
				? (record.arguments as Record<string, unknown>)
				: {};
		yield { name: record.name, args };
	}
}

function attributeEvent(
	event: { tool: string; args: Record<string, unknown>; sessionFile: string; timestamp?: string },
	acc: UsageAccumulators,
	prefixes: Array<{ prefix: string; server: string }>,
): void {
	const { tool, args, sessionFile, timestamp } = event;
	if (tool.startsWith("mcp__")) {
		const server = attributeMcpTool(tool, prefixes);
		if (server) bump(acc.mcp, server, sessionFile, timestamp);
		else acc.unknownMcpTools.set(tool, (acc.unknownMcpTools.get(tool) ?? 0) + 1);
		return;
	}
	if (tool === "read" || tool === "write") {
		const raw = typeof args.path === "string" ? args.path : "";
		// Device-dispatch route: write/read JSON args to xd://mcp__<server>_<tool>.
		const xd = raw.match(/^xd:\/\/mcp__([A-Za-z0-9_]+)$/);
		if (xd) {
			const server = attributeMcpTool(`mcp__${xd[1]}`, prefixes);
			if (server) bump(acc.mcp, server, sessionFile, timestamp);
			else acc.unknownMcpTools.set(`mcp__${xd[1]}`, (acc.unknownMcpTools.get(`mcp__${xd[1]}`) ?? 0) + 1);
			return;
		}
		if (tool === "write") return;
		if (raw.startsWith("skill://")) {
			bump(acc.skills, skillNameFromUri(raw), sessionFile, timestamp);
		} else if (raw.startsWith("rule://")) {
			const name = raw.replace(/^rule:\/\//, "").split(/[/?:]/)[0];
			if (name) bump(acc.rules, name, sessionFile, timestamp);
		} else if (raw.startsWith("mcp://")) {
			const server = raw.replace(/^mcp:\/\//, "").split(/[/?:#]/)[0];
			if (server) bump(acc.mcp, server, sessionFile, timestamp);
		}
		return;
	}
	if (tool === "task") {
		const tasks = Array.isArray(args.tasks) ? args.tasks : [];
		for (const task of tasks) {
			const agent =
				task && typeof task === "object" && typeof (task as { agent?: unknown }).agent === "string"
					? (task as { agent: string }).agent
					: undefined;
			if (agent) bump(acc.agents, agent, sessionFile, timestamp);
		}
		if (typeof args.agent === "string") bump(acc.agents, args.agent, sessionFile, timestamp);
	}
}

async function scanFile(
	filePath: string,
	fallbackTimestamp: string | undefined,
	acc: UsageAccumulators,
	prefixes: Array<{ prefix: string; server: string }>,
	parseErrors: { count: number },
): Promise<void> {
	const text = await Bun.file(filePath).text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
		let parsed: { message?: { role?: string; content?: unknown }; timestamp?: string };
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parseErrors.count++;
			continue;
		}
		if (!trimmed.includes('"toolCall"')) continue;
		for (const call of contentToolCalls(parsed)) {
			attributeEvent(
				{ tool: call.name, args: call.args, sessionFile: filePath, timestamp: parsed.timestamp ?? fallbackTimestamp },
				acc,
				prefixes,
			);
		}
	}
}

export interface ScanResult {
	sessionsScanned: number;
	sessionsTotal: number;
	oldest?: string;
	newest?: string;
	parseErrors: number;
	acc: UsageAccumulators;
}

export interface ScanOptions {
	/** Only files with mtime >= now - days. */
	days: number;
	/** Restrict to one project slug directory under the sessions root. */
	projectSlug?: string;
}

/** Home-relative session dir slug omp uses (`~/dev/dvdi` → `-dev-dvdi`). */
export function sessionSlugForCwd(home: string, cwd: string): string {
	const rel = path.relative(home, path.resolve(cwd));
	return rel === "" ? "-" : `-${rel.split(path.sep).join("-")}`;
}

export async function scanSessions(
	sessionsRoot: string,
	home: string,
	cwd: string,
	serverNames: string[],
	options: ScanOptions,
): Promise<ScanResult> {
	const acc = newAccumulators();
	const prefixes = serverPrefixTable(serverNames);
	const parseErrors = { count: 0 };
	const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;

	const allFiles = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionsRoot, onlyFiles: true })].map(
		rel => path.join(sessionsRoot, rel),
	);
	// Exact-directory match with a path-separator boundary: a plain startsWith
	// would swallow sibling projects (`-dev` matching `-dev-dvdi`).
	const scoped = options.projectSlug
		? allFiles.filter(file => {
				const dir = path.dirname(file);
				const root = path.join(sessionsRoot, options.projectSlug!);
				return dir === root || dir.startsWith(root + path.sep);
			})
		: allFiles;

	const mtimeByFile = new Map<string, string>();
	const inWindow = scoped.filter(file => {
		try {
			const mtimeMs = statSync(file).mtimeMs;
			if (mtimeMs < cutoff) return false;
			mtimeByFile.set(file, new Date(mtimeMs).toISOString());
			return true;
		} catch {
			return false;
		}
	});

	let oldest: string | undefined;
	let newest: string | undefined;
	for (const file of inWindow) {
		const iso = new Date(statSync(file).mtimeMs).toISOString();
		if (!oldest || iso < oldest) oldest = iso;
		if (!newest || iso > newest) newest = iso;
	}

	// Small batches keep memory flat on multi-MB transcripts.
	const BATCH = 24;
	for (let i = 0; i < inWindow.length; i += BATCH) {
		await Promise.all(
			inWindow
				.slice(i, i + BATCH)
				.map(file => scanFile(file, mtimeByFile.get(file), acc, prefixes, parseErrors)),
		);
	}

	return {
		sessionsScanned: inWindow.length,
		sessionsTotal: scoped.length,
		oldest,
		newest,
		parseErrors: parseErrors.count,
		acc,
	};
}
