import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyActions, setSkillHidden as setSkillHiddenFixture } from "../src/apply";
import { collectMcpConfigs, collectSkills, parseFrontmatter } from "../src/inventory";
import { resolveAuditPaths } from "../src/paths";
import { renderReport, verdictFor } from "../src/report";
import { redact } from "../src/redact";
import { attributeMcpTool, scanSessions, serverPrefixTable, skillNameFromUri, toUsageStat } from "../src/usage";

let tmp: string;

beforeAll(() => {

	tmp = mkdtempSync(path.join(os.tmpdir(), "ctx-audit-"));
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("secret redaction", () => {
	test("strips bearer tokens, key-laden URLs, userinfo, and provider keys", () => {
		const leaked = [
			"fetch failed for https://api.example.test/mcp?token=abc123SECRETxyz",
			"openai key sk-PROVIDERKEYabcd1234 dead",
			"https://user:hunter2@example.test/feed",
			"Authorization: Bearer 0000000000000000000000000000abcd.0AbCdEfGhIjKlMnO",
			"expired key 7c9f01d4e2a63b8f5c9014de77a2b6e0",
		].join(" | ");
		const out = redact(leaked);
		expect(out).not.toContain("abc123SECRETxyz");
		expect(out).not.toContain("0000000000000000000000000000abcd");
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("sk-PROVIDERKEYabcd");
		expect(out).toContain("<redacted>"); // from sk- rule
		expect(out).toContain("token=<redacted>");
		expect(out).toContain("Bearer <redacted>");
		// bare <32hex> prose is deliberately untouched (backup paths carry hashes)
		expect(out).toContain("expired key 7c9f01d4e2a63b8f5c9014de77a2b6e0");
	});
});

describe("skill name extraction", () => {
	test("strips selectors, subpaths, and queries", () => {
		expect(skillNameFromUri("skill://deploy-app")).toBe("deploy-app");
		expect(skillNameFromUri("skill://deploy-app:50-100")).toBe("deploy-app");
		expect(skillNameFromUri("skill://deploy-app/SKILL.md")).toBe("deploy-app");
		expect(skillNameFromUri("skill://deploy-app?q=why")).toBe("deploy-app");
	});
});

describe("mcp attribution", () => {
	test("longest configured prefix wins with dash normalization", () => {
		const table = serverPrefixTable(["web-search-prime", "mamcp", "arxiv_mcp_server"]);
		expect(attributeMcpTool("mcp__web_search_prime_web_search_prime", table)).toBe("web-search-prime");
		expect(attributeMcpTool("mcp__mamcp_myanonamouse_search", table)).toBe("mamcp");
		expect(attributeMcpTool("mcp__arxiv_mcp_server_check_alerts", table)).toBe("arxiv_mcp_server");
		expect(attributeMcpTool("mcp__ghost_tool", table)).toBeUndefined();
	});
});

describe("transcript mining", () => {
	test("attributes skills, mcp, rules, agents; ignores user-role blocks", async () => {
		const sessionsRoot = path.join(tmp, "sessions", "-proj");
		mkdirSync(sessionsRoot, { recursive: true });
		const mkEntry = (role: string, calls: Array<[string, Record<string, unknown>]>, timestamp: string) =>
			JSON.stringify({
				type: "message",
				timestamp,
				message: { role, content: calls.map(([name, args]) => ({ type: "toolCall", name, arguments: args })) },
			});
		writeFileSync(
			path.join(sessionsRoot, "a.jsonl"),
			[
				mkEntry(
					"assistant",
					[
						["read", { path: "skill://deploy-app" }],
						["read", { path: "skill://deploy-app:5-9" }],
						["mcp__mamcp_myanonamouse_search", {}],
						["write", { path: "xd://mcp__mamcp_qbittorrent_download", content: "{}" }],
						["write", { path: "xd://mcp__ghost2_tool", content: "{}" }],
						["write", { path: "/tmp/plain.txt", content: "x" }],
					],
					"2026-09-20T10:00:00.000Z",
				),
				mkEntry("user", [["read", { path: "skill://never-counted" }]], "2026-09-20T10:01:00.000Z"),
				"{ this is not json",
				mkEntry(
					"assistant",
					[
						["read", { path: "rule://formatting" }],
						["mcp__ghost_tool", {}],
					],
					"2026-09-21T11:00:00.000Z",
				),
			].join("\n") + "\n",
		);
		writeFileSync(
			path.join(sessionsRoot, "b.jsonl"),
			mkEntry(
				"assistant",
				[
					["read", { path: "skill://deploy-app/sub" }],
					["task", { tasks: [{ task: "map it", agent: "scout" }] }],
				],
				"2026-09-19T09:00:00.000Z",
			) + "\n",
		);

		const result = await scanSessions(path.join(tmp, "sessions"), tmp, path.join(tmp, "proj"), ["mamcp"], { days: 30 });
		const skill = toUsageStat(result.acc.skills.get("deploy-app"));
		expect(skill.calls).toBe(3);
		expect(skill.sessions).toBe(2);
		expect(skill.lastUsed).toBe("2026-09-20T10:00:00.000Z");
		expect(result.acc.skills.has("never-counted")).toBe(false);
		expect(toUsageStat(result.acc.mcp.get("mamcp")).calls).toBe(2);
		expect(toUsageStat(result.acc.mcp.get("mamcp")).sessions).toBe(1);
		expect(toUsageStat(result.acc.rules.get("formatting")).calls).toBe(1);
		expect(toUsageStat(result.acc.agents.get("scout")).calls).toBe(1);
		expect(result.acc.unknownMcpTools.get("mcp__ghost_tool")).toBe(1);
		expect(result.acc.unknownMcpTools.get("mcp__ghost2_tool")).toBe(1);
		expect(result.parseErrors).toBe(1);
		expect(result.sessionsScanned).toBe(2);
	});

	test("project scope excludes sibling projects with a prefixing slug", async () => {
		const root = path.join(tmp, "sibling-sessions");
		mkdirSync(path.join(root, "-dev"), { recursive: true });
		mkdirSync(path.join(root, "-dev-dvdi"), { recursive: true });
		mkdirSync(path.join(root, "-dev", "nested"), { recursive: true });
		const line = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "skill://x" } }] },
		});
		writeFileSync(path.join(root, "-dev", "s.jsonl"), line + "\n");
		writeFileSync(path.join(root, "-dev", "nested", "s.jsonl"), line + "\n");
		writeFileSync(path.join(root, "-dev-dvdi", "s.jsonl"), line + "\n");
		const result = await scanSessions(root, tmp, "/home/me/dev", [], { days: 30, projectSlug: "-dev" });
		// Own dir + nested subdir count; the `-dev-dvdi` sibling must not leak in.
		expect(result.sessionsTotal).toBe(2);
		expect(toUsageStat(result.acc.skills.get("x")).sessions).toBe(2);
	});

	test("project scope only scans the project slug dir", async () => {
		const root = path.join(tmp, "scoped-sessions");
		mkdirSync(path.join(root, "-proj-a"), { recursive: true });
		mkdirSync(path.join(root, "-proj-b"), { recursive: true });
		const line = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "skill://x" } }] },
		});
		writeFileSync(path.join(root, "-proj-a", "s.jsonl"), line + "\n");
		writeFileSync(path.join(root, "-proj-b", "s.jsonl"), line + "\n");
		const result = await scanSessions(root, tmp, "/proj/a", [], { days: 30, projectSlug: "-proj-a" });
		expect(result.sessionsTotal).toBe(1);
		expect(toUsageStat(result.acc.skills.get("x")).sessions).toBe(1);
	});
});

