/**
 * docx-preview, imported lazily by DocxView so the renderer (and its JSZip)
 * loads only when a Word document opens. The document renders into the
 * caller's shadow root, so its generated stylesheet cannot reach the app.
 * Everything that could fetch is cut before it lands: alt-chunks (raw HTML in
 * an iframe) are off, images and fonts become data: URLs from the package,
 * and `stripExternalResources` removes any remaining outside URL, link target
 * and embedding element. The CSP (no inline script, img/font/connect limited
 * to self, data: and blob:) is the second wall.
 */
import { renderAsync } from "docx-preview";

/** Attributes that load or navigate to a URL. */
const URL_ATTRIBUTES = ["src", "srcset", "href", "xlink:href", "poster", "background", "action", "formaction", "data"];
/** Elements a document preview never needs, each a way to load or run something. */
const BLOCKED_ELEMENTS =
	"script, iframe, frame, frameset, object, embed, link, meta, base, form, audio, video, source, track";
const INLINE_URL = /^(?:data:|blob:)/i;
const CSS_URL = /url\(\s*(['"]?)(?!data:|blob:)[^)]*\)/gi;
const CSS_IMPORT = /@import[^;]*;?/gi;

/**
 * Leaves only package-inline resources in a rendered document: outside URLs
 * dropped, hyperlinks inert (their target kept as a tooltip), event-handler
 * attributes and embedding elements removed, CSS `url()`s to anything but
 * data:/blob: and `@import`s blanked.
 */
export function stripExternalResources(root: Element | DocumentFragment | ShadowRoot): void {
	for (const element of root.querySelectorAll(BLOCKED_ELEMENTS)) element.remove();
	for (const element of root.querySelectorAll("*")) {
		for (const name of URL_ATTRIBUTES) {
			const value = element.getAttribute(name);
			if (value === null) continue;
			if (element.localName === "a" && name === "href") {
				// A link would navigate the app window; keep where it pointed as a hint.
				element.removeAttribute(name);
				if (value !== "" && !value.startsWith("#")) element.setAttribute("title", value);
			} else if (!INLINE_URL.test(value.trim())) {
				element.removeAttribute(name);
			}
		}
		for (const attribute of [...element.attributes]) {
			if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
		}
		const style = element.getAttribute("style");
		if (style?.includes("url(")) element.setAttribute("style", style.replace(CSS_URL, "none"));
		if (element.localName === "style" && element.textContent) {
			element.textContent = element.textContent.replace(CSS_IMPORT, "").replace(CSS_URL, "none");
		}
	}
}

/** `reflow`: text at its real size wrapping to the panel; `pages`: fixed-size pages split at page breaks. */
export type DocxLayout = "reflow" | "pages";

export async function renderDocx(
	data: Uint8Array,
	body: HTMLElement,
	styles: HTMLElement,
	layout: DocxLayout,
): Promise<void> {
	const reflow = layout === "reflow";
	await renderAsync(data, body, styles, {
		className: "docx",
		inWrapper: true,
		ignoreWidth: reflow,
		ignoreHeight: reflow,
		breakPages: !reflow,
		ignoreLastRenderedPageBreak: true,
		renderAltChunks: false,
		renderComments: false,
		renderChanges: false,
		// data: URLs: nothing to revoke, and allowed by the CSP's img-src/font-src.
		useBase64URL: true,
	});
	stripExternalResources(styles);
	stripExternalResources(body);
}
