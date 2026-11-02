/**
 * The lucide icon of each avatar mark, for Settings' shape picker. The avatar itself is drawn from `bot-face.ts`, so this
 * stays a module of its own and only the settings page, which is not on the first screen, carries the icons.
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
import type { BOT_AVATAR_SHAPES } from "../../../shared/bot-desk";

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
