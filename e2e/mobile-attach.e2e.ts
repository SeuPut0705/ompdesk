/**
 * Attaching on the phone, end to end: the built app's real web server behind the fake `tailscale serve`
 * (e2e/fixture/phone-serve.ts: the secret path prefix, serve's headers, the published origin), a phone page in
 * Chromium (Pixel 7) and WebKit (iPhone 14), and the fake omp recording what it was sent.
 *
 * Photos: the composer's file input takes a camera JPEG (4032×3024, about 5 MB), a 12 MB JPEG and a HEIC; each one
 * shows as a thumbnail, goes to the computer by `POST /upload` (a socket frame holds 1 MB, which a phone photo
 * outgrows even scaled down), reaches omp as an image block of the prompt, and comes back as a picture in the sent
 * bubble.
 *
 * Through the + menu as a person does it: tap +, pick Photos or Attach files, and the browser's chooser takes a
 * photo, a PDF and a text file while the page is hidden behind it (a phone's picker is another app) and the
 * agent's reply streams meanwhile, so the host drops those pushes and the page catches up in place on its
 * return (no reload). The pick still lands: the photo as a thumbnail and an image block, the PDF and the text file
 * uploaded with an upload chip while they go and named by their path on the computer in the prompt. A file over
 * 25 MB is refused with a message.
 *
 * OMP_GUI_MOBILE_ATTACH=<dir> also writes the composer and the bubble per picture.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, recordPhoneLoads, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, exitApp, fixtureOmp } from "./harness";

const CAPTURES = process.env.OMP_GUI_MOBILE_ATTACH;

const ENGINES: { name: string; type: BrowserType; device: (typeof devices)[string] }[] = [
	{ name: "chromium", type: chromium, device: devices["Pixel 7"] },
	{ name: "webkit", type: webkit, device: devices["iPhone 14"] },
];

interface Picture {
	name: string;
	mimeType: string;
	buffer: Buffer;
}

/** A private app profile: its folders, the fake Tailscale, and the file the fake omp records its frames in. */
interface Profile {
	root: string;
	desktop: string;
	project: string;
	env: Record<string, string>;
	tailscale: FixtureTailscale;
	record: string;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-attach-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const record = path.join(root, "omp-received.jsonl");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_RECORD: record,
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, project, env, tailscale, record };
}

/**
 * A camera-like JPEG made by the app's own encoder: a 4032×3024 gradient with sensor-like noise of `noise` levels,
 * which keeps it about as large as a phone's photo of a real scene (and as large after scaling down).
 */
function cameraJpeg(app: ElectronApplication, noise: number, quality: number): Promise<Buffer> {
	return app
		.evaluate(
			({ nativeImage }, { noise, quality }) => {
				const width = 4032;
				const height = 3024;
				const pixels = Buffer.alloc(width * height * 4);
				let seed = 1;
				for (let y = 0; y < height; y++)
					for (let x = 0; x < width; x++) {
						const at = (y * width + x) * 4;
						for (let channel = 0; channel < 3; channel++) {
							seed = (seed * 1103515245 + 12345) & 0x7fffffff;
							const base = channel === 0 ? (x * 255) / width : channel === 1 ? (y * 255) / height : 128;
							pixels[at + channel] = Math.max(0, Math.min(255, base + (seed % (2 * noise + 1)) - noise));
						}
						pixels[at + 3] = 255;
					}
				return nativeImage.createFromBuffer(pixels, { width, height }).toJPEG(quality).toString("base64");
			},
			{ noise, quality },
		)
		.then(base64 => Buffer.from(base64, "base64"));
}

interface Received {
	type?: string;
	message?: string;
	images?: { type: string; mimeType: string; data: string }[];
}

/** The prompt omp was sent with `message`, as the fake recorded it. */
async function receivedPrompt(record: string, message: string): Promise<Received | undefined> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Received)
		.find(frame => frame.type === "prompt" && frame.message === message);
}

/** The pictures of the sent bubbles that decoded (a broken one shows the unavailable chip instead). */
function bubblePictures(phone: Page): Promise<number> {
	return phone
		.locator(".omp-user-bubble img")
		.evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length);
}

interface Host {
	app: ElectronApplication;
	proxy: ServeProxy;
}

type Engine = (typeof ENGINES)[number];

