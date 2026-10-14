/**
 * What `system:open-external` hands to the OS: web pages and mail drafts.
 * Every other scheme (file:, javascript:, custom app handlers) is refused, so
 * a link in model output can never launch an arbitrary registered handler.
 */
export function isOpenableExternalUrl(url: unknown): url is string {
	if (typeof url !== "string") return false;
	if (url.startsWith("https://") || url.startsWith("http://")) return true;
	// A mail draft: an address (or query-only draft), no whitespace or control characters.
	return /^mailto:[^\s\p{Cc}]+$/iu.test(url);
}
