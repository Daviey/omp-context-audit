/**
 * Inventory of context fillers and their per-session cost.
 *
 * Enumerates the same roots omp's discovery providers scan (skills, rules,
 * agents, MCP configs) and computes the rendered size of what each injects
 * into the system prompt every session:
 * - skills: one `- name: description` line each (skipped when frontmatter sets
 *   `hide`/`disable-model-invocation` or description is missing)
 * - rules: full content when `alwaysApply`, else one summary line
 * - agents: nothing idle — content is paid per spawn, reported separately
 * - MCP servers: tool schemas (sized only by the opt-in probe)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { AuditPaths } from "./paths";
import { EMPTY_USAGE, type AgentEntry, type McpServerEntry, type RuleEntry, type SkillEntry } from "./types";

export interface Frontmatter {
	name?: string;
	description?: string;
	hide?: boolean;
	disableModelInvocation?: boolean;
	alwaysApply?: boolean;
	globs?: string[];
}

/** Minimal frontmatter reader: scalars, quoted strings, and block scalars. */
export function parseFrontmatter(text: string): Frontmatter | undefined {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return undefined;
	const fm: Record<string, unknown> = {};
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv) continue;
		const [, key, raw] = kv;
		let value: unknown = raw.trim();
		const folded = raw.trim();
		if (folded === "" || folded === ">" || folded === ">-" || folded === "|" || folded === "|-") {
			// Block scalar: consume following indented lines.
			const block: string[] = [];
			for (let j = i + 1; j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === ""); j++) {
				block.push(lines[j].replace(/^\t/, "    ").replace(/^ {1,4}/, ""));
			}
			value = block.join(" ").trim();
			i += block.length;
		} else if (/^".*"$/.test(folded)) {
			value = folded.slice(1, -1);
		} else if (/^'.*'$/.test(folded)) {
			value = folded.slice(1, -1);
		} else if (folded.startsWith("[") && folded.endsWith("]")) {
			value = folded
				.slice(1, -1)
				.split(",")
				.map(s => s.trim().replace(/^["']|["']$/g, ""))
				.filter(s => s.length > 0);
		} else if (folded === "true" || folded === "false") {
			value = folded === "true";
		}
		fm[key] = value;
	}
	return fm as Frontmatter;
}

export function skillIsListed(fm: Frontmatter | undefined, description: string): boolean {
	if (!fm) return false;
	if (fm.hide === true || fm.disableModelInvocation === true) return false;
	// Discovery sets requireDescription for the prompt-listed providers.
	return description.length > 0;
}

function readText(p: string): string | null {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

interface SkillRoot {
	dir: string;
	level: SkillEntry["level"];
}

/** Skill roots in omp precedence order (first occurrence of a name wins). */
export function skillRoots(paths: AuditPaths): SkillRoot[] {
	const roots: SkillRoot[] = [
		{ dir: path.join(paths.projectDir, "skills"), level: "project" },
		{ dir: path.join(paths.agentDir, "skills"), level: "user" },
		{ dir: path.join(paths.home, ".claude", "skills"), level: "user" },
	];
	// `.agent`/`.agents` walk-up + home.
	for (const repoDir of paths.repoDirs) {
		roots.push({ dir: path.join(path.dirname(repoDir), ".agent", "skills"), level: "project" });
		roots.push({ dir: path.join(path.dirname(repoDir), ".agents", "skills"), level: "project" });
	}
	roots.push({ dir: path.join(paths.home, ".agent", "skills"), level: "user" });
	roots.push({ dir: path.join(paths.home, ".agents", "skills"), level: "user" });
	for (const plugin of paths.pluginDirs) roots.push({ dir: path.join(plugin, "skills"), level: "plugin" });
	roots.push({ dir: path.join(paths.agentDir, "managed-skills"), level: "user" });
	return roots.filter(root => existsSync(root.dir));
}

export function collectSkills(paths: AuditPaths): SkillEntry[] {
	const seen = new Set<string>();
	const out: SkillEntry[] = [];
	for (const root of skillRoots(paths)) {
		let dirents;
		try {
			dirents = readdirSync(root.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			const name = dirent.name;
			if (name.startsWith(".") || seen.has(name)) continue;
			const skillPath = dirent.isDirectory()
				? path.join(root.dir, name, "SKILL.md")
				: name.endsWith(".md")
					? path.join(root.dir, name)
					: null;
			if (!skillPath) continue;
			const text = readText(skillPath);
			if (text === null) continue;
			const fm = parseFrontmatter(text);
			const skillName = fm?.name ?? (dirent.isDirectory() ? name : name.replace(/\.md$/, ""));
			if (seen.has(skillName)) continue;
			const description = typeof fm?.description === "string" ? fm.description : "";
			const listed = skillIsListed(fm, description);
			const line = listed ? `- ${skillName}: ${description}\n` : "";
			seen.add(skillName);
			out.push({
				name: skillName,
				path: skillPath,
				root: root.dir,
				level: root.level,
				description,
				listed,
				lineChars: line.length,
				usage: { ...EMPTY_USAGE },
			});
		}
	}
	return out;
}

export function collectRules(paths: AuditPaths): RuleEntry[] {
	const dirs: Array<{ dir: string; level: RuleEntry["level"] }> = [
		{ dir: path.join(paths.projectDir, "rules"), level: "project" },
		{ dir: path.join(paths.agentDir, "rules"), level: "user" },
	];
	for (const repoDir of paths.repoDirs) {
		dirs.push({ dir: path.join(path.dirname(repoDir), ".agent", "rules"), level: "project" });
		dirs.push({ dir: path.join(path.dirname(repoDir), ".agents", "rules"), level: "project" });
	}
	dirs.push({ dir: path.join(paths.home, ".agent", "rules"), level: "user" });
	dirs.push({ dir: path.join(paths.home, ".agents", "rules"), level: "user" });
	for (const plugin of paths.pluginDirs) dirs.push({ dir: path.join(plugin, "rules"), level: "plugin" });

	const seen = new Set<string>();
	const out: RuleEntry[] = [];
	for (const { dir, level } of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!/\.(md|mdc)$/.test(file)) continue;
			const rulePath = path.join(dir, file);
			const name = file.replace(/\.(md|mdc)$/, "");
			if (seen.has(name)) continue;
			const text = readText(rulePath);
			if (text === null) continue;
			const fm = parseFrontmatter(text);
			seen.add(name);
			const alwaysApply = fm?.alwaysApply === true;
			const description = typeof fm?.description === "string" ? fm.description : "";
			const globs = Array.isArray(fm?.globs) ? fm.globs.join(", ") : "";
			const summary = `- ${fm?.name ?? name} (${globs}): ${description}\n`;
			const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
			out.push({
				name,
				path: rulePath,
				level,
				alwaysApply,
				injectedChars: alwaysApply ? body.length : summary.length,
				usage: { ...EMPTY_USAGE },
			});
		}
	}
	return out;
}

export function collectAgents(paths: AuditPaths): AgentEntry[] {
	const dirs: Array<{ dir: string; level: AgentEntry["level"] }> = [
		{ dir: path.join(paths.projectDir, "agents"), level: "project" },
		{ dir: path.join(paths.agentDir, "agents"), level: "user" },
	];
	for (const plugin of paths.pluginDirs) dirs.push({ dir: path.join(plugin, "agents"), level: "plugin" });

	const seen = new Set<string>();
	const out: AgentEntry[] = [];
	for (const { dir, level } of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!/\.md$/.test(file)) continue;
			const agentPath = path.join(dir, file);
			const name = file.replace(/\.md$/, "");
			if (seen.has(name)) continue;
			const text = readText(agentPath);
			if (text === null) continue;
			seen.add(name);
			out.push({ name, path: agentPath, level, contentChars: text.length, usage: { ...EMPTY_USAGE } });
		}
	}
	return out;
}

