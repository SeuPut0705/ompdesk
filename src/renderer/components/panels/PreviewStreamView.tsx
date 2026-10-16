import { Copy, Keyboard } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PreviewStreamDialog, PreviewStreamFrame, PreviewStreamInput } from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { GestureRecognizer, TAP_SLOP_PX } from "../../lib/preview-gestures";
import { beforeInputInputs, compositionInputs, keyInputs } from "../../lib/preview-keyboard";
import { toast, toastError } from "../../stores/toast";
import { Banner, Button, IconButton, Sheet, Spinner } from "../common";

/** Wait before asking again after a poll failed (the socket is reconnecting). */
const RETRY_MS = 1000;

interface Shown {
	src: string;
	rect: PreviewStreamFrame["rect"];
}

/** Decode a frame off the paint path; a browser without `decode` just shows it. The poll acknowledges after this. */
async function decoded(src: string): Promise<void> {
	if (typeof Image === "undefined") return;
	const image = new Image();
	image.src = src;
	try {
		await image.decode();
	} catch {
		// A frame that does not decode is skipped by the browser; the next one replaces it.
	}
}

/**
 * The shown page of a web viewer (a phone or tablet): the host's offscreen page arrives as paced JPEG frames
 * (`preview.stream.poll`; the next poll acknowledges the last frame), the finger is read into the pointer actions
 * the page should get (lib/preview-gestures.ts), and a hidden field takes the soft keyboard and IME
 * (lib/preview-keyboard.ts). JS dialogs the page opens come as a sheet. Nothing here runs in the desktop app,
 * whose page is a native view the panel only positions.
 */
