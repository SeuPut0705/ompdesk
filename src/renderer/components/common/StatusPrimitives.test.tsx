import { RefreshCw } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { IconButton } from "./IconButton";
import { ProgressBar } from "./ProgressBar";
import { Skeleton, SkeletonRows } from "./Skeleton";

function render(node: React.ReactNode): string {
	return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

describe("IconButton loading", () => {
	it("swaps the icon for a spinner, marks itself busy and refuses clicks", () => {
		const html = render(<IconButton icon={<RefreshCw data-icon="refresh" />} label="Refresh" loading />);
		expect(html).toMatch(/<button[^>]*aria-busy="true"/);
		expect(html).toMatch(/<button[^>]*disabled=""/);
		expect(html).toContain("animate-spin");
		expect(html).not.toContain('data-icon="refresh"');
	});

	it("shows its icon when idle", () => {
		const html = render(<IconButton icon={<RefreshCw data-icon="refresh" />} label="Refresh" />);
		expect(html).toContain('data-icon="refresh"');
		expect(html).not.toContain("aria-busy");
		expect(html).not.toContain("animate-spin");
	});
});

describe("Skeleton", () => {
	it("is a hidden shimmer block sized by its caller", () => {
		const html = render(<Skeleton className="h-8 w-full" />);
		expect(html).toMatch(/aria-hidden="true"/);
		expect(html).toContain("omp-skeleton");
		expect(html).toContain("h-8 w-full");
	});

	it("announces a row list once, by its label, with one row per width", () => {
		const html = render(<SkeletonRows label="Loading sessions" widths={[72, 54, 64]} />);
		expect(html).toMatch(
			/role="status"[^>]*aria-label="Loading sessions"|aria-label="Loading sessions"[^>]*role="status"/,
		);
		expect(html.match(/data-skeleton-row/g)).toHaveLength(3);
		expect(html).toContain("width:54%");
	});
});

describe("ProgressBar", () => {
	it("keeps threshold colors for a meter, red near full", () => {
		expect(render(<ProgressBar ariaLabel="Quota" value={0.95} />)).toContain("var(--sc-danger)");
	});

	it("paints task progress in the accent at any fraction", () => {
		const html = render(<ProgressBar ariaLabel="Downloading" tone="progress" value={0.95} />);
		expect(html).toContain("var(--sc-accent)");
		expect(html).not.toContain("var(--sc-danger)");
		expect(html).toContain('aria-valuenow="0.95"');
		expect(html).toContain("95%");
	});

	it("is indeterminate without a value: no fraction claimed, no percent shown", () => {
		const html = render(<ProgressBar ariaLabel="Updating omp" tone="progress" />);
		expect(html).toContain('role="progressbar"');
		expect(html).not.toContain("aria-valuenow");
		expect(html).toContain("omp-indeterminate-progress");
		expect(html).not.toContain("%</span>");
	});
});