export interface McpConfig {
	servers: Map<string, { type: string; source: string; raw: Record<string, unknown> }>;
	disabled: Map<string, string>;
}

/** MCP server names from every config source, plus denylist entries. */
export function collectMcpConfigs(paths: AuditPaths): McpConfig {
	// The exact paths omp's builtin MCP provider reads: project `.omp/mcp.json`
	// + `.omp/.mcp.json`, user `<agentDir>/mcp.json` + `<agentDir>/.mcp.json`;
	// root `.mcp.json` kept defensively for claude-compat providers.
	const files = [
		path.join(paths.projectDir, "mcp.json"),
		path.join(paths.projectDir, ".mcp.json"),
		path.join(paths.agentDir, "mcp.json"),
		path.join(paths.agentDir, ".mcp.json"),
		path.join(paths.cwd, ".mcp.json"),
	];
	for (const plugin of paths.pluginDirs) {
		files.push(path.join(plugin, ".mcp.json"), path.join(plugin, "mcp.json"));
	}

	const servers = new Map<string, { type: string; source: string; raw: Record<string, unknown> }>();
	const disabled = new Map<string, string>();
	for (const file of files) {
		const text = readText(file);
		if (text === null) continue;
		let parsed: {
			mcpServers?: Record<string, Record<string, unknown>>;
			disabledServers?: string[];
		};
		try {
			parsed = JSON.parse(text);
		} catch {
			continue;
		}
		for (const [name, cfg] of Object.entries(parsed.mcpServers ?? {})) {
			if (!servers.has(name)) {
				servers.set(name, {
					type: typeof cfg.type === "string" ? cfg.type : "stdio",
					source: file,
					raw: cfg,
				});
			}
		}
		for (const name of parsed.disabledServers ?? []) disabled.set(name, file);
	}
	return { servers, disabled };
}

export function collectMcpEntries(paths: AuditPaths): McpServerEntry[] {
	const { servers, disabled } = collectMcpConfigs(paths);
	return [...servers.entries()].map(([name, meta]) => ({
		name,
		source: meta.source,
		type: meta.type,
		enabled: !disabled.has(name),
		disabledBy: disabled.get(name),
		usage: { ...EMPTY_USAGE },
	}));
}
