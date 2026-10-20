import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PowercfgRunner, parseActiveScheme, parseAcValue, WindowsLidBackend } from "./lid-backend-windows";

const BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";
const SUB = "4f971e89-eebd-4455-a8de-9e59040e7347";
const LID = "5ca83367-6e45-459f-a27b-476b1d01c936";

/** `powercfg /query` for LIDACTION as Windows prints it, labels in the system's language. */
function queryOutput(ac: number, dc: number, korean = false): string {
	const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
	const [acLabel, dcLabel] = korean
		? ["현재 AC 전원 설정 인덱스", "현재 DC 전원 설정 인덱스"]
		: ["Current AC Power Setting Index", "Current DC Power Setting Index"];
	return [
		`Power Scheme GUID: ${BALANCED}  (Balanced)`,
		`  GUID Alias: SCHEME_BALANCED`,
		`  Subgroup GUID: ${SUB}  (Power buttons and lid)`,
		`    GUID Alias: SUB_BUTTONS`,
		`    Power Setting GUID: ${LID}  (Lid close action)`,
		`      GUID Alias: LIDACTION`,
		`      Possible Setting Index: 000`,
		`      Possible Setting Friendly Name: Do nothing`,
		`      Possible Setting Index: 001`,
		`      Possible Setting Friendly Name: Sleep`,
		`    ${acLabel}: ${hex(ac)}`,
		`    ${dcLabel}: ${hex(dc)}`,
		"",
	].join("\r\n");
}

/** A fake powercfg over one scheme's lid values; records every command. */
function fakePowercfg(initial: { ac: number; dc: number }) {
	const state = { ...initial, active: BALANCED };
	const commands: string[] = [];
	const answer = (args: readonly string[]): string => {
		commands.push(args.join(" "));
		const [verb, scheme, , , value] = args;
		if (verb === "/getactivescheme") return `Power Scheme GUID: ${state.active}  (Balanced)\r\n`;
		if (verb === "/query") return queryOutput(state.ac, state.dc);
		if (verb === "/setacvalueindex") {
			expect(scheme).toBe(BALANCED);
			state.ac = Number(value);
			return "";
		}
		if (verb === "/setactive") return "";
		throw new Error(`unexpected powercfg ${args.join(" ")}`);
	};
	return { state, commands, runner: { run: async (args: readonly string[]) => answer(args), runSync: answer } };
}

let dir: string;
function backend(powercfg: { runner: PowercfgRunner }) {
	dir = mkdtempSync(join(tmpdir(), "lid-awake-"));
	return new WindowsLidBackend({
		powercfg: powercfg.runner,
		hasBattery: async () => true,
		markerFile: join(dir, "lid-awake.json"),
		now: () => 1000,
	});
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("powercfg parsing", () => {
	it("reads the active scheme and the AC value whatever language the labels are in", () => {
		expect(parseActiveScheme(`Power Scheme GUID: ${BALANCED.toUpperCase()}  (Balanced)`)).toBe(BALANCED);
		expect(parseAcValue(queryOutput(1, 2))).toBe(1);
		expect(parseAcValue(queryOutput(3, 0, true))).toBe(3);
		expect(() => parseAcValue("nothing here")).toThrow();
	});
});

describe("WindowsLidBackend", () => {
	it("sets the AC lid action to do nothing while held, never the battery value, and puts the user's back", async () => {
		const powercfg = fakePowercfg({ ac: 1, dc: 1 });
		const lid = backend(powercfg);
		expect(await lid.hold()).toEqual({ changed: true, details: { scheme: BALANCED, ac: 1 } });
		expect(powercfg.state).toMatchObject({ ac: 0, dc: 1 });
		expect(JSON.parse(readFileSync(join(dir, "lid-awake.json"), "utf8"))).toEqual({
			scheme: BALANCED,
			ac: 1,
			at: 1000,
		});
		expect(powercfg.commands).toContain(`/setacvalueindex ${BALANCED} ${SUB} ${LID} 0`);
		expect(powercfg.commands).toContain("/setactive SCHEME_CURRENT");
		expect(powercfg.commands.some(command => command.startsWith("/setdcvalueindex"))).toBe(false);

		await lid.release();
		expect(powercfg.state).toMatchObject({ ac: 1, dc: 1 });
		expect(existsSync(join(dir, "lid-awake.json"))).toBe(false);
	});

	it("leaves a user who already chose do nothing alone", async () => {
		const powercfg = fakePowercfg({ ac: 0, dc: 1 });
		const lid = backend(powercfg);
		expect((await lid.hold()).changed).toBe(false);
		await lid.release();
		expect(powercfg.commands.filter(command => command.startsWith("/set"))).toEqual([]);
		expect(existsSync(join(dir, "lid-awake.json"))).toBe(false);
	});

	it("keeps a value the user changed while it was held", async () => {
		const powercfg = fakePowercfg({ ac: 2, dc: 1 });
		const lid = backend(powercfg);
		await lid.hold();
		powercfg.state.ac = 1;
		await lid.release();
		expect(powercfg.state.ac).toBe(1);
	});

	it("restores synchronously at quit", async () => {
		const powercfg = fakePowercfg({ ac: 1, dc: 1 });
		const lid = backend(powercfg);
		await lid.hold();
		lid.releaseNow();
		expect(powercfg.state.ac).toBe(1);
		expect(existsSync(join(dir, "lid-awake.json"))).toBe(false);
	});

	it("after a crash, the next launch puts the user's value back from the marker", async () => {
		const powercfg = fakePowercfg({ ac: 1, dc: 1 });
		await backend(powercfg).hold();
		// The process died holding it: a new backend over the same userData.
		const next = new WindowsLidBackend({
			powercfg: powercfg.runner,
			hasBattery: async () => true,
			markerFile: join(dir, "lid-awake.json"),
			now: () => 2000,
		});
		expect(await next.recover()).toEqual({ scheme: BALANCED, ac: 1, restored: true });
		expect(powercfg.state.ac).toBe(1);
		expect(existsSync(join(dir, "lid-awake.json"))).toBe(false);
		expect(await next.recover()).toBeNull();
	});

	it("drops an unreadable marker without guessing a value", async () => {
		const powercfg = fakePowercfg({ ac: 0, dc: 1 });
		const lid = backend(powercfg);
		writeFileSync(join(dir, "lid-awake.json"), "{not json");
		expect(await lid.recover()).toBeNull();
		expect(powercfg.state.ac).toBe(0);
		expect(existsSync(join(dir, "lid-awake.json"))).toBe(false);
	});
});
