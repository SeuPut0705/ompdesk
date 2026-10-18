import {
	ArrowUp,
	ClipboardPaste,
	CornerDownLeft,
	Cpu,
	ListChecks,
	Mic,
	Minimize2,
	ShieldAlert,
	ShieldCheck,
	Square,
	Users,
	X,
} from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Button, IconButton } from "../../../components/common";
import { ComposerThumbnail } from "../../../components/layout/composer/ComposerThumbnail";
import { NextPromptChips } from "../../../components/layout/composer/NextPromptChips";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { useEnv } from "./Frame";
import { COMMANDS, type FakeImage, modelOf, useSession } from "./fake";
import { useFitField, useInsertNewline, useSend } from "./logic";
import { keepFocus } from "./ProtoSheet";
import { useP } from "./strings";

/* ── The field ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type EnterMode = "send" | "newline";

/**
 * The composer's text field: a 16 px textarea in the wrapper the phone grid (mobile.css) expects. `enterMode` is the
 * Return key's meaning on a touch keyboard; both go through the IME guard first (a Korean composition's Enter never
 * acts).
 */
export function Field({
	enterMode,
	placeholder,
	onType,
}: {
	enterMode: EnterMode;
	placeholder: string;
	onType?: () => void;
}) {
	const t = useT();
	const { s, set, fieldRef } = useSession();
	const { send } = useSend();
	useFitField(s.text, s.expanded);
	// Production's rule (InputArea NARROW_FIELD_PX): the long idle hint gives way to "Ask anything" below 290 px.
	const [narrow, setNarrow] = useState(false);
	useLayoutEffect(() => {
		const el = fieldRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setNarrow(el.clientWidth < 290));
		observer.observe(el);
		return () => observer.disconnect();
	}, [fieldRef]);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || isImeKeyEvent(event)) return;
		const sends = enterMode === "send" ? !event.shiftKey : event.metaKey || event.ctrlKey;
		if (!sends) return;
		event.preventDefault();
		send();
	};
	return (
		<div className={cx("relative px-4 pt-3 pb-1", s.expanded && "flex min-h-0 flex-1 flex-col")}>
			<textarea
				aria-label={t("input.ariaLabel")}
				autoCapitalize="sentences"
				autoCorrect="on"
				className={cx(
					"omp-composer-input block w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none",
					s.expanded ? "min-h-0 flex-1" : "max-h-[40vh] min-h-6",
				)}
				data-composer-input=""
				enterKeyHint={enterMode === "send" ? "send" : "enter"}
				onChange={event => {
					set({ text: event.target.value });
					onType?.();
				}}
				onKeyDown={onKeyDown}
				placeholder={narrow && !s.running ? t("input.placeholder.chat") : placeholder}
				ref={fieldRef}
				rows={s.expanded ? undefined : 1}
				spellCheck
				value={s.text}
			/>
		</div>
	);
}

export function usePlaceholder(): string {
	const t = useT();
	const { s } = useSession();
	if (s.running) return s.sendMode === "followUp" ? t("input.placeholder.followUp") : t("input.placeholder.streaming");
	return t("input.placeholder.idle");
}

/* ── Send, Stop, steer/follow-up, newline ──────────────────────────────────────────────────────────────────── */

export function SendButton({ longPressNewline }: { longPressNewline?: boolean }) {
	const t = useT();
	const { send, canSend } = useSend();
	const newline = useInsertNewline();
	const timer = useRef<number | null>(null);
	const longFired = useRef(false);
	const clear = () => {
		if (timer.current !== null) window.clearTimeout(timer.current);
		timer.current = null;
	};
	return (
		<IconButton
			{...keepFocus}
			className="omp-composer-action pp-send"
			data-send=""
			disabled={!canSend}
			icon={<ArrowUp strokeWidth={2.25} />}
			label={t("input.send")}
			onClick={() => {
				if (longFired.current) {
					longFired.current = false;
					return;
				}
				send();
			}}
			onContextMenu={event => longPressNewline && event.preventDefault()}
			onPointerCancel={clear}
			onPointerDown={event => {
				// No preventDefault here: see keepFocus (a cancelled pointerdown loses the click in WebKit).
				if (!longPressNewline || !canSend) return;
				longFired.current = false;
				timer.current = window.setTimeout(() => {
					longFired.current = true;
					newline();
				}, 450);
			}}
			onPointerLeave={clear}
			onPointerUp={clear}
			tooltip={false}
			variant="primary"
		/>
	);
}

export function StopButton({ secondary }: { secondary: boolean }) {
	const t = useT();
	const { set, act, fieldRef } = useSession();
	return (
		<IconButton
			{...keepFocus}
			className="omp-composer-action pp-send"
			data-stop=""
			icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
			label={t("input.abort")}
			onClick={() => {
				act("stop");
				set({ running: false });
				fieldRef.current?.focus();
			}}
			tooltip={false}
			variant={secondary ? "secondary" : "primary"}
		/>
	);
}

