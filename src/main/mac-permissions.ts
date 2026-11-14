import { MAC_PERMISSIONS, type MacPermission, type MacPermissionStatus } from "../shared/mac-permissions";

/**
 * The permissions OMPdesk has asked macOS for on its own, once each: a person who declines is not asked again at the
 * next launch (Settings › Agent behavior › Computer use keeps the state and the button).
 */
export const MAC_PERMISSIONS_REQUESTED_PREF = "macPermissionsRequested";

/** The pane of System Settings › Privacy & Security that holds each switch. */
const PANES: Record<MacPermission, string> = {
	accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export interface MacPermissionDeps {
	platform: NodeJS.Platform;
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** The agent-desktop executable sessions run (bundled with the app, or a newer managed copy), else null. */
	agentDesktop(): Promise<string | null>;
	/** Runs an executable; resolves its stdout, rejects when it cannot run, exits non-zero or outlasts its bound. */
	run(executable: string, args: readonly string[]): Promise<string>;
	/** `systemPreferences.isTrustedAccessibilityClient(prompt)`. */
	accessibilityTrusted(prompt: boolean): boolean | Promise<boolean>;
	/** `systemPreferences.getMediaAccessStatus("screen") === "granted"`. */
	screenGranted(): boolean | Promise<boolean>;
	openPane(url: string): Promise<void>;
}

/** A field of a parsed JSON object, when there is one. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

/** `agent-desktop permissions` as it prints it: `{data: {accessibility: {state}, screen_recording: {state}}}`. */
function parseAgentDesktop(stdout: string): MacPermissionStatus | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	const data = field(parsed, "data");
	const accessibility = field(field(data, "accessibility"), "state");
	const screen = field(field(data, "screen_recording"), "state");
	if (typeof accessibility !== "string" || typeof screen !== "string") return null;
	return { accessibility: accessibility === "granted", screen: screen === "granted" };
}

/**
 * Accessibility and Screen & System Audio Recording for computer use. Both engines run under OMPdesk, so macOS checks
 * OMPdesk's grant (TCC's responsible process) for either.
 *
 * - The state is read by a fresh `agent-desktop permissions` when it is installed: the engine's own view, and a new
 *   process each time, so a switch the person just turned on reads granted. Without it, Electron's own reading.
 * - Asking: Electron's `getMediaAccessStatus("screen")` says `denied` while macOS has no record of OMPdesk at all
 *   (measured, macOS 27: tccd answered `Unknown (None)` at the same moment), so it cannot tell "never asked" from
 *   "declined", and a capture request from Electron never put OMPdesk in the list. `agent-desktop permissions
 *   --request` does: its request reaches tccd as OMPdesk's, which adds OMPdesk to the list and shows macOS's prompt.
 *   Accessibility is asked with `isTrustedAccessibilityClient(true)`, which does the same.
 */
export class MacPermissions {
	readonly #deps: MacPermissionDeps;

	constructor(deps: MacPermissionDeps) {
		this.#deps = deps;
	}

	/** Whether each is granted now; null off macOS. */
	async status(): Promise<MacPermissionStatus | null> {
		const deps = this.#deps;
		if (deps.platform !== "darwin") return null;
		const executable = await deps.agentDesktop();
		if (executable) {
			const read = await deps.run(executable, ["permissions"]).then(parseAgentDesktop, () => null);
			if (read) return read;
		}
		return { accessibility: await deps.accessibilityTrusted(false), screen: await deps.screenGranted() };
	}

	async #ask(permission: MacPermission): Promise<boolean> {
		const deps = this.#deps;
		if (permission === "accessibility") {
			await deps.accessibilityTrusted(true);
			return true;
		}
		const executable = await deps.agentDesktop();
		if (!executable) return false;
		await deps.run(executable, ["permissions", "--request"]);
		return true;
	}

	/** The person's button: ask macOS (it lists OMPdesk and prompts once), then open the pane with the switch. */
	async request(permission: MacPermission): Promise<MacPermissionStatus | null> {
		if (this.#deps.platform !== "darwin") return null;
		await this.#ask(permission).catch(() => false);
		this.#remember(permission);
		await this.#deps.openPane(PANES[permission]);
		return this.status();
	}

	/** Accessibility was asked by this process: Screen Recording waits until it is granted, or until a later launch. */
	#accessibilityAskedNow = false;
	/** One automatic pass at a time: focus events can come faster than agent-desktop answers. */
	#asking: Promise<MacPermission[]> | null = null;
	/** Every permission is granted or was asked: no automatic pass has anything left to do. */
	#settled = false;

	/**
	 * Asks macOS for a missing permission OMPdesk never asked for, so its prompt reaches the person without a hunt
	 * through Settings; called at launch and whenever an OMPdesk window gains focus. macOS shows one permission prompt
	 * at a time, and a request made while one is up leaves no record (measured 6 Nov 2026: with Accessibility also
	 * missing, the Accessibility prompt showed and the Screen Recording request left the app unlisted). So one at a
	 * time: Accessibility first; Screen Recording once Accessibility is granted (the focus after the person turns it on),
	 * or at a later launch when it was declined. One that could not be asked (no agent-desktop to run) waits for a later
	 * pass. Returns what it asked.
	 */
	askMissing(): Promise<MacPermission[]> {
		this.#asking ??= this.#askNext().finally(() => {
			this.#asking = null;
		});
		return this.#asking;
	}

	async #askNext(): Promise<MacPermission[]> {
		if (this.#settled) return [];
		const requested = this.#requested();
		if (MAC_PERMISSIONS.every(permission => requested.includes(permission))) return [];
		const status = await this.status();
		if (!status) return [];
		// Nothing left to ask in this process: later focus events spawn nothing.
		if (MAC_PERMISSIONS.every(permission => status[permission] || requested.includes(permission))) {
			this.#settled = true;
			return [];
		}
		if (!status.accessibility && !requested.includes("accessibility")) {
			await this.#ask("accessibility");
			this.#remember("accessibility");
			this.#accessibilityAskedNow = true;
			return ["accessibility"];
		}
		const accessibilityAnswered = status.accessibility || !this.#accessibilityAskedNow;
		if (status.screen || requested.includes("screen") || !accessibilityAnswered) return [];
		if (!(await this.#ask("screen"))) return [];
		this.#remember("screen");
		return ["screen"];
	}

	#requested(): MacPermission[] {
		const stored = this.#deps.prefs.get(MAC_PERMISSIONS_REQUESTED_PREF);
		return MAC_PERMISSIONS.filter(permission => Array.isArray(stored) && stored.includes(permission));
	}

	#remember(permission: MacPermission): void {
		const requested = this.#requested();
		if (!requested.includes(permission)) {
			this.#deps.prefs.set(MAC_PERMISSIONS_REQUESTED_PREF, [...requested, permission]);
		}
	}
}
