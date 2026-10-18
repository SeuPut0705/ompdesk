/**
 * The model catalog (the picker's list, the provider rows) and a session's model selection (the composer chip),
 * kept as snapshots (`lib/snapshot-cache.ts`, kind `models`) so the picker opens on its last list and the chip
 * names the model before the tab's omp has answered `get_state`. The live reads replace them in place; the
 * catalog generation is never restored, so a live read always wins the generation check.
 */
import type { ModelInfo, ProviderInfo } from "../../shared/rpc-types";
import type { ModelSelection, ModelStore } from "../stores/model";
import { snapshotNs, snapshots } from "./snapshot-cache";

export const MODEL_WRITE_DELAY_MS = 1500;

interface CatalogSnapshot {
	availableModels: ModelInfo[];
	providers: ProviderInfo[];
}

type SeedTarget = { getState(): ModelStore; setState(patch: Partial<ModelStore>): void };

const SELECTION_FIELDS = [
	"model",
	"thinkingLevel",
	"thinkingConfigured",
	"availableThinkingLevels",
	"fastModeEnabled",
	"fastModeActive",
	"ultrafastSupported",
	"ultrafastEnabled",
	"slowModeSupported",
	"slowModeEnabled",
	"slowModeScope",
] as const satisfies readonly (keyof ModelSelection)[];

const selectionKey = (sessionKey: string) => `sel:${sessionKey}`;

/** Paint the last catalog and (when the session is known) its last selection into a store nothing has filled. */
export function seedModelStore(store: SeedTarget, device: string | undefined, sessionKey: string | null): void {
	const state = store.getState();
	const ns = snapshotNs(device);
	if (state.availableModels.length === 0 && state.providers.length === 0) {
		const catalog = snapshots().read<CatalogSnapshot>("models", ns, "catalog")?.value;
		if (catalog && Array.isArray(catalog.availableModels))
			store.setState({
				availableModels: catalog.availableModels,
				providers: Array.isArray(catalog.providers) ? catalog.providers : [],
			});
	}
	if (state.model === null && sessionKey) {
		const selection = snapshots().read<Partial<ModelSelection>>("models", ns, selectionKey(sessionKey))?.value;
		if (selection && typeof selection === "object") store.setState(selection);
	}
}

export function writeModelSnapshot(device: string | undefined, sessionKey: string | null, state: ModelStore): void {
	const ns = snapshotNs(device);
	if (state.availableModels.length > 0)
		snapshots().write<CatalogSnapshot>("models", ns, "catalog", {
			availableModels: state.availableModels,
			providers: state.providers,
		});
	if (sessionKey && state.model) {
		const selection: Partial<ModelSelection> = {};
		for (const field of SELECTION_FIELDS) Object.assign(selection, { [field]: state[field] });
		snapshots().write("models", ns, selectionKey(sessionKey), selection);
	}
}
