import { describe, expect, it } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import { errorDetail, errorMessage, inlineFailure } from "./error-detail";
import { translate } from "./i18n";

describe("errorDetail", () => {
	it("strips the Electron IPC wrapper and the error-class prefix", () => {
		expect(
			errorDetail(new Error("Error invoking remote method 'sessions:rename': Error: EACCES: permission denied")),
		).toBe("EACCES: permission denied");
		expect(errorDetail("TypeError: x is not a function")).toBe("x is not a function");
	});

	it("keeps plain messages and maps nullish causes to an empty detail", () => {
		expect(errorDetail(new Error("git status failed"))).toBe("git status failed");
		expect(errorDetail(undefined)).toBe("");
		expect(errorDetail(null)).toBe("");
	});

	it("maps main's coded failures to their own localized sentence and keeps the English as detail", () => {
		const thrown = new Error(
			`Error invoking remote method 'sessions:delete': Error: ${codedError("session_running", "Session is currently running").message}`,
		);
		expect(errorMessage(thrown)).toBe(translate("ipcError.session_running"));
		expect(errorDetail(thrown)).toBe("Session is currently running");
		const response = { success: false, error: "Sidecar not connected", code: "sidecar_not_connected" };
		expect(errorMessage(response)).toBe(translate("ipcError.sidecar_not_connected"));
		expect(errorDetail(response)).toBe("Sidecar not connected");
		expect(errorMessage(new Error("boom"))).toBe(translate("toast.failedRetry"));
	});
});

describe("inlineFailure", () => {
	it("headlines main's coded sentence when the failure carries a code, else the caller's sentence", () => {
		const coded = { success: false, error: "Not inside a git worktree: /tmp/x", code: "not_a_worktree" };
		expect(inlineFailure(coded, "Couldn't create the worktree.")).toEqual({
			message: translate("ipcError.not_a_worktree"),
			cause: coded,
		});
		const plain = new Error("git exited 128");
		expect(inlineFailure(plain, "Couldn't create the worktree.")).toEqual({
			message: "Couldn't create the worktree.",
			cause: plain,
		});
	});
});
