/**
 * Secret redaction for anything the audit emits into a transcript.
 *
 * mcp.json configs carry bearer tokens, key-laden URLs, and basic-auth URLs;
 * probe failures embed those URLs in fetch error strings. Every string that
 * reaches a report/action line passes through `redact()` first. Fixtures must
 * use placeholder credentials only.
 */

const REDACTIONS: Array<[RegExp, string]> = [
	// Authorization headers (incl. leaked into error text). Bare "token" is
	// deliberately excluded — report prose ("token estimates...") must not mangle.
	[/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
	// Secrets in URL query strings
	[/([?&](?:key|apikey|api_key|token|access_token|sig|signature|secret|password)=)[^&\s"']+/gi, "$1<redacted>"],
	// URL userinfo (https://user:pass@host)
	[/(:\/\/)[^/\s:@"']+:[^/\s@"']+@/g, "$1<redacted>@"],
	// Provider-style API keys appearing bare in text
	[/\b(sk|rk)-[A-Za-z0-9-]{16,}\b/g, "<redacted>"],
];

export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of REDACTIONS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}
