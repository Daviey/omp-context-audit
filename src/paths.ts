/**
 * Root resolution for the audit.
 *
 * Mirrors omp's own directory layout without importing omp internals (plugin
 * modules may not resolve them): agent dir from `PI_CODING_AGENT_DIR`
 * (set in-process when a profile is active), sessions under `<agentDir>/sessions`,
 * plugin packages under the omp plugins root, enabled-set from the plugins
 * lockfile. Every root is overridable so tests run against fixtures.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface AuditPaths {
	home: string;
	agentDir: string;
	/** `<agentDir>/sessions` */
	sessionsRoot: string;
	/** Nearest `.omp` dir to cwd (may not exist). */
	projectDir: string;
	/** Walk-up `.omp` dirs from cwd (nearest first). */
	repoDirs: string[];
	/** Enabled plugin package dirs. */
	pluginDirs: string[];
	/** Current working directory of the calling session. */
	cwd: string;
}

export interface PathOverrides {
	agentDir?: string;
	sessionsRoot?: string;
	projectDir?: string;
	pluginDirs?: string[];
	pluginLockfile?: string;
}

export function resolveAuditPaths(cwd: string, overrides: PathOverrides = {}): AuditPaths {
	const home = process.env.HOME ?? `/home/${process.env.USER ?? "nobody"}`;
	const agentDir =
		overrides.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent");
	const sessionsRoot = overrides.sessionsRoot ?? path.join(agentDir, "sessions");

	// Walk up from cwd to / collecting `.omp` dirs (nearest first). Existence is
	// checked by the inventory step, not here, so tests can point at fixtures.
	const repoDirs: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		repoDirs.push(path.join(current, ".omp"));
		if (current === path.dirname(current)) break;
		current = path.dirname(current);
	}

	return {
		home,
		agentDir,
		sessionsRoot,
		projectDir: overrides.projectDir ?? repoDirs[0],
		repoDirs,
		pluginDirs: overrides.pluginDirs ?? enabledPluginDirs(home, overrides.pluginLockfile),
		cwd: path.resolve(cwd),
	};
}

/**
 * Enabled plugin package dirs from the omp plugins lockfile
 * (`<pluginsRoot>/omp-plugins.lock.json`), falling back to scanning
 * `node_modules` for packages. Disabled plugins (`enabled: false`) are skipped.
 */
function enabledPluginDirs(home: string, lockfileOverride?: string): string[] {
	const pluginsRoot = pluginRootFor(home);
	const lockPath = lockfileOverride ?? path.join(pluginsRoot, "omp-plugins.lock.json");
	const nodeModules = path.join(pluginsRoot, "node_modules");
	try {
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
			plugins?: Record<string, { enabled?: boolean; path?: string }>;
		};
		const dirs: string[] = [];
		for (const [name, meta] of Object.entries(lock.plugins ?? {})) {
			if (meta.enabled === false) continue;
			dirs.push(meta.path ?? path.join(nodeModules, name));
		}
		return dirs;
	} catch {
		// No lockfile — fall through to a best-effort scan.
	}
	try {
		return readdirSync(nodeModules)
			.filter(entry => !entry.startsWith("."))
			.map(entry => path.join(nodeModules, entry));
	} catch {
		return [];
	}
}

/** Plugin root honors a sibling-of-agent-dir layout for profile-scoped installs. */
function pluginRootFor(home: string): string {
	if (process.env.PI_CODING_AGENT_DIR) {
		const sibling = path.join(path.dirname(process.env.PI_CODING_AGENT_DIR), "plugins");
		if (existsSync(sibling)) return sibling;
	}
	return path.join(home, ".omp", "plugins");
}
