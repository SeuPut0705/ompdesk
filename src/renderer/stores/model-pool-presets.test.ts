/**
 * Model-pool presets: hydrate from the "modelPool" prefs blob (untrusted),
 * save/replace/delete persist the whole list, and a rejected write rolls the
 * optimistic change back with a toast.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { translate } from "../lib/i18n";
import { MODEL_POOL_PREFS_KEY, normalizePresets, useModelPoolPresets } from "./model-pool-presets";
import { useToastStore } from "./toast";

const get = vi.fn(async (_key: string) => null as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

const haiku = { selector: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", role: "explore" };
const gpt = { selector: "openai/gpt-5.2", name: "GPT-5.2", role: "reasoning" };

afterEach(() => {
	get.mockReset();
	set.mockReset();
	useModelPoolPresets.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("normalizePresets", () => {
	it("keeps well-formed presets with deduplicated, defaulted members", () => {
		expect(
			normalizePresets([
				{ id: "a", name: " Cheap + smart ", members: [haiku, haiku, { selector: "bad" }, { selector: "x/y" }] },
				{ id: "", name: "no id", members: [haiku] },
				{ id: "b", name: "empty", members: [] },
				"junk",
			]),
		).toEqual([
			{ id: "a", name: "Cheap + smart", members: [haiku, { selector: "x/y", name: "x/y", role: "general" }] },
		]);
		expect(normalizePresets(undefined)).toEqual([]);
	});
});

describe("model-pool presets store", () => {
	it("hydrates once from prefs", async () => {
		get.mockResolvedValueOnce({ presets: [{ id: "a", name: "Duo", members: [haiku, gpt] }] });
		await useModelPoolPresets.getState().hydrate();
		await useModelPoolPresets.getState().hydrate();
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith(MODEL_POOL_PREFS_KEY);
		expect(useModelPoolPresets.getState().presets).toEqual([{ id: "a", name: "Duo", members: [haiku, gpt] }]);
	});

	it("saves, replaces by name, and deletes — persisting the whole list each time", async () => {
		await useModelPoolPresets.getState().savePreset("  Duo ", [haiku, gpt]);
		const [saved] = useModelPoolPresets.getState().presets;
		expect(saved).toMatchObject({ name: "Duo", members: [haiku, gpt] });
		expect(set).toHaveBeenLastCalledWith(MODEL_POOL_PREFS_KEY, { presets: [saved] });

		await useModelPoolPresets.getState().savePreset("Duo", [gpt]);
		expect(useModelPoolPresets.getState().presets).toEqual([{ id: saved.id, name: "Duo", members: [gpt] }]);

		await useModelPoolPresets.getState().deletePreset(saved.id);
		expect(useModelPoolPresets.getState().presets).toEqual([]);
		expect(set).toHaveBeenLastCalledWith(MODEL_POOL_PREFS_KEY, { presets: [] });
	});

	it("ignores blank names and empty pools", async () => {
		await useModelPoolPresets.getState().savePreset("   ", [haiku]);
		await useModelPoolPresets.getState().savePreset("Empty", []);
		expect(set).not.toHaveBeenCalled();
		expect(useModelPoolPresets.getState().presets).toEqual([]);
	});

	it("rolls back and toasts when the prefs write fails", async () => {
		set.mockRejectedValueOnce(new Error("disk full"));
		await useModelPoolPresets.getState().savePreset("Duo", [haiku, gpt]);
		expect(useModelPoolPresets.getState().presets).toEqual([]);
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			title: translate("modelPool.presetSaveFailed"),
			message: "disk full",
		});
	});
});
