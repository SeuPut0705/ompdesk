/**
 * Pictures that went out with a prompt, so ↑/↓ prompt history brings them back
 * with its text. Stock HistoryStorage keeps text only; this renderer-run map
 * (keyed by stock's own prompt key) holds the images of the latest sends.
 */

import type { ComposerImage } from "../stores/composer";
import { promptKey } from "../stores/input-history";

/** Sends whose pictures are kept (oldest dropped first): base64 previews are large. */
const LIMIT = 30;
const imagesByPrompt = new Map<string, readonly ComposerImage[]>();

export function rememberHistoryImages(prompt: string, images: readonly ComposerImage[]): void {
	const key = promptKey(prompt);
	imagesByPrompt.delete(key);
	if (images.length === 0) return;
	imagesByPrompt.set(key, images);
	if (imagesByPrompt.size > LIMIT) {
		const oldest = imagesByPrompt.keys().next().value;
		if (oldest !== undefined) imagesByPrompt.delete(oldest);
	}
}

/** The pictures sent with this prompt, or none. */
export function historyImages(prompt: string): readonly ComposerImage[] {
	return imagesByPrompt.get(promptKey(prompt)) ?? [];
}

export function clearHistoryImages(): void {
	imagesByPrompt.clear();
}
