/**
 * Per-model compaction limits (`compaction.modelThresholds`, omp 18.8.5+).
 *
 * Input rules mirror stock's `parseCompactionPointInput` /
 * `formatCompactionPointInput` and the key check in `validateModelCompactionThresholds`
 * (config/compaction-threshold.ts), so what the editor accepts is what stock
 * persists and reads back; stock re-validates every write (`assertWritable`).
 * Where each model compacts is never computed here: `useCompactionPoints`
 * reads it from stock's own resolver through the bridge (`get_compaction_points`).
 */

import { useEffect, useState } from "react";
import { z } from "zod";
import type { CompactionPoint, CompactionPointsResult } from "../../shared/rpc-types";
import { useSessionStore } from "../stores/session";
import { formatTokens } from "./format";
import { useTabRpc } from "./tab-rpc";

export const MODEL_THRESHOLDS_PATH = "compaction.modelThresholds";

/** A persisted entry: a positive token count, or a percentage string like `"80%"`. */
export type CompactionLimit = number | string;

const PERCENT_PATTERN = /^(\d+(?:\.\d+)?)%$/;
const TOKEN_INPUT_PATTERN = /^(\d+)([kmb])?$/i;
const TOKEN_SUFFIX_SCALE: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

export type CompactionLimitError = "percent" | "invalid";

/** A persistable entry stock accepts (positive safe integer, or a percentage in (0, 100]). */
export function isCompactionLimit(entry: unknown): entry is CompactionLimit {
	if (typeof entry === "number") return Number.isSafeInteger(entry) && entry > 0;
	if (typeof entry !== "string") return false;
	const match = PERCENT_PATTERN.exec(entry.trim());
	const percent = match ? Number(match[1]) : Number.NaN;
	return percent > 0 && percent <= 100;
}

/** Typed text (`90000`, `90k`, `1m`, `80%`) → the entry stock persists; empty text is not a limit. */
export function parseCompactionLimit(
	input: string,
): { ok: true; value: CompactionLimit } | { ok: false; error: CompactionLimitError } {
	const text = input.trim();
	if (text.endsWith("%")) return isCompactionLimit(text) ? { ok: true, value: text } : { ok: false, error: "percent" };
	const match = TOKEN_INPUT_PATTERN.exec(text);
	if (match) {
		const scale = match[2] ? TOKEN_SUFFIX_SCALE[match[2].toLowerCase()] : 1;
		const tokens = Number(match[1]) * scale;
		if (isCompactionLimit(tokens)) return { ok: true, value: tokens };
	}
	return { ok: false, error: "invalid" };
}

/** An entry as the text stock's `/models` hub prefills: `90k`, `1500k`, `123456`, `80%`. */
export function formatCompactionLimit(entry: CompactionLimit): string {
	if (typeof entry === "string") return entry.trim();
	for (const suffix of ["b", "m", "k"]) {
		const scale = TOKEN_SUFFIX_SCALE[suffix];
		if (entry % scale === 0) return `${entry / scale}${suffix}`;
	}
	return String(entry);
}

export type ModelSelectorError = "star" | "shape";

/** Keys are an exact `provider/model-id` or a `*`-terminated prefix of one (`openai/*`). */
export function modelSelectorError(key: string): ModelSelectorError | null {
	const star = key.indexOf("*");
	if (star !== -1 && star !== key.length - 1) return "star";
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return "shape";
	return null;
}

/** `compaction.modelThresholds` entries a layer sets (null clears an inherited entry, so it lists nothing). */
export function compactionLimitEntries(value: unknown): Array<[string, CompactionLimit]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return Object.entries(value)
		.filter((entry): entry is [string, CompactionLimit] => isCompactionLimit(entry[1]))
		.sort(([a], [b]) => a.localeCompare(b));
}

/** "Compacts at" text: `160.0k · 80%`, `90.0k`, or null when auto-compaction is off for the model. */
export function compactionPointValue(point: CompactionPoint): string | null {
	if (point.tokens === undefined) return null;
	return point.percent !== undefined
		? `${formatTokens(point.tokens)} · ${point.percent}%`
		: formatTokens(point.tokens);
}

const pointSchema = z.object({
	tokens: z.number().optional(),
	percent: z.number().optional(),
	source: z.string(),
	draft: z.string().optional(),
});

const pointsSchema = z.object({
	models: z.array(z.object({ selector: z.string(), point: pointSchema })),
	roles: z.array(z.object({ role: z.string(), selector: z.string(), autoSelected: z.boolean(), point: pointSchema })),
});

const settingsValuesSchema = z.object({ values: z.record(z.unknown()) });

export interface CompactionPoints {
	bySelector: ReadonlyMap<string, CompactionPoint>;
	byRole: ReadonlyMap<string, CompactionPointsResult["roles"][number]>;
}

/**
 * Where each available model and each role's model compacts, from stock's
 * resolver; re-read on config_update. Null while unknown, and always on an omp
 * whose live settings lack `compaction.modelThresholds` (before 18.8.5):
 * callers then show nothing.
 */
export function useCompactionPoints(active = true): CompactionPoints | null {
	const tabRpc = useTabRpc();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const [points, setPoints] = useState<CompactionPoints | null>(null);

	useEffect(() => {
		if (!active || !sidecarReady) return undefined;
		let version = 0;
		const load = async () => {
			const current = ++version;
			try {
				const settings = await tabRpc.getSettings([MODEL_THRESHOLDS_PATH]);
				const values = settings.success ? settingsValuesSchema.safeParse(settings.data) : undefined;
				if (current !== version) return;
				if (!values?.success || !Object.hasOwn(values.data.values, MODEL_THRESHOLDS_PATH)) {
					setPoints(null);
					return;
				}
				const res = await tabRpc.getCompactionPoints();
				if (current !== version) return;
				const parsed = res.success ? pointsSchema.safeParse(res.data) : undefined;
				if (!parsed?.success) return;
				setPoints({
					bySelector: new Map(parsed.data.models.map(entry => [entry.selector, entry.point])),
					byRole: new Map(parsed.data.roles.map(entry => [entry.role, entry])),
				});
			} catch {
				// Display-only: the last points (or none) stay; the next config_update retries.
			}
		};
		void load();
		const unsubscribe = window.omp.events.onConfigUpdate(() => void load());
		return () => {
			version++;
			unsubscribe();
		};
	}, [active, sidecarReady, tabRpc]);

	return points;
}
