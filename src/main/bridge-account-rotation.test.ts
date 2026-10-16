/**
 * gui-bridge account rotation (resources/gui-bridge/account-rotation-core.ts)
 * against a fake AuthStorage surface: quota mode leaves stock selection alone;
 * even mode pins each new session to the account handed out least recently,
 * skips blocked accounts, keeps a session on its account and never lets an
 * idle pin fall back to quota ranking.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	LEDGER_MAX_AGE_MS,
	parseLedger,
	planEvenRotation,
	type QuotaRerankAuth,
	type QuotaRerankStock,
	RERANK_DRAIN_MARGIN,
	type RotationAccount,
	type RotationAuth,
	type RotationBlock,
	type RotationLedger,
	type RotationStock,
	recordAssignment,
	rerankBeforePrompt,
	rotateBeforePrompt,
	setAccountRotation,
	withDrainMargin,
} from "../../resources/gui-bridge/account-rotation-core";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;

/** Stock's pieces for a provider with Claude's 60-minute warm window and one model-scoped block scope. */
const STOCK: RotationStock = {
	providerKey: provider => `${provider}:oauth`,
	blockScopes: (_provider, modelId) => ["", "auth", "account-policy", `model:${modelId}`],
	warmMs: () => HOUR,
	accountKey: (provider, account) => `${provider}/${account.email ?? account.credentialId}`,
};

interface Pin {
	sessionId: string;
	credentialId: number;
	restoredAtMs: number | undefined;
}

/** Two stored accounts; pins land in `pins` and become the session's active account, like stock affinity. */
function fakeAuth(stored = [7, 9], blocks: RotationBlock[] = []) {
	const pins: Pin[] = [];
	const sticky = new Map<string, { credentialId: number; lastUsedAtMs: number }>();
	const auth: RotationAuth = {
		oauth: {
			accounts: (_provider, sessionId) =>
				stored.map((credentialId): RotationAccount => {
					const pin = sessionId === undefined ? undefined : sticky.get(sessionId);
					const active = pin?.credentialId === credentialId;
					return {
						credentialId,
						email: `a${credentialId}@example.com`,
						active,
						...(active && pin ? { lastUsedAtMs: pin.lastUsedAtMs } : {}),
					};
				}),
		},
		sessions: {
			pin: (_provider, sessionId, credentialId, options) => {
				pins.push({ sessionId, credentialId, restoredAtMs: options?.restoredAtMs });
				sticky.set(sessionId, { credentialId, lastUsedAtMs: options?.restoredAtMs ?? NOW });
				return true;
			},
		},
		blocks: { list: ids => blocks.filter(block => ids.includes(block.credentialId)) },
	};
	/** Stock's own selection recorded `credentialId` for the session at `lastUsedAtMs`. */
	const served = (sessionId: string, credentialId: number, lastUsedAtMs: number) =>
		sticky.set(sessionId, { credentialId, lastUsedAtMs });
	return { auth, pins, served };
}

function memoryLedger(initial: RotationLedger = {}) {
	let ledger = initial;
	return {
		read: () => ledger,
		write: (text: string) => {
			ledger = parseLedger(text);
		},
		current: () => ledger,
	};
}

afterEach(() => {
	setAccountRotation({ mode: "quota" });
});

