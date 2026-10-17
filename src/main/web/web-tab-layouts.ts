/**
 * A paired web device's tabs outlive a relaunch of this computer's app, as a desktop window's do (`tabLayouts`).
 * Its window (`WebClientWindow`) is rebuilt with a new negative id each launch, so the layout is filed under the
 * device's own id (`web-devices.json`), saved on every change of that window's tabs, restored into its window at
 * launch for every device still paired, and dropped when the device is revoked, blocked or expires.
 */
import { type PersistedTabLayout, sanitizePersistedTabLayout } from "../tab-layout";

/** The `webTabLayouts` pref: device id → that device's window layout. */
export interface WebLayoutPrefs {
	get(): unknown;
	set(value: Record<string, PersistedTabLayout>): void;
}

export class WebTabLayouts {
	readonly #prefs: WebLayoutPrefs;
	readonly #sanitize: (value: unknown) => PersistedTabLayout | null;

	constructor(
		prefs: WebLayoutPrefs,
		sanitize: (value: unknown) => PersistedTabLayout | null = value => sanitizePersistedTabLayout(value),
	) {
		this.#prefs = prefs;
		this.#sanitize = sanitize;
	}

	#all(): Record<string, unknown> {
		const value = this.#prefs.get();
		return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
	}

	#write(next: Record<string, unknown>): void {
		// electron-store rewrites and fsyncs the whole file on every set: only what changed (index.ts persistTabLayouts).
		if (JSON.stringify(this.#prefs.get() ?? {}) !== JSON.stringify(next))
			this.#prefs.set(next as Record<string, PersistedTabLayout>);
	}

	/** The device's window tabs changed; `null` (no tab left) forgets them. */
	save(deviceId: string, layout: PersistedTabLayout | null): void {
		const all = this.#all();
		if (layout) all[deviceId] = layout;
		else delete all[deviceId];
		this.#write(all);
	}

	/** The device is gone (revoked, blocked, expired): its tabs never come back. */
	drop(deviceId: string): void {
		this.save(deviceId, null);
	}

	/** The saved layouts of the devices still paired; the others are dropped from the store. */
	restorable(paired: ReadonlySet<string>): Array<{ deviceId: string; layout: PersistedTabLayout }> {
		const all = this.#all();
		const kept: Record<string, unknown> = {};
		const layouts: Array<{ deviceId: string; layout: PersistedTabLayout }> = [];
		for (const [deviceId, value] of Object.entries(all)) {
			if (!paired.has(deviceId)) continue;
			kept[deviceId] = value;
			const layout = this.#sanitize(value);
			if (layout && layout.tabs.length > 0) layouts.push({ deviceId, layout });
		}
		this.#write(kept);
		return layouts;
	}
}
