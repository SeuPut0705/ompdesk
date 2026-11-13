import { describe, expect, it } from "vitest";
import {
	controlCall,
	isWaitingItem,
	onlyWaitingItems,
	WaitBook,
	waitReason,
} from "../../resources/gui-bridge/todo-wait-core";

const OPENED =
	"Opened session 15c8906674c31761 in /w/repo. It is working on your message.\nThey report back to you with ompdesk_report.";

function opened(book: WaitBook, callId = "t1", text = OPENED): void {
	book.noteCall(callId, { toolName: "ompdesk_session_open", input: { message: "x" }, isError: false, text });
}

const actionable = [{ tasks: [{ content: "Integrate the child's result", status: "in_progress" }] }];

describe("a session waiting on a child's reply is not woken by the todo reminder", () => {
	it("waits from an open that started work until that child reports done", () => {
		const book = new WaitBook();
		expect(waitReason({ book, phases: actionable })).toBeUndefined();
		opened(book);
		expect(waitReason({ book, phases: actionable })).toBe("reply");
		book.noteArrival({ kind: "mail", from: "15c8906674c31761", title: "Inquiry", mailKind: "done" });
		expect(waitReason({ book, phases: actionable })).toBeUndefined();
	});

	it("keeps waiting while a report only says progress, or comes from another session", () => {
		const book = new WaitBook();
		opened(book);
		book.noteArrival({ kind: "mail", from: "15c8906674c31761", mailKind: "progress" });
		book.noteArrival({ kind: "mail", from: "someone-else", mailKind: "done" });
		expect(book.size).toBe(1);
	});

	it("ends the wait when the child asks, is blocked or wants review: the session can act", () => {
		for (const mailKind of ["question", "blocked", "review"]) {
			const book = new WaitBook();
			opened(book);
			book.noteArrival({ kind: "mail", from: "15c8906674c31761", mailKind });
			expect(book.size).toBe(0);
		}
	});

	it("waits one reply per child and answers each on its own", () => {
		const book = new WaitBook();
		opened(
			book,
			"t1",
			"Opened session aaa111 in /w. It is working on your message.\nOpened session bbb222 in /w. It is working on your message.",
		);
		expect(book.size).toBe(2);
		book.noteArrival({ kind: "mail", from: "aaa111", mailKind: "done" });
		expect(waitReason({ book, phases: actionable })).toBe("reply");
		book.noteArrival({ kind: "mail", from: "bbb222", mailKind: "done" });
		expect(waitReason({ book, phases: actionable })).toBeUndefined();
	});

	it("does not wait for an idle child, a failed open or a refused send", () => {
		const book = new WaitBook();
		opened(book, "t1", "Opened session aaa111 in /w. It is idle; give it work with ompdesk_session_send.");
		opened(book, "t2", "Could not open a session: no folder");
		book.noteCall("t3", {
			toolName: "ompdesk_session_send",
			input: { session: "x", message: "m" },
			isError: true,
			text: "refused",
		});
		expect(book.size).toBe(0);
	});

	it("waits on a send until that session sends something back, by title, saved id or tab id", () => {
		const book = new WaitBook();
		book.noteCall("s1", {
			toolName: "ompdesk_session_send",
			input: { session: "15cab0f51b807e97", message: "m" },
			isError: false,
			text: 'Sent to "ompdesk 빌드" (saved id 01a1cd44-3e97-7345-a8cc-e9211a49f216, on 데스크탑): accepted',
		});
		expect(book.size).toBe(1);
		book.noteArrival({
			kind: "user",
			text: '<ompdesk-agent-message from="ompdesk 빌드" session="01a1cd44-3e97-7345-a8cc-e9211a49f216">\ndone\n</ompdesk-agent-message>',
		});
		expect(book.size).toBe(0);
	});

	it("counts a call once, however many times stock reports it (a nested xd:// dispatch repeats the call id)", () => {
		const book = new WaitBook();
		opened(book, "same");
		opened(book, "same");
		expect(book.size).toBe(1);
	});

	it("reads a call made as a write to the xd:// device", () => {
		const call = controlCall({
			toolName: "write",
			input: { path: "xd://ompdesk_session_open", content: '{"message":"x"}' },
			isError: false,
			text: OPENED,
		});
		expect(call).toMatchObject({ toolName: "ompdesk_session_open", input: { message: "x" } });
		expect(
			controlCall({ toolName: "write", input: { path: "/tmp/a", content: "x" }, isError: false, text: "" }),
		).toBeUndefined();
		expect(controlCall({ toolName: "bash", input: {}, isError: false, text: "" })).toBeUndefined();
	});

	it("ends every wait when the person writes: a wait that never matches must not silence the reminder for good", () => {
		const book = new WaitBook();
		opened(book);
		book.noteArrival({ kind: "user", text: "How is it going?" });
		expect(book.size).toBe(0);
	});
});

describe("a session whose open items are all written as waiting", () => {
	it("recognises an item that says it waits, in English and Korean", () => {
		for (const content of [
			"Wait for the inquiry tab's reply",
			"Waiting on CI",
			"awaiting the owner's decision",
			"Blocked on the release job",
			"대기: 문의 탭 답변",
			"기다리는 중: 빌드 결과",
			"문의 탭 응답 대기",
			"빌드 결과 기다리기",
		])
			expect(isWaitingItem(content), content).toBe(true);
	});

	it("never takes an actionable item for waiting", () => {
		for (const content of [
			"Fix the sidebar bug",
			"Add a Korean label",
			"Write the waiting-room page",
			"대기열 화면 고치기",
		])
			expect(isWaitingItem(content), content).toBe(false);
	});

	it("gives no reminder when every open item waits, whatever is done or abandoned", () => {
		const phases = [
			{
				tasks: [
					{ content: "Fix the bug", status: "completed" },
					{ content: "Drop the idea", status: "abandoned" },
					{ content: "Wait for the reply", status: "pending" },
					{ content: "대기: CI 결과", status: "in_progress" },
				],
			},
		];
		expect(onlyWaitingItems(phases)).toBe(true);
		expect(waitReason({ book: undefined, phases })).toBe("marked");
	});

	it("keeps the reminder when one open item can be acted on, or none is open", () => {
		expect(waitReason({ book: undefined, phases: actionable })).toBeUndefined();
		expect(
			waitReason({
				book: undefined,
				phases: [
					{
						tasks: [
							{ content: "Wait for the reply", status: "pending" },
							{ content: "Integrate it", status: "pending" },
						],
					},
				],
			}),
		).toBeUndefined();
		expect(
			waitReason({ book: undefined, phases: [{ tasks: [{ content: "Wait", status: "completed" }] }] }),
		).toBeUndefined();
		expect(waitReason({ book: undefined, phases: [] })).toBeUndefined();
	});
});
