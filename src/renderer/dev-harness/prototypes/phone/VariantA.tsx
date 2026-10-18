import { Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useEnv } from "./Frame";
import { useSession } from "./fake";
import { keepFocus } from "./ProtoSheet";
import {
	AttachmentStrip,
	CompletionMenu,
	ExpandedHead,
	Field,
	MicButton,
	SendCluster,
	StatusChips,
	Suggestions,
	usePlaceholder,
} from "./parts";
import { QueueTray } from "./queue";
import { ChipSheets, QueueActionsSheet, type SheetId } from "./sheets";

/**
 * A — the current one-row composer, repaired. Idle: `[+] [⋯] [field] [Send]`. ⋯ (a sliders glyph, so it is not the title
 * bar's ⋯) opens a SECOND row inside the box: live status chips (model · thinking, Plan, approval, delegation, context
 * %, mic). The field spans the box either way and Send never moves. The row closes itself: on send, on typing, on a
 * tap outside the composer and when a chip's sheet closes. Return sends (enterkeyhint=send); a visible ↵ key sits
 * before Send while the field is in use, and a long press on Send is the shortcut.
 */
export function VariantA() {
	const t = useT();
	const { s, set, fieldRef, state } = useSession();
	const { visibleH, kbUp } = useEnv();
	const placeholder = usePlaceholder();
	const rowId = useId();
	const regionRef = useRef<HTMLDivElement>(null);
	const [more, setMore] = useState(state === "more-open");
	const [sheet, setSheet] = useState<SheetId | null>(null);
	const [actionsFor, setActionsFor] = useState<number | null>(null);
	const [editId, setEditId] = useState<number | null>(null);
	const previousText = useRef(s.text);

	// Sent (or cleared): the row goes with the draft.
	useEffect(() => {
		if (previousText.current !== "" && s.text === "") setMore(false);
		previousText.current = s.text;
	}, [s.text]);

	// A tap outside the composer (and its sheets) closes the row.
	useEffect(() => {
		if (!more) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (regionRef.current?.contains(target) || (target as Element | null)?.closest?.("[data-proto-sheet]")) return;
			setMore(false);
		};
		document.addEventListener("pointerdown", onDown, true);
		return () => document.removeEventListener("pointerdown", onDown, true);
	}, [more]);

	const menu = s.text.startsWith("/") && !s.text.includes(" ");
	const chips =
		s.suggestions && !s.running && s.text === "" && s.images.length === 0 && visibleH >= 420 && !s.expanded && !menu;
	const refocus = () => requestAnimationFrame(() => fieldRef.current?.focus());

	return (
		<div
			className={cx(
				"omp-composer-region relative shrink-0 bg-transparent pb-3",
				s.expanded && "omp-composer-region--expanded",
			)}
			data-proto-region=""
			ref={regionRef}
		>
			<div className="omp-composer-shell relative w-full">
				<div className="omp-composer-anchor relative">
					{menu && <CompletionMenu />}
					<QueueTray editId={editId} onActions={setActionsFor} setEditId={setEditId} style="menu" />
					{chips && <Suggestions />}
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-expanded={s.expanded || undefined}
						data-pp="a"
					>
						{s.expanded && <ExpandedHead />}
						<AttachmentStrip
							images={s.images}
							onDropPaste={() => set({ pastes: 0 })}
							onRemove={id => set(current => ({ images: current.images.filter(image => image.id !== id) }))}
							pastes={s.pastes}
						/>
						<Field enterMode="send" onType={() => setMore(false)} placeholder={placeholder} />
						<div
							aria-label={t("input.toolbar")}
							className="omp-composer-toolbar flex min-h-8 items-center"
							role="toolbar"
						>
							<IconButton
								{...keepFocus}
								aria-haspopup="dialog"
								icon={<Plus />}
								data-plus=""
								label={t("input.addMenu")}
								onClick={() => setSheet("attach")}
								size="md"
								tooltip={false}
							/>
							<IconButton
								{...keepFocus}
								aria-controls={rowId}
								aria-expanded={more}
								className="omp-composer-more"
								icon={<SlidersHorizontal />}
								data-more=""
								label={t("input.moreControls")}
								onClick={() => setMore(open => !open)}
								size="md"
								tooltip={false}
							/>
							<SendCluster modeText newlineKey longPressNewline />
						</div>
						{more && (
							<div className="pp-more-row" id={rowId}>
								<StatusChips onOpen={setSheet} trailing={s.stt ? <MicButton /> : undefined} />
							</div>
						)}
					</div>
				</div>
			</div>
			<ChipSheets
				includeModes
				onClose={() => setSheet(null)}
				onClosed={() => {
					setMore(false);
					if (kbUp) refocus();
				}}
				open={sheet}
			/>
			<QueueActionsSheet itemId={actionsFor} onClose={() => setActionsFor(null)} onEdit={setEditId} />
		</div>
	);
}
