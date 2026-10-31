import { describe, expect, it, vi } from "vitest";
import {
	BOT_AVATAR_GENERATE,
	BOT_AVATAR_STATUS,
	type BotAvatarAnswer,
} from "../../../resources/gui-bridge/bot-avatar-contracts";
import { BotActivityLog } from "./bot-activity";
import {
	type AvatarBridge,
	type AvatarSidecar,
	type AvatarTabs,
	avatarBridge,
	avatarStatus,
	BotAvatarPromptSchema,
	generateAvatar,
	NO_SESSION_MESSAGE,
} from "./bot-avatar-draw";
import { BotDesk } from "./bot-desk";
import { editBotDesk } from "./bot-desk-edit";

/** A sidecar whose bridge answers with its own name, so a test can tell which one was asked. */
function sidecar(name: string, over: Partial<AvatarSidecar> = {}): AvatarSidecar {
	return { status: "ready", bridgeRequest: async () => name, ...over };
}

async function asked(bridge: AvatarBridge | null): Promise<unknown> {
	return bridge?.("x");
}

const BOT_FILE = "/sessions/bot.jsonl";

/** A pool with the bot's file held by a tab (`botTab`), or by none. */
function pool(botTab: AvatarSidecar | null): AvatarTabs {
	return {
		sessionOwner: path => (path === BOT_FILE && botTab ? { tabId: "tbot" } : null),
		sidecarOf: tabId => (tabId === "tbot" ? botTab : null),
	};
}

describe("the bridge Settings › Bot › Generate asks", () => {
	it("is the bot's own tab when it is live, else the asking window's tab", async () => {
		expect(await asked(avatarBridge(pool(sidecar("bot")), BOT_FILE, sidecar("window")))).toBe("bot");
		expect(await asked(avatarBridge(pool(null), BOT_FILE, sidecar("window")))).toBe("window");
		expect(await asked(avatarBridge(pool(sidecar("bot")), null, sidecar("window")))).toBe("window");
		expect(await asked(avatarBridge(pool(sidecar("bot", { status: "starting" })), BOT_FILE, sidecar("window")))).toBe(
			"window",
		);
	});

	it("never asks a paired host's tab, a tab without a bridge or one that is not ready", () => {
		const remote = sidecar("remote", { device: "mini" });
		const bare: AvatarSidecar = { status: "ready" };
		const asleep = sidecar("asleep", { status: "asleep" });
		expect(avatarBridge(pool(remote), BOT_FILE, bare)).toBeNull();
		expect(avatarBridge(pool(asleep), BOT_FILE, remote)).toBeNull();
		expect(avatarBridge(pool(null), null, null)).toBeNull();
	});
});

describe("avatarStatus", () => {
	it("answers the bridge's status without drawing, and says so when no session can be asked", async () => {
		const request = vi.fn(async (): Promise<BotAvatarAnswer> => ({ available: true, model: "openai/gpt-image-1" }));
		expect(await avatarStatus(request)).toEqual({ available: true, model: "openai/gpt-image-1" });
		expect(request).toHaveBeenCalledOnce();
		expect(request.mock.calls[0]).toEqual([BOT_AVATAR_STATUS]);
		expect(await avatarStatus(null)).toEqual({ available: false, reason: "no_session" });
	});

	it("passes the bridge's reason on, and reads a bridge that fails as unavailable", async () => {
		expect(await avatarStatus(async () => ({ available: false, reason: "no_credentials" }))).toEqual({
			available: false,
			reason: "no_credentials",
		});
		expect(
			await avatarStatus(async () => {
				throw new Error("unsupported_omp");
			}),
		).toEqual({ available: false, reason: "unavailable" });
	});
});

describe("generateAvatar", () => {
	function rig() {
		const activity = new BotActivityLog({ file: null });
		const desk = new BotDesk({ file: null, activity: draft => void activity.append(draft) });
		const cut: Buffer[] = [];
		const deps = {
			desk,
			avatarFromBuffer: (bytes: Buffer) => {
				cut.push(bytes);
				return `data:image/png;base64,${bytes.toString("base64")}`;
			},
		};
		return { activity, desk, deps, cut };
	}

	it("sends the words to the bridge, cuts the picture it returns and sets it as the owner's change", async () => {
		const { activity, desk, deps, cut } = rig();
		const before = desk.state().identity.avatar;
		const bridge = vi.fn(async () => ({ mimeType: "image/png", base64: Buffer.from("pixels").toString("base64") }));
		await generateAvatar(deps, bridge, "a calm blue fox");
		expect(bridge).toHaveBeenCalledOnce();
		const [method, params, wait] = bridge.mock.calls[0] as unknown as [string, unknown, number];
		expect(method).toBe(BOT_AVATAR_GENERATE);
		expect(params).toEqual({ prompt: "a calm blue fox" });
		expect(wait).toBeGreaterThan(180_000);
		expect(cut.map(bytes => bytes.toString())).toEqual(["pixels"]);
		expect(desk.state().identity.avatar).toEqual({
			kind: "image",
			dataUrl: `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`,
		});
		const entry = activity.entries().find(item => item.action === "identity");
		expect(entry).toMatchObject({ by: "owner" });
		expect(entry?.undo).toMatchObject({ op: "identity", avatar: before });
	});

	it("is undone from the activity log like any identity change", async () => {
		const { activity, desk, deps } = rig();
		const before = desk.state().identity.avatar;
		await generateAvatar(deps, async () => ({ mimeType: "image/png", base64: "AAAA" }), "a fox");
		const entry = activity.entries().find(item => item.action === "identity");
		await editBotDesk(
			{ desk, activity, createSideChat: async () => "", deleteSession: async () => {} },
			{ op: "undo", activity: entry?.id ?? "" },
			"owner",
		);
		expect(desk.state().identity.avatar).toEqual(before);
		expect(activity.get(entry?.id ?? "")?.undone).toBe(true);
	});

	it("refuses with no live session, and leaves the desk alone when the model draws nothing", async () => {
		const { desk, deps } = rig();
		const before = desk.state();
		await expect(generateAvatar(deps, null, "a fox")).rejects.toThrow(NO_SESSION_MESSAGE);
		await expect(generateAvatar(deps, async () => ({ mimeType: "image/png", base64: "" }), "a fox")).rejects.toThrow(
			/no picture/,
		);
		await expect(
			generateAvatar(
				deps,
				async () => {
					throw new Error("Image generation exhausted the resolved image chain");
				},
				"a fox",
			),
		).rejects.toThrow(/exhausted/);
		expect(desk.state()).toEqual(before);
	});

	it("takes a description of 1 to 500 characters, trimmed", () => {
		expect(BotAvatarPromptSchema.parse("  a fox  ")).toBe("a fox");
		expect(() => BotAvatarPromptSchema.parse("   ")).toThrow();
		expect(() => BotAvatarPromptSchema.parse("x".repeat(501))).toThrow();
	});
});
