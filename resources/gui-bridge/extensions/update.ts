/**
 * What the extension updater (src/main/ext-update/) asks of a live session once the stock helper's
 * `extensions` worker has changed files on disk: pick up new plugin state (`extension_update.reload`, the
 * headless `/reload-plugins`) and reconnect the MCP servers whose package was updated
 * (`extension_update.reconnect`, `/mcp reconnect` for several names). Main sends them only to an idle, ready
 * tab; commands and skills reach a running session this way, extensions/tools/hooks need a restart instead.
 */
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { serializeMcpReload } from "./mcp";
import { paramsOf, reloadPluginState } from "./shared";

function serverNames(params: unknown): string[] {
	const names = paramsOf(params).names;
	if (!Array.isArray(names) || !names.every(name => typeof name === "string" && name !== "")) {
		throw new Error("names must be a list of server names");
	}
	return [...new Set<string>(names)];
}

export const methods: BridgeMethods = {
	...guard("plugins", {
		"extension_update.reload": async (_params, env) => {
			await reloadPluginState(env.session());
			return { ok: true };
		},
	}),
	...guard("mcp", {
		/**
		 * Reconnects each named server the live manager knows and the user's config still enables (a disabled
		 * server has no connection to refresh and must stay down), serialized with the other MCP mutations, then
		 * rebinds the session's MCP tools once. A server that fails to reconnect lands in `skipped`, it never
		 * fails the call: the next server and the tool rebind still run.
		 */
		"extension_update.reconnect": async (params, env) => {
			const names = serverNames(params);
			const session = env.session();
			const manager = MCPManager.instance();
			if (!manager) throw new Error("MCP manager not available.");
			return serializeMcpReload(async () => {
				const enabled = await loadAllMCPConfigs(session.sessionManager.getCwd(), {
					enableProjectConfig: cfgMcpEnableProjectConfig.get(session.settings),
					filterExa: false,
					extensionRoots: session.effectiveExtensionRoots,
				});
				const known = new Set(manager.getAllServerNames());
				const reconnected: string[] = [];
				const skipped: string[] = [];
				for (const name of names) {
					if (!known.has(name) || !Object.hasOwn(enabled.configs, name)) {
						skipped.push(name);
						continue;
					}
					try {
						const connection = await manager.reconnectServer(name, { manual: true });
						if (connection) reconnected.push(name);
						else skipped.push(name);
					} catch {
						skipped.push(name);
					}
				}
				if (reconnected.length > 0) await session.refreshMCPTools(manager.getTools());
				return { reconnected, skipped };
			});
		},
	}),
};
