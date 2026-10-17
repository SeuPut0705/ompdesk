import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("src/renderer/public/manifest.webmanifest", "utf8")) as Record<
	string,
	unknown
>;

describe("manifest.webmanifest", () => {
	it("leaves the orientation to the system, so the user's rotation lock holds", () => {
		// "any" (and the sensor values) make Chromium's WebAPK rotate even with auto-rotate locked; "natural" and
		// "portrait" would stop tablets rotating. Unspecified follows the system setting.
		const allowed = [undefined];
		expect(allowed).toContain(manifest.orientation);
		expect(["any", "sensor", "sensor-landscape", "sensor-portrait"]).not.toContain(manifest.orientation);
	});
});
