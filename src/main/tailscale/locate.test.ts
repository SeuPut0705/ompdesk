import { describe, expect, it } from "vitest";
import { type LocateDeps, locateTailscale, MAC_APP_BINARY, macVariantOfBundle } from "./locate";

interface World {
	platform?: "darwin" | "win32";
	env?: NodeJS.ProcessEnv;
	pref?: string | null;
	files?: string[];
	heads?: Record<string, string>;
	links?: Record<string, string>;
	bundles?: Record<string, string>;
	path?: string;
}

function deps(world: World): LocateDeps {
	const files = new Set(world.files ?? []);
	return {
		platform: world.platform ?? "darwin",
		env: world.env ?? {},
		pref: world.pref ?? null,
		pathEnv: async () => world.path ?? "",
		isExecutable: file => files.has(file),
		readHead: file => world.heads?.[file] ?? null,
		realpath: file => world.links?.[file] ?? file,
		bundleId: async app => world.bundles?.[app] ?? null,
	};
}

const APP = "/Applications/Tailscale.app";

describe("locateTailscale on macOS", () => {
	it("prefers the app's own binary and runs it as a CLI", async () => {
		const found = await locateTailscale(
			deps({
				files: [MAC_APP_BINARY, "/opt/homebrew/bin/tailscale"],
				bundles: { [APP]: "io.tailscale.ipn.macos" },
			}),
		);
		expect(found).toEqual({
			path: MAC_APP_BINARY,
			variant: "mac-app-store",
			app: APP,
			env: { TAILSCALE_BE_CLI: "1" },
		});
	});

	it("tells the Standalone app from the App Store one by bundle id, and an unknown bundle is other", async () => {
		const bundle = (id: string) => ({ files: [MAC_APP_BINARY], bundles: { [APP]: id } });
		expect((await locateTailscale(deps(bundle("io.tailscale.ipn.macsys"))))?.variant).toBe("mac-standalone");
		expect((await locateTailscale(deps(bundle("com.example.thing"))))?.variant).toBe("other");
		expect(macVariantOfBundle(null)).toBe("other");
	});

	it("sees through Homebrew's wrapper that execs the app, and through a link into the app", async () => {
		const wrapper = await locateTailscale(
			deps({
				files: ["/opt/homebrew/bin/tailscale"],
				heads: { "/opt/homebrew/bin/tailscale": `#!/bin/sh\nexec ${MAC_APP_BINARY} "$@"\n` },
				bundles: { [APP]: "io.tailscale.ipn.macos" },
			}),
		);
		expect(wrapper).toMatchObject({ path: "/opt/homebrew/bin/tailscale", variant: "mac-app-store", app: APP });
		const link = await locateTailscale(
			deps({
				files: ["/usr/local/bin/tailscale"],
				links: { "/usr/local/bin/tailscale": MAC_APP_BINARY },
				bundles: { [APP]: "io.tailscale.ipn.macsys" },
			}),
		);
		expect(link).toMatchObject({
			path: "/usr/local/bin/tailscale",
			variant: "mac-standalone",
			env: { TAILSCALE_BE_CLI: "1" },
		});
	});

	it("calls a CLI with no app behind it mac-cli, without the app's environment", async () => {
		const found = await locateTailscale(deps({ files: ["/opt/homebrew/bin/tailscale"] }));
		expect(found).toEqual({ path: "/opt/homebrew/bin/tailscale", variant: "mac-cli", app: null, env: {} });
	});

	it("searches the login shell's PATH last", async () => {
		const found = await locateTailscale(
			deps({ files: ["/opt/custom/bin/tailscale"], path: "/usr/bin:/opt/custom/bin" }),
		);
		expect(found?.path).toBe("/opt/custom/bin/tailscale");
		expect(await locateTailscale(deps({ path: "/usr/bin" }))).toBeNull();
	});

	it("takes the pref before the standard places, but not a pref that does not exist", async () => {
		const files = [MAC_APP_BINARY, "/my/tailscale"];
		expect((await locateTailscale(deps({ files, pref: "/my/tailscale" })))?.path).toBe("/my/tailscale");
		expect((await locateTailscale(deps({ files, pref: "/gone/tailscale" })))?.path).toBe(MAC_APP_BINARY);
	});

	it("uses OMP_GUI_TAILSCALE alone: a missing one never falls through to a real install", async () => {
		const files = [MAC_APP_BINARY, "/fake/tailscale"];
		expect(
			(await locateTailscale(deps({ files, env: { OMP_GUI_TAILSCALE: "/fake/tailscale" }, pref: "/x" })))?.path,
		).toBe("/fake/tailscale");
		expect(await locateTailscale(deps({ files, env: { OMP_GUI_TAILSCALE: "/missing/tailscale" } }))).toBeNull();
	});
});

describe("locateTailscale on Windows", () => {
	const win = (world: World) => deps({ platform: "win32", ...world });
	const programFiles = "C:\\Program Files";

	it("looks in Program Files, then Program Files (x86), then PATH", async () => {
		const x64 = `${programFiles}\\Tailscale\\tailscale.exe`.replaceAll("\\", "/");
		const env = { ProgramFiles: "C:/Program Files", "ProgramFiles(x86)": "C:/Program Files (x86)" };
		expect(await locateTailscale(win({ env, files: [x64] }))).toEqual({
			path: x64,
			variant: "windows",
			app: null,
			env: {},
		});
		const x86 = "C:/Program Files (x86)/Tailscale/tailscale.exe";
		expect((await locateTailscale(win({ env, files: [x86] })))?.path).toBe(x86);
		expect(await locateTailscale(win({ env, files: [] }))).toBeNull();
	});
});
