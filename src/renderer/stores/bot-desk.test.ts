import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotDeskAnswer, BotDeskDuties, BotDeskState } from "../../shared/bot-desk";
import { ensureBotDesk, releaseBotDesk, useBotDeskStore } from "./bot-desk";
import { useToastStore } from "./toast";

interface DeskApi {
	get: Mock<(device?: string) => Promise<BotDeskState>>;
	answer: Mock<(payload: BotDeskAnswer, device?: string) => Promise<void>>;
	setDuties: Mock<(payload: BotDeskDuties, device?: string) => Promise<void>>;
	onChanged: Mock<(callback: (state: BotDeskState, device?: string) => void) => () => void>;
}

const EMPTY: BotDeskState = { duties: [], decisions: [], wakes: [] };
const WITH_DUTY: BotDeskState = {
	...EMPTY,
	duties: [{ id: "a", text: "Check the build", at: "2026-10-31T09:00:00.000Z" }],
};
const MINI_OPEN: BotDeskState = {
	...EMPTY,
	decisions: [{ id: "d1", state: "open", question: "Ship?", options: [], at: "2026-10-31T09:00:00.000Z" }],
};

const local = () => useBotDeskStore.getState().desks.local;
const host = (device: string) => useBotDeskStore.getState().desks[device];

let api: DeskApi;

beforeEach(() => {
	api = {
		get: vi.fn(async () => EMPTY),
		answer: vi.fn(async () => {}),
		setDuties: vi.fn(async () => {}),
		onChanged: vi.fn(() => () => {}),
	};
	vi.stubGlobal("window", { omp: { sessions: { botDesk: api } } });
});

afterEach(() => {
	useBotDeskStore.getState().reset();
	useToastStore.setState({ toasts: [] } as never);
	vi.unstubAllGlobals();
});

describe("bot desk store", () => {
	it("is not loaded until the first read lands", async () => {
		expect(local()?.loaded).toBeUndefined();
		await useBotDeskStore.getState().refresh();
		expect(local()?.loaded).toBe(true);
	});

	it("lets a push that lands during a read win over the read's older answer", async () => {
		const { promise, resolve } = Promise.withResolvers<BotDeskState>();
		api.get.mockImplementationOnce(() => promise);
		const read = useBotDeskStore.getState().refresh();

		useBotDeskStore.getState().apply(WITH_DUTY);
		resolve(EMPTY);
		await read;

		expect(local()?.desk).toBe(WITH_DUTY);
	});

	it("keeps the error of a read that failed, and clears it when something arrives", async () => {
		const failure = new Error("not ready");
		api.get.mockRejectedValueOnce(failure);

		await useBotDeskStore.getState().refresh();
		expect(local()?.loaded).toBe(false);
		expect(local()?.loadError).toBe(failure);

		await useBotDeskStore.getState().refresh();
		expect(local()?.loaded).toBe(true);
		expect(local()?.loadError).toBeNull();
	});

	it("sends an answer and the whole duty list as main's payloads", async () => {
		expect(await useBotDeskStore.getState().answer("d1", "Ship it")).toBe(true);
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it" });

		expect(await useBotDeskStore.getState().setDuties([{ id: "a", text: "Check the build" }])).toBe(true);
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ id: "a", text: "Check the build" }] });
		// This computer's own desk follows main's push: no second read.
		expect(api.get).not.toHaveBeenCalled();
	});

	it("toasts and answers false when main refuses, never leaving the failure unhandled", async () => {
		api.answer.mockRejectedValueOnce(new Error("refused"));
		api.setDuties.mockRejectedValueOnce(new Error("refused"));

		expect(await useBotDeskStore.getState().answer("d1", "Ship it")).toBe(false);
		expect(await useBotDeskStore.getState().setDuties([])).toBe(false);

		expect(useToastStore.getState().toasts).toHaveLength(2);
	});

	it("reads once and follows main's changes", async () => {
		ensureBotDesk();
		ensureBotDesk();
		await vi.waitFor(() => expect(local()?.loaded).toBe(true));
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(api.onChanged).toHaveBeenCalledTimes(1);

		const [listener] = api.onChanged.mock.calls[0] ?? [];
		listener?.(WITH_DUTY);
		expect(local()?.desk).toBe(WITH_DUTY);
	});
});

describe("a paired host's desk", () => {
	it("is kept apart from this computer's, read and followed by the host's id", async () => {
		api.get.mockImplementation(async device => (device === "mini" ? MINI_OPEN : EMPTY));
		ensureBotDesk();
		ensureBotDesk("mini");
		ensureBotDesk("mini");
		await vi.waitFor(() => expect(host("mini")?.loaded).toBe(true));
		await vi.waitFor(() => expect(local()?.loaded).toBe(true));
		expect(api.get.mock.calls).toEqual([[], ["mini"]]);
		expect(host("mini")?.desk).toBe(MINI_OPEN);
		expect(local()?.desk).toBe(EMPTY);
		expect(api.onChanged).toHaveBeenCalledTimes(1);

		// A push names the computer it comes from; the other desk is untouched.
		const [listener] = api.onChanged.mock.calls[0] ?? [];
		listener?.(WITH_DUTY, "mini");
		expect(host("mini")?.desk).toBe(WITH_DUTY);
		expect(local()?.desk).toBe(EMPTY);
	});

	it("answers and edits the duties on that host, then reads its desk again", async () => {
		api.get.mockResolvedValue(WITH_DUTY);

		expect(await useBotDeskStore.getState().answer("d1", "Ship it", "mini")).toBe(true);
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it" }, "mini");
		expect(await useBotDeskStore.getState().setDuties([], "mini")).toBe(true);
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [] }, "mini");

		await vi.waitFor(() => expect(host("mini")?.desk).toBe(WITH_DUTY));
		expect(api.get).toHaveBeenCalledWith("mini");
		expect(local()).toBeUndefined();
	});

	it("reads again after its link was lost and came back", async () => {
		ensureBotDesk("mini");
		await vi.waitFor(() => expect(host("mini")?.loaded).toBe(true));
		releaseBotDesk("mini");
		ensureBotDesk("mini");
		await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
	});
});
