/**
 * Shared types for seucode's gui-bridge extension.
 *
 * The GUI loads `index.ts` into the user's installed omp with
 * `omp --mode rpc-ui -e <resources>/gui-bridge/index.ts`. The installed CLI is
 * a single bundled `dist/cli.js`; omp transpiles extension files itself, so
 * these stay plain TypeScript and are never built by the GUI.
 *
 * Import style (verified against omp 18.6.1):
 * - Live singletons: reach them through `env.pi.pi`, the package index omp hands
 *   every extension (`AgentRegistry`, `MAIN_AGENT_ID`, `settings`, `VERSION`, …).
 *   It is the running process's own module graph.
 * - Subpath modules: plain bare imports such as
 *   `import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager"` also work
 *   from this directory, even though it sits outside omp's node_modules: omp
 *   installs a Bun resolver plugin (`omp:legacy-pi-shim`) that maps every
 *   `@oh-my-pi/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui,pi-utils,…}` specifier
 *   onto the host's bundled modules. Same singletons as the running agent;
 *   no `import.meta.resolve` against the install path is needed.
 * - Types: `import type` from those packages is erased by the transpiler, so it
 *   costs nothing at runtime. The GUI's own `tsc` does not check this directory.
 *
 * These are omp internals with no semver guarantee; the GUI gates the whole
 * bridge on its minimum supported omp version.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/** A frame pushed to the GUI. It reaches the renderer exactly as if omp had written it on stdout. */
export interface BridgeEvent {
	type: string;
	[key: string]: unknown;
}

export interface BridgeEnv {
	/** The extension API omp passed to the bridge factory. `pi.pi` is the live package index. */
	pi: ExtensionAPI;
	/** The live main AgentSession (`AgentRegistry.global().get(MAIN_AGENT_ID).session`); throws when none is attached. */
	session(): AgentSession;
	/** Latest ExtensionContext omp handed a session lifecycle handler; throws before the first `session_start`. */
	context(): ExtensionContext;
	/** Push a frame to every connected GUI client. */
	emit(event: BridgeEvent): void;
}

/** One bridge method. `params` is the GUI's untyped JSON (narrow it); the resolved value becomes `result`. */
export type BridgeMethod = (params: unknown, env: BridgeEnv) => Promise<unknown>;

export type BridgeMethods = Record<string, BridgeMethod>;
