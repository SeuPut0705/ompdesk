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
 * A local tab several windows show (multi-viewer) has no one device: main sends the bridge
 * `prompt_origin_set {origin, text}` before it hands a prompt, steer or follow-up from a paired web
 * device to the omp, and the bridge journals that origin for the user message with that text. Each
 * window then gets the labels relative to itself: `labelPromptOrigins` marks every prompt with who
 * typed it (`promptFromId`) and main drops the label of the window's own prompts (`localizePromptOrigins`).
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

/** `promptFromId` of a prompt typed on the host itself (no journal entry). */
export const PROMPT_ORIGIN_HOST_ID = "host";

/** `prompt_origin_set`: the next user message with this text came from `origin`. */
export interface PromptOriginSet {
	origin: PromptOrigin;
	text: string;
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
 * A labelled prompt: `promptFrom` names the device when it is known; `promptFromId` (only on a tab no device
 * owns) says which device, for `localizePromptOrigins`.
 */
export interface PromptOriginLabel {
	promptFrom?: string;
	promptFromId?: string;
}

/**
 * `promptFrom` (the other device's name) on each user message typed on a
 * device other than the viewer's, once the messages hold prompts from at
 * least two devices. `viewer` null: no device owns the omp (a local tab), so every prompt is
 * marked with who typed it (`promptFromId`, `promptFrom` where a name is known) and each
 * window drops the label of its own with `localizePromptOrigins`.
 */
export function labelPromptOrigins<T extends { role: string; timestamp?: number }>(
	messages: readonly T[],
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	viewer: PromptOriginEnv | null,
): (T | (T & PromptOriginLabel))[] {
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
	return messages.map(message => {
		if (message.role !== "user") return message;
		if (viewer === null) {
			const tag = message.timestamp === undefined ? undefined : tags.get(message.timestamp);
			return {
				...message,
				promptFromId: tag?.deviceId ?? PROMPT_ORIGIN_HOST_ID,
				...(tag ? { promptFrom: tag.name } : {}),
			};
		}
		const key = keyOf(message);
		if (key === viewer.deviceId) return message;
		const name = key === HOST ? viewer.hostName : tags.get(message.timestamp as number)?.name;
		return name ? { ...message, promptFrom: name } : message;
	});
}

/**
 * A labelled page, as one window sees it: the window's own prompts lose their label, and a prompt typed
 * on the host carries the host's name. `ownId` is the window's device (`PROMPT_ORIGIN_HOST_ID` for a
 * desktop window). The id is dropped: it only says whose label this is.
 */
export function localizePromptOrigins<T extends object>(messages: readonly T[], ownId: string, hostName: string): T[] {
	return messages.map(message => {
		const { promptFromId, ...rest } = message as T & PromptOriginLabel;
		if (promptFromId === undefined) return message;
		if (promptFromId === ownId) {
			const { promptFrom: _own, ...plain } = rest;
			return plain as T;
		}
		return promptFromId === PROMPT_ORIGIN_HOST_ID ? ({ ...rest, promptFrom: hostName } as T) : (rest as T);
	});
}

/** The params of `prompt_origin_set`; anything else throws. */
export function parsePromptOriginSet(value: unknown): PromptOriginSet {
	const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const { origin, text } = record;
	if (!isOrigin(origin) || typeof text !== "string") throw new Error("prompt_origin_set needs {origin, text}");
	return { origin: { deviceId: origin.deviceId, name: origin.name }, text };
}
