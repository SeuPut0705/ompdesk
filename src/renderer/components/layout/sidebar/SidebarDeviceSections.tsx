/**
 * The sidebar's device sections (this device and each paired host) in the order the user set, reordered by dragging a
 * section's header. Only the header is a handle (rows keep their own drags): a mouse drag arms after a short move so a
 * click still folds the section; on touch a long press arms it, so a tap folds and a swipe scrolls. Nothing moves while
 * dragging: an accent line marks where the section lands and a chip with its name follows the pointer, with no drop
 * animation. The keyboard path is Alt+↑/↓ on a focused header, and the header's context menu (right click, Shift+F10)
 * has Move up / Move down. The order lives in the device-local `sidebarFolds` record (`deviceOrder`), so a paired web
 * page keeps its own order and the first frame paints it from the mirror.
 */
import {
	type ClientRect,
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	type DragStartEvent,
	PointerSensor,
	type PointerSensorOptions,
	pointerWithin,
	TouchSensor,
	useDndMonitor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { ArrowDown, ArrowUp, Monitor } from "lucide-react";
import {
	createContext,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type TouchEvent as ReactTouchEvent,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { moveDevice, orderDevices } from "../../../lib/device-order";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { reorderProjects } from "../../../lib/project-order";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../../common/ContextMenu";

export interface DeviceSection {
	/** `LOCAL_DEVICE` or a paired host's deviceId. */
	id: string;
	/** The device's name, for the drag chip and announcements. */
	label: string;
	node: ReactNode;
}

/** Props a section header spreads onto its toggle button: the drag handle and the keyboard and menu paths. */
export interface DeviceHeaderHandle {
	ref: (element: HTMLElement | null) => void;
	onPointerDown?: (event: ReactPointerEvent) => void;
	onTouchStart?: (event: ReactTouchEvent) => void;
	onKeyDown: (event: ReactKeyboardEvent) => void;
	onContextMenu: (event: ReactMouseEvent) => void;
	"aria-describedby"?: string;
	"aria-keyshortcuts": string;
	"data-device-drag-handle": string;
	"data-dragging"?: true;
}

const HeaderHandleContext = createContext<DeviceHeaderHandle | undefined>(undefined);

/** The handle of the section a header sits in; undefined outside a reorderable list (no host paired). */
export function useDeviceHeaderHandle(): DeviceHeaderHandle | undefined {
	return useContext(HeaderHandleContext);
}

type Drop = { over: string; edge: "before" | "after" };

// A section is a tall target: the pointer's own section decides, the nearest one when it is in a gap or past the ends.
const collision: CollisionDetection = args => {
	const within = pointerWithin(args);
	return within.length > 0 ? within : closestCenter(args);
};

/** How long a finger rests on a header before it lifts the section; any move before that is a scroll or tap. */
const TOUCH_HOLD_MS = 400;
const TOUCH_TOLERANCE_PX = 8;

/**
 * The pointer sensor for a mouse or pen only: a finger goes through `TouchSensor`, whose touch events can still stop
 * the page scrolling once the long press lifted the section (a pointer drag on touch is cancelled by the scroll).
 */
class MouseOrPenSensor extends PointerSensor {
	static activators = [
		{
			eventName: "onPointerDown" as const,
			handler: (event: ReactPointerEvent, options: PointerSensorOptions) =>
				event.nativeEvent.pointerType !== "touch" &&
				(PointerSensor.activators[0]?.handler(event, options) ?? false),
		},
	];
}

export function SidebarDeviceSections({ sections }: { sections: readonly DeviceSection[] }) {
	const t = useT();
	const touch = useShellInput() === "touch";
	const saved = useSidebarFolds(s => s.deviceOrder);
	const byId = new Map(sections.map(section => [section.id, section]));
	const order = orderDevices(
		sections.map(section => section.id),
		saved,
	);
	const [active, setActive] = useState<string | null>(null);
	const [drop, setDrop] = useState<Drop | null>(null);
	const [menu, setMenu] = useState<{ id: string; anchor: ContextMenuAnchor } | null>(null);
	// What a keyboard or menu move tells a screen reader (dnd-kit announces only pointer drags).
	const [announcement, setAnnouncement] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	// The header a keyboard move left focused: re-focused and kept in view, since moving a node can drop its focus.
	const refocus = useRef<string | null>(null);
	const sensors = useSensors(
		useSensor(MouseOrPenSensor, { activationConstraint: { distance: 6 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_TOLERANCE_PX } }),
	);

	useLayoutEffect(() => {
		const id = refocus.current;
		if (id === null) return;
		refocus.current = null;
		const header = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-device-drag-handle]") ?? [])].find(
			element => element.dataset.deviceDragHandle === id,
		);
		header?.scrollIntoView?.({ block: "nearest" });
		if (header && document.activeElement !== header) header.focus({ preventScroll: true });
	});

	const move = (id: string, delta: number) => {
		const next = moveDevice(order, id, delta);
		if (next.join("\n") === order.join("\n")) return;
		refocus.current = id;
		setAnnouncement(t("sidebar.deviceOrder.moved", { name: label(id) }));
		useSidebarFolds.getState().setDeviceOrder(next);
	};

	const onDragStart = ({ active: dragged }: DragStartEvent) => {
		setActive(String(dragged.id));
		setMenu(null);
	};
	const onDragOver = ({ active: dragged, over }: DragOverEvent) => {
		const from = order.indexOf(String(dragged.id));
		const to = over ? order.indexOf(String(over.id)) : -1;
		setDrop(to === -1 || to === from ? null : { over: String(over?.id), edge: to < from ? "before" : "after" });
	};
	const finish = () => {
		setActive(null);
		setDrop(null);
	};
	const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
		finish();
		if (over && over.id !== dragged.id)
			useSidebarFolds.getState().setDeviceOrder(reorderProjects(order, String(dragged.id), String(over.id)));
	};

	const label = (id: unknown) => byId.get(String(id))?.label ?? String(id);
	const menuIndex = menu ? order.indexOf(menu.id) : -1;

	return (
		<div data-device-sections ref={listRef}>
			<span aria-live="polite" className="sr-only" role="status">
				{announcement}
			</span>
			<DndContext
				accessibility={{
					announcements: {
						onDragStart: ({ active: item }) => t("sidebar.deviceOrder.picked", { name: label(item.id) }),
						onDragOver: ({ over }) =>
							over ? t("sidebar.deviceOrder.over", { name: label(over.id) }) : undefined,
						onDragEnd: ({ active: item, over }) =>
							over && over.id !== item.id
								? t("sidebar.deviceOrder.moved", { name: label(item.id) })
								: t("sidebar.deviceOrder.cancelled", { name: label(item.id) }),
						onDragCancel: ({ active: item }) => t("sidebar.deviceOrder.cancelled", { name: label(item.id) }),
					},
					screenReaderInstructions: { draggable: t("sidebar.deviceOrder.instructions") },
				}}
				collisionDetection={collision}
				onDragCancel={finish}
				onDragEnd={onDragEnd}
				onDragOver={onDragOver}
				onDragStart={onDragStart}
				sensors={sensors}
			>
				{order.map((id, index) => {
					const section = byId.get(id);
					if (!section) return null;
					return (
						<DeviceSlot
							dragging={active === id}
							drop={drop?.over === id ? drop.edge : undefined}
							first={index === 0}
							id={id}
							key={id}
							onKeyMove={delta => move(id, delta)}
							onMenu={anchor => setMenu({ id, anchor })}
							touch={touch}
						>
							{section.node}
						</DeviceSlot>
					);
				})}
				<DragChip label={label} />
			</DndContext>
			{menu && (
				<ContextMenu
					ariaLabel={t("sidebar.deviceOrder.menu", { name: label(menu.id) })}
					items={[
						{
							id: "device-move-up",
							label: t("sidebar.menu.moveUp"),
							icon: ArrowUp,
							disabled: menuIndex <= 0,
							onSelect: () => {
								setMenu(null);
								move(menu.id, -1);
							},
						},
						{
							id: "device-move-down",
							label: t("sidebar.menu.moveDown"),
							icon: ArrowDown,
							disabled: menuIndex === -1 || menuIndex >= order.length - 1,
							onSelect: () => {
								setMenu(null);
								move(menu.id, 1);
							},
						},
					]}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
		</div>
	);
}

function DeviceSlot({
	id,
	first,
	dragging,
	drop,
	touch,
	onKeyMove,
	onMenu,
	children,
}: {
	id: string;
	first: boolean;
	dragging: boolean;
	drop: Drop["edge"] | undefined;
	touch: boolean;
	onKeyMove: (delta: number) => void;
	onMenu: (anchor: ContextMenuAnchor) => void;
	children: ReactNode;
}) {
	const { setNodeRef: setDragRef, listeners, attributes } = useDraggable({ id });
	const { setNodeRef: setDropRef } = useDroppable({ id });
	const handle: DeviceHeaderHandle = {
		ref: setDragRef,
		...(listeners as Pick<DeviceHeaderHandle, "onPointerDown" | "onTouchStart">),
		// Only the instructions: the rest of dnd-kit's attributes (role, tabIndex 0) would break the list's roving focus.
		"aria-describedby": attributes["aria-describedby"],
		onKeyDown: event => {
			if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
				event.preventDefault();
				event.stopPropagation();
				onKeyMove(event.key === "ArrowUp" ? -1 : 1);
			} else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
				event.preventDefault();
				event.stopPropagation();
				const rect = event.currentTarget.getBoundingClientRect();
				onMenu({
					x: Number.isFinite(rect.left) ? rect.left : 8,
					y: (Number.isFinite(rect.bottom) ? rect.bottom : 40) + 4,
				});
			}
		},
		onContextMenu: event => {
			event.preventDefault();
			// On touch the shell turns a long press into a context menu: that press lifts the section instead.
			if (!touch) onMenu(anchorFromEvent(event));
		},
		"aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
		"data-device-drag-handle": id,
		...(dragging ? { "data-dragging": true as const } : {}),
	};
	return (
		<div
			className={cx("relative", !first && "mt-3", dragging && "opacity-50")}
			data-device-slot={id}
			data-drop={drop}
			ref={setDropRef}
		>
			{drop && (
				<div
					aria-hidden
					className={cx(
						"pointer-events-none absolute inset-x-1 z-(--sc-z-raised) h-0.5 rounded-full bg-(--sc-accent)",
						drop === "after" ? "-bottom-[7px]" : first ? "top-0" : "-top-[7px]",
					)}
					data-device-drop-indicator={drop}
				/>
			)}
			<HeaderHandleContext.Provider value={handle}>{children}</HeaderHandleContext.Provider>
		</div>
	);
}

