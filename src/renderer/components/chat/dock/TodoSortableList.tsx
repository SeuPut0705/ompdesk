/**
 * The todo dock card's task list: phase sections with drag reorder (@dnd-kit),
 * status cycling and inline edit. Split from TodoDockCard so @dnd-kit loads
 * with the first todo list instead of at app startup — TodoDockCard imports
 * this module lazily.
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AlertCircle, Check, CheckCircle2, Circle, GripVertical, Pencil, X, XCircle } from "lucide-react";
import { memo, useCallback, useState } from "react";
import type { TodoTask } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { onEscape } from "../../../lib/keymap";
import type { UiTodoPhase, UiTodoTask } from "../../../stores/todo";
import { DisclosureButton, IconButton } from "../../common";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from "../../common/ContextMenu";

const STATUS_LABEL_KEY: Record<TodoTask["status"], string> = {
	pending: "todoPanel.status.pending",
	in_progress: "todoPanel.status.inProgress",
	completed: "todoPanel.status.completed",
	blocked: "todoPanel.status.blocked",
	abandoned: "todoPanel.status.abandoned",
};

/**
 * Blocked and abandoned are verdicts about a task, not steps on the way to done,
 * so they stay out of the click loop: one click on a finished task used to claim
 * it was stuck, which the agent then re-planned around. They are set from the
 * row's context menu, and a click on such a task returns it to pending.
 */
const STATUS_CYCLE: TodoTask["status"][] = ["pending", "in_progress", "completed"];

function nextStatus(current: TodoTask["status"]): TodoTask["status"] {
	return STATUS_CYCLE[(STATUS_CYCLE.indexOf(current) + 1) % STATUS_CYCLE.length] ?? "pending";
}

function TodoStatusIcon({ status }: { status: TodoTask["status"] }) {
	if (status === "in_progress") {
		return <span aria-hidden="true" className="size-2 rounded-full bg-(--sc-accent)" />;
	}
	if (status === "completed") {
		return <CheckCircle2 aria-hidden="true" className="text-(--sc-text-muted)" size={16} />;
	}
	if (status === "blocked" || status === "abandoned") {
		return <AlertCircle aria-hidden="true" className="text-(--sc-danger)" size={16} />;
	}
	return <Circle aria-hidden="true" className="text-(--sc-text-subtle)" size={16} strokeDasharray="2.5 2.5" />;
}

interface SortableTaskRowProps {
	task: UiTodoTask;
	phaseId: string;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
}

const SortableTaskRow = memo(function SortableTaskRow({ task, phaseId, onPatch }: SortableTaskRowProps) {
	const t = useT();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(task.content);
	const [statusMenu, setStatusMenu] = useState<ContextMenuAnchor>();
	const statusItems: ContextMenuItem[] = [
		{
			id: "blocked",
			icon: AlertCircle,
			label: t("todoPanel.markBlocked"),
			onSelect: () => {
				setStatusMenu(undefined);
				onPatch(phaseId, task.id, { status: "blocked" });
			},
		},
		{
			danger: true,
			id: "abandoned",
			icon: XCircle,
			label: t("todoPanel.markAbandoned"),
			onSelect: () => {
				setStatusMenu(undefined);
				onPatch(phaseId, task.id, { status: "abandoned" });
			},
		},
	];
	const commit = () => {
		const content = draft.trim();
		setEditing(false);
		if (content && content !== task.content) onPatch(phaseId, task.id, { content });
		else setDraft(task.content);
	};

	return (
		<div
			className={`group flex min-h-8 items-center gap-2 rounded-(--sc-radius-md) py-0.5 pr-1 pl-0.5 text-sc-md transition-colors ${
				isDragging ? "z-10 bg-(--sc-selected) shadow-(--sc-shadow-md)" : "hover:bg-(--sc-hover)"
			}`}
			ref={setNodeRef}
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
					: undefined,
				transition,
			}}
		>
			<IconButton
				className="cursor-grab opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-100"
				icon={<GripVertical />}
				label={t("todoPanel.reorder")}
				size="sm"
				tooltip={false}
				{...attributes}
				{...listeners}
			/>
			<IconButton
				className="rounded-(--sc-radius-full)"
				icon={<TodoStatusIcon status={task.status} />}
				label={t("todoPanel.statusAria", {
					status: t(STATUS_LABEL_KEY[task.status] ?? "todoPanel.status.pending"),
				})}
				onClick={() => onPatch(phaseId, task.id, { status: nextStatus(task.status) })}
				onContextMenu={event => setStatusMenu(anchorFromEvent(event))}
				size="sm"
				title={t("todoPanel.cycleHint")}
				tooltip={false}
			/>
			{statusMenu && (
				<ContextMenu
					items={statusItems}
					onClose={() => setStatusMenu(undefined)}
					x={statusMenu.x}
					y={statusMenu.y}
				/>
			)}
			{editing ? (
				<span className="flex min-w-0 flex-1 items-center gap-1">
					<input
						aria-label={t("todoPanel.edit")}
						autoFocus
						className="w-full min-w-0 rounded-(--sc-radius-sm) border border-(--sc-accent) bg-(--sc-field) px-1.5 py-0.5 text-sc-md text-(--sc-text) focus:outline-none"
						onBlur={commit}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") commit();
							onEscape(event, () => {
								setDraft(task.content);
								setEditing(false);
							});
						}}
						value={draft}
					/>
					<IconButton icon={<Check />} label={t("common.save")} onClick={commit} size="sm" />
					<IconButton
						icon={<X />}
						label={t("common.cancel")}
						onClick={() => {
							setDraft(task.content);
							setEditing(false);
						}}
						size="sm"
					/>
				</span>
			) : (
				<>
					<span
						className={`min-w-0 flex-1 truncate ${
							task.status === "abandoned"
								? "text-(--sc-text-subtle) line-through"
								: task.status === "completed"
									? "text-(--sc-text-muted)"
									: "text-(--sc-text)"
						}`}
						onDoubleClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						title={task.content}
					>
						{task.content}
					</span>
					<IconButton
						className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
						icon={<Pencil />}
						label={t("todoPanel.edit")}
						onClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						size="sm"
					/>
				</>
			)}
		</div>
	);
});

