/**
 * Stock's tool approval as an RPC host sees it (`requestApproval` in `tools/approval.ts`: the RPC UI context has no
 * `approve`, so stock falls back to a `select`): a title whose first line is "Allow tool: <name>", and the options
 * ["Approve", "Deny"], or ["Approve", "Approve <subject> for this session", "Deny"] when the approval mode raised the
 * prompt and stock may remember the answer for the session (`sessionApprovalScope`). Stock answers "Approve" as this
 * call only, the middle option as this call plus later like calls of the session, anything else as a denial.
 * Pinned to the installed omp by `src/main/tool-approval-stock.test.ts`.
 */
export const APPROVAL_TITLE_PREFIX = "Allow tool: ";
export const APPROVE_ONCE = "Approve";
export const APPROVE_DENY = "Deny";

const SESSION_HEAD = "Approve ";
const SESSION_TAIL = " for this session";

export function isApprovalSelect(request: { method: string; title?: unknown; options?: unknown }): boolean {
	if (request.method !== "select" || typeof request.title !== "string") return false;
	if (!request.title.startsWith(APPROVAL_TITLE_PREFIX)) return false;
	const options = request.options;
	if (!Array.isArray(options) || options[0] !== APPROVE_ONCE || options[options.length - 1] !== APPROVE_DENY)
		return false;
	if (options.length === 2) return true;
	const session = options[1];
	return (
		options.length === 3 &&
		typeof session === "string" &&
		session.length > SESSION_HEAD.length + SESSION_TAIL.length &&
		session.startsWith(SESSION_HEAD) &&
		session.endsWith(SESSION_TAIL)
	);
}

/** The "approve for this session" option of an approval select, when stock offered one. */
export function sessionApprovalOption(request: {
	method: string;
	title?: unknown;
	options?: unknown;
}): string | undefined {
	if (!isApprovalSelect(request)) return undefined;
	const options = request.options as string[];
	return options.length === 3 ? options[1] : undefined;
}

/** What a session approval covers: the tool, or its `xd://` device, as stock names it in the option. */
export function sessionApprovalSubject(option: string): string {
	return option.slice(SESSION_HEAD.length, option.length - SESSION_TAIL.length);
}
