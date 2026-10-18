import { create } from "zustand";
import type { RpcPrDetail, RpcPrListItem, RpcPrListView, RpcPrRepo } from "../../shared/rpc-types";
import type { FocusedScope } from "../lib/focused-scope";
import { translate } from "../lib/i18n";
import { lastRead, rememberRead } from "../lib/last-read";
import { useTabsStore } from "./tabs";
import { toast, toastError } from "./toast";

/**
 * PR Center store (plan/21): repo probe → list → detail → per-file lazy
 * diffs, plus the create/checkout actions. One store per window (the panel
 * is a singleton); everything re-probes on repo/cwd change at open time.
 */
interface PrCenterStore {
	/** Whose PRs these are (the focused tab's host and folder): the key of every last-read snapshot below. */
	scope: FocusedScope;
	repo: RpcPrRepo | null;
	listState: "open" | "closed" | "merged" | "all";
	/** Every PR, those waiting on your review, or yours. */
	listView: RpcPrListView;
	list: RpcPrListItem[];
	listLoading: boolean;
	selected: number | null;
	detail: RpcPrDetail | null;
	detailLoading: boolean;
	/** Expanded file paths and their diff state. */
	expandedFiles: Record<string, { phase: "loading" } | { phase: "ready"; diff: string } | { phase: "error" }>;
	error: string | null;

	/**
	 * The panel opens on `scope`: what it showed last time (repo, list) is the state at once, the probe reads again
	 * in place. A different scope never inherits another repository's rows.
	 */
	enter: (scope: FocusedScope) => void;
	probe: () => Promise<void>;
	refresh: () => Promise<void>;
	setListState: (state: "open" | "closed" | "merged" | "all") => void;
	setListView: (view: RpcPrListView) => void;
	/** Re-read the selected PR and the list after an action changed it (merge, review, edit). */
	reloadSelected: () => Promise<void>;
	select: (number: number) => Promise<void>;
	/** Close the selected PR's detail (a phone's back from the detail). */
	deselect: () => void;
	toggleFile: (path: string) => Promise<void>;
	checkout: (number: number) => Promise<void>;
	reset: () => void;
}

const NO_SCOPE: FocusedScope = { device: undefined, cwd: "" };

/** The snapshot keys of one repository (the folder names it); a diff or a log is only remembered in memory. */
const repoKey = (scope: FocusedScope) => `pr:repo:${scope.cwd}`;
const listKey = (scope: FocusedScope, state: string, view: string) => `pr:list:${scope.cwd}:${state}:${view}`;
const detailKey = (scope: FocusedScope, number: number) => `pr:detail:${scope.cwd}:${number}`;
const diffKey = (scope: FocusedScope, number: number, path: string) => `pr:diff:${scope.cwd}:${number}:${path}`;

const initialState = {
	scope: NO_SCOPE,
	repo: null,
	listState: "open" as const,
	listView: "all" as const,
	list: [],
	listLoading: false,
	selected: null,
	detail: null,
	detailLoading: false,
	expandedFiles: {},
	error: null,
};

