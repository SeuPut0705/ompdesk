/**
 * The lookup against the real core process, over files this test makes. Its cases with a made-up machine (the Mac's
 * fixed places, bundle ids, wrappers and links of every shape) moved to the core with the lookup
 * (`native/ompdesk/crates/core/src/tailscale/locate.rs`, rows captured from the TypeScript). A Mac's rules are only
 * asked with the override here: without it they would find the Tailscale of the machine that runs the test.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type LocateInputs, locateTailscale } from "./locate";

const dir = mkdtempSync(join(tmpdir(), "omp-gui-tailscale-locate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An executable file with `text` in it. */
function file(path: string, text = ""): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, 0o755);
	return path;
}

const mac = (forced: string, patch: Partial<LocateInputs> = {}) =>
	locateTailscale({
		platform: "darwin",
		pref: null,
		pathEnv: "",
		bundle: true,
		env: { OMP_GUI_TAILSCALE: forced },
		...patch,
	});

describe("locateTailscale on macOS", () => {
	it("uses OMP_GUI_TAILSCALE alone: a missing one never falls through to a real install", async () => {
		const cli = file(join(dir, "forced", "tailscale"), "#!/bin/sh\nexit 0\n");
		const pref = file(join(dir, "forced", "preferred"));
		expect(await mac(` ${cli} `, { pref })).toEqual({ path: cli, variant: "mac-cli", app: null, env: {} });
		expect(await mac(join(dir, "forced", "missing"), { pref, pathEnv: join(dir, "forced") })).toBeNull();
		// A folder is no CLI.
		expect(await mac(join(dir, "forced"))).toBeNull();
	});

	it("sees through a wrapper that execs the app, and takes a binary for a plain CLI", async () => {
		const app = "/NoSuchPlace/Tailscale.app";
		const wrapper = file(
			join(dir, "wrapper", "tailscale"),
			`#!/bin/sh\nexec "${app}/Contents/MacOS/Tailscale" "$@"\n`,
		);
		// No bundle there to ask: whichever Tailscale it is reads `other`, and it still runs as a CLI.
		const expected = { path: wrapper, variant: "other", app, env: { TAILSCALE_BE_CLI: "1" } };
		expect(await mac(wrapper)).toEqual(expected);
		expect(await mac(wrapper, { bundle: false })).toEqual(expected);
		const binary = file(join(dir, "wrapper", "binary"), `\u0000exec ${app}/Contents/MacOS/Tailscale\n`);
		expect(await mac(binary)).toMatchObject({ variant: "mac-cli", app: null });
	});

	it.skipIf(process.platform === "win32")("needs the execute bit, and sees through a link into an app", async () => {
		const plain = join(dir, "bits", "tailscale");
		file(plain);
		chmodSync(plain, 0o644);
		expect(await mac(plain)).toBeNull();
		const inside = file(join(dir, "bits", "Fake.app", "Contents", "MacOS", "Tailscale"));
		const link = join(dir, "bits", "linked");
		symlinkSync(inside, link);
		expect(await mac(link)).toEqual({
			path: link,
			variant: "other",
			app: join(realpathSync(join(dir, "bits")), "Fake.app"),
			env: { TAILSCALE_BE_CLI: "1" },
		});
	});
});

describe("locateTailscale on Windows", () => {
	// The core joins a Windows path with `\`, whatever machine it runs on: so do these.
	const programs = join(dir, "pf");
	const programs86 = join(dir, "pf86");
	const x64 = `${programs}\\Tailscale\\tailscale.exe`;
	const x86 = `${programs86}\\Tailscale\\tailscale.exe`;
	const tools = join(dir, "tools");
	const onPath = `${tools}\\tailscale.exe`;
	const env = { ProgramFiles: programs, "ProgramFiles(x86)": programs86 };
	const win = (patch: Partial<LocateInputs> = {}) =>
		locateTailscale({ platform: "win32", pref: null, pathEnv: "", bundle: true, env, ...patch });

	it("looks at the pref, in Program Files, then Program Files (x86), then along PATH", async () => {
		mkdirSync(tools, { recursive: true });
		expect(await win({ pathEnv: `${join(dir, "empty")};${tools}` })).toBeNull();
		file(onPath);
		const found = (path: string) => ({ path, variant: "windows", app: null, env: {} });
		expect(await win({ pathEnv: `;${join(dir, "empty")};${tools};` })).toEqual(found(onPath));
		expect(await win()).toBeNull();
		file(x86);
		expect(await win({ pathEnv: tools })).toEqual(found(x86));
		file(x64);
		expect(await win({ pathEnv: tools })).toEqual(found(x64));
		const pref = file(join(dir, "my", "ts.exe"));
		expect(await win({ pref })).toEqual(found(pref));
		expect(await win({ pref: join(dir, "my", "gone.exe") })).toEqual(found(x64));
		// The override alone, here too.
		expect(await win({ pref, env: { ...env, OMP_GUI_TAILSCALE: join(dir, "my", "gone.exe") } })).toBeNull();
	});
});
