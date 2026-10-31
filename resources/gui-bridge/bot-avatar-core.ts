/**
 * The bot's avatar on the image role: which model would draw it, and the one request that does. Pure: the slice of
 * stock it calls comes in as `AvatarStock` (`bot-avatar.ts` binds the real functions to the session), so the rules
 * run in the GUI's own vitest. Nothing re-derives stock's image-role resolution: the chain is stock's
 * `resolveRoleChain`, and the drawing is stock's own `generate_image` tool (candidate order, hosted carriers and
 * credentials included).
 */
import type { BotAvatarImage, BotAvatarStatus } from "./bot-avatar-contracts";

/** Added to the owner's words, so a provider that draws a scene still draws something an avatar can use. */
export const AVATAR_STYLE = "square avatar, centered, simple background";

export interface AvatarModel {
	provider: string;
	id: string;
	api: string;
}

/** The parameters of stock's `generate_image` tool that the avatar sets. */
export interface AvatarDrawParams {
	subject: string;
	style: string;
	aspect_ratio: "1:1";
}

/** What one `generate_image` run leaves: the pictures, the temp files stock wrote for them, and its message. */
export interface AvatarDrawn {
	images: ReadonlyArray<{ data: string; mimeType: string }>;
	paths: readonly string[];
	message: string;
}

export interface AvatarStock {
	/** `resolveRoleChain("image", settings, roleCandidatePool("image", settings, registry))`, in stock's attempt order. */
	imageChain(): readonly AvatarModel[];
	/** `pi-ai` `isImageGenerationApi`. */
	isImageGenerationApi(api: string): boolean;
	/** `modelRegistry.getApiKey(model, sessionId)`. */
	apiKey(model: AvatarModel): Promise<unknown>;
	/** `config/model-registry` `isAuthenticated`. */
	isAuthenticated(key: unknown): boolean;
	/** One run of stock's `generate_image` tool over the session's registry and settings. */
	draw(params: AvatarDrawParams): Promise<AvatarDrawn>;
	/** Deletes a temp picture stock wrote. */
	remove(path: string): Promise<void>;
}

/** The first image model of the role's chain that stock's tool could call, without generating anything. */
export async function avatarStatus(stock: AvatarStock): Promise<BotAvatarStatus> {
	const chain = stock.imageChain().filter(model => stock.isImageGenerationApi(model.api));
	if (chain.length === 0) return { available: false, reason: "no_model" };
	for (const model of chain) {
		if (stock.isAuthenticated(await stock.apiKey(model))) {
			return { available: true, model: `${model.provider}/${model.id}` };
		}
	}
	return { available: false, reason: "no_credentials" };
}

export async function generateAvatar(stock: AvatarStock, prompt: string): Promise<BotAvatarImage> {
	const subject = prompt.trim();
	if (!subject) throw new Error("Describe the avatar first");
	const drawn = await stock.draw({ subject, style: AVATAR_STYLE, aspect_ratio: "1:1" });
	try {
		const first = drawn.images[0];
		if (!first) throw new Error(drawn.message || "The image model returned no picture");
		return { mimeType: first.mimeType, base64: first.data };
	} finally {
		await Promise.all(drawn.paths.map(path => stock.remove(path).catch(() => {})));
	}
}
