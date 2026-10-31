/**
 * The bot's avatar (`BotIdentity.avatar`, Settings › Bot): a mark (one of `BOT_AVATAR_SHAPES` in a theme colour) or the
 * picture the owner uploaded or the bot made. `inline` is the sidebar row's mark, the icon alone at icon size; `tile`
 * sizes draw it on a soft wash of its colour (the bot's bar, Settings). Each colour is a theme token with its soft wash
 * and its on-soft text, so every theme keeps the contrast `lib/theme-contrast.ts` checks.
 */
import {
	Bird,
	Bot,
	Cat,
	Dog,
	Ghost,
	Heart,
	Leaf,
	type LucideIcon,
	Rabbit,
	Rocket,
	Smile,
	Sparkles,
	Star,
} from "lucide-react";
import type { BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BotAvatar as BotAvatarValue } from "../../../shared/bot-desk";

export const BOT_SHAPE_ICONS: Record<(typeof BOT_AVATAR_SHAPES)[number], LucideIcon> = {
	bot: Bot,
	sparkles: Sparkles,
	cat: Cat,
	dog: Dog,
	bird: Bird,
	rabbit: Rabbit,
	ghost: Ghost,
	rocket: Rocket,
	star: Star,
	heart: Heart,
	leaf: Leaf,
	smile: Smile,
};

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

export function BotAvatar({
	avatar,
	size,
	label,
	...data
}: {
	avatar: BotAvatarValue;
	size: "inline" | "md" | "lg";
	/** The name a screen reader hears; without one the avatar is decoration. */
	label?: string;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
	if (avatar.kind === "image") {
		const box = size === "inline" ? "size-(--sc-icon-sm) rounded-full" : `${TILE[size].box} overflow-hidden`;
		return (
			<span {...a11y} {...data} className={`inline-flex shrink-0 ${box}`} data-bot-avatar="image">
				<img alt="" className="size-full object-cover" draggable={false} src={avatar.dataUrl} />
			</span>
		);
	}
	const Icon = BOT_SHAPE_ICONS[avatar.shape];
	if (size === "inline")
		return (
			<span {...a11y} {...data} className="inline-flex shrink-0" data-bot-avatar={avatar.shape}>
				<Icon aria-hidden className={`size-(--sc-icon-sm) ${INLINE_CLASSES[avatar.color]}`} />
			</span>
		);
	return (
		<span
			{...a11y}
			{...data}
			className={`flex shrink-0 items-center justify-center ${TILE[size].box} ${BOT_TILE_CLASSES[avatar.color]}`}
			data-bot-avatar={avatar.shape}
		>
			<Icon aria-hidden className={TILE[size].icon} />
		</span>
	);
}
