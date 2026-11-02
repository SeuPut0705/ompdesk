/**
 * The bot's avatar (`BotIdentity.avatar`, Settings › Bot): a mark (one of `BOT_AVATAR_SHAPES` in a theme colour) or the
 * picture the owner uploaded or the bot made. `inline` is the sidebar row's mark, the icon alone at icon size; `tile`
 * sizes draw it on a soft wash of its colour (the bot's bar, Settings). Each colour is a theme token with its soft wash
 * and its on-soft text, so every theme keeps the contrast `lib/theme-contrast.ts` checks.
 *
 * It moves by what the bot does (`motion`, `bot-motion.ts`; none draws it still): a mark is drawn from `bot-face.ts`,
 * an outline with a face whose eyes and mouth blink, glance and talk; a picture gets a ring around it. The box never
 * changes with the motion, the ring is absolutely positioned outside it, and only transform and opacity animate
 * (`styles/bot-avatar.css`, which also keeps a still pose under reduced motion and software compositing). While
 * speaking it follows the call's playback level through `--bot-voice`, written on the root without a render.
 */
import { createElement, type ReactElement, useEffect, useRef } from "react";
import type { BOT_AVATAR_COLORS, BotAvatar as BotAvatarValue } from "../../../shared/bot-desk";
import { subscribeCallLevel } from "../../stores/bot-call";
import { useWindowVisible } from "../common/LiveShimmer";
import { BOT_FACES, type BotAvatarShape, DEFAULT_MOUTH_HALF_WIDTH } from "./bot-face";
import { type BotMotion, useBotMotion } from "./bot-motion";
import type { BotState } from "./bot-status";
import "../../styles/bot-avatar.css";

type AvatarColor = (typeof BOT_AVATAR_COLORS)[number];

/** A tile's wash with its on-soft text, per avatar colour. */
export const BOT_TILE_CLASSES: Record<AvatarColor, string> = {
	accent: "bg-(--sc-accent-soft) text-(--sc-accent-on-soft)",
	info: "bg-(--sc-info-soft) text-(--sc-info-on-soft)",
	success: "bg-(--sc-success-soft) text-(--sc-success-on-soft)",
	warning: "bg-(--sc-warning-soft) text-(--sc-warning-on-soft)",
	danger: "bg-(--sc-danger-soft) text-(--sc-danger-on-soft)",
	neutral: "bg-(--sc-hover) text-(--sc-text)",
};

/** An inline mark's strong colour, legible on any row background. */
const INLINE_CLASSES: Record<AvatarColor, string> = {
	accent: "text-(--sc-accent)",
	info: "text-(--sc-info)",
	success: "text-(--sc-success)",
	warning: "text-(--sc-warning)",
	danger: "text-(--sc-danger)",
	neutral: "text-(--sc-text-muted)",
};

const TILE = {
	md: { box: "size-7 rounded-(--sc-radius-md)", icon: "size-4" },
	lg: { box: "size-14 rounded-(--sc-radius-lg)", icon: "size-7" },
} as const;

/** The eye's size on the 24 x 24 grid: the dot lucide draws with a round cap, a little taller than wide. */
const EYE_RX = 1;
const EYE_RY = 1.4;
/** A closed eye's half width. */
const SHUT_HALF_WIDTH = 1.3;
const MOUTH_STROKE = 1.6;

const round = (value: number): number => Math.round(value * 100) / 100;

function MarkFace({ shape, motion, className }: { shape: BotAvatarShape; motion?: BotMotion; className: string }) {
	const face = BOT_FACES[shape];
	const shut = motion === "asleep";
	const half = face.mouthHalfWidth ?? DEFAULT_MOUTH_HALF_WIDTH;
	const unit = face.featureScale ?? 1;
	return (
		<svg
			aria-hidden
			className={`omp-bot-mark ${className}`}
			fill="none"
			focusable="false"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={2}
			viewBox="0 0 24 24"
		>
			<g className="omp-bot-body">
				{face.body.map(([tag, attrs]) => createElement(tag, { key: JSON.stringify(attrs), ...attrs }))}
				<g className="omp-bot-eyes">
					{face.eyes.map(([x, y]) =>
						shut ? (
							<path
								className="omp-bot-eye"
								d={`M${round(x - SHUT_HALF_WIDTH * unit)} ${y}h${round(SHUT_HALF_WIDTH * 2 * unit)}`}
								data-bot-eye="closed"
								key={`${x},${y}`}
								strokeWidth={round(MOUTH_STROKE * unit)}
							/>
						) : (
							<ellipse
								className="omp-bot-eye"
								cx={x}
								cy={y}
								data-bot-eye="open"
								fill="currentColor"
								key={`${x},${y}`}
								rx={round(EYE_RX * unit)}
								ry={round(EYE_RY * unit)}
								stroke="none"
							/>
						),
					)}
				</g>
				{face.mouth ? (
					<g className="omp-bot-mouth" data-bot-mouth="">
						<path
							className="omp-bot-smile"
							d={`M${round(face.mouth[0] - half)} ${face.mouth[1]}Q${face.mouth[0]} ${round(face.mouth[1] + half)} ${round(face.mouth[0] + half)} ${face.mouth[1]}`}
							strokeWidth={round(MOUTH_STROKE * unit)}
						/>
						<ellipse
							className="omp-bot-talk"
							cx={face.mouth[0]}
							cy={round(face.mouth[1] + half * 0.35)}
							fill="currentColor"
							rx={round(half * 0.75)}
							ry={round(half * 0.65)}
							stroke="none"
						/>
					</g>
				) : null}
			</g>
		</svg>
	);
}

