/**
 * The SVG preview sanitizer: whitelist rebuild, outside references removed,
 * theme tokens resolved, and anything not (yet) well-formed rejected so the
 * caller keeps showing code.
 */
import { describe, expect, it } from "vitest";
import { sanitizeSvg, svgDataUrl, svgFillsWidth } from "./svg-preview";

const PALETTE = { fg: "#ededf0", accent: "#a5a7fa" };

describe("sanitizeSvg", () => {
	it("keeps a drawing and adds namespace, theme color and font", () => {
		const out = sanitizeSvg(
			'<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="var(--accent)"/></svg>',
			PALETTE,
		);
		expect(out).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" color="#ededf0" font-family="sans-serif" viewBox="0 0 10 10"><rect width="10" height="10" fill="#a5a7fa"/></svg>',
		);
	});

	it("resolves unknown tokens to their fallback, then the foreground", () => {
		const out = sanitizeSvg('<svg><path fill="var(--nope, red)" stroke="var(--c9)"/></svg>', PALETTE);
		expect(out).toContain('fill="red"');
		expect(out).toContain('stroke="#ededf0"');
	});

	it("drops scripts, handlers, foreign content and outside references", () => {
		const out = sanitizeSvg(
			[
				'<svg onload="alert(1)" xmlns:evil="urn:x">',
				"<script>alert(2)</script>",
				'<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(3)"/></div></foreignObject>',
				'<a href="javascript:alert(4)"><circle r="2" onclick="alert(5)"/></a>',
				'<use href="https://evil.example/s.svg#a"/>',
				'<use xlink:href="#local"/>',
				'<image href="http://evil.example/p.png"/>',
				'<rect fill="url(https://evil.example/f)" stroke="url(#grad)"/>',
				'<rect style="fill: url(http://evil.example/x); stroke: red"/>',
				"<style>@import url(https://evil.example/a.css); rect { fill: url('//evil.example/b') }</style>",
				'<set attributeName="href" to="javascript:alert(6)"/>',
				'<path d="M0 0" evil:attr="1"/>',
				"</svg>",
			].join(""),
			PALETTE,
		);
		expect(out).not.toBeNull();
		const svg = out ?? "";
		expect(svg).not.toMatch(/script|onload|onclick|onerror|foreignObject|javascript|evil|@import|<a\b|<set\b/i);
		expect(svg).toContain('<circle r="2"/>');
		expect(svg).toContain('<use xlink:href="#local"/>');
		expect(svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
		expect(svg).toContain('stroke="url(#grad)"');
		expect(svg).toContain('style="fill: none; stroke: red"');
		expect(svg).toContain("<style><![CDATA[ rect { fill: none }]]></style>");
	});

	it("checks decoded values, so entity-encoded schemes do not slip through", () => {
		const out = sanitizeSvg('<svg><rect fill="&#117;rl(https://evil.example/x)"/><a href="&#35;x"/></svg>');
		expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" font-family="sans-serif"><rect/></svg>');
	});

	it("keeps inline raster images only", () => {
		const raster = "data:image/png;base64,iVBORw0KGgo=";
		expect(sanitizeSvg(`<svg><image href="${raster}"/></svg>`)).toContain(`href="${raster}"`);
		expect(sanitizeSvg('<svg><image href="data:image/svg+xml,&lt;svg/&gt;"/></svg>')).toContain("<image/>");
	});

	it("escapes text and never honors DOCTYPE entities", () => {
		const out = sanitizeSvg(
			'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg><text>a &lt; b &amp; &x; &nbsp;</text></svg>',
		);
		expect(out).toContain("<text>a &lt; b &amp; &amp;x; &amp;nbsp;</text>");
	});

	it("rejects incomplete or malformed documents", () => {
		const complete = '<svg viewBox="0 0 4 4"><circle cx="2" cy="2" r="2"/></svg>';
		for (let cut = 1; cut < complete.length; cut++) {
			expect(sanitizeSvg(complete.slice(0, cut))).toBeNull();
		}
		expect(sanitizeSvg(complete)).not.toBeNull();
		expect(sanitizeSvg("<svg><g></svg></g>")).toBeNull();
		expect(sanitizeSvg("<svg><rect hidden/></svg>")).toBeNull();
		expect(sanitizeSvg("<html><svg/></html>")).toBeNull();
		expect(sanitizeSvg("<svg/><svg/>")).toBeNull();
		expect(sanitizeSvg("text <svg/>")).toBeNull();
		expect(sanitizeSvg("not svg at all")).toBeNull();
	});

	it("encodes a data URL that round-trips", () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>#1 100%</text></svg>';
		const url = svgDataUrl(svg);
		expect(url.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(url.slice(url.indexOf(",") + 1))).toBe(svg);
	});

	it("tells a figure that leaves its width open from one that sets it", () => {
		const fills = (source: string) => svgFillsWidth(sanitizeSvg(source) ?? "");
		expect(fills('<svg viewBox="0 0 760 470"><rect stroke-width="2" width="9"/></svg>')).toBe(true);
		expect(fills('<svg viewBox="0 0 760 470" width="100%"/>')).toBe(true);
		expect(fills('<svg viewBox="0 0 760 470" width="auto" height="200"/>')).toBe(true);
		expect(fills('<svg viewBox="0 0 120 60" width="240" height="120"/>')).toBe(false);
		expect(fills('<svg viewBox="0 0 120 60" width="12em"/>')).toBe(false);
	});
});
