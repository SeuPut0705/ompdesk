/**
 * models.dev's catalog.json explicitly maps OpenRouter ids to model-only release dates.
 * The provider row's date is not used: its sync may derive it from OpenRouter.created (listing time).
 * Stock's fetchWellKnownModels cache is field-pruned and carries no release dates.
 * Source semantics: https://github.com/anomalyco/models.dev#api-reference
 */
import type { ModelReleaseDatesResult } from "../shared/rpc-types";

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 5 * 60 * 1_000;
const TIMEOUT_MS = 5_000;

let dates = new Map<string, number>();
let expiresAt = 0;
let inFlight: Promise<Map<string, number>> | undefined;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDates(payload: unknown): Map<string, number> {
	if (
		!record(payload) ||
		!record(payload.providers) ||
		!record(payload.providers.openrouter) ||
		!record(payload.providers.openrouter.models) ||
		!record(payload.models)
	) {
		throw new Error("Invalid models.dev catalog");
	}
	const result = new Map<string, number>();
	for (const [id, providerRow] of Object.entries(payload.providers.openrouter.models)) {
		if (!record(providerRow) || providerRow.id !== id || typeof providerRow.canonical_model_id !== "string") continue;
		const canonicalId = providerRow.canonical_model_id;
		if (!Object.hasOwn(payload.models, canonicalId)) continue;
		const row = payload.models[canonicalId];
		if (!record(row) || row.id !== canonicalId || typeof row.release_date !== "string") continue;
		const date = row.release_date;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
		const timestamp = Date.parse(`${date}T00:00:00.000Z`);
		if (Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date) {
			result.set(id, timestamp);
		}
	}
	return result;
}

function releaseDates(): Promise<Map<string, number>> {
	if (Date.now() < expiresAt) return Promise.resolve(dates);
	if (inFlight) return inFlight;
	inFlight = (async () => {
		try {
			const response = await fetch("https://models.dev/catalog.json", { signal: AbortSignal.timeout(TIMEOUT_MS) });
			if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
			dates = parseDates(await response.json());
			expiresAt = Date.now() + SUCCESS_TTL_MS;
		} catch {
			expiresAt = Date.now() + FAILURE_TTL_MS;
		}
		return dates;
	})().finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

export async function getModelReleaseDates(): Promise<ModelReleaseDatesResult> {
	return { dates: Object.fromEntries(await releaseDates()) };
}