/** "Steer" / "Follow-up" as text, a tap flips it: the running row says what Send will do. */
export function ModeChip() {
	const t = useT();
	const { s, set, act } = useSession();
	const label = s.sendMode === "followUp" ? t("input.followUp") : t("input.steer");
	return (
		<Button
			{...keepFocus}
			aria-label={t("input.sendModeLabel", { mode: label })}
			className="pp-mode-chip"
			data-send-mode={s.sendMode}
			onClick={() => {
				const next = s.sendMode === "followUp" ? "steer" : "followUp";
				act("send-mode", next);
				set({ sendMode: next });
			}}
			size="sm"
			variant="secondary"
		>
			{label}
		</Button>
	);
}

export function NewlineKey() {
	const p = useP();
	const newline = useInsertNewline();
	return (
		<IconButton
			{...keepFocus}
			className="pp-key"
			data-newline=""
			icon={<CornerDownLeft />}
			label={p("pp.newline")}
			onClick={newline}
			tooltip={false}
			variant="secondary"
		/>
	);
}

export function MicButton({ primary }: { primary?: boolean }) {
	const t = useT();
	const { act } = useSession();
	return (
		<IconButton
			{...keepFocus}
			className={primary ? "omp-composer-action pp-send" : undefined}
			data-mic=""
			icon={<Mic />}
			label={t("voice.mic.start")}
			onClick={() => act("voice")}
			tooltip={false}
			variant={primary ? "secondary" : "ghost"}
		/>
	);
}

/**
 * The right end of the row: Stop (alone while a turn runs with nothing to send, beside Send with a draft), Send, and
 * what a variant adds (steer text chip, newline key, mic where the empty Send sits).
 */
export function SendCluster({
	modeText,
	newlineKey,
	micWhenEmpty,
	longPressNewline,
	splitSend,
}: {
	modeText?: boolean;
	newlineKey?: boolean;
	micWhenEmpty?: boolean;
	longPressNewline?: boolean;
	splitSend?: ReactNode;
}) {
	const { s, fieldRef } = useSession();
	const { hasDraft } = useSend();
	const { kbUp } = useEnv();
	const focused = typeof document !== "undefined" && document.activeElement === fieldRef.current;
	const stoppable = s.running;
	const showSend = !stoppable || hasDraft;
	const showMic = micWhenEmpty && s.stt && !hasDraft && !stoppable;
	return (
		<div className="omp-composer-send-cluster flex shrink-0 items-center">
			<div className="pp-actions flex items-center">
				{modeText && stoppable && hasDraft && <ModeChip />}
				{newlineKey && (kbUp || focused) && hasDraft && <NewlineKey />}
				{stoppable && <StopButton secondary={showSend} />}
				{splitSend && stoppable && hasDraft ? (
					splitSend
				) : showMic ? (
					<MicButton primary />
				) : (
					showSend && <SendButton longPressNewline={longPressNewline} />
				)}
			</div>
		</div>
	);
}

/* ── Attachments: one scrolling row, +N for what is off screen ─────────────────────────────────────────────── */

