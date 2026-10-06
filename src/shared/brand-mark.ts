/**
 * Geometry of the seucode mark: one S drawn as two arcs on a 32-unit grid. The
 * upper arc (ink) is the person, the lower arc (accent) is the agent; the stroke
 * changes hands at the center (16,16). The accent arc has a butt start so it
 * covers the ink arc's round end cap cleanly, plus a round terminal dot.
 *
 * The hand-written SVGs in resources/ (icon-source.svg, brand/*.svg) repeat these
 * exact path strings; brand-mark.test.ts keeps them in sync with this module.
 */
export const BRAND_MARK = {
	viewBox: "0 0 32 32",
	strokeWidth: 3.8,
	ink: "M20.64 8.29A5.25 5.25 0 1 0 16 16",
	accent: "M16 16A5.25 5.25 0 1 1 11.36 23.71",
	accentTerminal: { cx: 11.36, cy: 23.71, r: 1.9 },
	/** Full-bleed tile form (favicon, Windows icon, in-app badge): ink tile, glyph at 84%. */
	tile: { radius: 7.2, glyphScale: 0.84, background: "#17171C", ink: "#FFFFFF", accent: "#8B8DF8" },
} as const;
