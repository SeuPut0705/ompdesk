/**
 * Pictures of a page, for the code that sends them on: a capture no wider than a bound, and a paint encoded as JPEG.
 * Under Electron these were `NativeImage#resize`/`toPNG`/`toJPEG` on a bitmap; here the shell holds the pixels, so
 * the size and the format are asked for at the source (`electron/native-image.ts`).
 */
import type { NativeImage as ElectronImage } from "electron";
import { type EncodeOptions, NativeImage } from "./electron/native-image";

/** Electron's `NativeImage` contract, as a `capturePage` result is (the shim's image in the app). */
function shimImage(image: ElectronImage): NativeImage | null {
	return image instanceof NativeImage ? image : null;
}

/**
 * `image` no wider than `width` and no taller than `height` pixels, keeping its aspect ratio. A capture of the shell is
 * taken again by the page at the smaller scale; any other image uses Electron's own `resize`.
 */
export async function fitImage(
	image: ElectronImage,
	bound: { width?: number; height?: number },
): Promise<ElectronImage> {
	const { width, height } = image.getSize();
	const ratio = Math.min(
		1,
		bound.width === undefined ? 1 : bound.width / width,
		bound.height === undefined ? 1 : bound.height / height,
	);
	if (ratio >= 1) return image;
	const target = { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
	const shim = shimImage(image);
	if (!shim) return image.resize({ ...target, quality: "good" });
	return (await shim.fitted(target.width)) as unknown as ElectronImage;
}

/** `image` encoded in `options.format`, scaled down to `options.width` when wider (a paint the shell still holds). */
export async function encodeImage(image: ElectronImage, options: EncodeOptions): Promise<Buffer> {
	const shim = shimImage(image);
	if (!shim) throw new Error("Only the shell's images can be encoded this way");
	return shim.encode(options);
}
