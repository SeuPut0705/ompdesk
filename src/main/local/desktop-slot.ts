/**
 * Main's own door into the bridge's desktop slot module (`desktop_slot_bridge`, like `autopilot_bridge`): the slot
 * (src/main/desktop-slot.ts) answers a tab's acting run with `desktop_slot.grant` and takes the screen back with
 * `desktop_slot.revoke`. `get_desktop_slot` and `desktop_slot_stop` are answered in `ipc.ts`, where the slot is.
 */
import { LocalCommandError, type LocalHandler } from "./types";

/** The bridge methods main calls (resources/gui-bridge/desktop-slot.ts registers them). */
export const DESKTOP_SLOT_BRIDGE_METHODS = {
	grant: "desktop_slot.grant",
	revoke: "desktop_slot.revoke",
} as const;

const BRIDGE_METHODS: readonly string[] = Object.values(DESKTOP_SLOT_BRIDGE_METHODS);

export const handlers: Record<string, LocalHandler> = {
	desktop_slot_bridge: async (command, ctx) => {
		const method = command.method;
		if (typeof method !== "string" || !BRIDGE_METHODS.includes(method)) {
			throw new LocalCommandError(`${String(method)} is not a desktop slot method.`, "invalid_method");
		}
		return ctx.bridge.request(method, command.params);
	},
};
