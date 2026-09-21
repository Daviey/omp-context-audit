/**
 * Action executor: applies audit verdicts to config.
 *
 * - `hide_skill` / `unhide_skill`: set/remove `hide: true` in the SKILL.md
 *   frontmatter (equivalent to `disable-model-invocation`). The skill stays
 *   reachable via `skill://<name>` and `/skill:<name>`; it just stops being
 *   listed in the system prompt.
 * - `disable_mcp` / `enable_mcp`: add/remove the server in the user-level
 *   `mcp.json` `disabledServers` denylist (highest-precedence switch omp reads).
 *
 * Every mutation backs up the original under
 * `<agentDir>/cache/context-audit-backups/<runId>/...` before writing.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { AuditPaths } from "./paths";
import { parseFrontmatter } from "./inventory";
import type { AuditAction, SkillEntry } from "./types";

export interface ActionResult {
	action: AuditAction;
	ok: boolean;
	detail: string;
	backup?: string;
}

const HIDE_KEYS = ["hide", "disable-model-invocation"];

function backupPath(paths: AuditPaths, runId: string, originalPath: string): string {
	const root = path.join(paths.agentDir, "cache", "context-audit-backups", runId);
	const rel = originalPath.replace(/^(\/|\/home\/[^/]+\/)/, "").replace(/[/\\]/g, "__");
	return path.join(root, rel);
}

function withBackup(paths: AuditPaths, runId: string, originalPath: string, next: string): string | undefined {
	let backup: string | undefined;
	try {
		const original = readFileSync(originalPath, "utf8");
		backup = backupPath(paths, runId, originalPath);
		mkdirSync(path.dirname(backup), { recursive: true });
		writeFileSync(backup, original);
		writeFileSync(originalPath, next);
	} catch {
		return undefined;
	}
	return backup;
}

/** Patch `hide`/`disable-model-invocation` in frontmatter; add FM when absent. */
export function setSkillHidden(text: string, hidden: boolean): string {
	const fmMatch = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n)?/);
	if (!fmMatch) {
		return hidden ? `---\nhide: true\n---\n${text}` : text;
	}
	let body = fmMatch[2];
	const eol = fmMatch[3].startsWith("\r\n") ? "\r\n" : "\n";
	let changed = false;
	const lines = body.split(/\r?\n/);
	const kept: string[] = [];
	for (const line of lines) {
		const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
		if (key && HIDE_KEYS.includes(key)) {
			changed = true;
			if (hidden) kept.push(`hide: true`);
			// unhiding: drop the line entirely
		} else {
			kept.push(line);
		}
	}
	if (hidden && !changed) kept.push("hide: true");
	body = kept.join(eol);
	const tail = fmMatch[4] ?? "\n";
	return `${fmMatch[1]}${body}${fmMatch[3]}${tail}${text.slice(fmMatch[0].length)}`;
}

function hideSkill(paths: AuditPaths, runId: string, skills: SkillEntry[], name: string, hidden: boolean): ActionResult {
	const action: AuditAction = { action: hidden ? "hide_skill" : "unhide_skill", name };
	const skill = skills.find(entry => entry.name === name);
	if (!skill) return { action, ok: false, detail: `skill not found in inventory: ${name}` };
	const current = parseFrontmatter(readFileSync(skill.path, "utf8"));
	const already = hidden
		? current?.hide === true || current?.disableModelInvocation === true
		: current?.hide !== true && current?.disableModelInvocation !== true;
	if (already) return { action, ok: true, detail: `already ${hidden ? "hidden" : "listed"}: ${name}` };
	const next = setSkillHidden(readFileSync(skill.path, "utf8"), hidden);
	const backup = withBackup(paths, runId, skill.path, next);
	if (backup === undefined) return { action, ok: false, detail: `failed to write ${skill.path}` };
	return {
		action,
		ok: true,
		detail: `${hidden ? "hid" : "unhid"} ${name} (${skill.path})`,
		backup,
	};
}

interface McpFile {
	path: string;
	doc: Record<string, unknown>;
}

function readUserMcp(paths: AuditPaths, runId: string): McpFile | { error: string } {
	const file = path.join(paths.agentDir, "mcp.json");
	try {
		const text = readFileSync(file, "utf8");
		return { path: file, doc: JSON.parse(text) as Record<string, unknown> };
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return { path: file, doc: {} };
		}
		return { error: `unreadable mcp.json: ${err instanceof Error ? err.message : String(err)}` };
	}
}

function writeUserMcp(paths: AuditPaths, runId: string, mcp: McpFile): string | undefined {
	const text = `${JSON.stringify(mcp.doc, null, "\t")}\n`;
	return withBackup(paths, runId, mcp.path, text);
}

function toggleMcp(paths: AuditPaths, runId: string, name: string, disable: boolean): ActionResult {
	const action: AuditAction = { action: disable ? "disable_mcp" : "enable_mcp", name };
	const mcp = readUserMcp(paths, runId);
	if ("error" in mcp) return { action, ok: false, detail: mcp.error };
	const list = Array.isArray(mcp.doc.disabledServers) ? [...(mcp.doc.disabledServers as string[])] : [];
	const present = list.includes(name);
	if (disable && present) return { action, ok: true, detail: `already disabled: ${name}` };
	if (!disable && !present) return { action, ok: true, detail: `not in user denylist: ${name} (check project/plugin mcp.json)` };
	if (disable) list.push(name);
	mcp.doc.disabledServers = list.filter(entry => (disable ? true : entry !== name));
	const backup = writeUserMcp(paths, runId, mcp as McpFile);
	if (backup === undefined) return { action, ok: false, detail: `failed to write ${mcp.path}` };
	return { action, ok: true, detail: `${disable ? "disabled" : "enabled"} ${name} (${mcp.path})`, backup };
}

export function applyActions(
	paths: AuditPaths,
	skills: SkillEntry[],
	actions: AuditAction[],
	runId = new Date().toISOString().replace(/[:.]/g, "-"),
): ActionResult[] {
	return actions.map(action => {
		switch (action.action) {
			case "hide_skill":
				return hideSkill(paths, runId, skills, action.name, true);
			case "unhide_skill":
				return hideSkill(paths, runId, skills, action.name, false);
			case "disable_mcp":
				return toggleMcp(paths, runId, action.name, true);
			case "enable_mcp":
				return toggleMcp(paths, runId, action.name, false);
		}
	});
}
