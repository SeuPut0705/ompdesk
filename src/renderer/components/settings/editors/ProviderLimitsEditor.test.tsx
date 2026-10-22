/** Each provider's limit field is named after its provider, so a screen reader says which limit it edits. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { ProviderLimitsEditor } from "./ProviderLimitsEditor";

describe("ProviderLimitsEditor", () => {
	it("names each limit field after its provider", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<ProviderLimitsEditor disabled onCommit={() => {}} value={{ anthropic: 2, openai: 4 }} />
			</I18nProvider>,
		);
		const labels = [...markup.matchAll(/<input[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);
		expect(labels).toEqual(["Request limit for anthropic", "Request limit for openai"]);
	});
});
