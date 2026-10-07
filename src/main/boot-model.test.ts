import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { bootModelSelector, FALLBACK_BOOT_MODEL, isNoModelBootFailure } from "./boot-model";
import { RM_TEMP } from "./test-fake-omp";

const bridgeDir = path.resolve("resources/gui-bridge");
const run = async () => ({ code: 0, stdout: "", stderr: "" });

/** An npm-style install: `<dir>/omp` beside `node_modules/@oh-my-pi/{pi-coding-agent,pi-catalog}`. */
async function fakeInstall(dir: string, defaults: Record<string, string>): Promise<string> {
	const scope = path.join(dir, "node_modules", "@oh-my-pi");
	await fs.mkdir(path.join(scope, "pi-coding-agent"), { recursive: true });
	await fs.mkdir(path.join(scope, "pi-catalog"), { recursive: true });
	await fs.writeFile(
		path.join(scope, "pi-coding-agent", "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
	);
	await fs.writeFile(
		path.join(scope, "pi-catalog", "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-catalog", exports: { "./provider-models": "./provider-models.ts" } }),
	);
	await fs.writeFile(
		path.join(scope, "pi-catalog", "provider-models.ts"),
		`export const DEFAULT_MODEL_PER_PROVIDER = ${JSON.stringify(defaults)};\n`,
	);
	const bin = path.join(dir, "omp");
	await fs.writeFile(bin, "");
	return bin;
}

test("recognizes every stock no-model boot failure", () => {
	expect(
		isNoModelBootFailure(
			"No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.",
		),
	).toBe(true);
	expect(isNoModelBootFailure("No models available. Use /login or set an API key environment variable.")).toBe(true);
	expect(isNoModelBootFailure("No model available matching enabledModels (x/y) with usable credentials.")).toBe(true);
	// The API-key footer stock appends to every headline: a reworded headline still recovers.
	expect(isNoModelBootFailure("Something new.\n\nSet an API key environment variable:\n  ANTHROPIC_API_KEY")).toBe(
		true,
	);
	expect(isNoModelBootFailure("error: Could not restore model gone/model-x")).toBe(false);
	// omp writes it in red when the terminal (or CI) asks for color.
	expect(isNoModelBootFailure("\x1b[31mNo models available. Use /login\x1b[39m")).toBe(true);
	expect(isNoModelBootFailure("\x1b[31mNo default model selected. Use /login\x1b[39m")).toBe(true);
});

test("picks the boot model from the installed omp's catalog defaults", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-boot-model-"));
	try {
		const bin = await fakeInstall(dir, { abliteration: "x-1", anthropic: "claude-next", openai: "gpt-next" });
		expect(await bootModelSelector({ bin, version: "18.6.3", run }, bridgeDir)).toBe("anthropic/claude-next");
	} finally {
		await fs.rm(dir, RM_TEMP);
	}
}, 30_000);

test("falls back to a known selector when the catalog cannot be read", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-boot-model-missing-"));
	try {
		const bin = path.join(dir, "omp");
		await fs.writeFile(bin, "");
		expect(await bootModelSelector({ bin, version: "18.6.3", run }, bridgeDir)).toBe(FALLBACK_BOOT_MODEL);
	} finally {
		await fs.rm(dir, RM_TEMP);
	}
});
