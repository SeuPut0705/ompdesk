import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderInput } from "../shared/ipc-types";
import { LOCAL_ENGINES, type LocalEngineSpec, type LocalEnginesLedger } from "../shared/local-engines";
import { LocalEngineDetector, localEngineSettings, probeLocalEngine } from "./local-engines";

const FREETOKEN: LocalEngineSpec = { id: "freetoken", name: "FreeToken", baseUrl: "http://127.0.0.1:1919/v1" };
const COLIBRI: LocalEngineSpec = { id: "colibri", name: "colibri", baseUrl: "http://127.0.0.1:8000/v1" };
const INTERVAL = 60_000;

interface Gate {
	release(): void;
	promise: Promise<void>;
}
function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { release: resolve, promise };
}
function rig() {
	const world = {
		up: new Set<string>(),
		file: new Set<string>(),
		ledger: { registered: [], removed: [] } as LocalEnginesLedger,
		enabled: true,
		probes: 0,
		changed: 0,
		upserts: [] as CustomProviderInput[],
		deletes: [] as string[],
		failures: [] as unknown[],
		hold: null as Gate | null,
		deleteFails: 0,
	};
	const engines = [FREETOKEN, COLIBRI];
	const detector = new LocalEngineDetector({
		engines,
		ledger: {
			get: () => structuredClone(world.ledger),
			set: value => {
				world.ledger = structuredClone(value);
			},
		},
		enabled: () => world.enabled,
		probe: async baseUrl => {
			world.probes++;
			const id = engines.find(engine => engine.baseUrl === baseUrl)?.id ?? "";
			const answer = world.up.has(id);
			await world.hold?.promise;
			return answer;
		},
		providers: {
			ids: async () => new Set(world.file),
			upsert: async input => {
				world.upserts.push(input);
				world.file.add(input.id);
			},
			delete: async id => {
				if (world.deleteFails > 0) {
					world.deleteFails--;
					throw new Error("disk full");
				}
				world.deletes.push(id);
				world.file.delete(id);
			},
		},
		changed: () => void world.changed++,
		failed: error => void world.failures.push(error),
		intervalMs: INTERVAL,
	});
	return { world, detector };
}

