/**
 * The faces of the bot's marks (`BOT_AVATAR_SHAPES`): each mark's outline, and where its eyes and mouth sit on the same
 * 24 x 24 grid, stroke 2, round caps and `currentColor` as the lucide icons they replace. The eyes and the mouth are
 * their own elements so `bot-avatar.css` can blink, glance and talk with them; the outline stays still.
 *
 * Every outline path below comes from lucide-react 0.500.0 (ISC, listed in THIRD_PARTY_NOTICES.txt) with the icon's own
 * eye strokes cut out. Marks the icon gave no eyes (sparkles, rocket, star, heart, leaf) get a face placed inside the
 * shape. A mark with no room for a mouth (cat, dog, bird, rabbit) has none: it talks with its body.
 */
import type { BOT_AVATAR_SHAPES } from "../../../shared/bot-desk";

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

export type SvgNode = readonly [
	tag: "path" | "rect" | "circle" | "line",
	attrs: Readonly<Record<string, string | number>>,
];

export type Pt = readonly [x: number, y: number];

export interface BotFace {
	/** The outline, drawn at stroke 2. */
	body: readonly SvgNode[];
	/** Where each eye sits: a dot of the mark's colour, one or two. */
	eyes: readonly [Pt] | readonly [Pt, Pt];
	/** The middle of the mouth's smile; none for a mark that talks with its body. */
	mouth?: Pt;
	/** Half of the mouth's width; {@link DEFAULT_MOUTH_HALF_WIDTH} when absent. */
	mouthHalfWidth?: number;
	/** How large the eyes and the mouth's stroke are against the usual, for a shape with little room inside; 1 when absent. */
	featureScale?: number;
}

export const DEFAULT_MOUTH_HALF_WIDTH = 1.6;

export const BOT_FACES: Record<BotAvatarShape, BotFace> = {
	bot: {
		body: [
			["path", { d: "M12 8V4H8" }],
			["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
			["path", { d: "M2 14h2" }],
			["path", { d: "M20 14h2" }],
		],
		eyes: [
			[9, 13.5],
			[15, 13.5],
		],
		mouth: [12, 17],
		mouthHalfWidth: 1.5,
	},
	sparkles: {
		body: [
			[
				"path",
				{
					d: "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
				},
			],
			["path", { d: "M20 3v4" }],
			["path", { d: "M22 5h-4" }],
			["path", { d: "M4 17v2" }],
			["path", { d: "M5 18H3" }],
		],
		eyes: [
			[10.7, 11],
			[13.3, 11],
		],
		mouth: [12, 13.5],
		mouthHalfWidth: 0.9,
		featureScale: 0.7,
	},
	cat: {
		body: [
			[
				"path",
				{
					d: "M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z",
				},
			],
			["path", { d: "M11.25 16.25h1.5L12 17l-.75-.75Z" }],
		],
		eyes: [
			[8, 14.25],
			[16, 14.25],
		],
	},
	dog: {
		body: [
			["path", { d: "M11.25 16.25h1.5L12 17z" }],
			[
				"path",
				{
					d: "M4.42 11.247A13.152 13.152 0 0 0 4 14.556C4 18.728 7.582 21 12 21s8-2.272 8-6.444a11.702 11.702 0 0 0-.493-3.309",
				},
			],
			[
				"path",
				{
					d: "M8.5 8.5c-.384 1.05-1.083 2.028-2.344 2.5-1.931.722-3.576-.297-3.656-1-.113-.994 1.177-6.53 4-7 1.923-.321 3.651.845 3.651 2.235A7.497 7.497 0 0 1 14 5.277c0-1.39 1.844-2.598 3.767-2.277 2.823.47 4.113 6.006 4 7-.08.703-1.725 1.722-3.656 1-1.261-.472-1.855-1.45-2.239-2.5",
				},
			],
		],
		eyes: [
			[8, 14.25],
			[16, 14.25],
		],
	},
	bird: {
		body: [
			["path", { d: "M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" }],
			["path", { d: "m20 7 2 .5-2 .5" }],
			["path", { d: "M10 18v3" }],
			["path", { d: "M14 17.75V21" }],
			["path", { d: "M7 18a6 6 0 0 0 3.84-10.61" }],
		],
		eyes: [[16, 7]],
	},
	rabbit: {
		body: [
			["path", { d: "M13 16a3 3 0 0 1 2.24 5" }],
			[
				"path",
				{
					d: "M18 21h-8a4 4 0 0 1-4-4 7 7 0 0 1 7-7h.2L9.6 6.4a1 1 0 1 1 2.8-2.8L15.8 7h.2c3.3 0 6 2.7 6 6v1a2 2 0 0 1-2 2h-1a3 3 0 0 0-3 3",
				},
			],
			["path", { d: "M20 8.54V4a2 2 0 1 0-4 0v3" }],
			["path", { d: "M7.612 12.524a3 3 0 1 0-1.6 4.3" }],
		],
		eyes: [[18, 12]],
	},
	ghost: {
		body: [["path", { d: "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" }]],
		eyes: [
			[9, 10],
			[15, 10],
		],
		mouth: [12, 13.8],
		mouthHalfWidth: 1.6,
	},
	rocket: {
		body: [
			["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" }],
			[
				"path",
				{ d: "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" },
			],
			["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" }],
			["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
		],
		eyes: [
			[13.1, 9],
			[15.9, 9],
		],
		mouth: [14.5, 11.4],
		mouthHalfWidth: 0.95,
		featureScale: 0.85,
	},
	star: {
		body: [
			[
				"path",
				{
					d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
				},
			],
		],
		eyes: [
			[10.4, 11],
			[13.6, 11],
		],
		mouth: [12, 14.2],
		mouthHalfWidth: 1.4,
	},
	heart: {
		body: [
			[
				"path",
				{
					d: "M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z",
				},
			],
		],
		eyes: [
			[9, 9.4],
			[15, 9.4],
		],
		mouth: [12, 13.2],
		mouthHalfWidth: 2,
	},
	leaf: {
		body: [
			["path", { d: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" }],
			["path", { d: "M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" }],
		],
		eyes: [
			[14.2, 9.4],
			[17.4, 9.4],
		],
		mouth: [16, 13.6],
		mouthHalfWidth: 1.3,
	},
	smile: {
		body: [["circle", { cx: 12, cy: 12, r: 10 }]],
		eyes: [
			[9, 9],
			[15, 9],
		],
		mouth: [12, 14],
		mouthHalfWidth: 4,
	},
};
