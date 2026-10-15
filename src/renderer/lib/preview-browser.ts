import { isLoopbackUrl, previewUrl } from "../../shared/preview";
import type { ToolsStore } from "../stores/tools";
import { resultText } from "./format";

/** What a dev server prints when it listens on every interface; the page answers on localhost. */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "[::]"]);

function reachableUrl(value: string): string | null {
	const safe = previewUrl(value);
	if (!safe) return null;
	const url = new URL(safe);
	if (!WILDCARD_HOSTS.has(url.hostname)) return safe;
	url.hostname = "localhost";
	return url.href;
}

export function detectLocalPreviewUrls(text: string): string[] {
	const urls: string[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s<>\x1b"'`]+/g)) {
		const safe = reachableUrl(match[0].replace(/[),.;\]}]+$/, ""));
		if (safe && isLoopbackUrl(safe) && !urls.includes(safe)) urls.push(safe);
	}
	return urls;
}
/** Stock bash wire results, including live updates; no second server-discovery source. */
export function latestBashPreviewUrl(
	state: Pick<ToolsStore, "finishedTools" | "liveTools" | "partialResults">,
): string | null {
	let latest: string | null = null;
	let timestamp = -Infinity;
	for (let phase = 0; phase < 2; phase++) {
		const entries = phase === 0 ? state.finishedTools : state.liveTools;
		for (const [key, entry] of entries) {
			if (entry.toolName !== "bash") continue;
			const time = entry.endTime ?? entry.startTime;
			if (time < timestamp) continue;
			const urls = detectLocalPreviewUrls(resultText(state.partialResults.get(key) ?? entry.result));
			if (urls.length) {
				latest = urls[urls.length - 1];
				timestamp = time;
			}
		}
	}
	return latest;
}
