/**
 * Turn the scenes' raw frames (`RAW_DIR/<name>/`) into `docs/media/<name>.webp`.
 *
 * ffmpeg builds the frame sequence (the recorded timestamps become constant-rate frames at the clip's fps, dead
 * time cut to `maxHold`, scaled to the clip's width) and libwebp's `img2webp` assembles the animated WebP, with
 * identical neighbours merged into one longer frame. `cwebp` writes the stills. The quality steps down until the
 * file fits the clip's size budget. Needs `ffmpeg`, `img2webp` and `cwebp` on PATH (`brew install ffmpeg webp`).
 *
 *   bun scripts/readme-media/encode.ts [name…]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RAW_DIR, type SceneMeta } from "./lib";

const OUT_DIR = path.resolve(import.meta.dir, "../../docs/media");
const QUALITIES = [90, 84, 78, 70, 62, 54, 46, 38];

function need(tool: string): void {
	try {
		execFileSync("which", [tool], { stdio: "ignore" });
	} catch {
		throw new Error(`${tool} is not on PATH (macOS: brew install ffmpeg webp)`);
	}
}

const mb = (file: string) => fs.statSync(file).size / 1_048_576;

function encodeClip(dir: string, meta: SceneMeta): void {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), `readme-encode-${meta.name}-`));
	try {
		const { frames } = meta;
		if (frames.length === 0) throw new Error(`${meta.name}: no frames were recorded`);
		const list: string[] = [];
		frames.forEach((frame, index) => {
			const next = frames[index + 1];
			const hold = next ? Math.min(next.t - frame.t, meta.maxHold) : meta.endHold;
			list.push(`file '${path.join(dir, frame.file)}'`, `duration ${(Math.max(hold, 1) / 1000).toFixed(3)}`);
		});
		list.push(`file '${path.join(dir, frames[frames.length - 1]?.file ?? "")}'`);
		const listFile = path.join(work, "list.txt");
		fs.writeFileSync(listFile, `${list.join("\n")}\n`);
		const seq = path.join(work, "f");
		fs.mkdirSync(seq);
		execFileSync(
			"ffmpeg",
			[
				"-v",
				"error",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				listFile,
				"-vf",
				`fps=${meta.fps},scale=${meta.width}:-2:flags=lanczos`,
				"-fps_mode",
				"cfr",
				path.join(seq, "%05d.png"),
			],
			{ stdio: "inherit" },
		);
		// Identical neighbours become one frame with their summed duration.
		const files = fs.readdirSync(seq).sort();
		const frameMs = Math.round(1000 / meta.fps);
		const merged: { file: string; ms: number }[] = [];
		let previous = "";
		for (const file of files) {
			const hash = createHash("md5")
				.update(fs.readFileSync(path.join(seq, file)))
				.digest("hex");
			const last = merged[merged.length - 1];
			if (last && hash === previous) last.ms += frameMs;
			else merged.push({ file: path.join(seq, file), ms: frameMs });
			previous = hash;
		}
		const out = path.join(OUT_DIR, `${meta.name}.webp`);
		for (const quality of QUALITIES) {
			const args = ["-loop", "0", "-lossy", "-q", String(quality), "-m", "4"];
			const frameArgs = merged.flatMap(frame => ["-d", String(frame.ms), frame.file]);
			execFileSync("img2webp", [...args, ...frameArgs, "-o", out], { stdio: ["ignore", "ignore", "inherit"] });
			const size = mb(out);
			console.log(
				`${meta.name}: ${merged.length} frames, q${quality} → ${size.toFixed(2)} MB (limit ${meta.maxMB})`,
			);
			if (size <= meta.maxMB) return;
		}
		throw new Error(`${meta.name}: ${mb(out).toFixed(2)} MB at the lowest quality, over ${meta.maxMB} MB`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

function encodeStill(dir: string, { name, width }: { name: string; width: number }): void {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), `readme-encode-${name}-`));
	try {
		const scaled = path.join(work, "still.png");
		execFileSync(
			"ffmpeg",
			["-v", "error", "-i", path.join(dir, `${name}.png`), "-vf", `scale=${width}:-2:flags=lanczos`, scaled],
			{
				stdio: "inherit",
			},
		);
		const out = path.join(OUT_DIR, `${name}.webp`);
		execFileSync("cwebp", ["-quiet", "-q", "90", "-m", "6", scaled, "-o", out]);
		console.log(`${name}: still → ${mb(out).toFixed(2)} MB`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

export function encodeAll(only: string[] = []): void {
	need("ffmpeg");
	need("img2webp");
	need("cwebp");
	fs.mkdirSync(OUT_DIR, { recursive: true });
	for (const name of fs.readdirSync(RAW_DIR).sort()) {
		if (only.length > 0 && !only.includes(name)) continue;
		const dir = path.join(RAW_DIR, name);
		if (fs.existsSync(path.join(dir, "frames.json")))
			encodeClip(dir, JSON.parse(fs.readFileSync(path.join(dir, "frames.json"), "utf8")) as SceneMeta);
		else if (fs.existsSync(path.join(dir, "still.json")))
			encodeStill(dir, JSON.parse(fs.readFileSync(path.join(dir, "still.json"), "utf8")));
	}
}

if (import.meta.main) encodeAll(process.argv.slice(2));
