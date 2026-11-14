import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeAgentMarkdown } from "../src/shared/agent-definition";
import { AGENT_TEMPLATES, templateDraft } from "../src/shared/agent-templates";
import { CHROMIUM_BROWSER_IDS, CHROMIUM_BROWSER_NAMES, CHROMIUM_RELAY_PORTS } from "../src/shared/default-browser";

const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "../native/ompdesk/crates/core/assets");

function outputs(): { name: string; content: string }[] {
	return [
		{
			name: "agent-templates.json",
			content: `${JSON.stringify(
				AGENT_TEMPLATES.map(template => ({
					name: template.name,
					content: serializeAgentMarkdown(templateDraft(template)),
				})),
				null,
				2,
			)}\n`,
		},
		{
			name: "browser-catalog.json",
			content: `${JSON.stringify(
				CHROMIUM_BROWSER_IDS.map(id => ({
					id,
					name: CHROMIUM_BROWSER_NAMES[id],
					port: CHROMIUM_RELAY_PORTS[id],
				})),
				null,
				2,
			)}\n`,
		},
	];
}

export function nativeAppDataCurrent(): boolean {
	return outputs().every(({ name, content }) => {
		const path = resolve(ASSETS, name);
		return existsSync(path) && readFileSync(path, "utf8") === content;
	});
}

export function generateNativeAppData(): void {
	for (const { name, content } of outputs()) {
		const path = resolve(ASSETS, name);
		if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
		mkdirSync(ASSETS, { recursive: true });
		writeFileSync(path, content);
	}
}

if (import.meta.main) {
	if (process.argv.includes("--check")) {
		if (!nativeAppDataCurrent())
			throw new Error("Native application data is stale; run bun scripts/native-app-data.ts.");
	} else {
		generateNativeAppData();
	}
}