describe("inventory cost", () => {
	test("listed, hidden, and description-less skills cost differently", () => {
		const skillsDir = path.join(tmp, "agent", "skills");
		mkdirSync(path.join(skillsDir, "plain"), { recursive: true });
		writeFileSync(path.join(skillsDir, "plain", "SKILL.md"), "---\nname: plain\ndescription: does plain things\n---\nbody");
		mkdirSync(path.join(skillsDir, "shy"), { recursive: true });
		writeFileSync(path.join(skillsDir, "shy", "SKILL.md"), "---\nname: shy\ndescription: hidden one\nhide: true\n---\nbody");
		mkdirSync(path.join(skillsDir, "mute"), { recursive: true });
		writeFileSync(path.join(skillsDir, "mute", "SKILL.md"), "---\nname: mute\n---\nbody");

		const paths = resolveAuditPaths(tmp, {
			agentDir: path.join(tmp, "agent"),
			pluginDirs: [],
			sessionsRoot: path.join(tmp, "sessions"),
		});
		const skills = collectSkills(paths);
		const byName = new Map(skills.map(s => [s.name, s]));
		expect(byName.get("plain")!.listed).toBe(true);
		expect(byName.get("plain")!.lineChars).toBe("- plain: does plain things\n".length);
		expect(byName.get("shy")!.listed).toBe(false);
		expect(byName.get("shy")!.lineChars).toBe(0);
		expect(byName.get("mute")!.listed).toBe(false);
	});
});

describe("frontmatter hide toggling", () => {
	test("adds, replaces, and removes hide", () => {
		expect(setSkillHiddenFixture("body only", true)).toBe("---\nhide: true\n---\nbody only");
		expect(setSkillHiddenFixture("---\nname: x\ndescription: y\n---\nbody", true)).toBe(
			"---\nname: x\ndescription: y\nhide: true\n---\nbody",
		);
		expect(setSkillHiddenFixture("---\nname: x\nhide: false\n---\nbody", true)).toBe("---\nname: x\nhide: true\n---\nbody");
		const unhidden = setSkillHiddenFixture("---\nname: x\nhide: true\ndescription: y\n---\nbody", false);
		expect(unhidden).toBe("---\nname: x\ndescription: y\n---\nbody");
		expect(parseFrontmatter(unhidden)?.hide).toBeUndefined();
	});
});

