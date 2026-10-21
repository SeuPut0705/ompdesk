/**
 * Spotlight tour for one getting-started step: dims the window around the
 * real control the step is about (a hole whose own box-shadow is the scrim),
 * follows it every frame while it moves, and puts a card beside it. The hole
 * lets the click reach the control; a click anywhere else, Escape or "Got it"
 * ends the tour, and so does the step completing. A control that is not on
 * screen (a collapsed sidebar, chat mode) gets a centered card instead.
 * Transitions stop under prefers-reduced-motion (global rule).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { type StarterStep, useStarterGuideStore } from "../../stores/starter-guide";
import { Button } from "../common";

/** Where each step's control lives; the first one on screen wins. */
const TARGETS: Record<StarterStep, readonly string[]> = {
	model: ["[data-model-chip]"],
	prompt: [".omp-composer-input"],
	project: ["[data-sidebar-open-project]", '[data-sidebar-device-add="local"]', ".omp-sidebar-controls"],
	split: ['[data-tour="sessions"]'],
	panel: ['[data-tour="panel"]'],
};

/** Room around the control inside the hole, and between the hole and the card. */
const PAD = 6;
const GAP = 12;
const CARD_WIDTH = 300;
const EDGE = 8;

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

function measure(step: StarterStep): Box | null {
	for (const selector of TARGETS[step]) {
		const node = document.querySelector(selector);
		if (!node) continue;
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			return {
				left: rect.left - PAD,
				top: rect.top - PAD,
				width: rect.width + PAD * 2,
				height: rect.height + PAD * 2,
			};
		}
	}
	return null;
}

/**
 * The card goes right of a control in the left third (the sidebar), else
 * below it, else above it (anchored by its bottom, so its height never needs
 * measuring), always inside the window.
 */
function cardPlacement(hole: Box): { left: number; top?: number; bottom?: number } {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const clampLeft = (left: number) => Math.min(Math.max(left, EDGE), width - CARD_WIDTH - EDGE);
	const right = hole.left + hole.width;
	if (hole.left < width / 3 && right + GAP + CARD_WIDTH <= width - EDGE) {
		return { left: right + GAP, top: Math.min(Math.max(hole.top, EDGE), height - 200) };
	}
	const below = hole.top + hole.height + GAP;
	if (below + 200 <= height) return { left: clampLeft(hole.left), top: below };
	return { left: clampLeft(hole.left), bottom: height - hole.top + GAP };
}

export function StarterTour() {
	const t = useT();
	const step = useStarterGuideStore(state => state.tour);
	const end = useStarterGuideStore(state => state.endTour);
	const [hole, setHole] = useState<Box | null>(null);
	const holeRef = useRef<Box | null>(null);

	// Follow the control every frame: sidebars resize, panels slide, lists scroll.
	useLayoutEffect(() => {
		if (!step) return;
		const update = () => {
			const next = measure(step);
			const prev = holeRef.current;
			if (
				prev === next ||
				(prev !== null &&
					next !== null &&
					prev.left === next.left &&
					prev.top === next.top &&
					prev.width === next.width &&
					prev.height === next.height)
			)
				return;
			holeRef.current = next;
			setHole(next);
		};
		update();
		let frame = requestAnimationFrame(function track() {
			update();
			frame = requestAnimationFrame(track);
		});
		return () => {
			cancelAnimationFrame(frame);
			holeRef.current = null;
			setHole(null);
		};
	}, [step]);

	useEffect(() => {
		if (!step) return;
		const previous = document.activeElement;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			end();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [end, step]);

	if (!step) return null;

	const titleId = `starter-tour-${step}-title`;
	const bodyId = `starter-tour-${step}-body`;
	const placement = hole ? cardPlacement(hole) : null;
	// The shield takes every click but the hole's, which reaches the real control.
	const clip = hole
		? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${hole.left}px ${hole.top}px, ${hole.left + hole.width}px ${hole.top}px, ${hole.left + hole.width}px ${hole.top + hole.height}px, ${hole.left}px ${hole.top + hole.height}px, ${hole.left}px ${hole.top}px)`
		: undefined;

	return createPortal(
		<div className="omp-starter-tour" data-starter-tour-root data-target-found={String(hole !== null)}>
			<div
				aria-hidden
				className="omp-starter-tour-shield"
				data-dimmed={String(hole === null)}
				data-tour-shield
				onClick={end}
				style={clip ? { clipPath: clip } : undefined}
			/>
			{hole && (
				<div
					aria-hidden
					className="omp-starter-tour-hole"
					data-tour-hole={`${hole.left},${hole.top},${hole.width},${hole.height}`}
					style={{
						left: `${hole.left}px`,
						top: `${hole.top}px`,
						width: `${hole.width}px`,
						height: `${hole.height}px`,
					}}
				/>
			)}
			<div
				aria-describedby={bodyId}
				aria-labelledby={titleId}
				className="omp-starter-tour-card"
				data-placement={placement ? "anchored" : "center"}
				data-starter-tour
				role="dialog"
				style={
					placement
						? {
								left: `${placement.left}px`,
								...(placement.top === undefined ? {} : { top: `${placement.top}px` }),
								...(placement.bottom === undefined ? {} : { bottom: `${placement.bottom}px` }),
							}
						: undefined
				}
			>
				<h2 className="text-sc-md font-semibold text-(--sc-text)" id={titleId}>
					{t(`starter.step.${step}.title`)}
				</h2>
				<p className="mt-1 text-sc-sm break-keep text-(--sc-text-secondary)" id={bodyId}>
					{t(`starter.step.${step}.tour`)}
				</p>
				<div className="mt-3 flex justify-end">
					<Button autoFocus onClick={end} size="sm" variant="primary">
						{t("starter.gotIt")}
					</Button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
