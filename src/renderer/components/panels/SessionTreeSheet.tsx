/**
 * The Session tree sheet (palette, session menus, native menu): visual branch graph of the session from the
 * `get_session_tree` RPC (nodes with parent links, roles, timestamps,
 * active-branch + leaf markers).
 *
 * Layout is a hand-rolled layered tidy tree (see session-tree-layout.ts):
 * depth rows top→bottom, parents centered on children, HTML cards over an
 * SVG edge layer, no graph dependency.
 *
 * The sheet reads the session of the tab focused when it opened (ViewSheetHost gives it that tab's runtime), so a
 * paired host's tab shows the host's session. One data controller (model, selection, filter, label edit, drag
 * offsets) and one camera; the sheet owns the keyboard while it is open.
 *
 * Interactions: drag the canvas to pan, wheel to zoom, drag a node to
 * rearrange it visually (cosmetic, kept per session in memory — the wire has
 * no rearrange op). Node actions (corner menu + keyboard): switch the active
 * leaf in place (switch_leaf → navigateTree; Enter, Shift+Enter summarizes),
 * branch from a user node (rpc.branch), or open an independent session from
 * any node in a new window (fork_from → copyBranchToNewSession). TUI
 * tree-selector parity layers: filter modes (all / current branch /
 * user-only / labeled-only), per-node label editing (set_entry_label RPC),
 * and keyboard navigation (↑/↓ select, Enter switch, L edit label).
 */