describe("mcp denylist apply", () => {
	test("disable then enable round-trips the user mcp.json with backup", () => {
		const agentDir = path.join(tmp, "agent2");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { ghost: { type: "http", url: "https://x" } } }, null, "\t"),
		);

		const paths = resolveAuditPaths(tmp, {
			agentDir,
			pluginDirs: [],
			sessionsRoot: path.join(tmp, "sessions"),
		});
		const [disable] = applyActions(paths, [], [{ action: "disable_mcp", name: "ghost" }], "run-1");
		expect(disable.ok).toBe(true);
		expect(disable.backup).toBeDefined();
		const doc = JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8"));
		expect(doc.disabledServers).toEqual(["ghost"]);
		expect(collectMcpConfigs(paths).disabled.has("ghost")).toBe(true);

		const [again] = applyActions(paths, [], [{ action: "disable_mcp", name: "ghost" }], "run-2");
		expect(again.ok).toBe(true);
		expect(again.detail).toContain("already disabled");

		const [enable] = applyActions(paths, [], [{ action: "enable_mcp", name: "ghost" }], "run-3");
		expect(enable.ok).toBe(true);
		const doc2 = JSON.parse(readFileSync(path.join(agentDir, "mcp.json"), "utf8"));
		expect(doc2.disabledServers ?? []).toEqual([]);
	});
});

describe("skill hide apply", () => {
	test("hide_skill patches frontmatter and inventory stops listing it", () => {
		const agentDir = path.join(tmp, "agent3");
		const skillDir = path.join(agentDir, "skills", "deploy-app");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = path.join(skillDir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: deploy-app\ndescription: deploys apps\n---\nbody");

		const paths = resolveAuditPaths(tmp, { agentDir, pluginDirs: [], sessionsRoot: path.join(tmp, "sessions") });
		const [hide] = applyActions(paths, collectSkills(paths), [{ action: "hide_skill", name: "deploy-app" }], "run-h");
		expect(hide.ok).toBe(true);
		expect(parseFrontmatter(readFileSync(skillPath, "utf8"))?.hide).toBe(true);
		// The exact contract the report depends on: hidden skills carry zero listing cost.
		expect(collectSkills(paths).find(s => s.name === "deploy-app")?.listed).toBe(false);

		const [unhide] = applyActions(paths, collectSkills(paths), [{ action: "unhide_skill", name: "deploy-app" }], "run-u");
		expect(unhide.ok).toBe(true);
		expect(collectSkills(paths).find(s => s.name === "deploy-app")?.listed).toBe(true);
	});
});

describe("report", () => {
	test("verdicts follow usage ratio and savings plan ranks by cost", () => {
		expect(verdictFor({ calls: 0, sessions: 0 }, 10, false)).toBe("UNUSED");
		expect(verdictFor({ calls: 3, sessions: 1 }, 100, false)).toBe("ACTIVE"); // 1% threshold is inclusive
		expect(verdictFor({ calls: 3, sessions: 4 }, 500, false)).toBe("RARE"); // 0.8% of sessions
		expect(verdictFor({ calls: 50, sessions: 20 }, 100, false)).toBe("ACTIVE");
		expect(verdictFor({ calls: 50, sessions: 20 }, 100, true)).toBe("DISABLED");

		const result: AuditResult = {
			generatedAt: "2026-09-21T00:00:00.000Z",
			windowDays: 30,
			sessionsScanned: 100,
			sessionsTotal: 120,
			skills: [
				{ name: "big-unused", path: "/x", root: "/x", level: "user", description: "d", listed: true, lineChars: 400, usage: { calls: 0, sessions: 0 } },
				{ name: "small-unused", path: "/y", root: "/y", level: "user", description: "d", listed: true, lineChars: 40, usage: { calls: 0, sessions: 0 } },
				{ name: "busy", path: "/z", root: "/z", level: "user", description: "d", listed: true, lineChars: 400, usage: { calls: 30, sessions: 20, lastUsed: "2026-09-20T00:00:00.000Z" } },
				{ name: "already-hidden", path: "/h", root: "/h", level: "user", description: "d", listed: false, lineChars: 0, usage: { calls: 0, sessions: 0 } },
			],
			mcp: [{ name: "never", source: "/m", type: "http", enabled: true, usage: { calls: 0, sessions: 0 } }],
			rules: [],
			agents: [],
			unknownMcpTools: new Map(),
			parseErrors: 0,
		};
		const options: AuditOptions = { days: 30, top: 25, probe: false, scope: "all" };
		const text = renderReport(result, options);
		expect(text).toContain("≈ 110 tokens"); // 440 chars of skill lines → 110 tokens
		const bigIndex = text.indexOf("big-unused");
		const smallIndex = text.indexOf("small-unused");
		expect(bigIndex).toBeGreaterThan(-1);
		expect(bigIndex).toBeLessThan(smallIndex);
		expect(text).toContain("| UNUSED | never |");
		expect(text).not.toContain("already-hidden"); // unlisted skills never make the table
	});
});
