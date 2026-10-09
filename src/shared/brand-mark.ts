/**
 * Geometry of the ompdesk mark: omp's π, rebuilt for the desk. It follows the
 * construction of omp's terminal logo (pi-tui `PI_LOGO`): a top bar, two legs
 * set well in from its ends, the right leg running the full height and the left
 * one stopping higher, its last cell shaded (`▒▒`). Here that shaded cell is the
 * foot, a separate shape painted in the OMPdesk accent where omp uses an orange
 * plug; everything else is ink.
 *
 * Shapes are filled paths on a 512-unit grid centred at the origin. Two forms:
 * `full` (round terminals, the foot set apart by a cut) for large renderings and
 * `small` (≤ SMALL_MAX_PX) drawn on a 16 px pixel grid (the menu-bar template
 * and Windows tray size; 32 and 48 px are the same grid scaled by whole
 * pixels), with the foot joined to its leg so the monochrome tray template
 * stays one solid, crisp π.
 *
 * resources/icon-source*.svg and resources/brand/*.svg are generated from this
 * module by `bun run gen:icons` (scripts/gen-icons.ts); brand-mark.test.ts keeps
 * the checked-in files in sync with it. The in-app mark is BrandMark.tsx.
 */

export interface PiOptions {
	/** Bar width. */
	width: number;
	/** Bar thickness and leg width. */
	stroke: number;
	/** Clear space between the legs. */
	legGap: number;
	/** Bar top to the end of the right leg. */
	height: number;
	/** Length of the left leg below the bar, foot included. */
	leftLeg: number;
	/** Length of the accent foot that ends the left leg. */
	foot: number;
	/** Cut between the left leg and its foot (0 = joined). */
	footGap: number;
	/** Corner radius at the ends of the bar. */
	barRadius: number;
	/** Corner radius at the free ends of the legs. */
	endRadius: number;
	/** Corner radius on both sides of the cut (ignored when `footGap` is 0). */
	cutRadius: number;
}

export interface PiGeometry {
	/** Bar, left leg above the foot, and right leg: one path, filled in ink. */
	ink: string;
	/** The foot of the left leg, filled in the accent; drawn after `ink`. */
	accent: string;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** Clockwise rectangle with per-corner radii [top-left, top-right, bottom-right, bottom-left]. */
function rect(x: number, y: number, w: number, h: number, [tl, tr, br, bl]: number[]): string {
	const corner = (r: number, dx: number, dy: number) => (r ? `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(dx)} ${fmt(dy)}` : "");
	return (
		`M${fmt(x + tl)} ${fmt(y)}H${fmt(x + w - tr)}${corner(tr, x + w, y + tr)}` +
		`V${fmt(y + h - br)}${corner(br, x + w - br, y + h)}` +
		`H${fmt(x + bl)}${corner(bl, x, y + h - bl)}` +
		`V${fmt(y + tl)}${corner(tl, x + tl, y)}Z`
	);
}

export function piGeometry(o: PiOptions): PiGeometry {
	const top = -o.height / 2;
	const barBottom = top + o.stroke;
	const leftX = -o.legGap / 2 - o.stroke;
	const rightX = o.legGap / 2;
	// Legs start inside the bar so the union has no seam; all subpaths wind the same way.
	const legTop = top + o.stroke / 2;
	const footTop = barBottom + o.leftLeg - o.foot;
	const footBottom = barBottom + o.leftLeg;
	const cut = o.footGap ? o.cutRadius : 0;
	// Joined foot: the ink leg reaches halfway under the foot, so mono renders stay one solid shape.
	const leftInkBottom = o.footGap ? footTop - o.footGap : footTop + o.foot / 2;
	const ink =
		rect(-o.width / 2, top, o.width, o.stroke, [o.barRadius, o.barRadius, o.barRadius, o.barRadius]) +
		rect(leftX, legTop, o.stroke, leftInkBottom - legTop, [0, 0, cut, cut]) +
		rect(rightX, legTop, o.stroke, o.height / 2 - legTop, [0, 0, o.endRadius, o.endRadius]);
	const accent = rect(leftX, footTop, o.stroke, footBottom - footTop, [cut, cut, o.endRadius, o.endRadius]);
	return { ink, accent };
}

/** One pixel of the 16 px grid the small form is drawn on. */
const PX = 512 / 16;

export const BRAND_MARK = {
	viewBox: "-256 -256 512 512",
	full: piGeometry({
		width: 448,
		stroke: 76,
		legGap: 112,
		height: 392,
		leftLeg: 230,
		foot: 76,
		footGap: 14,
		barRadius: 38,
		endRadius: 38,
		cutRadius: 8,
	}),
	small: piGeometry({
		width: 16 * PX,
		stroke: 3 * PX,
		legGap: 4 * PX,
		height: 14 * PX,
		leftLeg: 8 * PX,
		foot: 3 * PX,
		footGap: 0,
		barRadius: 0.75 * PX,
		endRadius: 0.75 * PX,
		cutRadius: 0,
	}),
	/** Largest rendered size (px) that uses the `small` form. */
	smallMaxPx: 48,
	/**
	 * App-icon tile (dock, .icns/.ico, Windows tray, in-app tile): ink square with
	 * the π in a platinum gradient and the foot in an indigo gradient at 76% of the tile.
	 */
	tile: {
		radius: 115,
		glyphScale: 0.76,
		background: "#17171C",
		/** Gradient line (userSpaceOnUse, top → bottom of the glyph). */
		from: [0, -200],
		to: [0, 200],
		/** [offset, color] stops. */
		ink: [
			[0, "#FFFFFF"],
			[1, "#C4C6D0"],
		],
		accent: [
			[0, "#A5A7FB"],
			[1, "#6E70EE"],
		],
	},
} as const;

export type PiForm = "full" | "small";

export function piFormForSize(px: number): PiForm {
	return px <= BRAND_MARK.smallMaxPx ? "small" : "full";
}