/** The app with Mobile web ready and the fake serve in front of it. */
async function startHost(engine: Engine, profile: Profile): Promise<Host> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	try {
		const desk = await app.firstWindow();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(profile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(profile.tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		const proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
			plainCookie: engine.name === "webkit",
		});
		return { app, proxy };
	} catch (error) {
		await exitApp(app).catch(() => undefined);
		throw error;
	}
}

/** The phone page with a tab of its own in the project (a web window starts with none). */
async function openPhonePage(phone: Page, proxy: ServeProxy, project: string) {
	const loads = recordPhoneLoads(phone);
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);
	try {
		await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
		await phone.reload();
	} catch (error) {
		await loads.attach("phone-loads.txt");
		throw error;
	}
	await phonePaired(phone);
	await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
}

/**
 * What the page sees while a phone's picker is in front (another app: the page is hidden) and after it (visible).
 * The page's own visibility handler tells the host, which then drops the stream pushes a hidden page would miss.
 */
function setVisibility(phone: Page, state: "hidden" | "visible") {
	return phone.evaluate(next => {
		Object.defineProperty(document, "visibilityState", { value: next, configurable: true });
		Object.defineProperty(document, "hidden", { value: next === "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	}, state);
}

for (const engine of ENGINES)
	test(`A photo attached on the phone (${engine.name}) goes up through the serve prefix, omp gets it as an image and the sent bubble shows it: a camera JPEG, a 12 MB JPEG and a HEIC`, async () => {
		test.setTimeout(240_000);
		const profile = await makeProfile();
		const browser = await engine.type.launch();
		let app: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		try {
			({ app, proxy } = await startHost(engine, profile));

			const pictures: Picture[] = [
				{ name: "camera.jpg", mimeType: "image/jpeg", buffer: await cameraJpeg(app, 24, 92) },
				{ name: "big.jpg", mimeType: "image/jpeg", buffer: await cameraJpeg(app, 40, 100) },
				{ name: "photo.heic", mimeType: "image/heic", buffer: await fs.readFile("e2e/media/photo.heic") },
			];
			const [camera, big] = pictures;
			expect(camera?.buffer.length).toBeGreaterThan(3 * 1024 * 1024);
			expect(big?.buffer.length).toBeGreaterThan(12 * 1024 * 1024);

			const context = await browser.newContext({ ...engine.device });
			const phone = await context.newPage();
			const uploads: string[] = [];
			phone.on("response", response => {
				const url = new URL(response.url());
				if (url.pathname === "/upload") uploads.push(`${response.request().method()} ${response.status()}`);
			});
			// A web window starts with no tab of its own: open one in the project, as the phone's sidebar would.
			await openPhonePage(phone, proxy, profile.project);
			const field = phone.locator("[data-composer-input]").first();
			// A picture this browser draws is a thumbnail; one it cannot (a HEIC in Chromium) is the photo chip with its
			// format and size (ComposerThumbnail), while the computer converts it for the model.
			const thumbnails = phone.locator('ul[aria-label="Attached images"] li :is(img, [data-composer-photo-chip])');
			const drawn = phone.locator('ul[aria-label="Attached images"] li img');

			for (const [index, picture] of pictures.entries()) {
				const message = `look at ${picture.name}`;
				await phone.locator('input[type="file"]').first().setInputFiles(picture);
				await expect(thumbnails).toHaveCount(1, { timeout: 30_000 });
				if (picture.mimeType === "image/heic" && engine.name === "chromium") {
					await expect(phone.locator("[data-composer-photo-chip]")).toHaveAttribute("aria-label", "HEIC photo");
					await expect(drawn).toHaveCount(0);
				} else {
					await expect
						.poll(() =>
							drawn.evaluateAll(
								images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length,
							),
						)
						.toBe(1);
				}
				await captureTo(CAPTURES, phone, `${engine.name}-${picture.name}-composer`);
				await field.fill(message);
				await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();

				// omp got the prompt with the picture as an image block, whatever the frame limit.
				await expect.poll(() => receivedPrompt(profile.record, message), { timeout: 60_000 }).toBeTruthy();
				const prompt = await receivedPrompt(profile.record, message);
				expect(prompt?.images).toHaveLength(1);
				const image = prompt?.images?.[0];
				expect(image?.type).toBe("image");
				// Models refuse HEIC: the computer converts it with stock's image path before omp sees it.
				expect(image?.mimeType).toBe("image/jpeg");
				expect(image?.data.length ?? 0).toBeGreaterThan(1000);
				if (picture.mimeType === "image/jpeg") {
					// Scaled down on the phone (IMAGE_MAX_SIDE) and still a JPEG; larger than a frame as base64.
					expect(image?.mimeType).toBe("image/jpeg");
					expect(Buffer.from(image?.data ?? "", "base64").length).toBeLessThan(picture.buffer.length);
				}
				await expect(thumbnails).toHaveCount(0);
				// The bubble shows the picture omp journaled (the HEIC as the computer's JPEG, in every browser).
				const shown = index + 1;
				await expect.poll(() => bubblePictures(phone), { timeout: 30_000 }).toBe(shown);
				await captureTo(CAPTURES, phone, `${engine.name}-${picture.name}-sent`);
			}
			// Two photos in one message: together well over what one frame may carry.
			const both = "look at both photos";
			await phone
				.locator('input[type="file"]')
				.first()
				.setInputFiles([camera, big].filter(p => p !== undefined));
			await expect(thumbnails).toHaveCount(2, { timeout: 30_000 });
			await field.fill(both);
			await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();
			await expect
				.poll(async () => (await receivedPrompt(profile.record, both))?.images?.length, { timeout: 60_000 })
				.toBe(2);
			// The three bubbles above showed 3 pictures, now 2 more.
			const decoded = 3 + 2;
			await expect.poll(() => bubblePictures(phone), { timeout: 30_000 }).toBe(decoded);
			await captureTo(CAPTURES, phone, `${engine.name}-two-photos-sent`);
			expect(uploads).toEqual(Array(5).fill("POST 200"));
		} finally {
			await browser.close();
			await proxy?.close();
			if (app) await exitApp(app).catch(() => undefined);
			await fs.rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
		}
	});

/** A 2×2 PNG, small enough that the photo's journey is about the picker, not the bytes. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEgAWwAAAz7AQ1vO8DGAAAAAElFTkSuQmCC",
	"base64",
);

/** Tap + and one of its items, as a finger does; the browser's file chooser that item opened. */
async function choose(phone: Page, item: string) {
	await phone.getByRole("button", { name: "Attach and more" }).tap();
	const chooser = phone.waitForEvent("filechooser");
	await phone.getByRole("menuitem", { name: item }).tap();
	return chooser;
}

/** Mark this page load, so {@link caughtUpInPlace} can tell the page never loaded again. */
function markPage(phone: Page) {
	return phone.evaluate(() => Reflect.set(window, "attachRun", true));
}

/** The page caught up on what it missed while hidden in place (web/resync.ts): same page load, composer still there. */
async function caughtUpInPlace(phone: Page) {
	await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
	expect(await phone.evaluate(() => Reflect.get(window, "attachRun"))).toBe(true);
}

/** The agent answers a prompt in the page's active tab while the page is hidden: the host drops those pushes. */
async function replyWhileHidden(phone: Page, record: string, message: string) {
	await phone.evaluate(async text => {
		const tab = (await window.omp.tabs.list()).find(entry => entry.active);
		if (!tab) throw new Error("no active tab");
		await window.omp.rpc.commandForTab(tab.tabId, { type: "prompt", message: text });
	}, message);
	await expect.poll(() => receivedPrompt(record, message), { timeout: 30_000 }).toBeTruthy();
	// Its reply's stream pushes reach the host now, while the page says it is hidden.
	await phone.waitForTimeout(500);
}

/** The host path a prompt names for `name` (`@/…/name` or `@"/…/name"`). */
function mentionedPath(message: string | undefined, name: string): string | undefined {
	return new RegExp(`@"?([^"\\s]*${name.replace(".", "\\.")})`).exec(message ?? "")?.[1];
}

for (const engine of ENGINES)
	test(`Through the + menu on the phone (${engine.name}), a PDF, a text file and a photo picked while the page hides behind the picker and a reply streams all reach omp; a file over 25 MB is refused with a message`, async () => {
		test.setTimeout(240_000);
		const profile = await makeProfile();
		const browser = await engine.type.launch();
		let host: Host | null = null;
		try {
			host = await startHost(engine, profile);
			const context = await browser.newContext({ ...engine.device });
			const phone = await context.newPage();
			await openPhonePage(phone, host.proxy, profile.project);
			const field = phone.locator("[data-composer-input]").first();
			const thumbnails = phone.locator('ul[aria-label="Attached images"] li[data-strip-item]');
			const documents = [
				{
					name: "report.pdf",
					mimeType: "application/pdf",
					buffer: Buffer.from("%PDF-1.4\n%\u00e2\u00e3\n%%EOF\n"),
				},
				{ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the phone\n") },
			];
			for (const [index, file] of documents.entries()) {
				await markPage(phone);
				const chooser = await choose(phone, "Attach files");
				// Any file: no `accept`, so a phone offers its file manager.
				expect(await chooser.element().getAttribute("accept")).toBeNull();
				await setVisibility(phone, "hidden");
				await replyWhileHidden(phone, profile.record, `busy while picking ${index}`);
				// Held until its chip has been seen: in the fake serve, never with `page.route` (WebKit's interception
				// can send the multipart body without the file's bytes; phone-serve.ts `hold`).
				const upload = host.proxy.hold("/upload");
				await setVisibility(phone, "visible");
				await chooser.setFiles(file);
				const chip = phone.locator("[data-upload-chip]");
				await expect(chip).toHaveText(new RegExp(file.name));
				await captureTo(CAPTURES, phone, `${engine.name}-${file.name}-uploading`);
				upload.release();
				await expect(chip).toHaveCount(0, { timeout: 30_000 });
				// The file is on the computer and the draft names it there.
				await expect(field).toHaveValue(new RegExp(`web-uploads.*${file.name.replace(".", "\\.")}`), {
					timeout: 30_000,
				});
				// The page caught up on what it missed while hidden without loading again; the draft stays.
				await caughtUpInPlace(phone);
				await expect(field).toHaveValue(new RegExp(`web-uploads.*${file.name.replace(".", "\\.")}`), {
					timeout: 30_000,
				});
				const message = `${(await field.inputValue()).trim()} read it`;
				await field.fill(message);
				await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();
				await expect.poll(() => receivedPrompt(profile.record, message), { timeout: 60_000 }).toBeTruthy();
				const hostPath = mentionedPath(message, file.name);
				expect(hostPath).toContain(path.join(profile.desktop, "web-uploads"));
				// What the agent reads at that path is the phone's file.
				expect(await fs.readFile(hostPath ?? "")).toEqual(file.buffer);
				await expect(field).toHaveValue("", { timeout: 30_000 });
			}

			// A photo goes through the same single attach item: no `accept` filter, so the phone offers gallery, camera and files.
			await markPage(phone);
			const chooser = await choose(phone, "Attach files");
			expect(await chooser.element().getAttribute("accept")).toBeNull();
			await setVisibility(phone, "hidden");
			await replyWhileHidden(phone, profile.record, "busy while picking a photo");
			await setVisibility(phone, "visible");
			await chooser.setFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG });
			await expect(thumbnails).toHaveCount(1, { timeout: 30_000 });
			// The picture lives only in this page: the reload waits for it to be sent.
			await phone.waitForTimeout(1500);
			await expect(thumbnails).toHaveCount(1);
			expect(await phone.evaluate(() => Reflect.get(window, "attachRun"))).toBe(true);
			await captureTo(CAPTURES, phone, `${engine.name}-picked-photo`);
			await field.fill("look at the photo");
			await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();
			await expect
				.poll(async () => (await receivedPrompt(profile.record, "look at the photo"))?.images?.length, {
					timeout: 60_000,
				})
				.toBe(1);
			await caughtUpInPlace(phone);

			// Over the 25 MB a file may be: refused on the phone with a message, nothing sent.
			const uploads: string[] = [];
			phone.on("request", request => {
				if (new URL(request.url()).pathname === "/upload") uploads.push(request.url());
			});
			await expect(field).toBeVisible({ timeout: 30_000 });
			const big = await choose(phone, "Attach files");
			await big.setFiles({ name: "huge.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(26 << 20) });
			await expect(phone.getByText("huge.bin is larger than 25 MB and wasn't sent to your computer.")).toBeVisible({
				timeout: 30_000,
			});
			await captureTo(CAPTURES, phone, `${engine.name}-too-large`);
			expect(uploads).toEqual([]);
			await expect(phone.locator("[data-upload-chip]")).toHaveCount(0);
		} finally {
			await browser.close();
			await host?.proxy.close();
			if (host) await exitApp(host.app).catch(() => undefined);
			await fs.rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
		}
	});
