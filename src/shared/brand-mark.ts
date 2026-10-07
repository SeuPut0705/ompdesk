/**
 * Geometry of the seucode mark, the interlaced knot: two congruent open loops
 * on a 512-unit grid centred at the origin. The upper loop (ink) is the person,
 * the lower loop (accent) is the agent; it is the same strand rotated 180°. The
 * loops cross twice and the weave alternates (each strand passes over at one
 * crossing and under at the other), so one strand plus one mask, reused inside
 * `rotate(180)`, gives a consistent over/under.
 *
 * Two forms: `full` (outer ring, hairline groove along the strand) for large
 * renderings and `small` (heavier strand, no ring or groove) for ≤ SMALL_MAX_PX.
 *
 * resources/icon-source*.svg and resources/brand/*.svg are generated from this
 * module by `bun run gen:icons` (scripts/gen-icons.ts); brand-mark.test.ts keeps
 * the checked-in files in sync with it. The in-app mark is BrandMark.tsx.
 */

export interface KnotOptions {
	/** Loop radius. */
	R: number;
	/** Vertical offset of each loop centre from the origin. */
	a: number;
	/** Strand stroke width. */
	sw: number;
	/** Start angle of the strand (degrees, +y down). */
	s0: number;
	/** How far the strand stops short of the far crossing (degrees). */
	tail: number;
	/** Clearance each side of the over-strand at the crossing where this strand goes under. */
	gap: number;
	/** Width of the hairline groove cut along the strand centre (0 = none). */
	groove: number;
	/** Draw the outer ring. */
	ring: boolean;
}

export interface KnotGeometry {
	/** The upper (ink) strand; the accent strand is the same path rotated 180°. */
	strand: string;
	strokeWidth: number;
	/** Where this strand goes under the other: the mask cut is clipped to this circle. */
	under: { cx: number; r: number };
	/** Stroke width of the other strand's silhouette cut out of this one. */
	cutWidth: number;
	/** Hairline groove along the strand centre, trimmed short of its ends. */
	groove: { d: string; width: number } | null;
	/** Outer ring: a heavy ink circle with a hairline accent circle inside. */
	ring: { ink: { r: number; width: number }; accent: { r: number; width: number } } | null;
}

const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => String(round(n));
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Arc around (cx, cy) from angle a0 to a1, split into ≤ 90° segments. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
	const point = (a: number) => `${fmt(cx + r * Math.cos(toRad(a)))} ${fmt(cy + r * Math.sin(toRad(a)))}`;
	const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
	let d = `M${point(a0)}`;
	for (let i = 1; i <= n; i++) d += `A${fmt(r)} ${fmt(r)} 0 0 ${a1 > a0 ? 1 : 0} ${point(a0 + ((a1 - a0) * i) / n)}`;
	return d;
}

export function knotGeometry(o: KnotOptions): KnotGeometry {
	const { R, a, sw } = o;
	const w = Math.sqrt(R * R - a * a);
	// Angle of the right crossing seen from the upper loop's centre.
	const crossing = toDeg(Math.atan2(a, w));
	const a1 = crossing - o.tail - 360;
	const trim = toDeg((sw * 0.75) / R);
	return {
		strand: arc(0, -a, R, o.s0, a1),
		strokeWidth: sw,
		under: { cx: round(-w), r: round(sw * 1.4) },
		cutWidth: round(sw + 2 * o.gap),
		groove: o.groove ? { d: arc(0, -a, R, o.s0 - trim, a1 + trim), width: o.groove } : null,
		ring: o.ring ? { ink: { r: 238, width: 5 }, accent: { r: 225, width: 1.8 } } : null,
	};
}

export const BRAND_MARK = {
	viewBox: "-256 -256 512 512",
	full: knotGeometry({ R: 104, a: 72, sw: 34, s0: -30, tail: 22, gap: 7, groove: 3.4, ring: true }),
	small: knotGeometry({ R: 114, a: 80, sw: 60, s0: -30, tail: 22, gap: 20, groove: 0, ring: false }),
	/** Largest rendered size (px) that uses the `small` form. */
	smallMaxPx: 48,
	/**
	 * App-icon tile (dock, .icns/.ico, Windows tray, in-app tile): ink square with
	 * the knot in platinum (person) and gold (agent) at 80% of the tile.
	 */
	tile: { radius: 115, glyphScale: 0.8, background: "#17171C" },
	/** Diagonal metal gradients (userSpaceOnUse, top-left → bottom-right), as [offset, color] stops. */
	metal: {
		from: [-180, -250],
		to: [180, 250],
		platinum: [
			[0, "#F5F5F7"],
			[0.5, "#C8CAD0"],
			[1, "#8E9098"],
		],
		gold: [
			[0, "#E2C990"],
			[0.5, "#B8955A"],
			[1, "#86663A"],
		],
	},
} as const;

export type KnotForm = "full" | "small";

export function knotFormForSize(px: number): KnotForm {
	return px <= BRAND_MARK.smallMaxPx ? "small" : "full";
}
