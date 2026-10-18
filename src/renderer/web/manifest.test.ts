import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Image {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
	form_factor?: string;
}

interface Manifest {
	id: string;
	name: string;
	short_name: string;
	description: string;
	start_url: string;
	scope: string;
	display: string;
	orientation?: string;
	icons: Image[];
	screenshots: Image[];
	shortcuts: { name: string; url: string }[];
}

const manifest = JSON.parse(readFileSync("src/renderer/public/manifest.webmanifest", "utf8")) as Manifest;

/** The pixel size a PNG file's header declares. */
function pngSize(file: string): string {
	const header = readFileSync(file);
	return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
}

describe("manifest.webmanifest", () => {
	it("leaves the orientation to the system, so the user's rotation lock holds", () => {
		// "any" (and the sensor values) make Chromium's WebAPK rotate even with auto-rotate locked; "natural" and
		// "portrait" would stop tablets rotating. Unspecified follows the system setting.
		expect(manifest.orientation).toBeUndefined();
	});

	it("names the app and starts it standalone at the origin root (behind serve, the prefix is never visible)", () => {
		expect(manifest).toMatchObject({
			id: "/",
			name: "OMPdesk",
			short_name: "OMPdesk",
			start_url: "/",
			scope: "/",
			display: "standalone",
		});
		expect(manifest.description).not.toBe("");
	});

	it("has 192 and 512 icons plus a maskable one, each file the size it claims", () => {
		const keys = manifest.icons.map(icon => `${icon.sizes}:${icon.purpose}`);
		expect(keys).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
		for (const icon of manifest.icons) expect(pngSize(`src/renderer/public${icon.src}`), icon.src).toBe(icon.sizes);
	});

	it("has narrow and wide screenshots, each file the size it claims, and a new-session shortcut", () => {
		expect(manifest.screenshots.map(shot => shot.form_factor).sort()).toEqual(["narrow", "wide"]);
		for (const shot of manifest.screenshots)
			expect(pngSize(`src/renderer/public${shot.src}`), shot.src).toBe(shot.sizes);
		expect(manifest.shortcuts.map(shortcut => shortcut.url)).toContain("/#/open?new=1");
	});
});
