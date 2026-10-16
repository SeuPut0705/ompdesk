/**
 * Getting bytes from the page onto the phone: the share sheet where the browser offers one for files (iOS
 * Safari, Android Chrome — the only way iOS reaches Files/Photos), otherwise an anchor download. Executable
 * types are only ever downloaded: the page never opens them.
 */

export type SaveOutcome = "shared" | "downloaded" | "cancelled";

export interface DownloadDeps {
	document?: Pick<Document, "createElement" | "body">;
	navigator?: Pick<Navigator, "canShare" | "share">;
	url?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
	/** Touch devices share; a desktop browser just downloads. */
	preferShare?: () => boolean;
	setTimer?: (callback: () => void, ms: number) => unknown;
}

function defaultPreferShare(): boolean {
	return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** Decode base64 (no data-URL prefix) into bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** `name` without path separators and control characters, never empty. */
export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = Array.from(base)
		.filter(character => character.charCodeAt(0) >= 32)
		.join("")
		.trim();
	return cleaned || "download";
}

/** Save `blob` as `name` on this device. */
export async function saveBlob(name: string, blob: Blob, deps: DownloadDeps = {}): Promise<SaveOutcome> {
	const fileName = safeFileName(name);
	const nav = deps.navigator ?? (typeof navigator === "undefined" ? undefined : navigator);
	if ((deps.preferShare ?? defaultPreferShare)() && nav?.canShare && nav.share) {
		const file = new File([blob], fileName, { type: blob.type });
		if (nav.canShare({ files: [file] })) {
			try {
				await nav.share({ files: [file], title: fileName });
				return "shared";
			} catch (error) {
				// Dismissing the sheet rejects with AbortError; anything else falls back to a download.
				if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
			}
		}
	}
	const urls = deps.url ?? URL;
	const doc = deps.document ?? document;
	const href = urls.createObjectURL(blob);
	const anchor = doc.createElement("a");
	anchor.href = href;
	anchor.download = fileName;
	anchor.rel = "noopener";
	anchor.style.display = "none";
	doc.body.append(anchor);
	anchor.click();
	anchor.remove();
	// The browser reads the URL asynchronously after the click.
	(deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms)))(() => urls.revokeObjectURL(href), 60_000);
	return "downloaded";
}
