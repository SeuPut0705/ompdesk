/**
 * Live side of the compatibility self-check (capabilities.ts holds the table and
 * the pure derivation): imports the modules the table names, reads the live
 * session, and either reports (`probe`, behind the `capabilities` method) or
 * refuses a feature's bridge methods with `unsupported_omp` (`guard`).
 * Detection only: imports resolve to omp's already-loaded modules, nothing is
 * called.
 */
import * as fs from "node:fs";
import {
	ALL_FEATURES,
	deriveUnavailable,
	type FeatureId,
	parseHidden,
	REQUIREMENTS,
	type UnavailableFeature,
	UnsupportedOmpError,
} from "./capabilities";
import { ompPromptPath } from "./modes/shared";
import type { BridgeEnv, BridgeMethods } from "./types";

/** `OMP_GUI_BRIDGE_PROBE_HIDE`: labels to report missing, to rehearse a broken omp (capabilities.ts `parseHidden`). */
const HIDDEN = parseHidden(process.env.OMP_GUI_BRIDGE_PROBE_HIDE);

/**
 * Loaders for every module REQUIREMENTS names. Literal specifiers on purpose:
 * omp rewrites `@oh-my-pi/*` imports onto its bundled singletons only when the
 * specifier is a literal; `import(variable)` reaches a separate on-disk copy
 * (verified on omp 18.8.0). src/main/bridge-capabilities.test.ts keeps the keys
 * in sync with the table.
 */
const LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
	"@oh-my-pi/pi-agent-core": () => import("@oh-my-pi/pi-agent-core"),
	"@oh-my-pi/pi-ai": () => import("@oh-my-pi/pi-ai"),
	"@oh-my-pi/pi-ai/auth-storage": () => import("@oh-my-pi/pi-ai/auth-storage"),
	"@oh-my-pi/pi-ai/auth/blocks": () => import("@oh-my-pi/pi-ai/auth/blocks"),
	"@oh-my-pi/pi-ai/oauth": () => import("@oh-my-pi/pi-ai/oauth"),
	"@oh-my-pi/pi-ai/usage/registry": () => import("@oh-my-pi/pi-ai/usage/registry"),
	"@oh-my-pi/pi-catalog/types": () => import("@oh-my-pi/pi-catalog/types"),
	"@oh-my-pi/pi-coding-agent/autolearn/managed-skills": () =>
		import("@oh-my-pi/pi-coding-agent/autolearn/managed-skills"),
	"@oh-my-pi/pi-coding-agent/capability": () => import("@oh-my-pi/pi-coding-agent/capability"),
	"@oh-my-pi/pi-coding-agent/capability/fs": () => import("@oh-my-pi/pi-coding-agent/capability/fs"),
	"@oh-my-pi/pi-coding-agent/capability/hook": () => import("@oh-my-pi/pi-coding-agent/capability/hook"),
	"@oh-my-pi/pi-coding-agent/capability/ssh": () => import("@oh-my-pi/pi-coding-agent/capability/ssh"),
	"@oh-my-pi/pi-coding-agent/commands/settings": () => import("@oh-my-pi/pi-coding-agent/commands/settings"),
	"@oh-my-pi/pi-coding-agent/config": () => import("@oh-my-pi/pi-coding-agent/config"),
	"@oh-my-pi/pi-coding-agent/config/all-settings": () => import("@oh-my-pi/pi-coding-agent/config/all-settings"),
	"@oh-my-pi/pi-coding-agent/config/model-resolver": () => import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
	"@oh-my-pi/pi-coding-agent/config/model-roles": () => import("@oh-my-pi/pi-coding-agent/config/model-roles"),
	"@oh-my-pi/pi-coding-agent/config/prompt-templates": () =>
		import("@oh-my-pi/pi-coding-agent/config/prompt-templates"),
	"@oh-my-pi/pi-coding-agent/config/registry": () => import("@oh-my-pi/pi-coding-agent/config/registry"),
	"@oh-my-pi/pi-coding-agent/discovery": () => import("@oh-my-pi/pi-coding-agent/discovery"),
	"@oh-my-pi/pi-coding-agent/discovery/helpers": () => import("@oh-my-pi/pi-coding-agent/discovery/helpers"),
	"@oh-my-pi/pi-coding-agent/export/share": () => import("@oh-my-pi/pi-coding-agent/export/share"),
	"@oh-my-pi/pi-coding-agent/extensibility/plugins/loader": () =>
		import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader"),
	"@oh-my-pi/pi-coding-agent/extensibility/plugins/manager": () =>
		import("@oh-my-pi/pi-coding-agent/extensibility/plugins/manager"),
	"@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace": () =>
		import("@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace"),
	"@oh-my-pi/pi-coding-agent/extensibility/skills": () => import("@oh-my-pi/pi-coding-agent/extensibility/skills"),
	"@oh-my-pi/pi-coding-agent/goals/settings": () => import("@oh-my-pi/pi-coding-agent/goals/settings"),
	"@oh-my-pi/pi-coding-agent/internal-urls": () => import("@oh-my-pi/pi-coding-agent/internal-urls"),
	"@oh-my-pi/pi-coding-agent/internal-urls/local-protocol": () =>
		import("@oh-my-pi/pi-coding-agent/internal-urls/local-protocol"),
	"@oh-my-pi/pi-coding-agent/mcp/client": () => import("@oh-my-pi/pi-coding-agent/mcp/client"),
	"@oh-my-pi/pi-coding-agent/mcp/config": () => import("@oh-my-pi/pi-coding-agent/mcp/config"),
	"@oh-my-pi/pi-coding-agent/mcp/config-writer": () => import("@oh-my-pi/pi-coding-agent/mcp/config-writer"),
	"@oh-my-pi/pi-coding-agent/mcp/manager": () => import("@oh-my-pi/pi-coding-agent/mcp/manager"),
	"@oh-my-pi/pi-coding-agent/mcp/oauth-credentials": () => import("@oh-my-pi/pi-coding-agent/mcp/oauth-credentials"),
	"@oh-my-pi/pi-coding-agent/mcp/oauth-discovery": () => import("@oh-my-pi/pi-coding-agent/mcp/oauth-discovery"),
	"@oh-my-pi/pi-coding-agent/mcp/oauth-flow": () => import("@oh-my-pi/pi-coding-agent/mcp/oauth-flow"),
	"@oh-my-pi/pi-coding-agent/mcp/settings": () => import("@oh-my-pi/pi-coding-agent/mcp/settings"),
	"@oh-my-pi/pi-coding-agent/memory-backend/resolve": () => import("@oh-my-pi/pi-coding-agent/memory-backend/resolve"),
	"@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule": () =>
		import("@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule"),
	"@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller": () =>
		import("@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller"),
	"@oh-my-pi/pi-coding-agent/modes/loop-condition": () => import("@oh-my-pi/pi-coding-agent/modes/loop-condition"),
	"@oh-my-pi/pi-coding-agent/modes/loop-limit": () => import("@oh-my-pi/pi-coding-agent/modes/loop-limit"),
	"@oh-my-pi/pi-coding-agent/modes/model-browser-source": () =>
		import("@oh-my-pi/pi-coding-agent/modes/model-browser-source"),
	"@oh-my-pi/pi-coding-agent/modes/settings": () => import("@oh-my-pi/pi-coding-agent/modes/settings"),
	"@oh-my-pi/pi-coding-agent/plan-mode/approved-plan": () =>
		import("@oh-my-pi/pi-coding-agent/plan-mode/approved-plan"),
	"@oh-my-pi/pi-coding-agent/plan-mode/plan-files": () => import("@oh-my-pi/pi-coding-agent/plan-mode/plan-files"),
	"@oh-my-pi/pi-coding-agent/registry/agent-lifecycle": () =>
		import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle"),
	"@oh-my-pi/pi-coding-agent/registry/agent-registry": () =>
		import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
	"@oh-my-pi/pi-coding-agent/security/coordinator": () => import("@oh-my-pi/pi-coding-agent/security/coordinator"),
	"@oh-my-pi/pi-coding-agent/security/store": () => import("@oh-my-pi/pi-coding-agent/security/store"),
	"@oh-my-pi/pi-coding-agent/session/credential-pin": () => import("@oh-my-pi/pi-coding-agent/session/credential-pin"),
	"@oh-my-pi/pi-coding-agent/session/foreign-session-import": () =>
		import("@oh-my-pi/pi-coding-agent/session/foreign-session-import"),
	"@oh-my-pi/pi-coding-agent/session/model-compaction-threshold": () =>
		import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"),
	"@oh-my-pi/pi-coding-agent/session/session-loader": () => import("@oh-my-pi/pi-coding-agent/session/session-loader"),
	"@oh-my-pi/pi-coding-agent/session/session-manager": () =>
		import("@oh-my-pi/pi-coding-agent/session/session-manager"),
	"@oh-my-pi/pi-coding-agent/session/session-pins": () => import("@oh-my-pi/pi-coding-agent/session/session-pins"),
	"@oh-my-pi/pi-coding-agent/session/session-workspace": () =>
		import("@oh-my-pi/pi-coding-agent/session/session-workspace"),
	"@oh-my-pi/pi-coding-agent/session/session-worktree": () =>
		import("@oh-my-pi/pi-coding-agent/session/session-worktree"),
	"@oh-my-pi/pi-coding-agent/session/settings": () => import("@oh-my-pi/pi-coding-agent/session/settings"),
	"@oh-my-pi/pi-coding-agent/session/ttsr-outputs": () => import("@oh-my-pi/pi-coding-agent/session/ttsr-outputs"),
	"@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions": () =>
		import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions"),
	"@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry": () =>
		import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry"),
	"@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage": () =>
		import("@oh-my-pi/pi-coding-agent/slash-commands/helpers/reset-usage"),
	"@oh-my-pi/pi-coding-agent/ssh/config-writer": () => import("@oh-my-pi/pi-coding-agent/ssh/config-writer"),
	"@oh-my-pi/pi-coding-agent/ssh/connection-manager": () => import("@oh-my-pi/pi-coding-agent/ssh/connection-manager"),
	"@oh-my-pi/pi-coding-agent/stt/asr-client": () => import("@oh-my-pi/pi-coding-agent/stt/asr-client"),
	"@oh-my-pi/pi-coding-agent/stt/downloader": () => import("@oh-my-pi/pi-coding-agent/stt/downloader"),
	"@oh-my-pi/pi-coding-agent/stt/models": () => import("@oh-my-pi/pi-coding-agent/stt/models"),
	"@oh-my-pi/pi-coding-agent/task/discovery": () => import("@oh-my-pi/pi-coding-agent/task/discovery"),
	"@oh-my-pi/pi-coding-agent/task/prewalk": () => import("@oh-my-pi/pi-coding-agent/task/prewalk"),
	"@oh-my-pi/pi-coding-agent/task/settings": () => import("@oh-my-pi/pi-coding-agent/task/settings"),
	"@oh-my-pi/pi-coding-agent/tools/builtin-names": () => import("@oh-my-pi/pi-coding-agent/tools/builtin-names"),
	"@oh-my-pi/pi-coding-agent/tools/debug": () => import("@oh-my-pi/pi-coding-agent/tools/debug"),
	"@oh-my-pi/pi-coding-agent/tools/resolve": () => import("@oh-my-pi/pi-coding-agent/tools/resolve"),
	"@oh-my-pi/pi-coding-agent/tts/models": () => import("@oh-my-pi/pi-coding-agent/tts/models"),
	"@oh-my-pi/pi-coding-agent/tts/tts-client": () => import("@oh-my-pi/pi-coding-agent/tts/tts-client"),
	"@oh-my-pi/pi-coding-agent/tts/vocalizer": () => import("@oh-my-pi/pi-coding-agent/tts/vocalizer"),
	"@oh-my-pi/pi-coding-agent/tts/wav": () => import("@oh-my-pi/pi-coding-agent/tts/wav"),
	"@oh-my-pi/pi-coding-agent/utils/atomic-file": () => import("@oh-my-pi/pi-coding-agent/utils/atomic-file"),
	"@oh-my-pi/pi-coding-agent/utils/tool-choice": () => import("@oh-my-pi/pi-coding-agent/utils/tool-choice"),
	"@oh-my-pi/pi-coding-agent/vibe/runtime": () => import("@oh-my-pi/pi-coding-agent/vibe/runtime"),
	"@oh-my-pi/pi-natives/vcs": () => import("@oh-my-pi/pi-natives/vcs"),
	"@oh-my-pi/pi-tui/overlays/model-browser": () => import("@oh-my-pi/pi-tui/overlays/model-browser"),
	"@oh-my-pi/pi-tui/overlays/settings-defs": () => import("@oh-my-pi/pi-tui/overlays/settings-defs"),
	"@oh-my-pi/pi-tui/overlays/usage-display": () => import("@oh-my-pi/pi-tui/overlays/usage-display"),
	"@oh-my-pi/pi-tui/theme": () => import("@oh-my-pi/pi-tui/theme"),
	"@oh-my-pi/pi-tui/tools/resolve": () => import("@oh-my-pi/pi-tui/tools/resolve"),
	"@oh-my-pi/pi-utils": () => import("@oh-my-pi/pi-utils"),
};

