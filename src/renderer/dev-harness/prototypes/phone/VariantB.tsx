import { ArrowUp, ChevronDown, CornerDownRight, ListPlus, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../../components/common";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useEnv } from "./Frame";
import { useSession } from "./fake";
import { useSend } from "./logic";
import { keepFocus } from "./ProtoSheet";
import {
	AttachmentStrip,
	CompletionMenu,
	ExpandedHead,
	Field,
	SendCluster,
	Suggestions,
	usePlaceholder,
} from "./parts";
import { QueueTray } from "./queue";
import { RunControlsSheet } from "./sheets";

/** While a turn runs with a draft: "↑ Steer | ⌄" is the Send button, the label IS the mode, the chevron flips it. */
function SplitSend() {
	const t = useT();
	const { s, set, act } = useSession();
	const { send } = useSend();
	const label = s.sendMode === "followUp" ? t("input.followUp") : t("input.steer");
	const Icon = s.sendMode === "followUp" ? ListPlus : CornerDownRight;
	return (
		<div className="pp-split" data-send-mode={s.sendMode} role="group">
			<button {...keepFocus} aria-label={`${t("input.send")} · ${label}`} data-send="" onClick={send} type="button">
				<ArrowUp aria-hidden className="size-(--sc-icon-sm)" strokeWidth={2.25} />
				<span>{label}</span>
			</button>
			<button
				{...keepFocus}
				aria-label={t("input.sendModeLabel", { mode: label })}
				data-send-mode-flip=""
				onClick={() => {
					const next = s.sendMode === "followUp" ? "steer" : "followUp";
					act("send-mode", next);
					set({ sendMode: next });
				}}
				type="button"
			>
				<Icon aria-hidden className="size-(--sc-icon-sm)" />
				<ChevronDown aria-hidden className="size-(--sc-icon-sm)" />
			</button>
		</div>
	);
}

/**
 * B — ONE "Run controls" sheet. Idle: `[⋯] [field] [Send]`; ⋯ (sliders glyph, with a dot while anything differs from the
 * default) opens a bottom sheet that shows every live value as a row that changes in place: attach / history / expand /
 * voice tiles, Thinking, Mode and Tool approval as segmented controls, Model and Delegation as rows that fold open,
 * Context with Compact. The sheet never takes focus (field + soft keyboard stay), stays open for several changes.
 * Return is a new line on touch (Send button or ⌘/Ctrl+Return sends), like every phone chat app.
 */
export function VariantB() {
	const t = useT();
	const { s, set, fieldRef, state } = useSession();
	const { visibleH, kbUp } = useEnv();
	const placeholder = usePlaceholder();
	const [open, setOpen] = useState(state === "more-open");
	const [editId] = useState<number | null>(null);
	const regionRef = useRef<HTMLDivElement>(null);
	const refocus = useRef(false);
	useEffect(() => {
		refocus.current = kbUp;
	}, [kbUp]);
	const menu = s.text.startsWith("/") && !s.text.includes(" ");
	const chips =
		s.suggestions && !s.running && s.text === "" && s.images.length === 0 && visibleH >= 420 && !s.expanded && !menu;
	const nonDefault = s.mode !== "agent" || s.approval !== "yolo";

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
					<QueueTray editId={editId} onActions={() => {}} style="tap" />
					{chips && <Suggestions />}
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-expanded={s.expanded || undefined}
						data-pp="b"
					>
						{s.expanded && <ExpandedHead />}
						<AttachmentStrip
							images={s.images}
							onDropPaste={() => set({ pastes: 0 })}
							onRemove={id => set(current => ({ images: current.images.filter(image => image.id !== id) }))}
							pastes={s.pastes}
						/>
						<Field enterMode="newline" placeholder={placeholder} />
						<div
							aria-label={t("input.toolbar")}
							className="omp-composer-toolbar flex min-h-8 items-center"
							role="toolbar"
						>
							<span className="relative inline-flex">
								<IconButton
									{...keepFocus}
									aria-expanded={open}
									aria-haspopup="dialog"
									icon={<SlidersHorizontal />}
									data-more=""
									label={t("input.moreControls")}
									onClick={() => setOpen(value => !value)}
									size="md"
									tooltip={false}
								/>
								{nonDefault && (
									<span
										aria-hidden
										className="pointer-events-none absolute top-0.5 right-0.5 size-2 rounded-full bg-(--sc-accent) ring-2 ring-(--sc-field)"
										data-state-dot=""
									/>
								)}
							</span>
							<SendCluster splitSend={<SplitSend />} />
						</div>
					</div>
				</div>
			</div>
			<RunControlsSheet
				onClose={() => setOpen(false)}
				onClosed={() => {
					if (refocus.current) requestAnimationFrame(() => fieldRef.current?.focus());
				}}
				open={open}
			/>
		</div>
	);
}