/** The ring around the box: a pulse, an aura or a level ring by motion, and the arc that circles it while working. */
function Ring(): ReactElement {
	return (
		<span aria-hidden className="omp-bot-ring" data-bot-ring="">
			<span className="omp-bot-arc" />
		</span>
	);
}

/** While speaking: write the call's playback level on `element` as `--bot-voice`, and say a level is arriving. */
function useVoiceLevel(motion: BotMotion | undefined) {
	const rootRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const element = rootRef.current;
		if (motion !== "speaking" || !element) return;
		const unsubscribe = subscribeCallLevel(level => {
			element.setAttribute("data-bot-voiced", "");
			element.style.setProperty("--bot-voice", String(level));
		});
		return () => {
			unsubscribe();
			element.removeAttribute("data-bot-voiced");
			element.style.removeProperty("--bot-voice");
		};
	}, [motion]);
	return rootRef;
}

type DataAttributes = { [key: `data-${string}`]: string | boolean | undefined };

interface BotAvatarOwnProps {
	avatar: BotAvatarValue;
	size: "inline" | "md" | "lg";
	/** The name a screen reader hears; without one the avatar is decoration. */
	label?: string;
	/** How it moves; absent draws it still. */
	motion?: BotMotion;
}

export function BotAvatar({ avatar, size, label, motion, ...data }: BotAvatarOwnProps & DataAttributes) {
	const rootRef = useVoiceLevel(motion);
	const visible = useWindowVisible();
	const attrs = {
		...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true }),
		...data,
		"data-bot-motion": motion,
		"data-paused": motion !== undefined && !visible ? "" : undefined,
	};
	if (avatar.kind === "image") {
		const box = size === "inline" ? "size-(--sc-icon-sm) rounded-full" : TILE[size].box;
		return (
			<span
				{...attrs}
				className={`omp-bot-avatar relative inline-flex shrink-0 ${box}`}
				data-bot-avatar="image"
				ref={rootRef}
			>
				<span className="omp-bot-picture inline-flex size-full overflow-hidden rounded-[inherit]">
					<img alt="" className="size-full object-cover" draggable={false} src={avatar.dataUrl} />
				</span>
				{motion ? <Ring /> : null}
			</span>
		);
	}
	if (size === "inline")
		return (
			<span
				{...attrs}
				className={`omp-bot-avatar relative inline-flex shrink-0 rounded-full ${INLINE_CLASSES[avatar.color]}`}
				data-bot-avatar={avatar.shape}
				ref={rootRef}
			>
				<MarkFace className="size-(--sc-icon-sm)" motion={motion} shape={avatar.shape} />
				{motion ? <Ring /> : null}
			</span>
		);
	return (
		<span
			{...attrs}
			className={`omp-bot-avatar relative flex shrink-0 items-center justify-center ${TILE[size].box} ${BOT_TILE_CLASSES[avatar.color]}`}
			data-bot-avatar={avatar.shape}
			ref={rootRef}
		>
			<MarkFace className={TILE[size].icon} motion={motion} shape={avatar.shape} />
			{motion ? <Ring /> : null}
		</span>
	);
}

/** The avatar of a bot's own row or dock: it moves by the bot's state, its host's link and the voice call on its tab. */
export function LiveBotAvatar({
	state,
	device,
	tabId,
	...props
}: Omit<BotAvatarOwnProps, "motion"> & DataAttributes & { state: BotState; device?: string; tabId?: string }) {
	return <BotAvatar {...props} motion={useBotMotion({ state, device, tabId })} />;
}
