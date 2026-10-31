/**
 * What the bot remembers (Muse's Memory.md), as a section of its work board: one row per memory with who wrote it,
 * an Edit field and Forget in its menu, a field to add one, and Export (a Memory.md file) and Import (a Memory.md, any
 * Markdown or text list, or a JSON list; add to the memories or replace them). Every change goes through main
 * (`BOT_DESK_EDIT`) and shows when its push lands; a forgotten memory can be put back from the activity log.
 */
import { BookmarkCheck, Download, MoreHorizontal, NotebookPen, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { BOT_MEMORIES_MAX, BOT_MEMORY_TEXT_MAX, type BotMemory } from "../../../shared/bot-desk";
import { botMemoryMarkdown, parseBotMemoryImport } from "../../../shared/bot-desk-edit";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import { useBotDeskStore } from "../../stores/bot-desk";
import { toastError } from "../../stores/toast";
import { Button, IconButton, Input, MenuButton, Modal } from "../common";
import { BoardRow, KindMark } from "../layout/work-board/board-parts";

/** Saves a text file the way the log panel does: a download the window or the phone's browser hands to the person. */
function download(name: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MemoryRow({ memory, device }: { memory: BotMemory; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(memory.text);
	if (editing)
		return (
			<li className="omp-work-board-item flex items-center gap-1.5 py-1">
				<div className="min-w-0 flex-1">
					<Input
						aria-label={t("botMemory.editLabel")}
						autoFocus
						controlSize="sm"
						data-bot-memory-edit={memory.id}
						maxLength={BOT_MEMORY_TEXT_MAX}
						onBlur={() => setEditing(false)}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							onEscape(event, () => setEditing(false));
							if (event.key !== "Enter") return;
							event.preventDefault();
							const text = draft.trim();
							setEditing(false);
							if (text && text !== memory.text) void edit({ op: "memory_edit", id: memory.id, text }, device);
						}}
						value={draft}
					/>
				</div>
			</li>
		);
	return (
		<BoardRow
			action={
				<MenuButton
					align="end"
					icon={<MoreHorizontal />}
					items={[
						{
							id: "edit",
							label: t("botMemory.edit"),
							icon: Pencil,
							onSelect: () => {
								setDraft(memory.text);
								setEditing(true);
							},
						},
						{
							id: "forget",
							label: t("botMemory.forget"),
							icon: Trash2,
							danger: true,
							onSelect: () => void edit({ op: "memory_forget", id: memory.id }, device),
						},
					]}
					label={t("botMemory.menu")}
					size="sm"
				/>
			}
			data={{ "data-bot-memory": memory.id, "data-bot-memory-by": memory.by }}
			label={memory.text}
			lead={<KindMark icon={memory.by === "bot" ? BookmarkCheck : NotebookPen} tone="muted" />}
			title={`${memory.text}\n${t(`botMemory.by.${memory.by}`)}`}
		/>
	);
}

export function BotMemoryRows({ memories, device }: { memories: readonly BotMemory[]; device?: string }) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const [draft, setDraft] = useState("");
	const [pending, setPending] = useState(false);
	const full = memories.length >= BOT_MEMORIES_MAX;
	const add = async () => {
		const text = draft.trim();
		if (!text || full || pending) return;
		setPending(true);
		const ok = await edit({ op: "memory_add", text }, device);
		setPending(false);
		if (ok) setDraft("");
	};
	return (
		<>
			{memories.map(memory => (
				<MemoryRow device={device} key={memory.id} memory={memory} />
			))}
			<li className="omp-work-board-item flex items-center gap-1.5 py-1">
				<div className="min-w-0 flex-1">
					<Input
						aria-label={t("botMemory.addLabel")}
						controlSize="sm"
						data-bot-memory-input
						disabled={full || pending}
						maxLength={BOT_MEMORY_TEXT_MAX}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void add();
							}
						}}
						placeholder={full ? t("botMemory.full") : t("botMemory.addPlaceholder")}
						value={draft}
					/>
				</div>
				<IconButton
					data-bot-memory-add
					disabled={full || pending || draft.trim() === ""}
					icon={<Plus />}
					label={t("botMemory.addLabel")}
					onClick={() => void add()}
					size="sm"
				/>
			</li>
		</>
	);
}

/** The section's Export and Import, beside its title. */
export function BotMemoryActions({
	memories,
	name,
	device,
}: {
	memories: readonly BotMemory[];
	name: string;
	device?: string;
}) {
	const t = useT();
	const edit = useBotDeskStore(state => state.edit);
	const fileRef = useRef<HTMLInputElement>(null);
	const [incoming, setIncoming] = useState<{ file: string; texts: string[] } | null>(null);
	const read = async (file: File | undefined) => {
		if (!file) return;
		try {
			const texts = parseBotMemoryImport(await file.text());
			if (texts.length === 0) toastError({ title: t("botMemory.importEmpty"), error: file.name });
			else setIncoming({ file: file.name, texts });
		} catch (error) {
			toastError({ title: t("botMemory.importFailed"), error });
		}
	};
	const apply = async (replace: boolean) => {
		if (!incoming) return;
		if (await edit({ op: "memory_import", texts: incoming.texts, replace }, device)) setIncoming(null);
	};
	return (
		<>
			<IconButton
				data-bot-memory-export
				disabled={memories.length === 0}
				icon={<Download />}
				label={t("botMemory.export")}
				onClick={() => download("Memory.md", botMemoryMarkdown(memories, name))}
				size="sm"
			/>
			<IconButton
				data-bot-memory-import
				icon={<Upload />}
				label={t("botMemory.import")}
				onClick={() => fileRef.current?.click()}
				size="sm"
			/>
			<input
				accept=".md,.markdown,.txt,.json,text/plain,text/markdown,application/json"
				aria-hidden
				className="hidden"
				data-bot-memory-file
				onChange={event => {
					void read(event.target.files?.[0]);
					event.target.value = "";
				}}
				ref={fileRef}
				tabIndex={-1}
				type="file"
			/>
			<Modal
				description={
					incoming ? t("botMemory.importDesc", { count: String(incoming.texts.length), file: incoming.file }) : ""
				}
				footer={
					<>
						<Button data-bot-memory-import-replace onClick={() => void apply(true)} variant="secondary">
							{t("botMemory.importReplace")}
						</Button>
						<Button data-bot-memory-import-add onClick={() => void apply(false)}>
							{t("botMemory.importAdd")}
						</Button>
					</>
				}
				onClose={() => setIncoming(null)}
				open={incoming !== null}
				size="sm"
				title={t("botMemory.importTitle")}
			>
				<ul className="flex max-h-60 flex-col gap-1 overflow-y-auto text-sc-sm text-(--sc-text-muted)">
					{incoming?.texts.map(text => (
						<li className="truncate" key={text} title={text}>
							{text}
						</li>
					))}
				</ul>
			</Modal>
		</>
	);
}
