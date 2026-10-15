/**
 * Prompt origins (A85): which device typed each prompt of a session a paired
 * device used on this computer. Main gives a host tab's omp its device as
 * JSON in `OMP_GUI_PROMPT_ORIGIN` at spawn (a host runs one omp per device
 * tab, so every prompt that omp receives comes from that device); the bridge
 * (prompt-origin.ts) journals one `ompdesk.prompt-origin` custom entry per
 * user message, keyed by the message's timestamp. A transcript then labels
 * the prompts typed elsewhere than on the viewing device — only once the
 * conversation holds prompts from more than one device. Untagged prompts were
 * typed on the host itself. Stock omp has no notion of devices.
 *
 * Dependency-free: main, the bridge and its tests import it.
 */

export const PROMPT_ORIGIN_ENTRY = "ompdesk.prompt-origin";

/** A paired device as the host knows it. */
export interface PromptOrigin {
	deviceId: string;
	name: string;
}

/** `OMP_GUI_PROMPT_ORIGIN`: the device a host tab serves, plus the host's own name for untagged prompts. */
export interface PromptOriginEnv extends PromptOrigin {
	hostName: string;
}

/** One journal entry: the user message sent at `timestamp` came from this device. */
export interface PromptOriginEntry extends PromptOrigin {
	timestamp: number;
}

function isOrigin(value: unknown): value is PromptOrigin {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.deviceId === "string" &&
		record.deviceId !== "" &&
		typeof record.name === "string" &&
		record.name !== ""
	);
}

export function isPromptOriginEntry(value: unknown): value is PromptOriginEntry {
	return isOrigin(value) && Number.isFinite((value as unknown as Record<string, unknown>).timestamp);
}

/** The env value, or null when absent or malformed (a local tab: no origin). */
export function parsePromptOriginEnv(raw: string | undefined): PromptOriginEnv | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isOrigin(value)) return null;
		const hostName = (value as unknown as Record<string, unknown>).hostName;
		return typeof hostName === "string" ? { deviceId: value.deviceId, name: value.name, hostName } : null;
	} catch {
		return null;
	}
}

/** The device key of an untagged prompt: the host itself. */
const HOST = "";

/**
 * `promptFrom` (the other device's name) on each user message typed on a
 * device other than the viewer's, once the messages hold prompts from at
 * least two devices. `viewer` null: the host's own tab.
 */
export function labelPromptOrigins<T extends { role: string; timestamp?: number }>(
	messages: readonly T[],
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	viewer: PromptOriginEnv | null,
): (T | (T & { promptFrom: string }))[] {
	const tags = new Map<number, PromptOrigin>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === PROMPT_ORIGIN_ENTRY && isPromptOriginEntry(entry.data))
			tags.set(entry.data.timestamp, entry.data);
	}
	if (tags.size === 0) return [...messages];
	const keyOf = (message: T) =>
		(message.timestamp !== undefined ? tags.get(message.timestamp)?.deviceId : undefined) ?? HOST;
	const devices = new Set(messages.filter(message => message.role === "user").map(keyOf));
	if (devices.size < 2) return [...messages];
	const self = viewer?.deviceId ?? HOST;
	return messages.map(message => {
		if (message.role !== "user") return message;
		const key = keyOf(message);
		if (key === self) return message;
		const name = key === HOST ? viewer?.hostName : tags.get(message.timestamp as number)?.name;
		return name ? { ...message, promptFrom: name } : message;
	});
}
