/**
 * Queue commands on stock omp.
 *
 * Stock omp exposes the pending queues only as chip-text lanes
 * (`get_state.queuedMessages`, `queue_update {steering, followUp}`) and edits
 * them by text (`remove_queued_message`, `promote_queued_message`). The
 * renderer keys chips by stable ids, so the main process gives every chip an
 * id the first time it sees it and carries it across snapshots: equal text in
 * the same relative order keeps its id, a chip that moved lanes (promotion)
 * keeps it too. Stock cannot reorder within a lane, and its lanes carry no
 * images.
 */
import type { RpcGetQueueResult, RpcQueuedMessage, RpcQueueMoveResult } from "../../shared/rpc-types";
import { type BridgeClient, type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

export type QueueLane = "steering" | "followUp";

export interface QueueSnapshot {
	steering: readonly string[];
	followUp: readonly string[];
}

/** stock `queueChipText` for an image-only message: there is no text to edit or re-queue. */
const IMAGE_ONLY_CHIP = "[Image]";
/** A pending edit/lane move older than this no longer claims a fresh chip. */
const EXPECTATION_TTL_MS = 10_000;

interface Chip {
	id: string;
	text: string;
	timestamp: number;
}

interface Expectation {
	lane: QueueLane;
	chip: Chip;
	at: number;
}

let nextChipId = 0;

/** Stable ids for one omp spawn's queue chips. */
export class QueueIds {
	steering: Chip[] = [];
	followUp: Chip[] = [];
	#expected: Expectation[] = [];

	/** Adopt a stock snapshot; returns the renderer view. */
	reconcile(snapshot: QueueSnapshot, now = Date.now()): RpcGetQueueResult {
		this.#expected = this.#expected.filter(expectation => now - expectation.at < EXPECTATION_TTL_MS);
		const previous: Record<QueueLane, Chip[]> = { steering: this.steering, followUp: this.followUp };
		const matched: Record<QueueLane, (Chip | null)[]> = {
			steering: matchInOrder(previous.steering, snapshot.steering),
			followUp: matchInOrder(previous.followUp, snapshot.followUp),
		};
		const usedIds = new Set<string>();
		for (const chip of [...matched.steering, ...matched.followUp]) if (chip) usedIds.add(chip.id);
		const next: Record<QueueLane, Chip[]> = { steering: [], followUp: [] };
		for (const lane of ["steering", "followUp"] as const) {
			const other: QueueLane = lane === "steering" ? "followUp" : "steering";
			snapshot[lane].forEach((text, index) => {
				const chip = matched[lane][index] ??
					this.#claimExpected(lane, text, usedIds) ??
					// A chip that left the other lane with the same text moved here (promotion).
					previous[other].find(candidate => candidate.text === text && !usedIds.has(candidate.id)) ?? {
						id: `q${++nextChipId}`,
						text,
						timestamp: now,
					};
				usedIds.add(chip.id);
				next[lane].push(chip);
			});
		}
		this.steering = next.steering;
		this.followUp = next.followUp;
		return this.view();
	}

	view(): RpcGetQueueResult {
		return { steering: this.steering.map(toWire), followUp: this.followUp.map(toWire) };
	}

	find(id: string): { lane: QueueLane; chip: Chip; index: number } | undefined {
		for (const lane of ["steering", "followUp"] as const) {
			const index = this[lane].findIndex(chip => chip.id === id);
			if (index !== -1) return { lane, chip: this[lane][index], index };
		}
		return undefined;
	}

	/** The next unmatched `text` chip in `lane` is `chip` re-queued (an edit or a lane move). */
	expect(lane: QueueLane, text: string, chip: Chip, now = Date.now()): void {
		this.#expected.push({ lane, chip: { ...chip, text }, at: now });
	}

	#claimExpected(lane: QueueLane, text: string, usedIds: ReadonlySet<string>): Chip | undefined {
		const index = this.#expected.findIndex(
			expectation =>
				expectation.lane === lane && expectation.chip.text === text && !usedIds.has(expectation.chip.id),
		);
		if (index === -1) return undefined;
		return this.#expected.splice(index, 1)[0].chip;
	}
}

/** Greedy in-order match: each new text takes the earliest unconsumed equal chip after the previous match. */
function matchInOrder(previous: readonly Chip[], texts: readonly string[]): (Chip | null)[] {
	let cursor = 0;
	return texts.map(text => {
		for (let index = cursor; index < previous.length; index++) {
			if (previous[index].text === text) {
				cursor = index + 1;
				return previous[index];
			}
		}
		return null;
	});
}

function toWire(chip: Chip): RpcQueuedMessage {
	return { id: chip.id, text: chip.text, editable: chip.text !== IMAGE_ONLY_CHIP, timestamp: chip.timestamp };
}

/** Per omp spawn, keyed by its bridge client (which lives exactly as long as that process). */
const queues = new WeakMap<BridgeClient, QueueIds>();

function queueFor(bridge: BridgeClient): QueueIds {
	let queue = queues.get(bridge);
	if (!queue) {
		queue = new QueueIds();
		queues.set(bridge, queue);
	}
	return queue;
}

