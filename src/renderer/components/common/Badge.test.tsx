import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
	it("renders one opacity pulse instead of an expanding duplicate halo", () => {
		const html = renderToStaticMarkup(
			<Badge dot pulse variant="success">
				Running
			</Badge>,
		);

		expect(html).toContain("omp-pulse-dot");
		expect(html).not.toContain("animate-ping");
	});
});