describe("localEngineSettings", () => {
	const table = JSON.stringify([{ id: "fake", name: "Fake", baseUrl: "http://127.0.0.1:5555/v1" }]);

	it("takes a test table and pause from the environment on an unpackaged launch", () => {
		expect(
			localEngineSettings(
				{ OMP_GUI_TEST_LOCAL_ENGINES: table, OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: "250" },
				false,
			),
		).toEqual({ engines: JSON.parse(table), intervalMs: 250 });
	});

	it("keeps the real table and pause for a packaged app, a bad table and a bad pause", () => {
		const real = { engines: LOCAL_ENGINES, intervalMs: 60_000 };
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: table }, true)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: '[{"id":1}]' }, false)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: "nope" }, false)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: "0" }, false)).toEqual(real);
		expect(localEngineSettings({}, false)).toEqual(real);
	});
});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("LocalEngineDetector", () => {
	it("registers an engine that answers as a discovery-only provider and tells the windows once", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		expect(world.upserts).toEqual([
			{
				id: "freetoken",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1919/v1",
				auth: "none",
				discovery: { type: "openai-models-list" },
				models: [],
			},
		]);
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		expect(world.changed).toBe(1);
		// Nothing changed in the next pass: no second write, no second push.
		await detector.tick();
		expect(world.upserts).toHaveLength(1);
		expect(world.changed).toBe(1);
	});

	it("unregisters an entry when its engine stops answering, and registers it again when it returns", async () => {
		const { world, detector } = rig();
		world.up.add("colibri");
		await detector.tick();
		world.up.delete("colibri");
		await detector.tick();
		expect(world.file.has("colibri")).toBe(false);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
		expect(world.changed).toBe(2);
		world.up.add("colibri");
		await detector.tick();
		expect(world.file.has("colibri")).toBe(true);
		expect(world.changed).toBe(3);
	});

	it("never makes an entry again that the person deleted, while the engine keeps answering", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.file.delete("freetoken");
		await detector.tick();
		expect(world.ledger).toEqual({ registered: [], removed: ["freetoken"] });
		await detector.tick();
		await detector.tick();
		expect(world.upserts).toHaveLength(1);
		// The tombstone changed nothing in models.yml, so it pushed nothing.
		expect(world.changed).toBe(1);
	});

	it("leaves an entry of the same id that the person made alone, up or down", async () => {
		const { world, detector } = rig();
		world.file.add("freetoken");
		world.up.add("freetoken");
		await detector.tick();
		world.up.clear();
		await detector.tick();
		expect(world.file.has("freetoken")).toBe(true);
		expect(world.upserts).toEqual([]);
		expect(world.deletes).toEqual([]);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
		expect(world.changed).toBe(0);
	});

	it("turning the switch off removes every entry it wrote, and none of the person's", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken").add("colibri");
		await detector.tick();
		expect(world.file).toEqual(new Set(["freetoken", "colibri"]));
		world.file.delete("colibri");
		await detector.tick();
		world.enabled = false;
		await detector.setEnabled(false);
		expect(world.file.size).toBe(0);
		expect(world.ledger.registered).toEqual([]);
		// The tombstone survives while off; a pass while off does nothing at all.
		const before = world.probes;
		await detector.tick();
		expect(world.probes).toBe(before);
	});

	it("turning the switch on again registers at once and keeps what the person deleted", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.up.add("colibri");
		await detector.tick();
		world.file.delete("freetoken");
		await detector.tick();
		expect(world.ledger.removed).toEqual(["freetoken"]);
		world.enabled = false;
		await detector.setEnabled(false);
		expect(world.file.size).toBe(0);
		world.enabled = true;
		await detector.setEnabled(true);
		expect(world.ledger).toEqual({ registered: ["colibri"], removed: ["freetoken"] });
		expect(world.file.has("colibri")).toBe(true);
		expect(world.file.has("freetoken")).toBe(false);
	});

	it("a pass that began before the switch went off writes nothing", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.hold = gate();
		const pass = detector.tick();
		await vi.advanceTimersByTimeAsync(0);
		world.enabled = false;
		const off = detector.setEnabled(false);
		world.hold.release();
		await Promise.all([pass, off]);
		expect(world.upserts).toEqual([]);
		expect(world.file.size).toBe(0);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
	});

	it("runs one pass for any number of callers at once", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.hold = gate();
		const calls = [detector.tick(), detector.tick(), detector.tick()];
		await vi.advanceTimersByTimeAsync(0);
		world.hold.release();
		await Promise.all(calls);
		expect(world.probes).toBe(2);
		expect(world.upserts).toHaveLength(1);
		await detector.tick();
		expect(world.probes).toBe(4);
	});

	it("starts with a pass, then waits the interval after each pass ends", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(world.probes).toBe(2);
		await vi.advanceTimersByTimeAsync(INTERVAL - 1);
		expect(world.probes).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(world.probes).toBe(4);
		world.up.clear();
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.file.size).toBe(0);
	});

	it("does not stack a pass on one still running when the interval elapses", async () => {
		const { world, detector } = rig();
		world.hold = gate();
		detector.start();
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		expect(world.probes).toBe(2);
		world.hold.release();
		await vi.advanceTimersByTimeAsync(0);
		world.hold = null;
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.probes).toBe(4);
	});

	it("stops the timer while off and restarts it when turned on", async () => {
		const { world, detector } = rig();
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		world.enabled = false;
		await detector.setEnabled(false);
		const before = world.probes;
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		expect(world.probes).toBe(before);
		world.enabled = true;
		await detector.setEnabled(true);
		expect(world.probes).toBe(before + 2);
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.probes).toBe(before + 4);
	});

	it("does nothing after dispose, not even a timer already waiting", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		const probes = world.probes;
		detector.dispose();
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		await detector.tick();
		expect(world.probes).toBe(probes);
	});

	it("keeps an entry whose removal failed, owned, and removes it on the next pass", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.up.clear();
		world.deleteFails = 1;
		await detector.tick();
		expect(world.failures).toHaveLength(1);
		expect(world.file.has("freetoken")).toBe(true);
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		await detector.tick();
		expect(world.file.has("freetoken")).toBe(false);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
	});

	it("reads an unreadable models.yml as no decision, not as every entry gone", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		const broken = new LocalEngineDetector({
			engines: [FREETOKEN],
			ledger: {
				get: () => structuredClone(world.ledger),
				set: value => {
					world.ledger = structuredClone(value);
				},
			},
			enabled: () => true,
			probe: async () => true,
			providers: {
				ids: async () => {
					throw new Error("invalid YAML");
				},
				upsert: async () => {},
				delete: async () => {},
			},
			changed: () => void world.changed++,
			failed: error => void world.failures.push(error),
			intervalMs: INTERVAL,
		});
		await broken.tick();
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		expect(world.failures).toHaveLength(1);
	});
});

describe("probeLocalEngine", () => {
	const answer = (body: unknown, ok = true) =>
		vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

	it("is up for an OpenAI-style model list on loopback", async () => {
		const fetchImpl = answer({ data: [{ id: "m" }] });
		await expect(probeLocalEngine("http://127.0.0.1:1919/v1", fetchImpl)).resolves.toBe(true);
		expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toBe(
			"http://127.0.0.1:1919/v1/models",
		);
	});

	it("is down for an error status, a body without a data array, a thrown fetch, or invalid JSON", async () => {
		await expect(probeLocalEngine("http://127.0.0.1:1/v1", answer({ data: [] }, false))).resolves.toBe(false);
		await expect(probeLocalEngine("http://127.0.0.1:1/v1", answer({ data: "x" }))).resolves.toBe(false);
		await expect(probeLocalEngine("http://127.0.0.1:1/v1", answer(null))).resolves.toBe(false);
		const throws = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		await expect(probeLocalEngine("http://127.0.0.1:1/v1", throws)).resolves.toBe(false);
		const badJson = vi.fn(async () => ({
			ok: true,
			json: async () => {
				throw new SyntaxError("bad");
			},
		})) as unknown as typeof fetch;
		await expect(probeLocalEngine("http://127.0.0.1:1/v1", badJson)).resolves.toBe(false);
	});

	it("never asks an address off loopback", async () => {
		const fetchImpl = answer({ data: [] });
		await expect(probeLocalEngine("http://192.168.1.5:8000/v1", fetchImpl)).resolves.toBe(false);
		await expect(probeLocalEngine("https://127.0.0.1:8000/v1", fetchImpl)).resolves.toBe(false);
		await expect(probeLocalEngine("http://example.com/v1", fetchImpl)).resolves.toBe(false);
		await expect(probeLocalEngine("not a url", fetchImpl)).resolves.toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
