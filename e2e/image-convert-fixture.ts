/// <reference types="bun" />
/**
 * The fake omp package's stand-ins for stock's image path (`pi-tui/chat/image-loading` `ensureSupportedImageInput`
 * and `pi-coding-agent/utils/image-resize` `resizeImage`), which the stock helper's `image.toModel` runs on a
 * phone's HEIC. Like stock they decode with `Bun.Image`; this one always answers a JPEG.
 */
interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function ensureSupportedImageInput(image: ImageBlock): Promise<ImageBlock | null> {
	if (SUPPORTED.has(image.mimeType)) return image;
	const png = await new Bun.Image(Buffer.from(image.data, "base64")).png().bytes();
	return { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" };
}

export async function resizeImage(image: ImageBlock): Promise<{ data: string; mimeType: string }> {
	const jpeg = await new Bun.Image(Buffer.from(image.data, "base64")).jpeg().bytes();
	return { data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };
}