export const AttachmentStrip = memo(function AttachmentStrip({
	images,
	pastes,
	onRemove,
	onDropPaste,
}: {
	images: readonly FakeImage[];
	pastes: number;
	onRemove: (id: number) => void;
	onDropPaste: () => void;
}) {
	const t = useT();
	const p = useP();
	const list = useRef<HTMLUListElement>(null);
	const [hidden, setHidden] = useState(0);
	const [edge, setEdge] = useState({ start: false, end: false });
	const measure = useCallback(() => {
		const el = list.current;
		if (!el) return;
		const right = el.getBoundingClientRect().right;
		let off = 0;
		for (const child of Array.from(el.children) as HTMLElement[]) {
			if (child.dataset.thumb !== undefined && child.getBoundingClientRect().right > right + 1) off += 1;
		}
		setHidden(off);
		setEdge({ start: el.scrollLeft > 2, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the strip's content only triggers a re-measure of +N
	useLayoutEffect(measure, [measure, images.length, pastes]);
	useEffect(() => {
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [measure]);
	const gallery = images.map((image, index) => ({
		src: image.src,
		alt: t("input.attachmentAlt", { index: index + 1 }),
	}));
	if (images.length === 0 && pastes === 0) return null;
	return (
		<div
			className="pp-strip-wrap relative"
			data-edge-end={edge.end || undefined}
			data-edge-start={edge.start || undefined}
		>
			<ul
				aria-label={t("input.attachments")}
				className="pp-strip flex gap-3 overflow-x-auto px-3 pt-3 pb-1"
				onScroll={measure}
				ref={list}
			>
				{images.map((image, index) => (
					<li className="relative shrink-0" data-thumb="" key={image.id}>
						<ComposerThumbnail
							alt={t("input.attachmentAlt", { index: index + 1 })}
							className="size-12 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
							data={image.src}
							gallery={gallery}
							mimeType="image/jpeg"
							onRemove={() => onRemove(image.id)}
							src={image.src}
						/>
						<IconButton
							{...keepFocus}
							className="pp-thumb-remove absolute -top-2 -right-2 rounded-full! shadow-(--sc-shadow-sm) [--hit-gap-x:8px] [--hit-gap-y:8px]"
							icon={<X />}
							label={t("input.removeAttachment", { index: index + 1 })}
							onClick={() => onRemove(image.id)}
							size="md"
							tooltip={false}
							variant="secondary"
						/>
					</li>
				))}
				{pastes > 0 && (
					<li className="shrink-0 self-center">
						<button
							{...keepFocus}
							className="flex h-7 items-center gap-1.5 rounded-(--sc-radius-full) border border-(--sc-border-subtle) px-2.5 text-sc-xs text-(--sc-text-secondary)"
							data-paste-chip="1"
							onClick={onDropPaste}
							title={t("input.paste.edit")}
							type="button"
						>
							<ClipboardPaste aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
							<span className="tabular-nums">{t("input.paste.chip", { id: 1, lines: 30 })}</span>
						</button>
					</li>
				)}
			</ul>
			{hidden > 0 && (
				<span
					aria-label={p("pp.thumbsMore", { count: hidden })}
					className="pp-strip-more pointer-events-none absolute top-1/2 right-2 rounded-(--sc-radius-full) bg-(--sc-text) px-2 py-0.5 text-sc-xs font-medium text-(--sc-bg) tabular-nums"
					role="status"
				>
					+{hidden}
				</span>
			)}
		</div>
	);
});

/* ── Suggestions (the real touch chips) ────────────────────────────────────────────────────────────────────── */

export function Suggestions() {
	const p = useP();
	const { set, act, fieldRef } = useSession();
	const chips = [p("pp.suggest1"), p("pp.suggest2")];
	return (
		<NextPromptChips
			chips={chips}
			onPick={text => {
				set({ text });
				fieldRef.current?.focus();
			}}
			onReturn={() => fieldRef.current?.focus()}
			onSend={text => {
				act("send", text);
				set({ text: "" });
			}}
			touch
		/>
	);
}

/* ── Completion menu: its height comes from the room above the composer ───────────────────────────────────── */

export function CompletionMenu() {
	const t = useT();
	const p = useP();
	const { visibleH } = useEnv();
	const { set, fieldRef } = useSession();
	const ref = useRef<HTMLDivElement>(null);
	const [max, setMax] = useState(240);
	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleH re-measures the room above the box
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			const top = el.parentElement?.getBoundingClientRect().top ?? 0;
			const header = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
			// 8 px of margin under the header, 8 px above the box: the menu never runs under the bar.
			setMax(Math.max(88, Math.floor(top - header - 16)));
		};
		measure();
		const frame = requestAnimationFrame(measure);
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
		const anchor = el.parentElement;
		if (anchor) observer?.observe(anchor);
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
		};
	}, [visibleH]);
	return (
		<div
			aria-label={t("input.completion.label")}
			className="absolute bottom-full left-0 z-(--sc-z-popover) mb-2 w-[min(440px,100%)] overflow-y-auto overscroll-contain rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)"
			data-completion-menu=""
			ref={ref}
			role="listbox"
			style={{ maxHeight: `min(60dvh, ${max}px)`, ["--hit-gap-y" as string]: "0px" }}
		>
			{COMMANDS.map((command, index) => (
				<button
					aria-selected={index === 0}
					className={cx(
						"flex min-h-(--sc-row-action) w-full items-baseline gap-3 rounded-(--sc-radius-sm) px-2.5 py-2.5 text-left",
						index === 0 ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
					)}
					key={command.name}
					onClick={() => {
						set({ text: `${command.name} ` });
						fieldRef.current?.focus();
					}}
					onMouseDown={event => event.preventDefault()}
					role="option"
					type="button"
				>
					<span className="shrink-0 font-mono text-sc-md font-medium text-(--sc-text)">{command.name}</span>
					<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">{p(command.key)}</span>
				</button>
			))}
		</div>
	);
}

/* ── Live status chips (variant A's second row, variant C's row above the box) ────────────────────────────── */

export type ChipSheet = "model" | "mode" | "approval" | "delegation" | "context";

function Chip({
	icon,
	children,
	onClick,
	pressed,
	haspopup,
	label,
	tone,
	chip,
}: {
	icon?: ReactNode;
	children: ReactNode;
	onClick: () => void;
	pressed?: boolean;
	haspopup?: boolean;
	label?: string;
	tone?: "accent" | "warn";
	chip: string;
}) {
	return (
		<button
			{...keepFocus}
			aria-haspopup={haspopup ? "dialog" : undefined}
			aria-label={label}
			aria-pressed={pressed}
			className={cx(
				"pp-chip inline-flex shrink-0 items-center gap-1 rounded-(--sc-radius-full) border px-2.5 text-sc-sm whitespace-nowrap",
				tone === "accent"
					? "border-(--sc-accent) bg-(--sc-accent) text-(--sc-accent-fg)"
					: tone === "warn"
						? "border-(--sc-warning) text-(--sc-text)"
						: "border-(--sc-border-subtle) bg-(--sc-surface-1) text-(--sc-text-secondary)",
			)}
			data-chip={chip}
			onClick={onClick}
			type="button"
		>
			{icon && <span className="inline-flex [&>svg]:size-(--sc-icon-sm)">{icon}</span>}
			{children}
		</button>
	);
}

export function StatusChips({ onOpen, trailing }: { onOpen: (sheet: ChipSheet) => void; trailing?: ReactNode }) {
	const t = useT();
	const p = useP();
	const { s, set, act } = useSession();
	const model = modelOf(s.model);
	const thinking = t(`input.thinking.name.${s.thinking}`);
	const planOn = s.mode === "plan";
	const modeLabel = s.mode === "goal" ? p("pp.goal") : s.mode === "autopilot" ? p("pp.autopilot") : p("pp.plan");
	const row = useRef<HTMLDivElement>(null);
	const [edge, setEdge] = useState({ start: false, end: false });
	const measure = useCallback(() => {
		const el = row.current;
		if (el) setEdge({ start: el.scrollLeft > 2, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the chip values only trigger a re-measure of the row's fade
	useLayoutEffect(measure, [measure, s.model, s.thinking, s.approval, s.delegation, s.mode, s.context]);
	useEffect(() => {
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [measure]);
	return (
		<div
			aria-label={p("pp.runStatus")}
			className="pp-chiprow flex items-center gap-2 overflow-x-auto"
			data-edge-end={edge.end || undefined}
			data-edge-start={edge.start || undefined}
			onScroll={measure}
			ref={row}
			role="toolbar"
		>
			<Chip chip="model" haspopup icon={<Cpu aria-hidden />} onClick={() => onOpen("model")}>
				{model.short} · {thinking}
			</Chip>
			<Chip
				chip="mode"
				haspopup={s.mode !== "agent" && s.mode !== "plan"}
				onClick={() => {
					if (s.mode === "agent" || s.mode === "plan") {
						const next = planOn ? "agent" : "plan";
						act("mode", next);
						set({ mode: next });
					} else onOpen("mode");
				}}
				pressed={s.mode === "agent" || s.mode === "plan" ? planOn : undefined}
				tone={s.mode === "agent" ? undefined : "accent"}
				icon={<ListChecks aria-hidden />}
			>
				{modeLabel}
			</Chip>
			<Chip
				chip="approval"
				haspopup
				icon={s.approval === "yolo" ? <ShieldAlert aria-hidden /> : <ShieldCheck aria-hidden />}
				label={t("input.approval.title", { mode: t(`input.approval.${s.approval}`) })}
				onClick={() => onOpen("approval")}
				tone={s.approval === "yolo" ? "warn" : undefined}
			>
				{t(`input.approval.${s.approval}`)}
			</Chip>
			<Chip chip="delegation" haspopup icon={<Users aria-hidden />} onClick={() => onOpen("delegation")}>
				{t(`input.delegation.mode.${s.delegation}`)}
			</Chip>
			<Chip
				chip="context"
				haspopup
				onClick={() => onOpen("context")}
				label={t("contextUsage.open", { percent: s.context })}
			>
				<span className="tabular-nums">{s.context} %</span>
			</Chip>
			{trailing}
		</div>
	);
}

/* ── Expanded header ───────────────────────────────────────────────────────────────────────────────────────── */

export function ExpandedHead() {
	const t = useT();
	const p = useP();
	const { set } = useSession();
	return (
		<div
			className="pp-expanded-head flex items-center gap-2 border-b border-(--sc-divider) py-1.5 pr-2 pl-4"
			data-expanded-head=""
		>
			<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-secondary)">
				{p("pp.longDraftTitle")}
			</span>
			<IconButton
				{...keepFocus}
				icon={<Minimize2 />}
				label={t("input.expanded.collapse")}
				onClick={() => set({ expanded: false })}
				size="md"
				tooltip={false}
			/>
		</div>
	);
}
