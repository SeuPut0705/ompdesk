// ompdesk check: one JSON line per finished test case and test file into $OMPDESK_CHECK_RESULTS, written as each file
// ends, so a run cut off half way still says what passed. Vitest 3 calls onTestModuleEnd; Vitest 2 only onFinished.
import { appendFileSync } from "node:fs";
import { relative, sep } from "node:path";

const CASE = { passed: "passed", failed: "failed", skipped: "skipped" };

export default class OmpdeskCheckReporter {
	out = process.env.OMPDESK_CHECK_RESULTS;
	root = process.cwd();
	seen = false;

	onInit(vitest) {
		this.root = vitest?.config?.root ?? this.root;
	}
	write(record) {
		if (!this.out) return;
		try {
			appendFileSync(this.out, `${JSON.stringify(record)}\n`);
		} catch {}
	}
	file(id) {
		return relative(this.root, id).split(sep).join("/");
	}
	onTestModuleEnd(mod) {
		this.seen = true;
		const project = mod.project?.name ?? "";
		const file = this.file(mod.moduleId);
		let failed = false;
		for (const c of mod.children.allTests()) {
			const d = c.diagnostic();
			let status = CASE[c.result().state] ?? "unknown";
			if (status === "passed" && d?.flaky) status = "flaky";
			if (status !== "passed" && status !== "skipped") failed = true;
			this.write({ runner: "vitest", project, file, abs: mod.moduleId, titles: c.fullName.split(" > "), status, ms: d?.duration ?? 0, first_error: c.result().errors?.[0]?.message });
		}
		const state = mod.state();
		const errors = typeof mod.errors === "function" ? mod.errors() : [];
		const status =
			state === "skipped" ? "skipped" : state === "passed" && !failed && errors.length === 0 ? "passed" : "failed";
		const ms = typeof mod.diagnostic === "function" ? (mod.diagnostic()?.duration ?? 0) : 0;
		this.write({ runner: "vitest", project, file, abs: mod.moduleId, kind: "file", status, ms });
	}
	onTestRunEnd(_modules, errors, reason) {
		for (const e of errors ?? []) {
			this.write({ runner: "vitest", kind: "error", status: "failed", titles: [String(e?.message ?? e).split("\n")[0]] });
		}
		this.write({ runner: "vitest", end: errors?.length ? "failed" : reason });
	}
	onFinished(files, errors) {
		if (this.seen || !files) return;
		const walk = (task, out) => {
			if (task.type === "test") out.push(task);
			for (const t of task.tasks ?? []) walk(t, out);
			return out;
		};
		const STATE = { pass: "passed", fail: "failed", skip: "skipped", todo: "skipped" };
		for (const f of files) {
			const file = this.file(f.filepath);
			const project = f.projectName ?? "";
			let failed = f.result?.state !== "pass" && f.result?.state !== "skip";
			for (const t of walk(f, [])) {
				const status = STATE[t.result?.state] ?? "unknown";
				if (status !== "passed" && status !== "skipped") failed = true;
				const titles = [];
				for (let s = t; s && s !== f && s.filepath === undefined; s = s.suite) titles.unshift(s.name);
				this.write({ runner: "vitest", project, file, abs: f.filepath, titles, status, ms: t.result?.duration ?? 0, first_error: t.result?.errors?.[0]?.message });
			}
			this.write({ runner: "vitest", project, file, abs: f.filepath, kind: "file", status: failed ? "failed" : "passed", ms: f.result?.duration ?? 0 });
		}
		for (const e of errors ?? []) {
			this.write({ runner: "vitest", kind: "error", status: "failed", titles: [String(e?.message ?? e).split("\n")[0]] });
		}
		this.write({ runner: "vitest", end: errors?.length ? "failed" : "passed" });
	}
}