export function PreviewStreamView({ active, tab }: { active: boolean; tab: string }) {
	const t = useT();
	const [shown, setShown] = useState<Shown | null>(null);
	const [lost, setLost] = useState(false);
	const [dialogs, setDialogs] = useState<PreviewStreamDialog[]>([]);
	const [answer, setAnswer] = useState("");
	const [composing, setComposing] = useState("");
	const [pinch, setPinch] = useState<number | null>(null);
	const image = useRef<HTMLImageElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const tabRef = useRef(tab);
	tabRef.current = tab;

	// The tab changed: its first frame has not come, and the old tab's picture is not it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tab` is the trigger, not a value read here.
	useEffect(() => setShown(null), [tab]);

	useEffect(() => {
		if (!active) return;
		let stopped = false;
		void (async () => {
			let ack: number | null = null;
			while (!stopped) {
				try {
					const poll = await window.omp.preview.stream.poll({ ack });
					if (stopped) return;
					setLost(false);
					if (poll.dialogs.length > 0) setDialogs(previous => [...previous, ...poll.dialogs]);
					const frame = poll.frame;
					if (!frame) continue;
					// A frame of a tab the viewer already left is acknowledged and dropped.
					if (!tabRef.current || frame.tab === tabRef.current) {
						const src = `data:image/jpeg;base64,${frame.jpeg}`;
						await decoded(src);
						if (stopped) return;
						setShown({ src, rect: frame.rect });
					}
					ack = frame.seq;
				} catch {
					if (stopped) return;
					setLost(true);
					ack = null;
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, RETRY_MS);
					await promise;
				}
			}
		})();
		return () => {
			stopped = true;
		};
	}, [active]);

	const send = useCallback((events: PreviewStreamInput[]) => window.omp.preview.stream.input(events), []);

	const recognizer = useRef<GestureRecognizer | null>(null);
	useEffect(() => {
		const gestures = new GestureRecognizer({
			emit: send,
			size: () => {
				const box = image.current?.getBoundingClientRect();
				return { width: box?.width ?? 0, height: box?.height ?? 0 };
			},
			onPinch: setPinch,
		});
		recognizer.current = gestures;
		return () => {
			gestures.dispose();
			recognizer.current = null;
		};
	}, [send]);

	/** A point of the frame, in CSS px from its corner. */
	const local = (event: { clientX: number; clientY: number }) => {
		const box = image.current?.getBoundingClientRect();
		return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), box };
	};
	const fraction = (event: { clientX: number; clientY: number }) => {
		const { x, y, box } = local(event);
		return { x: box?.width ? x / box.width : 0, y: box?.height ? y / box.height : 0 };
	};
	// A mouse (a tablet with one, a USB mouse): hover, click, drag, wheel, right click — no recogniser needed.
	const mouse = useRef<{ clientX: number; clientY: number; dragging: boolean } | null>(null);
	const lastHover = useRef(0);

	const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
		event.currentTarget.setPointerCapture?.(event.pointerId);
		if (event.pointerType === "mouse") {
			if (event.button !== 0) return;
			mouse.current = { clientX: event.clientX, clientY: event.clientY, dragging: false };
			return;
		}
		const { x, y } = local(event);
		recognizer.current?.pointerDown(event.pointerId, x, y);
	};
	const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
		if (event.pointerType === "mouse") {
			const down = mouse.current;
			if (!down) {
				// Hover is only a cue for the page's :hover; 20 a second is plenty.
				if (event.timeStamp - lastHover.current < 50) return;
				lastHover.current = event.timeStamp;
				return send([{ t: "hover", ...fraction(event) }]);
			}
			if (!down.dragging && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > TAP_SLOP_PX) {
				down.dragging = true;
				send([{ t: "drag", phase: "start", ...fraction(down) }]);
			}
			if (down.dragging) send([{ t: "drag", phase: "move", ...fraction(event) }]);
			return;
		}
		const { x, y } = local(event);
		recognizer.current?.pointerMove(event.pointerId, x, y);
	};
	const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
		if (event.pointerType === "mouse") {
			const down = mouse.current;
			mouse.current = null;
			if (!down) return;
			if (down.dragging) send([{ t: "drag", phase: "end", ...fraction(event) }]);
			else
				send([
					{
						t: "tap",
						...fraction(down),
						...(event.detail > 1 ? { count: Math.min(3, event.detail) as 2 | 3 } : {}),
					},
				]);
			return;
		}
		recognizer.current?.pointerUp(event.pointerId);
	};
	const onPointerCancel = (event: React.PointerEvent<HTMLImageElement>) => {
		if (event.pointerType === "mouse") {
			mouse.current = null;
			return;
		}
		recognizer.current?.pointerCancel(event.pointerId);
	};

	// The wheel needs a non-passive listener to keep the page from scrolling under the panel.
	const surface = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `fraction` only reads refs.
	useEffect(() => {
		const element = surface.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if (!image.current) return;
			event.preventDefault();
			send([{ t: "wheel", ...fraction(event), dx: event.deltaX, dy: event.deltaY }]);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [send]);

	// The hidden field: `beforeinput` (a native listener, React's onBeforeInput is the older textInput) carries
	// the soft keyboard's text; a composition is shown here and sent once, committed.
	useEffect(() => {
		const input = field.current;
		if (!input) return;
		const onBeforeInput = (event: InputEvent) => {
			const result = beforeInputInputs({
				inputType: event.inputType,
				data: event.data,
				isComposing: event.isComposing,
				pasted: event.dataTransfer?.getData("text/plain") ?? null,
			});
			if (result.prevent) event.preventDefault();
			if (result.inputs.length > 0) send(result.inputs);
		};
		const onStart = () => setComposing(" ");
		const onUpdate = (event: Event) => setComposing((event as CompositionEvent).data || " ");
		const onEnd = (event: Event) => {
			setComposing("");
			const inputs = compositionInputs((event as CompositionEvent).data);
			if (inputs.length > 0) send(inputs);
			input.value = "";
		};
		input.addEventListener("beforeinput", onBeforeInput);
		input.addEventListener("compositionstart", onStart);
		input.addEventListener("compositionupdate", onUpdate);
		input.addEventListener("compositionend", onEnd);
		return () => {
			input.removeEventListener("beforeinput", onBeforeInput);
			input.removeEventListener("compositionstart", onStart);
			input.removeEventListener("compositionupdate", onUpdate);
			input.removeEventListener("compositionend", onEnd);
		};
	}, [send]);

	const dialog = dialogs[0];
	const settle = (accept: boolean) => {
		if (!dialog) return;
		const text = dialog.kind === "prompt" && accept ? answer : undefined;
		setDialogs(previous => previous.slice(1));
		setAnswer("");
		void window.omp.preview.stream
			.answerDialog(dialog.id, text === undefined ? { accept } : { accept, text })
			.catch(error => toastError({ title: t("panel.preview.stream.dialog.alert"), error }));
	};
	useEffect(() => setAnswer(dialog?.kind === "prompt" ? (dialog.initial ?? "") : ""), [dialog]);

	const copy = async () => {
		try {
			const text = await window.omp.preview.stream.selectedText();
			if (!text) {
				toast({ variant: "info", message: t("panel.preview.stream.copyEmpty") });
				return;
			}
			await navigator.clipboard.writeText(text);
			toast({ variant: "success", message: t("panel.preview.stream.copied") });
		} catch (error) {
			toastError({ title: t("panel.preview.stream.copyFailed"), error });
		}
	};

	return (
		<div className="absolute inset-0 overflow-hidden bg-(--sc-surface-1)" data-preview-stream ref={surface}>
			{shown ? (
				<img
					alt={t("panel.preview.stream.frame")}
					className="absolute max-w-none select-none"
					data-preview-stream-frame
					draggable={false}
					onContextMenu={event => event.preventDefault()}
					onPointerCancel={onPointerCancel}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					ref={image}
					src={shown.src}
					style={{
						left: shown.rect.x,
						top: shown.rect.y,
						width: shown.rect.width,
						height: shown.rect.height,
						touchAction: "none",
						transform: pinch === null ? undefined : `scale(${pinch})`,
					}}
				/>
			) : (
				<div className="flex h-full items-center justify-center" data-preview-stream-connecting>
					<Spinner label={t("panel.preview.stream.connecting")} size="sm" />
				</div>
			)}
			{lost && (
				<Banner className="absolute inset-x-3 top-3" live variant="warning">
					{t("panel.preview.stream.reconnecting")}
				</Banner>
			)}
			<textarea
				aria-label={t("panel.preview.stream.keyboard")}
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				className="absolute right-0 bottom-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
				data-preview-stream-input
				onInput={event => {
					// Everything is forwarded as it is committed; the field itself stays empty.
					if (!composing) event.currentTarget.value = "";
				}}
				onKeyDown={event => {
					const inputs = keyInputs({
						key: event.key,
						keyCode: event.keyCode,
						ctrlKey: event.ctrlKey,
						metaKey: event.metaKey,
						altKey: event.altKey,
						shiftKey: event.shiftKey,
						isComposing: event.nativeEvent.isComposing,
					});
					if (!inputs) return;
					event.preventDefault();
					send(inputs);
				}}
				ref={field}
				rows={1}
				spellCheck={false}
				style={{ fontSize: 16 }}
			/>
			{composing.trim() && (
				<div
					className="pointer-events-none absolute inset-x-3 bottom-14 rounded-(--sc-radius-md) border border-(--sc-border) bg-(--sc-elevated) px-3 py-2 text-sc-md text-(--sc-text)"
					data-preview-stream-composing
				>
					{composing}
				</div>
			)}
			<div className="absolute right-2 bottom-2 flex gap-1 rounded-(--sc-radius-md) bg-(--sc-elevated) p-0.5 shadow-sm">
				<IconButton
					data-preview-stream-copy
					icon={<Copy />}
					label={t("panel.preview.stream.copy")}
					onClick={() => void copy()}
					size="md"
				/>
				<IconButton
					data-preview-stream-keyboard
					icon={<Keyboard />}
					label={t("panel.preview.stream.keyboardShow")}
					onClick={() => field.current?.focus()}
					size="md"
				/>
			</div>
			<Sheet
				footer={
					<>
						{dialog?.kind !== "alert" && (
							<Button data-preview-dialog-cancel onClick={() => settle(false)} variant="ghost">
								{t("panel.preview.stream.dialog.cancel")}
							</Button>
						)}
						<Button data-preview-dialog-ok onClick={() => settle(true)} variant="primary">
							{t("panel.preview.stream.dialog.ok")}
						</Button>
					</>
				}
				onClose={() => settle(dialog?.kind === "alert")}
				open={Boolean(dialog)}
				placement="bottom"
				title={t(`panel.preview.stream.dialog.${dialog?.kind ?? "alert"}`)}
			>
				<div className="space-y-3 px-5 py-4" data-preview-dialog={dialog?.kind}>
					<p className="text-sc-md break-words whitespace-pre-wrap text-(--sc-text)">{dialog?.message}</p>
					{dialog?.kind === "prompt" && (
						<input
							aria-label={t("panel.preview.stream.dialog.input")}
							className="h-(--sc-control-md) w-full rounded-(--sc-radius-sm) border border-(--sc-border) bg-(--sc-field) px-2 text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
							data-preview-dialog-input
							onChange={event => setAnswer(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && !event.nativeEvent.isComposing) settle(true);
							}}
							style={{ fontSize: 16 }}
							value={answer}
						/>
					)}
				</div>
			</Sheet>
		</div>
	);
}
