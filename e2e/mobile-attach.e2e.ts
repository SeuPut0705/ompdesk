/**
 * A photo attached on the phone, end to end: the built app's real web server behind the fake `tailscale serve`
 * (e2e/fixture/phone-serve.ts: the secret path prefix, serve's headers, the published origin), a phone page in
 * Chromium (Pixel 7) and WebKit (iPhone 14), and the fake omp recording what it was sent. The composer's file
 * input takes a camera JPEG (4032×3024, about 5 MB), a 12 MB JPEG and a HEIC; each one shows as a thumbnail,
 * goes to the computer by `POST /upload` (a socket frame holds 1 MB, which a phone photo outgrows even scaled
 * down), reaches omp as an image block of the prompt, and comes back as a picture in the sent bubble.
 * OMP_GUI_MOBILE_ATTACH=<dir> also writes the composer and the bubble per picture.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserType, chromium, devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
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

async function makeProfile() {
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

for (const engine of ENGINES)
	test(`A photo attached on the phone (${engine.name}) goes up through the serve prefix, omp gets it as an image and the sent bubble shows it: a camera JPEG, a 12 MB JPEG and a HEIC`, async () => {
		test.setTimeout(240_000);
		const profile = await makeProfile();
		const browser = await engine.type.launch();
		let app: ElectronApplication | null = null;
		let proxy: ServeProxy | null = null;
		try {
			app = await electron.launch({
				args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
				env: profile.env,
			});
			const desk = await app.firstWindow();
			await desk.waitForFunction(() => window.omp?.rpc != null);
			await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(profile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(profile.tailscale).at(-1);
			if (!site) throw new Error("serve publishes no handler");
			proxy = await ServeProxy.start(site, "seuput@example.com", undefined, {
				plainCookie: engine.name === "webkit",
			});

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
			await phone.goto(`${proxy.url}/`);
			// A web window starts with no tab of its own: open one in the project, as the phone's sidebar would.
			await expect(phone.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 60_000 });
			await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), profile.project);
			await phone.reload();
			const field = phone.locator("[data-composer-input]").first();
			await expect(field).toBeVisible({ timeout: 60_000 });
			const thumbnails = phone.locator('ul[aria-label="Attached images"] li img');

			for (const [index, picture] of pictures.entries()) {
				const message = `look at ${picture.name}`;
				await phone.locator('input[type="file"]').first().setInputFiles(picture);
				await expect(thumbnails).toHaveCount(1, { timeout: 30_000 });
				await captureTo(CAPTURES, phone, `${engine.name}-${picture.name}-composer`);
				await field.fill(message);
				await phone.keyboard.press("Enter");

				// omp got the prompt with the picture as an image block, whatever the frame limit.
				await expect.poll(() => receivedPrompt(profile.record, message), { timeout: 60_000 }).toBeTruthy();
				const prompt = await receivedPrompt(profile.record, message);
				expect(prompt?.images).toHaveLength(1);
				const image = prompt?.images?.[0];
				expect(image?.type).toBe("image");
				expect(image?.mimeType).toMatch(/^image\//);
				expect(image?.data.length ?? 0).toBeGreaterThan(1000);
				if (picture.mimeType === "image/jpeg") {
					// Scaled down on the phone (IMAGE_MAX_SIDE) and still a JPEG; larger than a frame as base64.
					expect(image?.mimeType).toBe("image/jpeg");
					expect(Buffer.from(image?.data ?? "", "base64").length).toBeLessThan(picture.buffer.length);
				}
				await expect(thumbnails).toHaveCount(0);
				// The bubble shows the picture omp journaled (a browser that cannot draw HEIC shows the chip).
				const shown = picture.mimeType === "image/heic" && engine.name === "chromium" ? index : index + 1;
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
			await phone.keyboard.press("Enter");
			await expect
				.poll(async () => (await receivedPrompt(profile.record, both))?.images?.length, { timeout: 60_000 })
				.toBe(2);
			// The three bubbles above showed 3 pictures (2 where the browser cannot draw HEIC), now 2 more.
			const decoded = (engine.name === "chromium" ? 2 : 3) + 2;
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
