import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotDeskAnswer, BotDeskDuties, BotDeskState } from "../../shared/bot-desk";
import { ensureBotDesk, useBotDeskStore } from "./bot-desk";
import { useToastStore } from "./toast";

interface DeskApi {
	get: Mock<() => Promise<BotDeskState>>;
	answer: Mock<(payload: BotDeskAnswer) => Promise<void>>;
	setDuties: Mock<(payload: BotDeskDuties) => Promise<void>>;
	onChanged: Mock<(callback: (state: BotDeskState) => void) => () => void>;
}

const EMPTY: BotDeskState = { duties: [], decisions: [], wakes: [] };
const WITH_DUTY: BotDeskState = {
	...EMPTY,
	duties: [{ id: "a", text: "Check the build", at: "2026-10-31T09:00:00.000Z" }],
};

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
		expect(useBotDeskStore.getState().loaded).toBe(false);
		await useBotDeskStore.getState().refresh();
		expect(useBotDeskStore.getState().loaded).toBe(true);
	});

	it("lets a push that lands during a read win over the read's older answer", async () => {
		const { promise, resolve } = Promise.withResolvers<BotDeskState>();
		api.get.mockImplementationOnce(() => promise);
		const read = useBotDeskStore.getState().refresh();

		useBotDeskStore.getState().apply(WITH_DUTY);
		resolve(EMPTY);
		await read;

		expect(useBotDeskStore.getState().desk).toBe(WITH_DUTY);
	});

	it("keeps the error of a read that failed, and clears it when something arrives", async () => {
		const failure = new Error("not ready");
		api.get.mockRejectedValueOnce(failure);

		await useBotDeskStore.getState().refresh();
		expect(useBotDeskStore.getState().loaded).toBe(false);
		expect(useBotDeskStore.getState().loadError).toBe(failure);

		await useBotDeskStore.getState().refresh();
		expect(useBotDeskStore.getState().loaded).toBe(true);
		expect(useBotDeskStore.getState().loadError).toBeNull();
	});

	it("sends an answer and the whole duty list as main's payloads", async () => {
		expect(await useBotDeskStore.getState().answer("d1", "Ship it")).toBe(true);
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it" });

		expect(await useBotDeskStore.getState().setDuties([{ id: "a", text: "Check the build" }])).toBe(true);
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ id: "a", text: "Check the build" }] });
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
		await vi.waitFor(() => expect(useBotDeskStore.getState().loaded).toBe(true));
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(api.onChanged).toHaveBeenCalledTimes(1);

		const [listener] = api.onChanged.mock.calls[0] ?? [];
		listener?.(WITH_DUTY);
		expect(useBotDeskStore.getState().desk).toBe(WITH_DUTY);
	});
});
