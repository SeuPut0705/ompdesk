/**
 * The one owner of the `sidebar` prefs key (`src/shared/sidebar-prefs.ts`): a window or a paired page sends a
 * `SidebarChange`, and it is applied here to the value stored now. Nothing else writes the blob, so a page that read
 * it earlier can never put an older copy back.
 */
import { z } from "zod";
import { codedError } from "../shared/ipc-error-codes";
import {
	RAIL_PINS,
	readSidebarPrefs,
	SIDEBAR_PREFS_KEY,
	type SidebarChange,
	sidebarPatch,
} from "../shared/sidebar-prefs";
import type { RuntimeLogReport } from "./runtime-log-core";

export interface SidebarPrefsStorage {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

const path = z.string().min(1);

/** What a page may send, checked here: a page is not trusted to send a well-formed change. */
const SidebarChangeSchema = z.discriminatedUnion("op", [
	z.object({ op: z.literal("set-group-pinned"), cwd: path, pinned: z.boolean() }),
	z.object({ op: z.literal("set-session-pinned"), path, pinned: z.boolean() }),
	z.object({ op: z.literal("set-agent-hidden"), path, hidden: z.boolean() }),
	z.object({ op: z.literal("set-group-alias"), cwd: path, alias: z.string().nullable() }),
	z.object({ op: z.literal("set-group-order"), order: z.array(z.string()) }),
	z.object({ op: z.literal("set-session-order"), list: path, order: z.array(z.string()) }),
	z.object({ op: z.literal("set-sessions-archived"), ids: z.array(z.string()), archived: z.boolean() }),
	z.object({ op: z.literal("set-rail-pin"), pin: z.enum(RAIL_PINS), pinned: z.boolean() }),
	z.object({ op: z.literal("touch-workspace"), cwd: path }),
]) satisfies z.ZodType<SidebarChange>;

/** The runtime log's line for a change that moved what the sidebar remembers in order; the workspace clock fires on every switch and says nothing. */
function logLine(change: SidebarChange, from: "window" | "web"): RuntimeLogReport | null {
	const line = (details: { list?: string; count: number; on?: boolean }): RuntimeLogReport => ({
		source: "sidebar",
		message: change.op,
		details: { level: "info", ...details, from },
	});
	switch (change.op) {
		case "set-session-order":
			return line({ list: change.list, count: change.order.length });
		case "set-group-order":
			return line({ count: change.order.length });
		case "set-sessions-archived":
			return line({ count: change.ids.length, on: change.archived });
		case "set-session-pinned":
		case "set-group-pinned":
			return line({ count: 1, on: change.pinned });
		default:
			return null;
	}
}

/**
 * Applies one change to the stored blob and writes it only when something moved. A payload that is not a
 * `SidebarChange` throws and leaves the blob alone. `from` is where it was sent (a desktop window or a paired page).
 */
export function updateSidebarPrefs(
	storage: SidebarPrefsStorage,
	payload: unknown,
	from: "window" | "web",
	log: (report: RuntimeLogReport) => void,
): void {
	const parsed = SidebarChangeSchema.safeParse(payload);
	if (!parsed.success) throw codedError("invalid_preference_key", "Invalid sidebar change");
	const current = readSidebarPrefs(storage.get(SIDEBAR_PREFS_KEY));
	const patch = sidebarPatch(current, parsed.data);
	if (Object.keys(patch).length === 0) return;
	storage.set(SIDEBAR_PREFS_KEY, { ...current, ...patch });
	const line = logLine(parsed.data, from);
	if (line) log(line);
}
