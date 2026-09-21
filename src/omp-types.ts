/**
 * Structural types for the omp custom-tool contract.
 *
 * The plugin declares the subset of the CustomTool factory surface it uses so
 * the package type-checks standalone; omp injects the real `pi` API
 * (cwd + arktype module) and validates the returned tool shape at load time
 * (`name`, `description`, `parameters`, `execute`).
 */

export interface ArkTypeExpr {
	describe(description: string): unknown;
	array(): ArkTypeExpr;
}

/** arktype module: callable on string literals and object definitions. */
export interface ArkTypeModule {
	(literal: string): ArkTypeExpr;
	(def: Record<string, unknown>): ArkTypeExpr;
}

/** Injected factory API (subset used by this plugin). */
export interface CustomToolAPI {
	cwd: string;
	arktype: ArkTypeModule;
	exec(command: string, args: string[], options?: unknown): Promise<unknown>;
	hasUI: boolean;
	logger: {
		error(msg: string, meta?: unknown): void;
		warn(msg: string, meta?: unknown): void;
		debug(msg: string, meta?: unknown): void;
	};
}

export interface ToolCallParams {
	days?: number;
	top?: number;
	probe?: boolean;
	scope?: "all" | "project";
	actions?: Array<{ action: string; name: string }>;
}

export interface CustomToolContext {
	autoApprove?: boolean;
}

export type CustomToolFactory = (pi: CustomToolAPI) => {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	strict?: boolean;
	approval?: unknown;
	execute(
		toolCallId: string,
		params: ToolCallParams,
		onUpdate: unknown,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }> }>;
};