function PhaseSection({
	phase,
	fullPhase,
	hideHeader,
	collapsed,
	onToggle,
	onPatch,
}: {
	phase: UiTodoPhase;
	fullPhase?: UiTodoPhase;
	hideHeader: boolean;
	collapsed: boolean;
	onToggle: () => void;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
}) {
	const t = useT();
	const countSource = fullPhase ?? phase;
	const done = countSource.tasks.filter(task => task.status === "completed").length;
	const total = countSource.tasks.length;

	return (
		<section className="mb-1.5">
			{!hideHeader && (
				<DisclosureButton
					chevronClassName="size-3.5 text-(--sc-text-subtle)"
					className="gap-1.5 rounded-(--sc-radius-sm) px-1.5 py-1 transition-colors hover:bg-(--sc-hover)"
					onToggle={onToggle}
					open={!collapsed}
				>
					<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-secondary)">
						{phase.name}
					</span>
					<span className="shrink-0 text-sc-2xs tabular-nums text-(--sc-text-muted)">
						{done}/{total}
					</span>
				</DisclosureButton>
			)}
			{(hideHeader || !collapsed) && (
				<SortableContext items={phase.tasks.map(task => task.id)} strategy={verticalListSortingStrategy}>
					<div className={hideHeader ? "px-0.5" : "ml-2 border-l border-(--sc-border-subtle) pl-2"}>
						{phase.tasks.map(task => (
							<SortableTaskRow key={task.id} onPatch={onPatch} phaseId={phase.id} task={task} />
						))}
						{total === 0 && (
							<div className="py-1 text-sc-sm text-(--sc-text-muted)">{t("todoPanel.noTasks")}</div>
						)}
					</div>
				</SortableContext>
			)}
		</section>
	);
}

export function TodoSortableList({
	phases,
	displayedPhases,
	collapsed,
	onToggle,
	onPatch,
	onReorder,
}: {
	/** Every phase, for reorder lookups and section counts. */
	phases: UiTodoPhase[];
	/** The phases actually shown (all, or the dock's compact summary). */
	displayedPhases: UiTodoPhase[];
	collapsed: ReadonlySet<string>;
	onToggle: (phaseId: string) => void;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
	onReorder: (next: UiTodoPhase[]) => void;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const phase = phases.find(p => p.tasks.some(task => task.id === active.id));
			if (!phase) return;
			const from = phase.tasks.findIndex(task => task.id === active.id);
			const to = phase.tasks.findIndex(task => task.id === over.id);
			if (from < 0 || to < 0) return;
			onReorder(phases.map(p => (p.id === phase.id ? { ...p, tasks: arrayMove(p.tasks, from, to) } : p)));
		},
		[phases, onReorder],
	);

	return (
		<DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
			{displayedPhases.map(phase => (
				<PhaseSection
					collapsed={collapsed.has(phase.id)}
					fullPhase={phases.find(candidate => candidate.id === phase.id)}
					hideHeader={displayedPhases.length === 1}
					key={phase.id}
					onPatch={onPatch}
					onToggle={() => onToggle(phase.id)}
					phase={phase}
				/>
			))}
		</DndContext>
	);
}
