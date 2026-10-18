import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo } from "../../shared/rpc-types";
import { createModelStore } from "../stores/model";
import { seedModelStore, writeModelSnapshot } from "./model-snapshot";
import { resetSnapshotsForTest } from "./snapshot-cache";

class Memory {
	readonly map = new Map<string, string>();
	get length() {
		return this.map.size;
	}
	key(i: number) {
		return [...this.map.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.map.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.map.set(k, v);
	}
	removeItem(k: string) {
		this.map.delete(k);
	}
}

const model = (id: string): ModelInfo => ({ id, name: id, provider: "p" }) as ModelInfo;

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Memory() });
	resetSnapshotsForTest();
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, "localStorage");
	resetSnapshotsForTest();
});

describe("model snapshot", () => {
	it("seeds an empty store with the last catalog and the session's last selection, never the catalog generation", () => {
		const live = createModelStore();
		live.setState({ availableModels: [model("a"), model("b")], model: model("a"), catalogGeneration: 7 });
		writeModelSnapshot(undefined, "path:/s.jsonl", live.getState());
		const next = createModelStore();
		seedModelStore(next, undefined, "path:/s.jsonl");
		expect(next.getState().availableModels.map(m => m.id)).toEqual(["a", "b"]);
		expect(next.getState().model?.id).toBe("a");
		expect(next.getState().catalogGeneration).toBe(0);
	});

	it("keeps selections per session and catalogs per host", () => {
		const live = createModelStore();
		live.setState({ availableModels: [model("a")], model: model("a") });
		writeModelSnapshot(undefined, "path:/one", live.getState());
		live.setState({ model: model("b") });
		writeModelSnapshot("dev-1", "path:/two", live.getState());
		const local = createModelStore();
		seedModelStore(local, undefined, "path:/two");
		expect(local.getState().model).toBeNull();
		expect(local.getState().availableModels.map(m => m.id)).toEqual(["a"]);
		const host = createModelStore();
		seedModelStore(host, "dev-1", "path:/two");
		expect(host.getState().model?.id).toBe("b");
		const other = createModelStore();
		seedModelStore(other, "dev-2", "path:/two");
		expect(other.getState().availableModels).toEqual([]);
	});

	it("does not overwrite what a store already shows", () => {
		const live = createModelStore();
		live.setState({ availableModels: [model("a")], model: model("a") });
		writeModelSnapshot(undefined, "path:/s", live.getState());
		const shown = createModelStore();
		shown.setState({ availableModels: [model("z")], model: model("z") });
		seedModelStore(shown, undefined, "path:/s");
		expect(shown.getState().availableModels.map(m => m.id)).toEqual(["z"]);
		expect(shown.getState().model?.id).toBe("z");
	});
});
