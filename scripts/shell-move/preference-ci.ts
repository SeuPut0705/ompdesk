// keychain-ci.sh's existing signed launch only; API success without a fresh CEF readback is not evidence.
import { readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { evaluateExpression, Inspector, inspectorUrl } from "../../e2e/fixture/shell-launch";

export async function verifyProxyPreference(logFile: string, invoke: () => Promise<unknown>) {
	const before = await readFile(logFile);
	if (before.length && before.at(-1) !== 10) throw new Error("Incomplete pre-invocation shell log");
	await invoke();
	const after = await readFile(logFile);
	if (after.length < before.length || !after.subarray(0, before.length).equals(before)) {
		throw new Error("Shell log was replaced during preference invocation");
	}
	const added = after.subarray(before.length).toString("utf8");
	if (!added.endsWith("\n")) throw new Error("No complete fresh preference readback");
	let records = 0;
	for (const line of added.trimEnd().split("\n")) {
		const record: unknown = JSON.parse(line);
		if (!record || typeof record !== "object" || !("event" in record)) continue;
		if (record.event !== "session.pref" || !("name" in record) || record.name !== "proxy") continue;
		if (!("applied" in record) || record.applied !== true) throw new Error("CEF proxy preference was not applied");
		records++;
	}
	if (!records) throw new Error("No fresh CEF proxy preference readback");
	return { event: "session.pref", name: "proxy", applied: true, records };
}

async function main() {
	if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
		throw new Error("Preference invocation is restricted to the throwaway macOS Actions runner");
	}
	const root = await realpath(process.env.RUNNER_TEMP);
	const work = await realpath(process.argv[2] ?? "");
	if (work !== path.join(root, "kc")) throw new Error("Not the keychain CI work folder");
	const userData = path.join(work, "ud-a");
	const stderr = path.join(work, "shell-a.out");
	const logFile = path.join(userData, "shell-webview", "shell.log.jsonl");
	for (const file of [userData, stderr, logFile]) {
		if ((await realpath(file)) !== file) throw new Error("Keychain CI path redirects outside its launch");
	}
	const url = inspectorUrl(await readFile(stderr, "utf8"));
	if (!url) throw new Error("This launch exposed no Node inspector");
	const endpoint = new URL(url);
	if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1") throw new Error("Non-local Node inspector");
	const inspector = await Inspector.connect(url, 10_000);
	try {
		const result = await verifyProxyPreference(logFile, () =>
			inspector.evaluate(
				evaluateExpression(
					(
						electron: {
							app: { getPath(name: string): string };
							shellHost: { call(method: string, params: unknown): Promise<unknown> };
						},
						expected: string,
					) => {
						if (electron.app.getPath("userData") !== expected)
							throw new Error("Inspector belongs to another profile");
						return electron.shellHost.call("session.op", {
							partition: "app",
							op: "setProxy",
							args: { mode: "direct" },
						});
					},
					userData,
				),
			),
		);
		console.log(`EVIDENCE: A CEF preference ${JSON.stringify(result)}`);
	} finally {
		inspector.close();
	}
}

if (import.meta.main) await main();
