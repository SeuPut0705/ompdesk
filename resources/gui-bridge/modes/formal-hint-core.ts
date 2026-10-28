/**
 * The formal-verification hint: a turn whose request (a person's prompt, an Autopilot cycle prompt or a subagent's
 * assignment) is about a race, a duplicate or twice-run effect, an ordering, retry, lease, idempotency, deadlock,
 * shutdown or state-machine bug, or asks to prove something can never happen, gets one short prompt section sending
 * the agent to `skill://ompdesk-formal-verify` before it changes code. Every other turn gets nothing.
 *
 * The text is matched again on every turn (no per-folder or per-session cache: the trigger is the request, not the
 * project), by a small pure matcher, no model call. Registered as a prompt section (../prompt-sections.ts), so it
 * reaches subagents (their assignment is the hook's `prompt`) and the context inspector. No omp imports.
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";

export const FORMAL_SKILL = "skill://ompdesk-formal-verify";

/** A long assignment carries its background first; the ask is in what the matcher reads. */
const MAX_TEXT = 8000;

/** One pattern per way to say it; each is a concurrency or never-happens signal on its own. */
export const FORMAL_PATTERNS: readonly RegExp[] = [
	// English
	/\brace[- ]conditions?\b|\bdata races?\b|\bracy\b|\brace between\b|\brace (?:in|on|when|with)\b|\braces\b/i,
	/\bconcurren(?:t|cy)\b|\bparallel (?:writes?|updates?|runs?)\b|\binterleav/i,
	/\btwice\b|\bran two times\b|\bdouble[- ](?:run|fire|fired|send|sent|credit|credited|charge|charged|submit|spawn|apply|applied)\b/i,
	/\bduplicate[ds]? (?:run|runs|request|requests|send|sends|credit|charge|webhook|event|events|delivery|deliveries|message|messages|notification|notifications|entry|entries|execution|spawn)\b/i,
	/\bidempoten/i,
	/\bretr(?:y|ies|ied|ying)\b.*\b(?:twice|duplicate|again and again|loop|storm|lost|race|ordering|backoff)\b|\b(?:bug|fix|broken|wrong|race|storm)\b.*\bretr(?:y|ies|ied|ying)\b/i,
	/\bdead-?lock|\blive-?lock|\bstarv(?:es|ed|ation)\b/i,
	/\blease[sd]?\b.*\b(?:expire|expiry|renew|steal|stolen|fence|owner|holder|bug|race)\b|\b(?:expire|renew|steal|fence)\w*\b.*\blease\b/i,
	/\bout[- ]of[- ]order\b|\b(?:ordering|order of events?)\b.*\b(?:bug|wrong|broken|guarantee|race)\b|\b(?:bug|race)\b.*\bordering\b/i,
	/\bstate[- ]machine\b|\bstatechart\b/i,
	/\bstale(?:ness)?\b.*\b(?:listing|list|state|cache|snapshot)\b.*\b(?:after|when|race|never|sometimes)\b/i,
	/\b(?:shutdown|quit|restart|resume)\b.*\b(?:race|twice|duplicate|lost|interrupted|half)\b|\b(?:race|twice|duplicate)\b.*\b(?:shutdown|quit|restart|resume)\b/i,
	/\bnever (?:happen|happens|happened|occur|occurs|fire|fires|run|runs)\b|\bcan(?:not|'t) (?:ever )?(?:happen|occur)\b|\bimpossible (?:for|that|to happen)\b|\bprove (?:that|it|this)\b|\bformally (?:verify|prove)\b|\bformal verification\b|\bTLA\+|\bmodel[- ]check/i,
	// Korean
	/경쟁\s?조건|레이스\s?컨디션|경합|동시성|동시에\s*(?:두|여러|실행|호출|쓰|써|수정|들어|처리)|동시\s*(?:실행|호출|수정|접근|처리)/,
	/두\s?번\s*(?:실행|호출|처리|지급|결제|전송|발송|들어|돌|나가|보내|적용|반영|생성|생겨)|두\s?번(?:씩)?\s*(?:되|돼|이나)|이중\s*(?:실행|지급|결제|처리|전송)/,
	/중복\s*(?:실행|처리|전송|지급|결제|호출|발송|알림|생성|반영|요청|이벤트)/,
	/재시도|멱등|교착|데드락|락\s*(?:경합|누수)|리스\s*(?:만료|탈취)/,
	/순서\s*(?:가|는|를)?\s*(?:뒤바뀌|꼬|어긋|바뀌|틀|보장)|(?:뒤바뀌|꼬이|어긋나)[^\n]{0,8}순서|순서\s*(?:버그|문제)/,
	/상태\s?기계|상태\s?머신/,
	/(?:절대|결코)\s*(?:안|않|못)\s*(?:일어|발생|생기|나|되)|(?:일어|발생)(?:할|하지)?\s*수\s*없|증명|형식\s?검증/,
];

/** Whether this turn's request is the kind that must read the formal-verification skill first. */
export function isFormalRequest(text: string | undefined): boolean {
	if (!text) return false;
	const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
	return FORMAL_PATTERNS.some(pattern => pattern.test(body));
}

export const FORMAL_HINT = `This request is a concurrency, ordering or never-happens problem (a race, a duplicate or twice-run effect, retry, lease, idempotency, deadlock, shutdown or state-machine bug, or a claim that something can never happen). Before you change code or answer, read ${FORMAL_SKILL} and follow it.`;

export type FormalHost = PromptSectionHost;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: FormalHost): void {
	registerPromptSection(pi, "formal", (_ctx, prompt) => (isFormalRequest(prompt) ? FORMAL_HINT : undefined));
}
