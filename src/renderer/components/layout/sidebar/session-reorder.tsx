/**
 * Dragging a session row to a new place in its own list (a project's, Chats, a paired host's). Native drag, like the
 * drag-to-split a row already starts (`omp:tab-drag`, taken by `SplitWorkspace` over a pane): one drag does both, and
 * which one happens depends on where it is dropped, so a row dropped on a pane edge still splits and a row dropped on
 * a row of its own list moves. The browser scrolls the list while a drag nears its edge. A finger has no native
 * drag: the row menu's Move up / Move down and Alt+↑/↓ are the other paths.
 */
import { type DragEvent, type HTMLAttributes, type ReactNode, useState } from "react";
import { hideNativeDragImage } from "../../../lib/drag-image";
import { useT } from "../../../lib/i18n";
import { reorderProjects } from "../../../lib/project-order";

/** A list the rows of which can be reordered: where its order is kept, and its stored rows as drawn, top first. */
export interface SessionList {
	key: string;
	paths: readonly string[];
	/** Pinned rows stay on top: a row never trades places across the pinned edge. */
	pinned?: readonly string[];
}

type Edge = "before" | "after";

interface Drop {
	path: string;
	edge: Edge;
}

const SESSION_MIME = "application/x-omp-session";

/** Whether `over` may take `from`'s place: both in the list, and on the same side of the pinned edge. */
export function canDropOn(list: SessionList, from: string, over: string): boolean {
	if (from === over || !list.paths.includes(from) || !list.paths.includes(over)) return false;
	const pinned = list.pinned ?? [];
	return pinned.includes(from) === pinned.includes(over);
}

/** Dragging down lands a row after the one it is over, dragging up before it (as a project or device section does). */
export function dropEdge(paths: readonly string[], from: string, over: string): Edge {
	return paths.indexOf(over) < paths.indexOf(from) ? "before" : "after";
}

export interface SessionReorder {
	/**
	 * The drag props of a row: the split drag while a tab holds the session and is not on screen, the reorder while
	 * the row is in a list.
	 */
	rowDrag: (
		path: string,
		list: SessionList | null,
		tab: { id: string; shown: boolean } | undefined,
	) => HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | true | undefined>;
	/** Saves a new order for `list` and says so to a screen reader. */
	move: (list: SessionList, path: string, next: readonly string[], title: string) => void;
	/** The polite live region a drop, a menu move or Alt+↑/↓ is told through. */
	status: ReactNode;
}

/**
 * `titleOf` names a row for the announcement; `save` writes the list's order (under the caller's prefs key, so a
 * host's rows are kept apart from this computer's).
 */
export function useSessionReorder(options: {
	titleOf: (path: string) => string;
	save: (list: SessionList, next: readonly string[]) => void;
}): SessionReorder {
	const t = useT();
	const [drag, setDrag] = useState<{ list: SessionList; path: string; splits: boolean } | null>(null);
	const [drop, setDrop] = useState<Drop | null>(null);
	const [announcement, setAnnouncement] = useState("");

	const move: SessionReorder["move"] = (list, path, next, title) => {
		options.save(list, next);
		setAnnouncement(
			t("sidebar.sessionOrder.moved", { name: title, position: next.indexOf(path) + 1, count: next.length }),
		);
	};

	const finish = () => {
		setDrag(null);
		setDrop(null);
	};

	const rowDrag: SessionReorder["rowDrag"] = (path, list, tab) => {
		const splits = tab !== undefined && !tab.shown;
		const target = drag !== null && list !== null && drag.list.key === list.key && canDropOn(list, drag.path, path);
		return {
			draggable: splits || list !== null,
			onDragStart: (event: DragEvent<HTMLDivElement>) => {
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(SESSION_MIME, path);
				if (splits) {
					hideNativeDragImage(event.dataTransfer);
					window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: tab.id } }));
				}
				if (list) setDrag({ list, path, splits });
			},
			onDragOver: (event: DragEvent<HTMLDivElement>) => {
				if (!drag || !list || !target) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const edge = dropEdge(list.paths, drag.path, path);
				setDrop(current => (current?.path === path && current.edge === edge ? current : { path, edge }));
			},
			onDragLeave: (event: DragEvent<HTMLDivElement>) => {
				if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
				setDrop(current => (current?.path === path ? null : current));
			},
			onDrop: (event: DragEvent<HTMLDivElement>) => {
				if (!drag || !list || !target) return;
				event.preventDefault();
				event.stopPropagation();
				const from = drag.path;
				const next = reorderProjects(list.paths, from, path);
				if (drag.splits) window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } }));
				finish();
				if (next.join("\n") !== list.paths.join("\n")) move(list, from, next, options.titleOf(from));
			},
			onDragEnd: () => {
				if (splits) window.dispatchEvent(new CustomEvent("omp:tab-drag", { detail: { tabId: null } }));
				finish();
			},
			"data-session-dragging": drag?.path === path || undefined,
			"data-session-drop": drop?.path === path ? drop.edge : undefined,
		};
	};

	return {
		rowDrag,
		move,
		status: (
			<span aria-live="polite" className="sr-only" data-session-order-status role="status">
				{announcement}
			</span>
		),
	};
}
