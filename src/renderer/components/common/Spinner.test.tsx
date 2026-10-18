import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
	// An <svg> transform animation runs on the main thread every frame; an HTML
	// box's runs on the compositor (two running spinners: ~20% → ~7% renderer CPU).
	it("spins an HTML wrapper, never the svg itself", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Spinner size="sm" spin />
				<Spinner inheritColor label="Loading" spin />
			</I18nProvider>,
		);
		expect(html.match(/<span[^>]*class="[^"]*animate-spin/g)).toHaveLength(2);
		expect(html).not.toMatch(/<svg[^>]*animate-spin/);
	});

	it("is a still hollow ring unless it is action feedback", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<Spinner label="Loading" />
			</I18nProvider>,
		);
		expect(html).not.toContain("animate-spin");
		expect(html).toContain('role="status"');
		expect(html).not.toContain("<path");
	});
});
