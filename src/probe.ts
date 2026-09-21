/**
 * Opt-in MCP schema probe: connects to configured servers, lists their tools,
 * and sizes the JSON the provider sees per session (name + description +
 * inputSchema). HTTP/streamable servers are probed with fetch; stdio servers
 * are spawned and spoken JSON-RPC over stdin/stdout. Best-effort: failures are
 * reported inline, never fatal to the audit.
 */
import { redact } from "./redact";
import type { McpServerEntry } from "./types";

interface RawServerConfig {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

export interface ProbeResult {
	tools: number;
	schemaTokens: number;
	ok: boolean;
	error?: string;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "omp-context-audit", version: "0.1.0" };
const PROBE_TIMEOUT_MS = 15_000;

function sizeTools(tools: Array<Record<string, unknown>>): { tools: number; schemaTokens: number } {
	let chars = 0;
	for (const tool of tools) {
		chars += JSON.stringify({
			name: (tool.name as string) ?? "",
			description: (tool.description as string) ?? "",
			parameters: tool.inputSchema ?? {},
		}).length;
	}
	return { tools: tools.length, schemaTokens: Math.ceil(chars / 4) };
}

function extractResult(message: unknown): { tools?: unknown } | undefined {
	if (message && typeof message === "object" && "result" in message) {
		return (message as { result?: { tools?: unknown } }).result as { tools?: unknown };
	}
	return undefined;
}

/** Parse one JSON value out of a chunk that may be SSE-framed or bare JSON. */
function parseRpcMessage(payload: string): unknown | undefined {
	const trimmed = payload.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return undefined;
		}
	}
	// SSE: take the first data: line that parses as an object.
	for (const line of trimmed.split("\n")) {
		if (line.startsWith("data:")) {
			const data = line.slice(5).trim();
			if (!data.startsWith("{")) continue;
			try {
				return JSON.parse(data);
			} catch {
				// try next data line
			}
		}
	}
	return undefined;
}

export async function probeHttp(url: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const post = async (body: unknown, extraHeaders: Record<string, string> = {}) => {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...headers,
					...extraHeaders,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			return {
				text: await response.text(),
				sessionId: response.headers.get("mcp-session-id") ?? undefined,
			};
		};
		const init = await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		});
		const initMessage = parseRpcMessage(init.text);
		if (!initMessage) throw new Error(redact(`initialize returned unparseable response (${init.text.slice(0, 120)})`));
		// Streamable-http servers issue Mcp-Session-Id; echo it on later calls.
		const sessionHeaders: Record<string, string> = init.sessionId ? { "mcp-session-id": init.sessionId } : {};
		await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders).catch(() => undefined);
		const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionHeaders);
		const result = extractResult(parseRpcMessage(list.text));
		const tools = Array.isArray(result?.tools) ? (result!.tools as Array<Record<string, unknown>>) : [];
		return { ok: true, ...sizeTools(tools) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: 0, schemaTokens: 0, ok: false, error: redact(message) };
	} finally {
		clearTimeout(timer);
	}
}

export async function probeStdio(
	command: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<ProbeResult> {
	const child = Bun.spawn([command, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, ...env },
	});
	const decoder = new TextDecoder();
	let buffer = "";
	const pending = new Map<number, (value: unknown) => void>();
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();

	const drain = async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const message = parseRpcMessage(line);
					const id = (message as { id?: number } | undefined)?.id;
					if (typeof id === "number" && pending.has(id)) {
						pending.get(id)!(message);
						pending.delete(id);
					}
					newline = buffer.indexOf("\n");
				}
			}
		} catch {
			// stream closed — pending requests time out
		}
	};
	const draining = drain();

	const request = (id: number, method: string, params: unknown, notify = false) =>
		new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), PROBE_TIMEOUT_MS);
			if (!notify) {
				pending.set(id, value => {
					clearTimeout(timer);
					resolve(value);
				});
			}
			const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
			if (!notify) payload.id = id;
			if (params !== undefined) payload.params = params;
			void Promise.resolve(child.stdin.write(`${JSON.stringify(payload)}\n`)).catch(() => {
				clearTimeout(timer);
				reject(new Error("stdin closed"));
			});
			if (notify) {
				clearTimeout(timer);
				resolve(undefined);
			}
		});

	try {
		await request(1, "initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		await request(2, "notifications/initialized", undefined, true);
		const response = (await request(3, "tools/list", {})) as { result?: { tools?: unknown } } | undefined;
		const tools = Array.isArray(response?.result?.tools)
			? (response!.result!.tools as Array<Record<string, unknown>>)
			: [];
		return { ok: true, ...sizeTools(tools) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { tools: 0, schemaTokens: 0, ok: false, error: redact(message) };
	} finally {
		child.kill();
		reader.cancel().catch(() => undefined);
		void draining.catch(() => undefined);
	}
}

/** Probe one server entry using its raw config from the source mcp.json. */
export async function probeServer(entry: McpServerEntry, raw: RawServerConfig): Promise<ProbeResult> {
	if (raw.type === "http" || raw.type === "sse") {
		if (!raw.url) return { tools: 0, schemaTokens: 0, ok: false, error: "missing url" };
		return probeHttp(raw.url, raw.headers);
	}
	if (!raw.command) return { tools: 0, schemaTokens: 0, ok: false, error: "missing command" };
	return probeStdio(raw.command, raw.args ?? [], raw.env);
}
