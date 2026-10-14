/**
 * Agent browsing in OMPdesk's preview (Preview panel › "Let the agent use this
 * page"). Stock's own browser relay (`tools/browser/relay/server.ts`, the
 * `omp browser-relay` server) runs inside this session's omp on a free loopback
 * port; the session's `browser.relay` / `browser.relayUrl` are held as runtime
 * overrides (never written to config.yml), so stock's browser tool resolves to
 * relay mode and drives whatever tab the relay's extension offers. OMPdesk's
 * main process connects as that extension (src/main/preview/agent-relay.ts) and
 * offers only the visible preview page.
 *
 * The extension socket needs the random token this method returns; the server
 * binds 127.0.0.1 only and refuses browser Origins on its CDP socket.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { guard } from "./health";
import { attach } from "./modes/shared";
import type { BridgeMethods } from "./types";

interface OverridableSetting {
	override(scope: object, value: unknown): void;
	clearOverride(scope: object): void;
}

function overridable(id: string): OverridableSetting {
	const setting: unknown = lookup(id);
	if (
		!setting ||
		typeof setting !== "object" ||
		!("override" in setting) ||
		typeof setting.override !== "function" ||
		!("clearOverride" in setting) ||
		typeof setting.clearOverride !== "function"
	) {
		throw new Error(`omp has no overridable ${id} setting`);
	}
	return setting as OverridableSetting;
}

interface RunningRelay {
	server: RelayServer;
	url: string;
	token: string;
	scope: object;
}

let running: RunningRelay | null = null;

function stop(): void {
	if (!running) return;
	const { server, scope } = running;
	running = null;
	server.stop();
	overridable("browser.relay").clearOverride(scope);
	overridable("browser.relayUrl").clearOverride(scope);
}

export const methods: BridgeMethods = guard("agentBrowser", {
	/** Start (or reuse) this session's relay and point its browser tool at it. */
	"browser.relay_start": async (_params, env) => {
		const scope = attach(env).settings as unknown as object;
		if (running && running.scope !== scope) stop();
		if (!running) {
			const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
			const port = await findFreeCdpPort();
			const server = startRelayServer({ port, token, group: false });
			running = { server, url: `http://127.0.0.1:${server.port}`, token, scope };
		}
		overridable("browser.relay").override(scope, true);
		overridable("browser.relayUrl").override(scope, running.url);
		return { url: running.url, token: running.token };
	},
	/** Stop the relay and give the browser tool back its configured browser. */
	"browser.relay_stop": async () => {
		stop();
		return {};
	},
});

/** The relay dies with the session it serves. */
export function install(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => stop());
}
