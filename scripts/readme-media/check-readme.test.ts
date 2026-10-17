import { describe, expect, it } from "vitest";
import { checkAll, slug } from "./check-readme";

describe("README", () => {
	it("keeps every link, image path, alt text, download button, language switch and media budget valid", () => {
		expect(checkAll()).toEqual([]);
	});

	it("derives GitHub heading anchors", () => {
		expect(slug("Build from source")).toBe("build-from-source");
		expect(slug("FAQ & troubleshooting")).toBe("faq--troubleshooting");
		expect(slug("`omp` update")).toBe("omp-update");
		expect(slug("업데이트 · 기기")).toBe("업데이트--기기");
	});
});