describe("gui-bridge account rotation", () => {
	it("does nothing in quota mode: stock usage ranking picks the account", () => {
		const { auth, pins } = fakeAuth();
		let asked = false;
		const step = rotateBeforePrompt(
			() => {
				asked = true;
				return { auth, provider: "anthropic", modelId: "m", sessionId: "s1" };
			},
			STOCK,
			memoryLedger(),
			NOW,
		);
		expect(step).toEqual({ pin: false });
		expect(asked).toBe(false);
		expect(pins).toEqual([]);
	});

	it("hands new sessions the accounts in turn in even mode, as automatic warm pins", () => {
		setAccountRotation({ mode: "even" });
		const { auth, pins } = fakeAuth();
		const ledger = memoryLedger();
		for (const [index, sessionId] of ["s1", "s2", "s3", "s4"].entries()) {
			rotateBeforePrompt(
				() => ({ auth, provider: "anthropic", modelId: "m", sessionId }),
				STOCK,
				ledger,
				NOW + index,
			);
		}
		expect(pins).toEqual([
			{ sessionId: "s1", credentialId: 7, restoredAtMs: NOW },
			{ sessionId: "s2", credentialId: 9, restoredAtMs: NOW + 1 },
			{ sessionId: "s3", credentialId: 7, restoredAtMs: NOW + 2 },
			{ sessionId: "s4", credentialId: 9, restoredAtMs: NOW + 3 },
		]);
		expect(ledger.current()).toEqual({ "anthropic/a7@example.com": NOW + 2, "anthropic/a9@example.com": NOW + 3 });
	});

	it("still takes turns when sessions start in the same millisecond", () => {
		setAccountRotation({ mode: "even" });
		const { auth, pins } = fakeAuth();
		const ledger = memoryLedger();
		for (const sessionId of ["s1", "s2", "s3", "s4"]) {
			rotateBeforePrompt(() => ({ auth, provider: "anthropic", modelId: "m", sessionId }), STOCK, ledger, NOW);
		}
		expect(pins.map(pin => pin.credentialId)).toEqual([7, 9, 7, 9]);
	});

	it("continues the turn another omp left in the shared ledger", () => {
		setAccountRotation({ mode: "even" });
		const { auth, pins } = fakeAuth();
		const ledger = memoryLedger({ "anthropic/a7@example.com": NOW - 10, "anthropic/a9@example.com": NOW - 20 });
		rotateBeforePrompt(() => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s1" }), STOCK, ledger, NOW);
		expect(pins.map(pin => pin.credentialId)).toEqual([9]);
	});

	it("skips an account blocked for this model until its block ends; other models' blocks don't count", () => {
		setAccountRotation({ mode: "even" });
		const blocks: RotationBlock[] = [
			{ credentialId: 7, providerKey: "anthropic:oauth", blockScope: "", blockedUntilMs: NOW + HOUR },
			{ credentialId: 9, providerKey: "anthropic:oauth", blockScope: "model:other", blockedUntilMs: NOW + HOUR },
		];
		const { auth, pins } = fakeAuth([7, 9], blocks);
		const ledger = memoryLedger();
		rotateBeforePrompt(() => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s1" }), STOCK, ledger, NOW);
		rotateBeforePrompt(
			() => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s2" }),
			STOCK,
			ledger,
			NOW + 1,
		);
		expect(pins.map(pin => pin.credentialId)).toEqual([9, 9]);
		// The block has run out by now: account 7 is back in turn.
		rotateBeforePrompt(
			() => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s3" }),
			STOCK,
			ledger,
			NOW + HOUR,
		);
		expect(pins.map(pin => pin.credentialId)).toEqual([9, 9, 7]);
	});

	it("keeps a session on its account, renews an idle pin there, and moves it only when the account is blocked", () => {
		setAccountRotation({ mode: "even" });
		const blocks: RotationBlock[] = [];
		const { auth, pins, served } = fakeAuth([7, 9], blocks);
		const ledger = memoryLedger();
		const prompt = () => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s1" });

		served("s1", 9, NOW - 5 * 60_000);
		expect(rotateBeforePrompt(prompt, STOCK, ledger, NOW)).toEqual({ pin: false });
		expect(pins).toEqual([]);

		// Idle past the warm window: stock would re-rank by quota; even mode keeps the account.
		served("s1", 9, NOW - 2 * HOUR);
		expect(rotateBeforePrompt(prompt, STOCK, ledger, NOW)).toEqual({ pin: true, credentialId: 9, kind: "renew" });
		expect(ledger.current()).toEqual({});

		blocks.push({ credentialId: 9, providerKey: "anthropic:oauth", blockScope: "auth", blockedUntilMs: NOW + HOUR });
		expect(rotateBeforePrompt(prompt, STOCK, ledger, NOW + 1)).toEqual({
			pin: true,
			credentialId: 7,
			kind: "assign",
		});
		expect(pins.map(pin => pin.credentialId)).toEqual([9, 7]);
	});

	it("leaves single-account providers, key overrides and fully blocked pools to stock", () => {
		setAccountRotation({ mode: "even" });
		const single = fakeAuth([7]);
		rotateBeforePrompt(
			() => ({ auth: single.auth, provider: "x", modelId: "m", sessionId: "s" }),
			STOCK,
			memoryLedger(),
			NOW,
		);
		const overridden = fakeAuth([]);
		rotateBeforePrompt(
			() => ({ auth: overridden.auth, provider: "x", modelId: "m", sessionId: "s" }),
			STOCK,
			memoryLedger(),
			NOW,
		);
		const blocked = fakeAuth(
			[7, 9],
			[7, 9].map(credentialId => ({
				credentialId,
				providerKey: "x:oauth",
				blockScope: "",
				blockedUntilMs: NOW + 1,
			})),
		);
		rotateBeforePrompt(
			() => ({ auth: blocked.auth, provider: "x", modelId: "m", sessionId: "s" }),
			STOCK,
			memoryLedger(),
			NOW,
		);
		expect([...single.pins, ...overridden.pins, ...blocked.pins]).toEqual([]);
	});

	it("follows stock's warm test: a pin without a last-use time, or a provider without a warm window, stays warm", () => {
		const active = { credentialId: 1, active: true, blocked: false };
		const other = { credentialId: 2, active: false, blocked: false };
		expect(planEvenRotation([active, other], NOW, HOUR)).toEqual({ pin: false });
		expect(planEvenRotation([{ ...active, lastUsedAtMs: 0 }, other], NOW, undefined)).toEqual({ pin: false });
		expect(planEvenRotation([{ ...active, lastUsedAtMs: NOW - HOUR }, other], NOW, HOUR)).toEqual({
			pin: true,
			credentialId: 1,
			kind: "renew",
		});
	});

	it("refuses a mode it doesn't know", () => {
		expect(() => setAccountRotation({ mode: "round-robin" })).toThrow(/account_rotation_set/);
		expect(() => setAccountRotation(null)).toThrow(/account_rotation_set/);
		expect(setAccountRotation({ mode: "even" })).toEqual({ mode: "even" });
	});

	it("reads a malformed ledger as empty and prunes month-old turns on write", () => {
		for (const text of [undefined, "", "{", "[]", '{"assigned":3}']) expect(parseLedger(text)).toEqual({});
		expect(parseLedger('{"version":1,"assigned":{"a":5,"b":"x"}}')).toEqual({ a: 5 });
		expect(parseLedger(recordAssignment({ old: NOW - LEDGER_MAX_AGE_MS, kept: NOW - 1 }, "new", NOW))).toEqual({
			kept: NOW - 1,
			new: NOW,
		});
	});
});

interface QuotaWorld {
	stored?: number[];
	/** The session's pin; `explicit` is a `/session pin`, absent is an automatic one. */
	pin?: { credentialId: number; explicit?: boolean; lastUsedAtMs?: number };
	/** Accounts a `sessions.restrict` pool leaves out. */
	outsidePool?: number[];
	/** Accounts (by id) with an `auth.accountPolicies` entry. */
	policies?: number[];
	blocks?: RotationBlock[];
	/** `sessions.inherit` never names the provider's pin (stock reports none). */
	provenanceHidden?: boolean;
	pinRefused?: boolean;
}

/** A fake AuthStorage for quota re-ranking: stock's `inherit` reports each pin's explicitness to `include` first. */
function quotaAuth(world: QuotaWorld = {}) {
	const stored = world.stored ?? [7, 9];
	const pins: Pin[] = [];
	const includeAnswers: boolean[] = [];
	const auth: QuotaRerankAuth = {
		oauth: {
			accounts: () =>
				stored.map(
					(credentialId): RotationAccount => ({
						credentialId,
						email: `a${credentialId}@example.com`,
						active: world.pin?.credentialId === credentialId,
						...(world.pin?.credentialId === credentialId
							? { lastUsedAtMs: world.pin.lastUsedAtMs ?? NOW - 5 * 60_000 }
							: {}),
					}),
				),
			policy: (_provider, identity) =>
				world.policies?.some(id => identity.email === `a${id}@example.com`) ? { reservePct: 10 } : undefined,
		},
		sessions: {
			pin: (_provider, sessionId, credentialId, options) => {
				if (world.pinRefused) return false;
				pins.push({ sessionId, credentialId, restoredAtMs: options?.restoredAtMs });
				return true;
			},
			permits: (_provider, _sessionId, credentialId) => !world.outsidePool?.includes(credentialId),
			inherit: (_source, _target, include) => {
				if (world.pin && !world.provenanceHidden) {
					includeAnswers.push(include?.("anthropic", world.pin.explicit === true) ?? true);
				}
				return 0;
			},
		},
		blocks: { list: ids => (world.blocks ?? []).filter(block => ids.includes(block.credentialId)) },
	};
	return { auth, pins, includeAnswers };
}

/** Stock's ranking, scripted: its pick, and whether it still ranks that pick first with the pin's drain handicapped. */
function quotaStock(top: number | undefined, clearly: boolean) {
	const asked = { top: 0, clearly: 0, margin: [] as Array<[number, number]> };
	const stock: QuotaRerankStock = {
		...STOCK,
		topChoice: async () => {
			asked.top += 1;
			return top;
		},
		clearlyBetter: async (_prompt, topId, pinId) => {
			asked.clearly += 1;
			asked.margin.push([topId, pinId]);
			return clearly;
		},
	};
	return { stock, asked };
}

const WARM_PIN = { credentialId: 7 };

describe("gui-bridge quota re-rank at turn start", () => {
	const rerank = (world: QuotaWorld, top: number | undefined, clearly: boolean) => {
		const { auth, pins, includeAnswers } = quotaAuth(world);
		const { stock, asked } = quotaStock(top, clearly);
		const step = rerankBeforePrompt(
			() => ({ auth, provider: "anthropic", modelId: "m", sessionId: "s1" }),
			stock,
			NOW,
		);
		return { step, pins, asked, includeAnswers };
	};

	it("moves a warm automatic pin to the account stock ranks first when it clearly beats the pin, as an automatic warm pin", async () => {
		const { step, pins, asked } = rerank({ pin: WARM_PIN }, 9, true);
		expect(await step).toEqual({ move: true, from: 7, to: 9 });
		// restoredAtMs: stock keeps treating it as an automatic pin (its eviction and failover rules still apply).
		expect(pins).toEqual([{ sessionId: "s1", credentialId: 9, restoredAtMs: NOW }]);
		expect(asked.margin).toEqual([[9, 7]]);
	});

	it("never touches an explicit pin, and never asks stock's ranking about it", async () => {
		const { step, pins, asked } = rerank({ pin: { credentialId: 7, explicit: true } }, 9, true);
		expect(await step).toEqual({ move: false, why: "explicit" });
		expect(pins).toEqual([]);
		expect(asked).toMatchObject({ top: 0, clearly: 0 });
	});

	it("reads the pin's explicitness without copying it anywhere", async () => {
		const { step, includeAnswers } = rerank({ pin: WARM_PIN }, 9, true);
		await step;
		// `include` answering false is what makes stock's `inherit` copy nothing.
		expect(includeAnswers).toEqual([false]);
	});

	it("stays when stock ranks the pin first, or ranks another first without beating the pin by the margin", async () => {
		const same = rerank({ pin: WARM_PIN }, 7, true);
		expect(await same.step).toEqual({ move: false, why: "same" });
		expect(same.asked.clearly).toBe(0);
		const within = rerank({ pin: WARM_PIN }, 9, false);
		expect(await within.step).toEqual({ move: false, why: "within-margin" });
		expect(within.pins).toEqual([]);
		const nothing = rerank({ pin: WARM_PIN }, undefined, true);
		expect(await nothing.step).toEqual({ move: false, why: "no-choice" });
	});

	it.each<[string, QuotaWorld, string]>([
		["no pin yet: stock ranks a new session itself", {}, "no-pin"],
		["a single stored account", { stored: [7], pin: WARM_PIN }, "single-account"],
		[
			"a cold pin: stock re-ranks it on the next key lookup",
			{ pin: { credentialId: 7, lastUsedAtMs: NOW - HOUR } },
			"cold",
		],
		[
			"a blocked pin: stock's selector already skips it",
			{
				pin: WARM_PIN,
				blocks: [{ credentialId: 7, providerKey: "anthropic:oauth", blockScope: "", blockedUntilMs: NOW + HOUR }],
			},
			"blocked",
		],
		["a session restricted to an account pool", { pin: WARM_PIN, outsidePool: [9] }, "restricted"],
		["accounts with a stock account policy", { pin: WARM_PIN, policies: [9] }, "policy"],
		["a pin stock reports no provenance for", { pin: WARM_PIN, provenanceHidden: true }, "unknown-provenance"],
	])("leaves %s to stock", async (_name, world, why) => {
		const { step, pins, asked } = rerank(world, 9, true);
		expect(await step).toEqual({ move: false, why });
		expect(pins).toEqual([]);
		// Every check that can be answered locally is answered before stock's usage fetch is paid for.
		expect(asked).toMatchObject({ top: 0, clearly: 0 });
	});

	it("ignores a block that applies to another model's scope, and an expired one", async () => {
		const blocks: RotationBlock[] = [
			{ credentialId: 7, providerKey: "anthropic:oauth", blockScope: "tier:other", blockedUntilMs: NOW + HOUR },
			{ credentialId: 7, providerKey: "anthropic:oauth", blockScope: "", blockedUntilMs: NOW - 1 },
		];
		expect((await rerank({ pin: WARM_PIN, blocks }, 9, true).step).move).toBe(true);
	});

	it("reports a refused pin as a stay", async () => {
		const { step } = rerank({ pin: WARM_PIN, pinRefused: true }, 9, true);
		expect(await step).toEqual({ move: false, why: "pin-refused" });
	});

	it("does nothing in even mode and never asks for the prompt", async () => {
		setAccountRotation({ mode: "even" });
		let asked = false;
		const { stock } = quotaStock(9, true);
		const step = await rerankBeforePrompt(
			() => {
				asked = true;
				return undefined;
			},
			stock,
			NOW,
		);
		expect(step).toEqual({ move: false, why: "mode" });
		expect(asked).toBe(false);
	});

	it("stays without a model", async () => {
		const { stock } = quotaStock(9, true);
		expect(await rerankBeforePrompt(() => undefined, stock, NOW)).toEqual({ move: false, why: "no-model" });
	});

	it("multiplies only the measured windows' drain by the margin, leaving every other metric as stock scored it", () => {
		const row = { primaryRequiredDrain: 0.5, secondaryRequiredDrain: 0.01, primaryUsed: 0.9, hasPriorityBoost: true };
		expect(RERANK_DRAIN_MARGIN).toBe(2);
		expect(withDrainMargin(row, { primary: true, secondary: true })).toEqual({
			...row,
			primaryRequiredDrain: 1,
			secondaryRequiredDrain: 0.02,
		});
		expect(withDrainMargin(row, { primary: false, secondary: true }, 3)).toEqual({
			...row,
			secondaryRequiredDrain: 0.03,
		});
		expect(withDrainMargin(row, { primary: false, secondary: false })).toEqual(row);
		// A copy: the candidate stock's ranking returns for the other account is never rewritten.
		expect(row.secondaryRequiredDrain).toBe(0.01);
	});
});
