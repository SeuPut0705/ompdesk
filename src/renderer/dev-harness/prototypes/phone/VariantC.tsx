import { Plus } from "lucide-react";
import { useState } from "react";
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
	SendCluster,
	StatusChips,
	usePlaceholder,
} from "./parts";
import { QueueTray } from "./queue";
import { ChipSheets, QueueActionsSheet, type SheetId } from "./sheets";
import { useP } from "./strings";

/**
 * C — status chip row. The box is the one-row field `[+] [field] [Send]` (no ⋯). ABOVE it a single sideways-scrolling
 * row of live chips: model · thinking, Plan (a direct toggle), approval, delegation, context %; after them, the
 * prompt suggestions (the same row, so idle chrome stays one row). Each chip opens its own small sheet and applies on
 * tap. The row hides while the keyboard is up (the steer/follow-up text stays inside the box). The empty Send slot is
 * the mic when dictation is on. Return sends; a long press on Send is the new line.
 */
export function VariantC() {
	const t = useT();
	const p = useP();
	const { s, set, fieldRef, state } = useSession();
	const { visibleH, kbUp } = useEnv();
	const placeholder = usePlaceholder();
	const [sheet, setSheet] = useState<SheetId | null>(state === "more-open" ? "model" : null);
	const [actionsFor, setActionsFor] = useState<number | null>(null);
	const [editId, setEditId] = useState<number | null>(null);
	const menu = s.text.startsWith("/") && !s.text.includes(" ");
	const suggest = s.suggestions && !s.running && s.text === "" && s.images.length === 0 && !menu;
	const rowShown = !kbUp && !s.expanded && visibleH >= 420;
	const refocus = () => requestAnimationFrame(() => fieldRef.current?.focus());

	return (
		<div
			className={cx(
				"omp-composer-region relative shrink-0 bg-transparent pb-3",
				s.expanded && "omp-composer-region--expanded",
			)}
			data-proto-region=""
		>
			<div className="omp-composer-shell relative w-full">
				<div className="omp-composer-anchor relative">
					{menu && <CompletionMenu />}
					{rowShown && (
						<div className="pp-c-row" data-c-row="">
							<StatusChips
								onOpen={setSheet}
								trailing={
									suggest ? (
										<>
											<span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-(--sc-divider)" />
											{[p("pp.suggest1"), p("pp.suggest2")].map(text => (
												<button
													{...keepFocus}
													className="omp-next-chip pp-chip shrink-0 max-w-[70vw] truncate"
													key={text}
													onClick={() => {
														set({ text });
														fieldRef.current?.focus();
													}}
													type="button"
												>
													{text}
												</button>
											))}
										</>
									) : undefined
								}
							/>
						</div>
					)}
					<QueueTray editId={editId} onActions={setActionsFor} setEditId={setEditId} style="chip" />
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-expanded={s.expanded || undefined}
						data-pp="c"
					>
						{s.expanded && <ExpandedHead />}
						<AttachmentStrip
							images={s.images}
							onDropPaste={() => set({ pastes: 0 })}
							onRemove={id => set(current => ({ images: current.images.filter(image => image.id !== id) }))}
							pastes={s.pastes}
						/>
						<Field enterMode="send" placeholder={placeholder} />
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
							<SendCluster longPressNewline micWhenEmpty modeText />
						</div>
					</div>
				</div>
			</div>
			<ChipSheets
				includeModes
				onClose={() => setSheet(null)}
				onClosed={() => {
					if (kbUp) refocus();
				}}
				open={sheet}
				runRows={rowShown ? undefined : setSheet}
			/>
			<QueueActionsSheet itemId={actionsFor} onClose={() => setActionsFor(null)} onEdit={setEditId} />
		</div>
	);
}
