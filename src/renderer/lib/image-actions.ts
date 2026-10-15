/**
 * What an image's right-click menu does with the picture it shows: copy it to
 * the clipboard, or save it where the user picks. Both work from the `src` the
 * page already holds (a data: or blob: URL, or a local media URL).
 */

/** Chromium's async clipboard writes PNG only; anything else is re-encoded. */
async function asPng(blob: Blob): Promise<Blob> {
	if (blob.type === "image/png") return blob;
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
		return await canvas.convertToBlob({ type: "image/png" });
	} finally {
		bitmap.close();
	}
}

export async function copyImage(src: string): Promise<void> {
	const blob = await (await fetch(src)).blob();
	const png = await asPng(blob);
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** `saved` is false when the user cancelled the dialog. */
export async function saveImage(src: string, name: string): Promise<{ saved: boolean; error?: string }> {
	const blob = await (await fetch(src)).blob();
	const type = blob.type || "image/png";
	return window.omp.system.saveImage(name, type, bytesToBase64(new Uint8Array(await blob.arrayBuffer())));
}