import { GitBranch, GitFork, Maximize, RotateCcw, RotateCw, Tag, ZoomIn, ZoomOut } from "lucide-react";
import type { Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcForkFromResult, RpcSwitchLeafResult } from "../../../shared/rpc-types";
import { hydrateSession, hydrateTabSession } from "../../hooks/use-rpc-events";
import { routeToSessionOwner } from "../../hooks/use-session-switch";
import { cx, formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { branchSessionFromEntry, fileBranchDraft } from "../../lib/messages";
import { type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import {
	Badge,
	Button,
	EmptyState,
	IconButton,
	InlineNotice,
	Input,
	Select,
	SettingInfo,
	Sheet,
	Spinner,
} from "../common";
import { PanelToolbar } from "./PanelChrome";
import { RoleGlyph, roleMeta, SessionRootNode, SessionTreeNodeCard } from "./SessionTreeNodeCard";
import {
	buildSessionTreeLayout,
	type SessionTreeEntry,
	type SessionTreeLayout,
	type SessionTreeLayoutNode,
	type SessionTreeResult,
	sessionTreeEdgePath,
	TREE_NODE_HEIGHT,
	TREE_NODE_WIDTH,
	TREE_ROOT_HEIGHT,
} from "./session-tree-layout";

interface SessionTreeModel {
	entries: SessionTreeEntry[];
	activeLeafId: string | null;
}

interface ViewTransform {
	x: number;
	y: number;
	k: number;
}

type DragOffsets = Record<string, { dx: number; dy: number }>;

type DragState =
	| { kind: "pan"; pointerId: number; startX: number; startY: number; baseX: number; baseY: number; moved: boolean }
	| {
			kind: "node";
			pointerId: number;
			entryId: string;
			startX: number;
			startY: number;
			baseDx: number;
			baseDy: number;
			moved: boolean;
	  };

/** Cosmetic node drag offsets, keyed by session id — visual only, never sent on the wire. */
const dragOffsetsBySession = new Map<string, DragOffsets>();

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
/** Initial width-fit never shrinks below this, so node text stays readable in a narrow panel. */
const MIN_INITIAL_ZOOM = 0.7;
const VIEW_INSET = 16;
const CULL_MARGIN = 160;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

async function loadSessionTreeModel(rpc: TabRpc): Promise<SessionTreeModel> {
	const response = await rpc.getSessionTree();
	if (!response.success) throw new Error(response.error);
	const data = response.data as SessionTreeResult | undefined;
	return { entries: data?.tree ?? [], activeLeafId: data?.activeLeafId ?? null };
}

/** Node subsets shown in the graph (TUI tree-selector filter-mode parity). */
type TreeFilterMode = "all" | "current" | "user" | "labeled";

const TREE_FILTER_MODES: Array<{ id: TreeFilterMode; labelKey: string }> = [
	{ id: "all", labelKey: "sessionTree.filter.all" },
	{ id: "current", labelKey: "sessionTree.filter.current" },
	{ id: "user", labelKey: "sessionTree.filter.user" },
	{ id: "labeled", labelKey: "sessionTree.filter.labeled" },
];

/**
 * Keep only entries passing the filter, remapping each survivor's parentId to
 * its nearest surviving ancestor (the same convention the RPC projection
 * uses) so filtered edges never dangle.
 */
function filterTreeEntries(entries: SessionTreeEntry[], mode: TreeFilterMode): SessionTreeEntry[] {
	if (mode === "all") return entries;
	const keep = new Set<string>();
	for (const entry of entries) {
		if (
			(mode === "current" && entry.onActiveBranch) ||
			(mode === "user" && entry.role === "user") ||
			(mode === "labeled" && entry.label !== undefined)
		) {
			keep.add(entry.entryId);
		}
	}
	const byId = new Map(entries.map(entry => [entry.entryId, entry]));
	const nearestKept = (id: string | null): string | null => {
		let current = id;
		let guard = 0;
		while (current && guard++ < 100_000) {
			if (keep.has(current)) return current;
			current = byId.get(current)?.parentId ?? null;
		}
		return null;
	};
	const filtered: SessionTreeEntry[] = [];
	for (const entry of entries) {
		if (keep.has(entry.entryId)) filtered.push({ ...entry, parentId: nearestKept(entry.parentId) });
	}
	return filtered;
}

/** Data + actions shared by both views of the tree (see {@link useSessionTreeController}). */
interface SessionTreeController {
	sessionName: string | null | undefined;
	sessionId: string | null | undefined;
	sidecarReady: boolean;
	model: SessionTreeModel | null;
	loading: boolean;
	/** Bumps on every (re)load; views reset their camera on it. */
	loadKey: number;
	error: string | null;
	retry: () => void;
	/** Entry id with an action in flight, or null. */
	branching: string | null;
	selectedId: string | null;
	setSelectedId: Dispatch<SetStateAction<string | null>>;
	filterMode: TreeFilterMode;
	setFilterMode: (mode: TreeFilterMode) => void;
	filteredEntries: SessionTreeEntry[];
	layout: SessionTreeLayout | null;
	nodeById: Map<string, SessionTreeLayoutNode>;
	offsets: DragOffsets;
	moveNode: (entryId: string, dx: number, dy: number) => void;
	resetOffsets: () => void;
	labelEditId: string | null;
	labelDraft: string;
	setLabelDraft: (draft: string) => void;
	savingLabel: boolean;
	branchFrom: (entryId: string) => Promise<void>;
	switchToLeaf: (entryId: string, summarize?: boolean) => Promise<void>;
	forkFromNode: (entryId: string) => Promise<void>;
	startLabelEdit: (entryId: string) => void;
	cancelLabelEdit: () => void;
	commitLabelEdit: () => Promise<void>;
}

/**
 * Data + actions shared by the inline panel view and the wide Sheet view.
 * `onNavigated` runs after the session moved (switch / branch / routed to the
 * owning tab) — the panel uses it to close the wide view.
 */
function useSessionTreeController(onNavigated: () => void): SessionTreeController {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const sessionName = useSessionStore(state => state.sessionName);
	const sessionId = useSessionStore(state => state.sessionId);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const sessionKey = sessionId || "session";

	const [model, setModel] = useState<SessionTreeModel | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadKey, setLoadKey] = useState(0);
	const [branching, setBranching] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filterMode, setFilterMode] = useState<TreeFilterMode>("all");
	const [labelEditId, setLabelEditId] = useState<string | null>(null);
	const [labelDraft, setLabelDraft] = useState("");
	const [savingLabel, setSavingLabel] = useState(false);
	const [offsets, setOffsetsState] = useState<DragOffsets>({});
	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs on `attempt`;
	   nothing inside reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!sidecarReady) {
			setModel(null);
			setError(t("sessionTree.notConnected"));
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		setBranching(null);
		setSelectedId(null);
		setFilterMode("all");
		setLabelEditId(null);
		setLabelDraft("");
		setOffsetsState(dragOffsetsBySession.get(sessionKey) ?? {});
		setLoadKey(key => key + 1);
		let cancelled = false;
		loadSessionTreeModel(tabRpc)
			.then(result => {
				if (!cancelled) setModel(result);
			})
			.catch(cause => {
				if (!cancelled) {
					setModel(null);
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, sessionKey, sidecarReady, t, tabRpc]);

	const filteredEntries = useMemo(
		() => (model ? filterTreeEntries(model.entries, filterMode) : []),
		[model, filterMode],
	);
	const layout = useMemo(() => (model ? buildSessionTreeLayout(filteredEntries) : null), [model, filteredEntries]);
	const nodeById = useMemo(() => {
		const map = new Map<string, SessionTreeLayoutNode>();
		if (layout) for (const node of layout.nodes) map.set(node.id, node);
		return map;
	}, [layout]);

	// Keep the selection visible across filter changes: walk up to the nearest
	// surviving ancestor, clear when none survives (TUI findNearestVisibleIndex).
	useEffect(() => {
		if (!selectedId || !model) return;
		const survivors = new Set(filteredEntries.map(entry => entry.entryId));
		if (survivors.has(selectedId)) return;
		const byId = new Map(model.entries.map(entry => [entry.entryId, entry]));
		let current: string | null = byId.get(selectedId)?.parentId ?? null;
		let guard = 0;
		while (current && guard++ < 100_000 && !survivors.has(current)) {
			current = byId.get(current)?.parentId ?? null;
		}
		setSelectedId(current);
	}, [filteredEntries, model, selectedId]);

	// The label editor is anchored to the node it edits; moving the selection
	// away (click, filter, keyboard) cancels it.
	useEffect(() => {
		if (labelEditId && labelEditId !== selectedId) {
			setLabelEditId(null);
			setLabelDraft("");
		}
	}, [selectedId, labelEditId]);

	const moveNode = (entryId: string, dx: number, dy: number) => {
		setOffsetsState(current => {
			const next = { ...current, [entryId]: { dx, dy } };
			dragOffsetsBySession.set(sessionKey, next);
			return next;
		});
	};

	const resetOffsets = () => {
		dragOffsetsBySession.delete(sessionKey);
		setOffsetsState({});
	};

	/** Localized failure toast; the raw sidecar/IPC cause stays as the quiet detail line. */
	const failureToast = (
		titleKey:
			| "sessionTree.branchFailed"
			| "sessionTree.switchFailed"
			| "sessionTree.forkFailed"
			| "sessionTree.labelFailed",
		cause: unknown,
	) => {
		toastError({ title: t(titleKey), error: cause });
	};

	const branchFrom = async (entryId: string) => {
		if (!sidecarReady || branching !== null) return;
		// The sidecar only branches from USER entries — refuse anything else
		// (Enter key / stale affordances), matching the disabled menu item.
		const entry = model?.entries.find(candidate => candidate.entryId === entryId);
		if (entry?.role !== "user") return;
		setBranching(entryId);
		try {
			const result = await branchSessionFromEntry(entryId);
			if (result === "cancelled") {
				toast({ variant: "info", message: t("sessionTree.branchCancelled") });
				return;
			}
			onNavigated();
		} catch (cause) {
			failureToast("sessionTree.branchFailed", cause);
		} finally {
			setBranching(null);
		}
	};

	// Move the active leaf to this node in place (switch_leaf → navigateTree,
	// TUI tree-selector Enter parity). Works on ANY node; the target's draft
	// text restores into the composer, and a hook veto is not a failure.
	const switchToLeaf = async (entryId: string, summarize = false) => {
		if (!sidecarReady || branching !== null) return;
		// F-OWN belt guard: switch_leaf mutates the attached session file. When
		// a DIFFERENT tab owns that file (diverged state), defer to the owner
		// instead of navigating a session this tab no longer owns.
		const sessionFile = useSessionStore.getState().sessionFile;
		if (sessionFile) {
			try {
				const owner = await window.omp.tabs.getSessionOwner(sessionFile);
				if (owner && owner.tabId !== useTabsStore.getState().activeTabId) {
					await routeToSessionOwner(owner, sessionFile);
					onNavigated();
					return;
				}
			} catch {
				// Best-effort pre-check; same-owner navigation is the common case.
			}
		}
		setBranching(entryId);
		try {
			const response = await tabRpc.switchLeaf(entryId, summarize ? { summarize: true } : undefined);
			if (!response.success) {
				failureToast("sessionTree.switchFailed", response);
				return;
			}
			const data = response.data as RpcSwitchLeafResult | undefined;
			if (!data) return;
			if (data.cancelled) {
				toast({ variant: "info", message: t("sessionTree.branchCancelled") });
				return;
			}
			if (data.editorText !== undefined) {
				window.dispatchEvent(
					new CustomEvent("omp:fill-composer", { detail: { text: data.editorText, images: data.editorImages } }),
				);
			}
			if (tabId) await hydrateTabSession(tabId);
			else await hydrateSession();
			onNavigated();
		} catch (cause) {
			failureToast("sessionTree.switchFailed", cause);
		} finally {
			setBranching(null);
		}
	};

	// Independent new session from this node (fork_from): writes a new session
	// file containing only the path to this node and opens it in a NEW WINDOW —
	// the attached session stays untouched, so every view stays open. From a
	// prompt the copy ends before it and the prompt waits as that session's draft.
	const forkFromNode = async (entryId: string) => {
		if (!sidecarReady || branching !== null) return;
		setBranching(entryId);
		try {
			const response = await tabRpc.forkFrom(entryId);
			if (!response.success) {
				failureToast("sessionTree.forkFailed", response);
				return;
			}
			const data = response.data as RpcForkFromResult | undefined;
			if (!data?.sessionPath) return;
			fileBranchDraft(data, useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.device);
			const opened = await window.omp.sessions.openInNewWindow({ sessionPath: data.sessionPath });
			if (!opened) {
				toast({ variant: "error", message: t("sidebar.openFailed") });
				return;
			}
			toast({ variant: "success", message: t("sessionTree.forkedOpened") });
		} catch (cause) {
			failureToast("sessionTree.forkFailed", cause);
		} finally {
			setBranching(null);
		}
	};

	const startLabelEdit = (entryId: string) => {
		if (!sidecarReady) return;
		const entry = model?.entries.find(candidate => candidate.entryId === entryId);
		setLabelEditId(entryId);
		setLabelDraft(entry?.label ?? "");
	};

	const cancelLabelEdit = () => {
		setLabelEditId(null);
		setLabelDraft("");
	};

	// Persist a label via set_entry_label (empty draft clears it). Optimistic;
	// reverts on failure. TUI tree-selector Shift+L parity.
	const commitLabelEdit = async () => {
		const entryId = labelEditId;
		if (!sidecarReady || !entryId || savingLabel) return;
		const label = labelDraft.trim() || undefined;
		setLabelEditId(null);
		setLabelDraft("");
		const previous = model?.entries.find(entry => entry.entryId === entryId)?.label;
		if (label === previous) return;
		const applyLabel = (value: string | undefined) => {
			setModel(
				current =>
					current && {
						...current,
						entries: current.entries.map(entry =>
							entry.entryId === entryId ? { ...entry, label: value } : entry,
						),
					},
			);
		};
		applyLabel(label);
		setSavingLabel(true);
		try {
			const response = await tabRpc.setEntryLabel(entryId, label);
			if (!response.success) {
				applyLabel(previous);
				failureToast("sessionTree.labelFailed", response);
			}
		} catch (cause) {
			applyLabel(previous);
			failureToast("sessionTree.labelFailed", cause);
		} finally {
			setSavingLabel(false);
		}
	};

	return {
		sessionName,
		sessionId,
		sidecarReady,
		model,
		loading,
		loadKey,
		error,
		retry: () => setAttempt(count => count + 1),
		branching,
		selectedId,
		setSelectedId,
		filterMode,
		setFilterMode,
		filteredEntries,
		layout,
		nodeById,
		offsets,
		moveNode,
		resetOffsets,
		labelEditId,
		labelDraft,
		setLabelDraft,
		savingLabel,
		branchFrom,
		switchToLeaf,
		forkFromNode,
		startLabelEdit,
		cancelLabelEdit,
		commitLabelEdit,
	};
}

/**
 * Where the keyboard handler listens: `element` scopes it to this view (the
 * docked panel must not steal ↑/↓ from the transcript), `document` takes the
 * whole window (the modal wide view), `null` disables it.
 */

/** Toolbar + canvas + footer of the tree. */
/** `active`: the sheet is open and the tree takes the document's keys. */
function SessionTreeView({ tree, active }: { tree: SessionTreeController; active: boolean }) {
	const t = useT();
	const { model, layout, nodeById, offsets, selectedId, sidecarReady, branching } = tree;
	const [transform, setTransform] = useState<ViewTransform>({ x: 0, y: 0, k: 1 });
	const [size, setSize] = useState({ w: 0, h: 0 });
	const [activeDrag, setActiveDrag] = useState<"pan" | "node" | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<DragState | null>(null);
	const transformRef = useRef(transform);
	const sizeRef = useRef(size);
	const offsetsRef = useRef(offsets);
	const needsInitialViewRef = useRef(true);

	useEffect(() => {
		transformRef.current = transform;
		sizeRef.current = size;
		offsetsRef.current = offsets;
	}, [transform, size, offsets]);

	// Every (re)load gets a fresh initial camera.
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadKey is the trigger
	useEffect(() => {
		needsInitialViewRef.current = true;
	}, [tree.loadKey]);

	// The canvas div only exists once data has loaded, so effects that need it
	// gate on this flag.
	const canvasReady = !tree.error && !tree.loading && layout !== null && layout.nodeCount > 0;

	useEffect(() => {
		if (!canvasReady) return;
		const el = containerRef.current;
		if (!el) return;
		if (typeof ResizeObserver !== "function") {
			// Non-standard DOM (test harness): assume a nominal viewport.
			setSize({ w: el.clientWidth || 960, h: el.clientHeight || 640 });
			return;
		}
		const observer = new ResizeObserver(entries => {
			const rect = entries[0]?.contentRect;
			if (rect) setSize({ w: rect.width, h: rect.height });
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [canvasReady]);

	// Wheel zoom (native, non-passive so the surface behind never scrolls).
	useEffect(() => {
		if (!canvasReady) return;
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const sx = event.clientX - rect.left;
			const sy = event.clientY - rect.top;
			const base = transformRef.current;
			const k = clampZoom(base.k * Math.exp(-event.deltaY * 0.0015));
			const wx = (sx - base.x) / base.k;
			const wy = (sy - base.y) / base.k;
			setTransform({ k, x: sx - wx * k, y: sy - wy * k });
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [canvasReady]);

	const isHead = (entry: SessionTreeEntry) => entry.isLeaf || entry.entryId === model?.activeLeafId;

	// Initial view: fit the tree to the view WIDTH (never above 1, never below
	// the readable floor). Whatever still overflows is anchored on HEAD: centered
	// horizontally on it, and the bottom of the tree in view vertically.
	// biome-ignore lint/correctness/useExhaustiveDependencies: isHead reads model, already a dep via layout
	useEffect(() => {
		if (!layout || size.w === 0 || !needsInitialViewRef.current) return;
		needsInitialViewRef.current = false;
		const k = clampZoom(Math.min(1, Math.max(MIN_INITIAL_ZOOM, (size.w - 2 * VIEW_INSET) / layout.width)));
		const head = layout.nodes.find(node => node.entry !== null && isHead(node.entry));
		const width = layout.width * k;
		const height = layout.height * k;
		const x = width <= size.w || !head ? (size.w - width) / 2 : size.w / 2 - (head.x + TREE_NODE_WIDTH / 2) * k;
		const y = height <= size.h - 2 * VIEW_INSET ? (size.h - height) / 2 : size.h - height - 2 * VIEW_INSET;
		setTransform({ k, x, y });
	}, [layout, size]);

	const fitToView = useCallback(() => {
		if (!layout || sizeRef.current.w === 0) return;
		const { w, h } = sizeRef.current;
		const k = clampZoom(Math.min((w - 48) / layout.width, (h - 48) / layout.height, 1));
		setTransform({ k, x: (w - layout.width * k) / 2, y: (h - layout.height * k) / 2 });
	}, [layout]);

	// Refit only when the filter actually changed (not on the initial layout).
	const prevFilterRef = useRef(tree.filterMode);
	useEffect(() => {
		if (prevFilterRef.current === tree.filterMode) return;
		prevFilterRef.current = tree.filterMode;
		if (canvasReady) fitToView();
	}, [tree.filterMode, canvasReady, fitToView]);

	const zoomBy = (factor: number) => {
		const { w, h } = sizeRef.current;
		const base = transformRef.current;
		const k = clampZoom(base.k * factor);
		const wx = (w / 2 - base.x) / base.k;
		const wy = (h / 2 - base.y) / base.k;
		setTransform({ k, x: w / 2 - wx * k, y: h / 2 - wy * k });
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || !layout) return;
		const nodeEl = event.target instanceof Element ? event.target.closest("[data-tree-node]") : null;
		const entryId = nodeEl?.getAttribute("data-tree-node") ?? null;
		const container = containerRef.current;
		if (container && typeof container.setPointerCapture === "function") {
			container.setPointerCapture(event.pointerId);
		}
		if (entryId) {
			const base = offsetsRef.current[entryId];
			dragRef.current = {
				kind: "node",
				pointerId: event.pointerId,
				entryId,
				startX: event.clientX,
				startY: event.clientY,
				baseDx: base?.dx ?? 0,
				baseDy: base?.dy ?? 0,
				moved: false,
			};
		} else {
			dragRef.current = {
				kind: "pan",
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				baseX: transformRef.current.x,
				baseY: transformRef.current.y,
				moved: false,
			};
		}
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) return;
		if (!drag.moved) {
			if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
			drag.moved = true;
			setActiveDrag(drag.kind);
		}
		if (drag.kind === "pan") {
			setTransform(current => ({
				...current,
				x: drag.baseX + event.clientX - drag.startX,
				y: drag.baseY + event.clientY - drag.startY,
			}));
		} else {
			const k = transformRef.current.k;
			tree.moveNode(
				drag.entryId,
				drag.baseDx + (event.clientX - drag.startX) / k,
				drag.baseDy + (event.clientY - drag.startY) / k,
			);
		}
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || event.pointerId !== drag.pointerId) return;
		dragRef.current = null;
		setActiveDrag(null);
		const container = containerRef.current;
		if (
			container &&
			typeof container.hasPointerCapture === "function" &&
			container.hasPointerCapture(event.pointerId)
		) {
			container.releasePointerCapture(event.pointerId);
		}
		if (drag.moved) return;
		// Click (no drag): node toggles its detail, background clears the selection.
		if (drag.kind === "node") tree.setSelectedId(current => (current === drag.entryId ? null : drag.entryId));
		else tree.setSelectedId(null);
	};

	const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (event.target instanceof Element && event.target.closest("[data-tree-node]")) return;
		fitToView();
	};

	// Latest-value ref for the keyboard handler (registered once per scope).
	const keyboardContextRef = useRef({ tree, nodeById });
	useEffect(() => {
		keyboardContextRef.current = { tree, nodeById };
	});

	// Pan the view just enough to keep a node on screen (keyboard navigation).
	const ensureNodeVisible = useCallback((entryId: string) => {
		const node = keyboardContextRef.current.nodeById.get(entryId);
		if (!node) return;
		const offset = offsetsRef.current[entryId];
		const x = node.x + (offset?.dx ?? 0);
		const y = node.y + (offset?.dy ?? 0);
		const base = transformRef.current;
		const { w, h } = sizeRef.current;
		if (w === 0 || h === 0) return;
		const margin = 48;
		let { x: tx, y: ty } = base;
		const sx = x * base.k + tx;
		const sy = y * base.k + ty;
		const sw = TREE_NODE_WIDTH * base.k;
		const sh = TREE_NODE_HEIGHT * base.k;
		if (sx < margin) tx += margin - sx;
		else if (sx + sw > w - margin) tx -= sx + sw - (w - margin);
		if (sy < margin) ty += margin - sy;
		else if (sy + sh > h - margin) ty -= sy + sh - (h - margin);
		if (tx !== base.x || ty !== base.y) setTransform({ ...base, x: tx, y: ty });
	}, []);

	// Keyboard navigation (TUI tree-selector parity): ↑/↓ move the selection
	// through the visible nodes in wire order (wrapping), Enter switches the
	// active leaf to the selection (Shift+Enter summarizes the abandoned branch
	// first), L opens the label editor. Skips text inputs, native button
	// activation, and keys a menu or field already claimed.
	useEffect(() => {
		if (!active || !canvasReady) return;
		const target = document;
		const onKeyDown = (raw: Event) => {
			const event = raw as KeyboardEvent;
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const element = event.target as HTMLElement | null;
			const tag = element?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || element?.isContentEditable) return;
			// ime-ok: editable targets returned above, so no composition is live on this path.
			const { tree: context } = keyboardContextRef.current;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				const entries = context.filteredEntries;
				if (entries.length === 0) return;
				event.preventDefault();
				const delta = event.key === "ArrowDown" ? 1 : -1;
				const index = entries.findIndex(entry => entry.entryId === context.selectedId);
				const next =
					index === -1 ? (delta > 0 ? 0 : entries.length - 1) : (index + delta + entries.length) % entries.length;
				const entryId = entries[next]!.entryId;
				context.setSelectedId(entryId);
				ensureNodeVisible(entryId);
			} else if (event.key === "Enter") {
				if (tag === "BUTTON" || !context.selectedId || context.branching !== null) return;
				event.preventDefault();
				void context.switchToLeaf(context.selectedId, event.shiftKey);
			} else if (event.key === "l" || event.key === "L") {
				if (tag === "BUTTON" || !context.selectedId || !context.model) return;
				event.preventDefault();
				context.startLabelEdit(context.selectedId);
			}
		};
		target.addEventListener("keydown", onKeyDown);
		return () => target.removeEventListener("keydown", onKeyDown);
	}, [active, canvasReady, ensureNodeVisible]);

	// Effective (post-drag) node positions + viewport culling, all in world coordinates.
	const positions = new Map<string, { x: number; y: number }>();
	if (layout) {
		for (const node of layout.nodes) {
			const off = offsets[node.id];
			positions.set(node.id, { x: node.x + (off?.dx ?? 0), y: node.y + (off?.dy ?? 0) });
		}
	}
	const view = {
		x0: -transform.x / transform.k - CULL_MARGIN,
		y0: -transform.y / transform.k - CULL_MARGIN,
		x1: (-transform.x + size.w) / transform.k + CULL_MARGIN,
		y1: (-transform.y + size.h) / transform.k + CULL_MARGIN,
	};
	const visibleNodes = layout
		? layout.nodes.filter(node => {
				const pos = positions.get(node.id);
				if (!pos) return false;
				const h = node.entry === null ? TREE_ROOT_HEIGHT : TREE_NODE_HEIGHT;
				return pos.x + TREE_NODE_WIDTH >= view.x0 && pos.x <= view.x1 && pos.y + h >= view.y0 && pos.y <= view.y1;
			})
		: [];
	const renderedEdges: Array<{ id: string; d: string; childId: string }> = [];
	if (layout) {
		for (const edge of layout.edges) {
			const parent = nodeById.get(edge.parentId);
			const p1 = positions.get(edge.parentId);
			const p2 = positions.get(edge.childId);
			if (!parent || !p1 || !p2) continue;
			const parentH = parent.entry === null ? TREE_ROOT_HEIGHT : TREE_NODE_HEIGHT;
			const x1 = p1.x + TREE_NODE_WIDTH / 2;
			const y1 = p1.y + parentH;
			const x2 = p2.x + TREE_NODE_WIDTH / 2;
			const y2 = p2.y;
			if (Math.max(x1, x2) < view.x0 || Math.min(x1, x2) > view.x1) continue;
			if (Math.max(y1, y2) < view.y0 || Math.min(y1, y2) > view.y1) continue;
			renderedEdges.push({ id: edge.id, d: sessionTreeEdgePath(x1, y1, x2, y2), childId: edge.childId });
		}
	}

	const selectedEntry = selectedId ? (model?.entries.find(entry => entry.entryId === selectedId) ?? null) : null;
	const onNodeAction = useCallback((action: "switch" | "branch" | "fork", entryId: string) => {
		const { tree: context } = keyboardContextRef.current;
		if (action === "switch") void context.switchToLeaf(entryId);
		else if (action === "branch") void context.branchFrom(entryId);
		else void context.forkFromNode(entryId);
	}, []);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PanelToolbar className="flex-col items-stretch">
				<div className="flex min-w-0 items-center gap-2">
					<span
						className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-muted)"
						title={tree.sessionName ?? tree.sessionId ?? undefined}
					>
						{tree.sessionName ?? t("sessionTree.untitled")}
					</span>
				</div>
				{model && model.entries.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<Select
							value={tree.filterMode}
							aria-label={t("sessionTree.filter.group")}
							controlSize="sm"
							onChange={event => tree.setFilterMode(event.target.value as TreeFilterMode)}
							options={TREE_FILTER_MODES.map(mode => ({ value: mode.id, label: t(mode.labelKey) }))}
						/>
						{layout && layout.nodeCount > 0 && (
							<span className="ml-auto text-sc-xs text-(--sc-text-muted)">
								{tree.filterMode === "all"
									? t("sessionTree.messageCount", {
											count: layout.nodeCount,
											plural: layout.nodeCount === 1 ? "" : "s",
										})
									: t("sessionTree.shownOfTotal", {
											shown: layout.nodeCount,
											total: model.entries.length,
										})}
								{layout.forkCount > 0 &&
									` · ${t("sessionTree.forkCount", {
										count: layout.forkCount,
										plural: layout.forkCount === 1 ? "" : "s",
									})}`}
							</span>
						)}
					</div>
				)}
			</PanelToolbar>
			{tree.error ? (
				<InlineNotice
					action={
						<Button
							disabled={!sidecarReady}
							icon={<RotateCw />}
							onClick={tree.retry}
							size="sm"
							title={!sidecarReady ? t("sessionTree.notConnected") : undefined}
							variant="secondary"
						>
							{t("common.retry")}
						</Button>
					}
					className="px-4"
					detail={tree.error}
					live
					title={t("sessionTree.loadFailed")}
					tone="danger"
				/>
			) : tree.loading || !layout ? (
				<div className="flex flex-1 items-center justify-center">
					<Spinner label={t("sessionTree.loading")} size="sm" />
				</div>
			) : layout.nodeCount === 0 ? (
				<div className="flex flex-1 items-center justify-center">
					{model && model.entries.length > 0 ? (
						<EmptyState
							actions={
								<Button onClick={() => tree.setFilterMode("all")} size="sm" variant="secondary">
									{t("sessionTree.filter.all")}
								</Button>
							}
							icon={<GitFork />}
							size="sm"
							title={t("sessionTree.noFilterMatch")}
						/>
					) : (
						<EmptyState icon={<GitFork />} size="sm" title={t("sessionTree.empty")} />
					)}
				</div>
			) : (
				<div
					aria-label={t("sessionTree.canvasAria")}
					className={cx(
						"relative min-h-0 flex-1 touch-none overflow-hidden focus-visible:outline-(length:--sc-focus-width) focus-visible:-outline-offset-(--sc-focus-width) focus-visible:outline-(--sc-focus-ring)",
						activeDrag === "pan" ? "cursor-grabbing" : "cursor-grab",
					)}
					onDoubleClick={onDoubleClick}
					onPointerCancel={onPointerUp}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					ref={containerRef}
					role="application"
					tabIndex={0}
				>
					{size.w > 0 && (
						<div
							className="absolute top-0 left-0"
							style={{
								width: layout.width,
								height: layout.height,
								transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
								transformOrigin: "0 0",
							}}
						>
							<svg aria-hidden className="absolute top-0 left-0" height={layout.height} width={layout.width}>
								<defs>
									<marker
										id="session-tree-arrow"
										markerHeight="6"
										markerWidth="6"
										orient="auto"
										refX="5"
										refY="3"
									>
										<path d="M 0 0 L 6 3 L 0 6 z" fill="context-stroke" />
									</marker>
								</defs>
								{renderedEdges.map(edge => {
									const child = nodeById.get(edge.childId)?.entry;
									const childActive = child?.onActiveBranch === true;
									const childSelected = edge.childId === selectedId;
									return (
										<path
											d={edge.d}
											fill="none"
											key={edge.id}
											markerEnd="url(#session-tree-arrow)"
											stroke={
												childSelected
													? "var(--sc-info)"
													: childActive
														? "var(--sc-accent)"
														: "var(--sc-border-subtle)"
											}
											strokeWidth={childActive || childSelected ? 1.75 : 1.25}
										/>
									);
								})}
							</svg>
							{visibleNodes.map(node => {
								const pos = positions.get(node.id) ?? { x: node.x, y: node.y };
								if (node.entry === null) return <SessionRootNode key={node.id} x={pos.x} y={pos.y} />;
								return (
									<SessionTreeNodeCard
										branching={branching}
										entry={node.entry}
										head={isHead(node.entry)}
										key={node.id}
										onAction={onNodeAction}
										ready={sidecarReady}
										selected={node.id === selectedId}
										x={pos.x}
										y={pos.y}
									/>
								);
							})}
						</div>
					)}
					<div
						className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-elevated) p-0.5 shadow-(--sc-shadow-sm)"
						onDoubleClick={event => event.stopPropagation()}
						onPointerDown={event => event.stopPropagation()}
					>
						<IconButton
							icon={<ZoomOut />}
							label={t("sessionTree.zoomOut")}
							onClick={() => zoomBy(1 / 1.25)}
							size="sm"
						/>
						<span className="w-10 text-center text-sc-xs tabular-nums text-(--sc-text-muted)">
							{Math.round(transform.k * 100)}%
						</span>
						<IconButton
							icon={<ZoomIn />}
							label={t("sessionTree.zoomIn")}
							onClick={() => zoomBy(1.25)}
							size="sm"
						/>
						<span aria-hidden className="mx-0.5 h-4 w-px bg-(--sc-divider)" />
						<IconButton icon={<Maximize />} label={t("sessionTree.fitToView")} onClick={fitToView} size="sm" />
						<IconButton
							disabled={Object.keys(offsets).length === 0}
							icon={<RotateCcw />}
							label={t("sessionTree.resetLayout")}
							onClick={() => {
								tree.resetOffsets();
								fitToView();
							}}
							size="sm"
						/>
					</div>
				</div>
			)}
			{canvasReady ? (
				selectedEntry && tree.labelEditId === selectedEntry.entryId ? (
					<div className="flex shrink-0 items-center gap-2 border-t border-(--sc-divider) px-3 py-2">
						<Tag aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)" />
						<div className="min-w-0 flex-1">
							<Input
								aria-label={t("sessionTree.editLabel")}
								autoFocus={active}
								controlSize="sm"
								onChange={event => tree.setLabelDraft(event.target.value)}
								onKeyDown={event => {
									if (isImeKeyEvent(event)) return;
									if (event.key === "Enter") {
										event.preventDefault();
										void tree.commitLabelEdit();
									} else if (event.key === "Escape") {
										// Claim the Escape so the app-level handler (abort turn) skips it.
										event.preventDefault();
										tree.cancelLabelEdit();
									}
								}}
								placeholder={t("sessionTree.labelPlaceholder")}
								value={tree.labelDraft}
							/>
						</div>
						<Button
							disabled={!sidecarReady}
							loading={tree.savingLabel}
							onClick={() => void tree.commitLabelEdit()}
							size="sm"
							title={!sidecarReady ? t("sessionTree.notConnected") : undefined}
							variant="secondary"
						>
							{t("common.save")}
						</Button>
						<Button disabled={tree.savingLabel} onClick={tree.cancelLabelEdit} size="sm" variant="ghost">
							{t("common.cancel")}
						</Button>
					</div>
				) : selectedEntry ? (
					<div className="flex max-h-36 shrink-0 flex-col gap-2 overflow-y-auto border-t border-(--sc-divider) px-3 py-2">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<RoleGlyph role={selectedEntry.role} />
							<span
								className={cx(
									"text-sc-xs font-semibold tracking-wide uppercase",
									roleMeta(selectedEntry.role).className,
								)}
							>
								{t(roleMeta(selectedEntry.role).labelKey)}
							</span>
							{selectedEntry.timestamp > 0 && (
								<span className="text-sc-xs text-(--sc-text-subtle)">
									{formatClock(selectedEntry.timestamp)}
								</span>
							)}
							{selectedEntry.label && <Badge variant="info">{selectedEntry.label}</Badge>}
							{isHead(selectedEntry) && <Badge variant="success">{t("sessionTree.head")}</Badge>}
							{!selectedEntry.onActiveBranch && <Badge variant="muted">{t("sessionTree.inactiveBranch")}</Badge>}
						</div>
						<p
							className={cx(
								"text-sc-sm whitespace-pre-wrap break-words",
								selectedEntry.textPreview ? "text-(--sc-text)" : "text-(--sc-text-subtle)",
							)}
						>
							{selectedEntry.textPreview || t("sessionTree.noText")}
						</p>
						<div className="flex flex-wrap gap-1.5">
							{selectedEntry.role === "user" && (
								<Button
									disabled={!sidecarReady || branching !== null}
									icon={<GitBranch />}
									loading={branching === selectedEntry.entryId}
									onClick={() => void tree.branchFrom(selectedEntry.entryId)}
									size="sm"
									title={!sidecarReady ? t("sessionTree.notConnected") : undefined}
									variant="secondary"
								>
									{t("sessionTree.branch")}
								</Button>
							)}
							<Button
								disabled={!sidecarReady || tree.savingLabel}
								icon={<Tag />}
								onClick={() => tree.startLabelEdit(selectedEntry.entryId)}
								size="sm"
								title={!sidecarReady ? t("sessionTree.notConnected") : undefined}
								variant="ghost"
							>
								{t("sessionTree.editLabel")}
							</Button>
						</div>
					</div>
				) : (
					<p className="flex shrink-0 items-center gap-1 border-t border-(--sc-divider) px-3 py-1 text-sc-xs text-(--sc-text-muted)">
						<span className="min-w-0 truncate">{t("sessionTree.footerKeys")}</span>
						<SettingInfo text={`${t("sessionTree.footerTree")} ${t("sessionTree.footerHint")}`} />
					</p>
				)
			) : null}
		</div>
	);
}

/** The Session tree sheet; a switch or a branch that moves the session closes it. */
export function SessionTreeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const tree = useSessionTreeController(onClose);
	return (
		<Sheet
			bodyClassName="flex flex-col"
			// Escape / scrim while a label is being edited cancels the edit first.
			onClose={() => (tree.labelEditId ? tree.cancelLabelEdit() : onClose())}
			open={open}
			size="lg"
			title={t("sessionTree.title")}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-view-sheet="tree">
				<SessionTreeView active={open} tree={tree} />
			</div>
		</Sheet>
	);
}
