/**
 * Settings › Bot › "Generate…" (`bot-avatar-core.ts`): `bot_avatar.status` resolves the image role without drawing,
 * `bot_avatar.generate` draws one picture on it. The drawing is stock's `generate_image` tool, run here with the
 * session's own registry and settings, rather than a port of its candidate order (`defaultImageCandidates` and
 * `resolveHostedImageCarrier` are private to `tools/image-gen`); it only reads `settings`, `modelRegistry`, `model`
 * and `sessionManager` from its context. `tools/image-gen`, `config/*` and `pi-ai` are modules omp's bundle registers
 * (`tools/*` and `config/*` are named wildcard exports), so none is a separate copy.
 */
import { rm } from "node:fs/promises";
import { isImageGenerationApi } from "@oh-my-pi/pi-ai";
import { isAuthenticated } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { BOT_AVATAR_GENERATE, BOT_AVATAR_PROMPT_MAX, BOT_AVATAR_STATUS } from "./bot-avatar-contracts";
import { type AvatarModel, type AvatarStock, avatarStatus, generateAvatar } from "./bot-avatar-core";
import { guard } from "./health";
import { requiredString } from "./params";
import type { BridgeMethods } from "./types";

function stockFor(session: AgentSession): AvatarStock {
	const { settings, modelRegistry } = session;
	return {
		imageChain: () =>
			resolveRoleChain("image", settings, roleCandidatePool("image", settings, modelRegistry)).map(
				candidate => candidate.model,
			),
		isImageGenerationApi: api => isImageGenerationApi(api as never),
		apiKey: model => modelRegistry.getApiKey(model as AvatarModel as never, session.sessionId),
		isAuthenticated: key => isAuthenticated(key as string | undefined),
		draw: async params => {
			const result = await imageGenTool.execute(
				"ompdesk-bot-avatar",
				params as never,
				undefined,
				{
					sessionManager: session.sessionManager,
					settings,
					modelRegistry,
					model: session.model,
				} as never,
				undefined,
			);
			const message = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
			return { images: result.details?.images ?? [], paths: result.details?.imagePaths ?? [], message };
		},
		remove: path => rm(path, { force: true }),
	};
}

export const methods: BridgeMethods = guard("botAvatar", {
	[BOT_AVATAR_STATUS]: async (_params, env) => avatarStatus(stockFor(env.session())),
	[BOT_AVATAR_GENERATE]: async (params, env) => {
		const prompt = requiredString(params, "prompt");
		if (prompt.length > BOT_AVATAR_PROMPT_MAX)
			throw new Error(`The description is over ${BOT_AVATAR_PROMPT_MAX} characters`);
		return generateAvatar(stockFor(env.session()), prompt);
	},
});
