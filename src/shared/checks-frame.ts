/**
 * What main's relay sends a page about check control (`src/main/checks/relay.ts`): the hub's snapshot as the contract
 * writes it (`checks-contract.ts`), and beside it the names main knows for the ids in it. The contract carries ids
 * only; a title or a computer's name changes without the hub hearing of it, so main reads them when it sends.
 */
import type { Snapshot } from "./checks-contract";

/**
 * Names for the ids of one snapshot. An id main cannot name is absent, and the page says so in its own words. A goal
 * needs none: `Origin.goal` is the goal's own text.
 */
export interface ChecksNames {
	/** By device id (`local`: the hub's own computer). `here`: the computer whose hub this is. */
	devices: Record<string, { name: string; here?: true }>;
	/** By `Origin.session`, the saved session id (or a tab id before its file exists). `autopilot`: an Autopilot run's. */
	sessions: Record<string, { title: string; autopilot?: true }>;
}

export interface ChecksFrame {
	snapshot: Snapshot;
	names: ChecksNames;
	/** `lost`: the hub cannot be reached now, and the snapshot is the last it said. Nothing in it counts as current. */
	hub: "live" | "lost";
}
