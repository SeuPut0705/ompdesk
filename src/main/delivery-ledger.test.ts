import { describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../shared/rpc-types";
import { deliverOnce } from "./delivery-ledger";

const accepted: RpcResponse = { type: "response", command: "prompt", success: true };
const refused: RpcResponse = { type: "response", command: "prompt", success: false, error: "busy" };

describe("deliverOnce", () => {
	it("hands omp a message once however often it comes, and every try gets the first one's answer", async () => {
		const send = vi.fn(async () => accepted);
		const first = deliverOnce("m-once", send);
		// A repeat while the first is still on its way, and one after it was answered.
		const during = deliverOnce("m-once", send);
		expect(await first).toBe(accepted);
		expect(await during).toBe(accepted);
		expect(await deliverOnce("m-once", send)).toBe(accepted);
		expect(send).toHaveBeenCalledTimes(1);
		await deliverOnce("m-other", send);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("lets a message omp refused or never got be tried again", async () => {
		const refusedFirst = vi
			.fn<() => Promise<RpcResponse>>()
			.mockResolvedValueOnce(refused)
			.mockResolvedValue(accepted);
		expect(await deliverOnce("m-refused", refusedFirst)).toBe(refused);
		expect(await deliverOnce("m-refused", refusedFirst)).toBe(accepted);
		expect(refusedFirst).toHaveBeenCalledTimes(2);

		const lostFirst = vi
			.fn<() => Promise<RpcResponse>>()
			.mockRejectedValueOnce(new Error("omp exited"))
			.mockResolvedValue(accepted);
		await expect(deliverOnce("m-lost", lostFirst)).rejects.toThrow("omp exited");
		expect(await deliverOnce("m-lost", lostFirst)).toBe(accepted);
		expect(lostFirst).toHaveBeenCalledTimes(2);
	});
});