/** Settled imports by specifier; `undefined` when this omp has no such module. */
const imports = new Map<string, Promise<unknown>>();

function importOnce(specifier: string): Promise<unknown> {
	let pending = imports.get(specifier);
	if (!pending) {
		const load = LOADERS[specifier];
		pending = load ? load().catch(() => undefined) : Promise.resolve(undefined);
		imports.set(specifier, pending);
	}
	return pending;
}

/** Features of `features` whose omp internals are missing. */
export async function probe(
	env: BridgeEnv,
	features: readonly FeatureId[] = ALL_FEATURES,
): Promise<UnavailableFeature[]> {
	const specifiers = new Set(features.flatMap(feature => Object.keys(REQUIREMENTS[feature].modules ?? {})));
	const modules = new Map<string, unknown>();
	await Promise.all(
		[...specifiers].map(async specifier => {
			const namespace = await importOnce(specifier);
			if (namespace !== undefined) modules.set(specifier, namespace);
		}),
	);
	let session: unknown;
	if (features.some(feature => REQUIREMENTS[feature].session?.length)) {
		try {
			session = env.session();
		} catch {
			// No session attached yet: session requirements are skipped, not failed.
		}
	}
	return deriveUnavailable(features, {
		session,
		pkg: env.pi.pi,
		modules,
		hasPrompt: relative => fs.existsSync(ompPromptPath(relative)),
		hidden: HIDDEN,
	});
}

/** `methods` refused with `unsupported_omp` while any of `features` is missing an internal. */
export function guard(features: FeatureId | readonly FeatureId[], methods: BridgeMethods): BridgeMethods {
	const required = typeof features === "string" ? [features] : features;
	const guarded: BridgeMethods = {};
	for (const [name, method] of Object.entries(methods)) {
		guarded[name] = async (params, env) => {
			const unavailable = await probe(env, required);
			if (unavailable.length > 0) throw new UnsupportedOmpError(unavailable, env.pi.pi.VERSION);
			return method(params, env);
		};
	}
	return guarded;
}
