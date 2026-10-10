/**
 * Per-model compaction limits (`compaction.modelThresholds`, omp 18.8.5+).
 *
 * Stock parses, validates and formats committed limits through the bridge.
 * Text drafts stay synchronous; no persisted compaction grammar lives here.
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

export const compactionLimitsSchema = z.object({
	rows: z.array(z.object({ key: z.string(), value: z.union([z.number(), z.string()]), text: z.string() })),
});

export const compactionLimitCommitSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), value: z.union([z.number(), z.string()]) }),
	z.object({
		ok: z.literal(false),
		modelError: z.enum(["empty", "star", "shape"]).optional(),
		limitError: z.enum(["percent", "invalid"]).optional(),
	}),
]);

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
