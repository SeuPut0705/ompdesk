// A 60 s, ~15 MB VP8 WebM of noise frames (shell-assets/video.webm): big enough that seeking needs range requests.
// Uses Playwright's bundled ffmpeg (VP8 only, frames in as MJPEG) and sharp for the frames.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), "AppData/Local/ms-playwright");
const dir = readdirSync(root).find(name => name.startsWith("ffmpeg-"));
if (!dir) throw new Error("no Playwright ffmpeg");
const ffmpeg = join(root, dir, process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-win64.exe");
const out = resolve(import.meta.dir, "../shell-assets/video.webm");
const fps = 15;
const seconds = 60;
const [w, h] = [640, 360];
const tmp = `${out}.mjpeg`;
const chunks: Buffer[] = [];
const raw = Buffer.alloc(w * h * 3);
for (let frame = 0; frame < fps * seconds; frame++) {
	for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0;
	chunks.push(await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 70 }).toBuffer());
}
await Bun.write(tmp, Buffer.concat(chunks));
const proc = Bun.spawn(
	[ffmpeg, "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(fps), "-i", `file:${tmp}`, "-c:v", "vp8", "-b:v", "2M", "-g", String(fps * 2), out],
	{ stdout: "inherit", stderr: "inherit" },
);
console.log("exit", await proc.exited, Bun.file(out).size, "bytes");
await Bun.file(tmp).delete();