function isLane(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/**
 * Rewrite a stock `queue_update` frame (`string[]` lanes) into the renderer's
 * `{id, text, …}` lanes. Called by the sidecar on every inbound frame of that
 * type, in arrival order; anything malformed passes through untouched.
 */
export function projectQueueUpdate(bridge: BridgeClient, frame: Record<string, unknown>): Record<string, unknown> {
	const { steering, followUp } = frame;
	if (!isLane(steering) || !isLane(followUp)) return frame;
	return { ...frame, ...queueFor(bridge).reconcile({ steering, followUp }) };
}

async function refresh(ctx: LocalCommandContext): Promise<QueueIds> {
	const state = await ctx.send<{ queuedMessages?: QueueSnapshot }>({ type: "get_state" });
	const queue = queueFor(ctx.bridge);
	queue.reconcile(state?.queuedMessages ?? { steering: [], followUp: [] });
	return queue;
}

/** Resolve a renderer id, refreshing once in case the chip arrived after the last snapshot. */
async function locate(ctx: LocalCommandContext, id: unknown) {
	if (typeof id !== "string" || id.length === 0) throw new Error("queueId must be a non-empty string");
	const found = queueFor(ctx.bridge).find(id) ?? (await refresh(ctx)).find(id);
	if (!found) throw new Error(`Unknown queued message id: ${id}`);
	return { queue: queueFor(ctx.bridge), ...found };
}

async function removeChip(ctx: LocalCommandContext, lane: QueueLane, text: string): Promise<boolean> {
	const data = await ctx.send<{ removed?: boolean }>({ type: "remove_queued_message", message: text, queue: lane });
	return data?.removed === true;
}

function requireEditable(text: string): void {
	if (text === IMAGE_ONLY_CHIP) {
		throw new LocalCommandError("An image-only queued message cannot be re-queued", "not_editable");
	}
}

export const handlers: Record<string, LocalHandler> = {
	get_queue: async (_command, ctx): Promise<RpcGetQueueResult> => (await refresh(ctx)).view(),

	queue_remove: async (command, ctx) => {
		const { lane, chip } = await locate(ctx, command.queueId);
		if (!(await removeChip(ctx, lane, chip.text))) throw new Error(`Unknown queued message id: ${chip.id}`);
		return { removed: true };
	},

	queue_clear: async (command, ctx) => {
		const only = command.lane;
		if (only !== undefined && only !== "steering" && only !== "followUp") {
			throw new Error('lane must be "steering" or "followUp"');
		}
		const queue = await refresh(ctx);
		let removed = 0;
		const lanes: readonly QueueLane[] = only ? [only] : ["steering", "followUp"];
		for (const lane of lanes) {
			for (const chip of [...queue[lane]]) if (await removeChip(ctx, lane, chip.text)) removed++;
		}
		return { removed };
	},

	/** Stock edits text in place by removing and re-queueing: the chip moves to the end of its lane. */
	queue_edit: async (command, ctx) => {
		if (typeof command.text !== "string") throw new Error("text must be a string");
		const text = command.text;
		const { queue, lane, chip } = await locate(ctx, command.queueId);
		if (text === chip.text) return { updated: true };
		requireEditable(chip.text);
		if (!(await removeChip(ctx, lane, chip.text))) throw new Error(`Unknown queued message id: ${chip.id}`);
		queue.expect(lane, text, chip);
		await ctx.send({ type: lane === "steering" ? "steer" : "follow_up", message: text });
		return { updated: true };
	},

	/**
	 * Lane switches only: follow-up → steering is stock promotion (attachments
	 * kept); steering → follow-up re-queues the text. Stock cannot reorder
	 * within a lane, so a same-lane move is refused unless it is a no-op.
	 */
	queue_move: async (command, ctx): Promise<RpcQueueMoveResult> => {
		const toLane = command.toLane;
		if (toLane !== undefined && toLane !== "steering" && toLane !== "followUp") {
			throw new Error('toLane must be "steering" or "followUp"');
		}
		if (typeof command.toIndex !== "number" || !Number.isFinite(command.toIndex)) {
			throw new Error("toIndex must be a finite number");
		}
		const { queue, lane, chip, index } = await locate(ctx, command.queueId);
		if (toLane === undefined || toLane === lane) {
			const target = Math.max(0, Math.min(queue[lane].length - 1, Math.floor(command.toIndex)));
			if (target === index) return { lane, index };
			throw new LocalCommandError("omp cannot reorder queued messages within a lane", "unsupported");
		}
		const landedAt = queue[toLane].length;
		if (toLane === "steering") {
			queue.expect("steering", chip.text, chip);
			const data = await ctx.send<{ promoted?: boolean }>({ type: "promote_queued_message", message: chip.text });
			if (data?.promoted !== true) throw new Error(`Unknown queued message id: ${chip.id}`);
		} else {
			requireEditable(chip.text);
			if (!(await removeChip(ctx, lane, chip.text))) throw new Error(`Unknown queued message id: ${chip.id}`);
			queue.expect("followUp", chip.text, chip);
			await ctx.send({ type: "follow_up", message: chip.text });
		}
		return { lane: toLane, index: landedAt };
	},

	/**
	 * Restore one queued message to the composer (TUI Alt+Up: the last steer,
	 * else the last follow-up). The bridge pops it with its attachments; without
	 * the bridge, stock removes it by text. The rest of the queue stays put.
	 */
	dequeue: async (_command, ctx) => {
		if (ctx.bridge.connected) {
			const popped = await ctx.bridge.request<{ text: string; images?: unknown[] } | null>("composer.dequeue");
			return { messages: popped ? [popped] : [] };
		}
		const queue = await refresh(ctx);
		const lane: QueueLane = queue.steering.length > 0 ? "steering" : "followUp";
		const chip = queue[lane].at(-1);
		if (!chip || !(await removeChip(ctx, lane, chip.text))) return { messages: [] };
		return { messages: [{ text: chip.text }] };
	},
};
