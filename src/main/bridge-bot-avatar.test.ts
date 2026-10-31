import { describe, expect, it, vi } from "vitest";
import {
	AVATAR_STYLE,
	type AvatarDrawn,
	type AvatarModel,
	type AvatarStock,
	avatarStatus,
	generateAvatar,
} from "../../resources/gui-bridge/bot-avatar-core";

const OPENAI: AvatarModel = { provider: "openai", id: "gpt-image-2", api: "openai-responses" };
const GEMINI: AvatarModel = { provider: "google", id: "gemini-3-pro-image", api: "google-generative-ai" };
const CHAT: AvatarModel = { provider: "anthropic", id: "claude", api: "anthropic-messages" };
const IMAGE_APIS = new Set([OPENAI.api, GEMINI.api]);

/** The slice of stock the module calls, over a chain and the keys each model has. */
function stock(chain: AvatarModel[], keys: Record<string, string | undefined> = {}, drawn?: AvatarDrawn) {
	const removed: string[] = [];
	const draw = vi.fn(async (_params: unknown) => drawn ?? { images: [], paths: [], message: "" });
	const api: AvatarStock = {
		imageChain: () => chain,
		isImageGenerationApi: apiName => IMAGE_APIS.has(apiName),
		apiKey: async model => keys[`${model.provider}/${model.id}`],
		isAuthenticated: key => Boolean(key) && key !== "N/A",
		draw,
		remove: async path => void removed.push(path),
	};
	return { api, draw, removed };
}

describe("bot_avatar.status", () => {
	it("is no_model while the image role resolves to nothing a generation API serves", async () => {
		expect(await avatarStatus(stock([]).api)).toEqual({ available: false, reason: "no_model" });
		expect(await avatarStatus(stock([CHAT], { "anthropic/claude": "key" }).api)).toEqual({
			available: false,
			reason: "no_model",
		});
	});

	it("is no_credentials when the models resolve but none is signed in", async () => {
		expect(await avatarStatus(stock([OPENAI, GEMINI], { "openai/gpt-image-2": "N/A" }).api)).toEqual({
			available: false,
			reason: "no_credentials",
		});
	});

	it("names the first model of the chain that has credentials, and draws nothing", async () => {
		const { api, draw } = stock([CHAT, OPENAI, GEMINI], { "google/gemini-3-pro-image": "key" });
		expect(await avatarStatus(api)).toEqual({ available: true, model: "google/gemini-3-pro-image" });
		expect(draw).not.toHaveBeenCalled();
	});
});

describe("bot_avatar.generate", () => {
	const drawn = (over: Partial<AvatarDrawn> = {}): AvatarDrawn => ({
		images: [{ data: "cGl4ZWxz", mimeType: "image/png" }],
		paths: ["/tmp/omp-image-1.png"],
		message: "",
		...over,
	});

	it("passes the words with a square avatar hint to stock's generate_image and returns the first picture's bytes", async () => {
		const { api, draw, removed } = stock(
			[OPENAI],
			{},
			drawn({
				images: [
					{ data: "cGl4ZWxz", mimeType: "image/png" },
					{ data: "b3RoZXI=", mimeType: "image/png" },
				],
			}),
		);
		expect(await generateAvatar(api, "  a calm blue fox ")).toEqual({ mimeType: "image/png", base64: "cGl4ZWxz" });
		expect(draw).toHaveBeenCalledWith({ subject: "a calm blue fox", style: AVATAR_STYLE, aspect_ratio: "1:1" });
		expect(removed).toEqual(["/tmp/omp-image-1.png"]);
	});

	it("refuses an empty description before asking any model", async () => {
		const { api, draw } = stock([OPENAI]);
		await expect(generateAvatar(api, "   ")).rejects.toThrow(/Describe/);
		expect(draw).not.toHaveBeenCalled();
	});

	it("reports what stock said when no picture came back, and still removes its files", async () => {
		const { api, removed } = stock([OPENAI], {}, drawn({ images: [], message: "No image data returned." }));
		await expect(generateAvatar(api, "a fox")).rejects.toThrow("No image data returned.");
		expect(removed).toEqual(["/tmp/omp-image-1.png"]);
	});

	it("lets stock's failure through (the exhausted chain names what was skipped)", async () => {
		const { api, draw } = stock([OPENAI]);
		draw.mockRejectedValue(new Error("Image generation exhausted the resolved image chain: openai/gpt-image-2"));
		await expect(generateAvatar(api, "a fox")).rejects.toThrow(/exhausted the resolved image chain/);
	});
});
