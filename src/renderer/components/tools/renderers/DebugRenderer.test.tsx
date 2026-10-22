/** The debug card's variables fold: open by default, the rows go with the fold, and the toggle says its state. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { DebugRenderer } from "./DebugRenderer";

describe("DebugRenderer variables", () => {
	it("opens the variables under a disclosure whose turning chevron is the shared one", () => {
		const markup = renderToStaticMarkup(
			<I18nProvider>
				<DebugRenderer
					args={{ action: "variables" }}
					isError={false}
					isPartial={false}
					result={{
						content: [{ type: "text", text: "count = 3" }],
						details: { action: "variables", variables: [{ name: "count", value: "3", type: "int" }] },
					}}
					{...({} as Record<string, never>)}
				/>
			</I18nProvider>,
		);
		expect(markup).toMatch(/<button[^>]*aria-expanded="true"[^>]*>.*omp-disclosure-chevron/s);
		expect(markup).toContain("count");
	});
});
