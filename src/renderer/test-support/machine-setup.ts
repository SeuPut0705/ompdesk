/**
 * A `window.omp.setup` double whose pushes a test drives, plus SetupState
 * builders. Platform is always explicit: renderer tests never read
 * process.platform.
 */
import { vi } from "vitest";
import {
	SETUP_ITEMS,
	type SetupItemId,
	type SetupItemState,
	type SetupPlatform,
	type SetupState,
	setupItemRequired,
} from "../../shared/setup";

export function setupItem(
	id: SetupItemId,
	platform: SetupPlatform,
	partial: Partial<SetupItemState> = {},
): SetupItemState {
	return {
		id,
		required: setupItemRequired(id, platform),
		phase: "present",
		presence: { kind: "present", version: "1.0.0", path: `/usr/local/bin/${id}` },
		method: null,
		command: null,
		location: null,
		prompt: null,
		progress: null,
		output: "",
		failure: null,
		manualCommands: [],
		manualUrl: `https://example.test/${id}`,
		...partial,
	};
}

/** Every item present unless overridden. */
export function setupState(
	platform: SetupPlatform,
	overrides: Partial<Record<SetupItemId, Partial<SetupItemState>>> = {},
	partial: Partial<SetupState> = {},
): SetupState {
	const items = SETUP_ITEMS.map(id => setupItem(id, platform, overrides[id]));
	const required = items.filter(item => item.required);
	return {
		platform,
		automatic: true,
		ompReady: items.find(item => item.id === "omp")?.phase === "present",
		requiredRunning: required.some(item => item.phase === "queued" || item.phase === "running"),
		items,
		...partial,
	};
}

/** `api` goes on `window.omp.setup`; `push` delivers a state the way main does. */
export function fakeSetupApi(initial: SetupState) {
	const current = { state: initial };
	let listener: ((state: SetupState) => void) | null = null;
	const api = {
		getState: vi.fn(async () => current.state),
		retry: vi.fn(async (_item: SetupItemId) => {}),
		cancel: vi.fn(async () => true),
		onState: vi.fn((callback: (state: SetupState) => void) => {
			listener = callback;
			return () => {
				listener = null;
			};
		}),
	};
	return {
		api,
		current,
		push: (state: SetupState) => {
			current.state = state;
			listener?.(state);
		},
	};
}
