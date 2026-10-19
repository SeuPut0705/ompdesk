/**
 * Stock's tool approval as an RPC host sees it (`requestApproval` in `tools/approval.ts`: the RPC UI context has no
 * `approve`, so stock falls back to a `select` whose options are `approvalChoiceLabels`): a title whose first line is
 * "Allow tool: <name>", then the options in this order, "Deny" always last:
 *
 * - the grants an `always-ask-cached` ("Ask and remember") prompt offers, each remembered for this session
 *   ("Approve Directory: <folder>", "Approve File", or "Approve" for a target that is no file), then the same grants
 *   remembered for every session ("Always " + each label);
 * - this call only: "Approve", or "Approve Once" beside grants;
 * - "Approve <subject> for this session" when the approval mode raised the prompt and stock may remember the answer
 *   for the session (`sessionApprovalScope`);
 * - "Deny". Stock reads any other answer as a denial.
 *
 * Pinned to the installed omp by `src/main/tool-approval-stock.test.ts`.
 */
/**
 * Stock's `tools.approvalMode` values, loosest first (stock's enum reversed): full access, auto-edit, "Ask and
 * remember" (omp ≥ 18.12.3: asks before file reads and writes too and can remember a file or folder), ask every time.
 */
export const APPROVAL_MODES = ["yolo", "write", "always-ask-cached", "always-ask"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export const APPROVAL_TITLE_PREFIX = "Allow tool: ";
export const APPROVE_DENY = "Deny";

const ONCE = "Approve";
const ONCE_BESIDE_GRANTS = "Approve Once";
const SESSION_HEAD = "Approve ";
const SESSION_TAIL = " for this session";
const FOLDER_HEAD = "Approve Directory: ";
const ALWAYS = "Always ";

/** One remembering answer of an "Ask and remember" prompt. */
export interface ApprovalGrantChoice {
	/** The option stock answers to. */
	option: string;
	/** What it remembers: the folder around the call, the file it names, or its target that is no file. */
	kind: "folder" | "file" | "target";
	/** The folder's label as stock shows it, for `kind: "folder"`. */
	folder?: string;
	/** Remembered for every session (stock's approval database) rather than this one. */
	always: boolean;
}

/** Every answer an approval select offers besides "Deny", in stock's order. */
export interface ApprovalChoices {
	grants: ApprovalGrantChoice[];
	/** This call only. */
	once: string;
	/** This call and later like calls of the session. */
	session?: string;
}

function grantOf(label: string): Omit<ApprovalGrantChoice, "always"> | undefined {
	if (label === "Approve File") return { option: label, kind: "file" };
	if (label === ONCE) return { option: label, kind: "target" };
	if (label.startsWith(FOLDER_HEAD) && label.length > FOLDER_HEAD.length)
		return { option: label, kind: "folder", folder: label.slice(FOLDER_HEAD.length) };
	return undefined;
}

function isSessionOption(option: unknown): option is string {
	return (
		typeof option === "string" &&
		option.length > SESSION_HEAD.length + SESSION_TAIL.length &&
		option.startsWith(SESSION_HEAD) &&
		option.endsWith(SESSION_TAIL)
	);
}

/** The answers of a stock tool approval, or undefined for any other select. */
export function approvalChoices(request: {
	method: string;
	title?: unknown;
	options?: unknown;
}): ApprovalChoices | undefined {
	if (request.method !== "select" || typeof request.title !== "string") return undefined;
	if (!request.title.startsWith(APPROVAL_TITLE_PREFIX)) return undefined;
	const options = request.options;
	if (!Array.isArray(options) || options[options.length - 1] !== APPROVE_DENY) return undefined;
	const rest: unknown[] = options.slice(0, -1);
	const last = rest[rest.length - 1];
	const session = isSessionOption(last) ? last : undefined;
	if (session) rest.pop();
	const once = rest.pop();
	// `rest` is now each grant label, then each with "Always " in front, in the same order.
	const onceLabel = rest.length > 0 ? ONCE_BESIDE_GRANTS : ONCE;
	if (rest.length % 2 !== 0 || once !== onceLabel) return undefined;
	const count = rest.length / 2;
	const grants: ApprovalGrantChoice[] = [];
	const always: ApprovalGrantChoice[] = [];
	for (let index = 0; index < count; index++) {
		const label = rest[index];
		const grant = typeof label === "string" ? grantOf(label) : undefined;
		if (!grant || rest[index + count] !== `${ALWAYS}${label}`) return undefined;
		grants.push({ ...grant, always: false });
		always.push({ ...grant, option: `${ALWAYS}${label}`, always: true });
	}
	return { grants: [...grants, ...always], once: onceLabel, ...(session ? { session } : {}) };
}

export function isApprovalSelect(request: { method: string; title?: unknown; options?: unknown }): boolean {
	return approvalChoices(request) !== undefined;
}

/** What a session approval covers: the tool, or its `xd://` device, as stock names it in the option. */
export function sessionApprovalSubject(option: string): string {
	return option.slice(SESSION_HEAD.length, option.length - SESSION_TAIL.length);
}
