/**
 * Shared-checkout claims under generated event sequences: the claim state machine (`ClaimBook`,
 * resources/gui-bridge/modes/checkout-claims.ts) of session A and main's real `CheckoutPeerCoordinator`, against the
 * invariants the TLA+ model checks (formal/checkout-claims/Properties.md). One file F, A's main agent and a subagent,
 * a peer B that only hears what main tells it. Events: a call starts (a file tool, a shell write, or A's own
 * `git commit -- F`; one stock refuses never runs), its bytes land (a commit: it commits), it reports back (ok or
 * failed), an agent's run ends, the omp restarts from its journal, someone else commits F, B changes F, a late retire
 * reaches A, and main's pass (A's bridge answers or is busy, git answers
 * or fails, the retire is answered or arrives late, and any of these events may happen while main waits for git).
 */
import { describe, expect, it } from "vitest";
import { ClaimBook, retiredClaims } from "../../resources/gui-bridge/modes/checkout-claims";
import type { CheckoutPeers } from "../../resources/gui-bridge/modes/checkout-peers-contracts";
import { type CheckoutMember, CheckoutPeerCoordinator } from "./checkout-peers";

const TOP = "/work/app";
const F = `${TOP}/src/f.ts`;

/** The claims of F a retire names, as `instance\0stamp`. */
function retireKeys(params: unknown): string[] {
	const instance = typeof params === "object" && params !== null && "instance" in params ? params.instance : "";
	return retiredClaims(params).flatMap(claim => (claim.file === F ? [`${instance}\0${claim.stamp}`] : []));
}
const OWNERS = ["main", "sub"] as const;

/** mulberry32: a seeded generator, so a failing sequence is replayed by its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Call {
	id: string;
	owner: string;
	/** A file tool or a shell write claims F; a commit (`git commit -- F`, a shell call) makes F clean when it succeeds. */
	kind: "file" | "shell" | "commit";
	runs: boolean;
	landed: boolean;
	/** A writer: the claim on F it took over (`instance\0stamp`), if A held one. */
	takenOver?: string;
	/** A commit: a writer of F started after it, so its clean leaves F alone. */
	writerSince?: boolean;
}

class World {
	book = new ClaimBook<string>();
	readonly calls = new Map<string, Call>();
	readonly log: string[] = [];
	/** Retires main sent that A's bridge has not handled yet. */
	late: unknown[] = [];
	/** Every claim of F main judged committed: `instance\0stamp`. */
	readonly committed = new Set<string>();
	/** Every claim of F a commit of A's own made committed: the ones the writers still pending took over. */
	readonly cleaned = new Set<string>();
	nextId = 1;
	dirty = false;
	/** A write of A's landed since F was last committed. */
	aWrote = false;
	/** What B was last told: F is A's. */
	bview = false;
	/** Calls that were running when B was last told F is A's. */
	shown = new Set<string>();
	/** A's bridge dropped its claim on F (a retire main sent) and A has started no call (and not restarted) since. */
	released = false;
	/** This pass: A's bridge answers, and the retire is answered at once (else it reaches A later). */
	answers = true;
	retireAnswered = true;
	readonly a: CheckoutMember = {
		key: "a",
		id: "a",
		title: "A",
		cwd: TOP,
		canMessage: true,
		request: async (method, params) => {
			if (method === "checkout_status") {
				if (!this.answers) throw new Error("busy");
				// The bridge answers its requests in order: a retire sent earlier is handled first.
				for (const retire of this.late.splice(0)) this.retire(retire);
				return this.book.status();
			}
			if (method === "checkout_retire") {
				for (const key of retireKeys(params)) this.committed.add(key);
				if (!this.retireAnswered) {
					this.late.push(params);
					throw new Error("busy");
				}
				this.retire(params);
				return { ok: true, ...this.book.status() };
			}
			return { ok: true };
		},
	};
	readonly b: CheckoutMember = {
		key: "b",
		id: "b",
		title: "B",
		cwd: TOP,
		canMessage: true,
		request: async (method, params) => {
			if (method === "checkout_status") return { files: [], stamps: [], pending: [], instance: "b" };
			if (method === "checkout_peers_set") {
				const peers = params as CheckoutPeers;
				this.bview = peers.worktree.some(peer => peer.id === "a" && peer.files?.includes(F) === true);
				if (this.bview) for (const call of this.writing()) this.shown.add(call.id);
			}
			return { ok: true };
		},
	};
	gitFails = false;
	during: Array<() => void> = [];
	readonly main = new CheckoutPeerCoordinator({
		members: () => [this.a, this.b],
		place: async () => ({ toplevel: TOP, commonDir: `${TOP}/.git` }),
		hiddenPaths: () => new Set(),
		gitStatus: async () => {
			for (const event of this.during.splice(0)) event();
			if (this.gitFails) throw new Error("git timed out");
			return this.dirty ? " M src/f.ts\0" : "";
		},
	});

	running(): Call[] {
		return [...this.calls.values()].filter(call => call.runs);
	}

	/** The running calls that write F. */
	writing(): Call[] {
		return this.running().filter(call => call.kind !== "commit");
	}

	/** A's bridge handles a retire main sent (`checkout_retire`). */
	retire(params: unknown): void {
		const held = this.book.files.includes(F);
		this.book.retireFrom(params);
		if (held && !this.book.files.includes(F)) this.released = true;
	}
}