export const usePrCenterStore = create<PrCenterStore>()((set, get) => ({
	...initialState,

	enter: scope => {
		const current = get().scope;
		if (current.device === scope.device && current.cwd === scope.cwd) return;
		const { listState, listView } = get();
		set({
			scope,
			repo: lastRead<RpcPrRepo>(scope.device, repoKey(scope)) ?? null,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, listState, listView)) ?? [],
			selected: null,
			detail: null,
			detailLoading: false,
			expandedFiles: {},
			error: null,
		});
	},

	probe: async () => {
		set({ error: null });
		const scope = get().scope;
		try {
			const response = await window.omp.rpc.prRepo();
			if (!response.success) {
				set({ repo: null, error: response.error });
				return;
			}
			const repo = response.data as RpcPrRepo;
			if (get().scope !== scope) return;
			set({ repo });
			if (repo.available) rememberRead(scope.device, repoKey(scope), repo);
			if (repo.available) await get().refresh();
		} catch (error) {
			set({ repo: null, error: String(error) });
		}
	},

	refresh: async () => {
		if (get().listLoading) return;
		set({ listLoading: true, error: null });
		const { scope, listState, listView } = get();
		try {
			const response = await window.omp.rpc.prList(listState, 50, listView);
			if (!response.success) {
				set({ error: response.error, listLoading: false });
				return;
			}
			const list = response.data as RpcPrListItem[];
			rememberRead(scope.device, listKey(scope, listState, listView), list);
			// Only if the person still looks at this list (another filter or repository seeded its own).
			if (get().scope !== scope || get().listState !== listState || get().listView !== listView) {
				set({ listLoading: false });
				return;
			}
			set({ list, listLoading: false });
		} catch (error) {
			set({ error: String(error), listLoading: false });
		}
	},

	setListState: state => {
		if (state === get().listState) return;
		const { scope, listView } = get();
		set({
			listState: state,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, state, listView)) ?? [],
			selected: null,
			detail: null,
			expandedFiles: {},
		});
		void get().refresh();
	},

	setListView: view => {
		if (view === get().listView) return;
		const { scope, listState } = get();
		set({
			listView: view,
			list: lastRead<RpcPrListItem[]>(scope.device, listKey(scope, listState, view)) ?? [],
			selected: null,
			detail: null,
			expandedFiles: {},
		});
		void get().refresh();
	},

	reloadSelected: async () => {
		const number = get().selected;
		await Promise.all([get().refresh(), number === null ? undefined : get().select(number)]);
	},

	deselect: () => set({ selected: null, detail: null, detailLoading: false, expandedFiles: {}, error: null }),

	select: async number => {
		const scope = get().scope;
		// A PR seen before shows at once (its last read), the read below replaces it in place.
		set({
			selected: number,
			detail: lastRead<RpcPrDetail>(scope.device, detailKey(scope, number)) ?? null,
			detailLoading: true,
			expandedFiles: {},
			error: null,
		});
		try {
			const response = await window.omp.rpc.prGet(number);
			// A slower answer for an earlier choice never replaces the PR shown now.
			if (get().selected !== number) return;
			if (!response.success) {
				set({ error: response.error, detailLoading: false });
				return;
			}
			const detail = response.data as RpcPrDetail;
			rememberRead(scope.device, detailKey(scope, number), detail);
			set({ detail, detailLoading: false });
		} catch (error) {
			if (get().selected === number) set({ error: String(error), detailLoading: false });
		}
	},

	toggleFile: async path => {
		const current = get().expandedFiles[path];
		if (current) {
			const next = { ...get().expandedFiles };
			delete next[path];
			set({ expandedFiles: next });
			return;
		}
		const number = get().selected;
		if (number === null) return;
		const scope = get().scope;
		const seen = lastRead<string>(scope.device, diffKey(scope, number, path));
		set(state => ({
			expandedFiles: {
				...state.expandedFiles,
				[path]: seen === undefined ? { phase: "loading" } : { phase: "ready", diff: seen },
			},
		}));
		try {
			const response = await window.omp.rpc.prDiff(number, path);
			if (get().selected !== number) return;
			set(state => {
				// pr_diff success arm carries { diff: string } (rpc-types.ts) — named
				// const instead of inline-cast-access so the assertion has one home.
				const data = response.data as { diff: string } | undefined;
				if (response.success && data) rememberRead(scope.device, diffKey(scope, number, path), data.diff, false);
				return {
					expandedFiles: {
						...state.expandedFiles,
						[path]: response.success && data ? { phase: "ready", diff: data.diff } : { phase: "error" },
					},
				};
			});
		} catch {
			set(state => ({ expandedFiles: { ...state.expandedFiles, [path]: { phase: "error" } } }));
		}
	},

	checkout: async number => {
		try {
			const response = await window.omp.rpc.prCheckout(number);
			if (!response.success) {
				toastError({ title: translate("prCenter.checkoutFailed"), error: response });
				return;
			}
			const result = response.data as { path: string; branch: string };
			const repo = get().repo;
			const tabId = await useTabsStore.getState().openTab({
				cwd: result.path,
				worktree: {
					name: `pr-${number}`,
					branch: result.branch,
					baseCwd: repo?.available ? repo.repo : "",
					path: result.path,
				},
			});
			if (tabId)
				toast({ variant: "success", message: translate("prCenter.checkoutOpened", { number: String(number) }) });
		} catch (error) {
			toastError({ title: translate("prCenter.checkoutFailed"), error });
		}
	},

	reset: () => set(initialState),
}));
