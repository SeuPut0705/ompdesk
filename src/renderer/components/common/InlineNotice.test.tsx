import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { InlineNotice } from "./InlineNotice";

function render(node: React.ReactNode): string {
	return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("InlineNotice", () => {
	it("announces a live failure as an alert with its raw cause under the sentence", () => {
		const html = render(
			<InlineNotice detail={new Error("EACCES: permission denied")} live title="Couldn't read" tone="danger" />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain('data-inline-notice="danger"');
		expect(html).toContain("Couldn&#x27;t read");
		expect(html).toContain("EACCES: permission denied");
	});

	it("offers the cause on the clipboard only when asked", () => {
		const plain = render(<InlineNotice detail="boom" title="Failed" tone="danger" />);
		expect(plain).not.toContain("<button");

		const copyable = render(<InlineNotice copyLabel="Copy error" detail="boom" title="Failed" tone="danger" />);
		expect(copyable).toMatch(/<button[^>]*aria-label="Copy error"/);
	});

	it("shows a labelled spinner while pending", () => {
		const html = render(<InlineNotice live title="Checking accounts…" tone="pending" />);
		expect(html).toContain('role="status"');
		expect(html).toContain("animate-spin");
	});
});