/** The events that can happen now, each a label and its effect (main's pass is added by the driver). */
function events(world: World, pick: () => number): Array<[string, () => void]> {
	const found: Array<[string, () => void]> = [];
	const pending = [...world.calls.values()];
	for (const owner of OWNERS) {
		if (!pending.some(call => call.owner === owner) && world.nextId <= 40)
			found.push([
				`start ${owner}`,
				() => {
					const roll = pick();
					const call: Call = {
						id: `c${world.nextId++}`,
						owner,
						kind: roll < 0.4 ? "file" : roll < 0.8 ? "shell" : "commit",
						runs: pick() < 0.85,
						landed: false,
					};
					if (call.kind !== "commit") {
						if (world.book.files.includes(F)) call.takenOver = `${world.book.instance}\0${world.book.stamp(F)}`;
						for (const other of world.calls.values()) if (other.kind === "commit") other.writerSince = true;
					}
					world.calls.set(call.id, call);
					world.released = false;
					world.book.begin({
						owner,
						id: call.id,
						paths: call.kind === "commit" ? [] : [F],
						keepsOnError: call.kind !== "file",
						drops: call.kind === "commit" ? [F] : [],
						refresh: call.kind === "commit",
						extra: call.id,
					});
					world.log.push(`start ${call.id} ${owner} ${call.kind}${call.runs ? "" : " (refused)"}`);
				},
			]);
		const mine = pending.filter(call => call.owner === owner);
		if (mine.length > 0 && mine.every(call => !call.runs))
			found.push([
				`run end ${owner}`,
				() => {
					world.book.agentEnded(owner);
					for (const call of mine) world.calls.delete(call.id);
				},
			]);
	}
	for (const call of world.running()) {
		if (call.kind === "commit") {
			if (!call.landed && world.dirty)
				found.push([
					`${call.id} commits`,
					() => {
						call.landed = true;
						world.dirty = false;
						world.aWrote = false;
					},
				]);
		} else
			found.push([
				`land ${call.id}`,
				() => {
					call.landed = true;
					world.dirty = true;
					world.aWrote = true;
				},
			]);
		// A failed file tool wrote nothing; a commit succeeds only when it committed.
		const failed =
			call.kind === "commit" ? !call.landed : !call.landed || call.kind === "shell" ? pick() < 0.4 : false;
		found.push([
			`end ${call.id}${failed ? " failed" : ""}`,
			() => {
				world.book.end(call.owner, call.id, { isError: failed });
				world.calls.delete(call.id);
				if (call.kind === "commit" && !failed && !call.writerSince)
					for (const writer of world.calls.values()) if (writer.takenOver) world.cleaned.add(writer.takenOver);
			},
		]);
	}
	found.push([
		"restart",
		() => {
			const journal = world.book.snapshot();
			world.book = new ClaimBook<string>();
			world.book.restore(journal);
			world.calls.clear();
			world.late = [];
			world.released = false;
		},
	]);
	if (world.dirty)
		found.push([
			"commit",
			() => {
				world.dirty = false;
				world.aWrote = false;
			},
		]);
	else
		found.push([
			"B writes",
			() => {
				world.dirty = true;
			},
		]);
	if (world.late.length > 0)
		found.push([
			"late retire",
			() => {
				const retire = world.late.shift();
				if (retire) world.retire(retire);
			},
		]);
	return found;
}

function check(world: World, seed: number): void {
	const where = () => `seed ${seed}:\n  ${world.log.join("\n  ")}`;
	// I1: a write B was told is A's stays A's to B until that call reports back.
	for (const call of world.writing()) if (world.shown.has(call.id)) expect(world.bview, where()).toBe(true);
	// I2a: a write of A's that nobody committed is A's claim.
	if (world.aWrote) expect(world.book.files, where()).toContain(F);
	// I2b: a claim main released, with no call of A's since, is never shown as A's again.
	if (world.released) expect(world.bview, where()).toBe(false);
	// I2c: A's book holds no claim main or A's own commit judged committed, once no call writes F and a retire of it
	// was handled.
	const key = `${world.book.instance}\0${world.book.stamp(F)}`;
	if (world.book.files.includes(F) && (world.committed.has(key) || world.cleaned.has(key)) && world.calls.size === 0)
		expect(
			world.late.some(retire => retireKeys(retire).includes(key)),
			where(),
		).toBe(true);
	// I3: every call still running is pending in A's book, whichever agent's run ended.
	for (const call of world.running()) expect(world.book.extra(call.owner, call.id), where()).toBe(call.id);
}

async function run(seed: number, steps: number): Promise<void> {
	const pick = random(seed);
	const world = new World();
	const choose = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length)] as T;
	for (let step = 0; step < steps; step++) {
		if (pick() < 0.35) {
			world.answers = pick() < 0.8;
			world.gitFails = pick() < 0.2;
			world.retireAnswered = pick() < 0.7;
			const meanwhile = pick() < 0.4 ? events(world, pick) : [];
			const during = meanwhile.length > 0 ? choose(meanwhile) : undefined;
			world.log.push(
				`pass${world.answers ? "" : " (A busy)"}${world.gitFails ? " (git fails)" : ""}${world.retireAnswered ? "" : " (retire late)"}${during ? `, meanwhile ${during[0]}` : ""}`,
			);
			if (during) world.during.push(() => during[1]());
			await world.main.refresh();
			// A pass with no claim to ask git about never reached the moment: the event happens after it.
			for (const event of world.during.splice(0)) event();
		} else {
			const [label, effect] = choose(events(world, pick));
			if (!label.startsWith("start")) world.log.push(label);
			effect();
		}
		check(world, seed);
	}
}

describe("shared-checkout claims under generated sequences", () => {
	// 3000 sequences take about 3 s alone; the ceiling is for a loaded runner, nothing waits on it.
	it("hold the claim invariants in every sequence", { timeout: 60_000 }, async () => {
		for (let seed = 1; seed <= 3000; seed++) await run(seed, 60);
	});
});
