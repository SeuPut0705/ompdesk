// bun measure/drag-point.ts <port>: a point (physical client pixels) inside the app page's top bar that the page marks
// `app-region: drag` and that no `no-drag` element covers; the point hittest.ps1 probes.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2]}`, { timeout: 15_000 });
const page = browser.contexts().flatMap(c => c.pages()).find(p => /index\.html/.test(p.url()));
if (!page) throw new Error("no app page");
const point = await page.evaluate(() => {
	const region = (el: Element | null): string => {
		for (let e = el; e; e = e.parentElement) {
			const r = getComputedStyle(e).getPropertyValue("app-region") || getComputedStyle(e).getPropertyValue("-webkit-app-region");
			if (r === "drag" || r === "no-drag") return r;
		}
		return "none";
	};
	for (let y = 10; y < 46; y += 6)
		for (let x = 200; x < innerWidth - 160; x += 20)
			if (region(document.elementFromPoint(x, y)) === "drag")
				return { x: Math.round(x * devicePixelRatio), y: Math.round(y * devicePixelRatio), css: { x, y }, dpr: devicePixelRatio };
	return null;
});
console.log(JSON.stringify(point));
// No browser.close(): over CDP it sends Browser.close, which quits the shell itself.
process.exit(0);