/**
 * The chip that follows the pointer while a section is dragged: the header's place plus the drag's delta, drawn over
 * everything in a fixed layer. Its own component, so a pointer move re-renders only it.
 */
function DragChip({ label }: { label: (id: unknown) => string }) {
	const [drag, setDrag] = useState<{ name: string; from: ClientRect | null; x: number; y: number } | null>(null);
	useDndMonitor({
		// dnd-kit measures the header's rect after it dispatched the start: the first move reads it.
		onDragStart: ({ active }) => setDrag({ name: label(active.id), from: active.rect.current.initial, x: 0, y: 0 }),
		onDragMove: ({ active, delta }) =>
			setDrag(current => current && { ...current, from: current.from ?? active.rect.current.initial, ...delta }),
		onDragEnd: () => setDrag(null),
		onDragCancel: () => setDrag(null),
	});
	if (!drag?.from) return null;
	return createPortal(
		<div
			aria-hidden
			className="pointer-events-none fixed z-(--sc-z-tooltip) flex h-7 max-w-56 items-center gap-1.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-elevated) px-2 text-sc-xs font-medium text-(--sc-text) shadow-(--sc-shadow-md)"
			data-device-drag-chip
			style={{
				left: drag.from.left,
				top: drag.from.top,
				transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`,
			}}
		>
			<Monitor aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			<span className="min-w-0 truncate">{drag.name}</span>
		</div>,
		document.body,
	);
}
