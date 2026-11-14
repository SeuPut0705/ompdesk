"use strict";
// ompdesk check: one JSON line per finished test and test file into $OMPDESK_CHECK_RESULTS, written as each file ends.
const fs = require("node:fs");
const path = require("node:path");

const CASE = { passed: "passed", failed: "failed" };

class OmpdeskCheckReporter {
	constructor(globalConfig) {
		this.out = process.env.OMPDESK_CHECK_RESULTS;
		this.root = (globalConfig && globalConfig.rootDir) || process.cwd();
	}
	write(record) {
		if (!this.out) return;
		try {
			fs.appendFileSync(this.out, `${JSON.stringify(record)}\n`);
		} catch {}
	}
	onTestResult(_test, result) {
		const abs = result.testFilePath;
		const file = path.relative(this.root, abs).split(path.sep).join("/");
		for (const a of result.testResults || []) {
			const status = CASE[a.status] || (a.status === "pending" || a.status === "skipped" || a.status === "todo" ? "skipped" : "unknown");
			this.write({ runner: "jest", file, abs, titles: [...(a.ancestorTitles || []), a.title], status, ms: a.duration || 0, first_error: a.failureMessages?.[0] });
		}
		const ok = !result.testExecError && !result.failureMessage && (result.numFailingTests || 0) === 0;
		const ms = result.perfStats ? result.perfStats.end - result.perfStats.start : 0;
		this.write({ runner: "jest", file, abs, kind: "file", status: ok ? "passed" : "failed", ms });
	}
	onRunComplete(_contexts, results) {
		this.write({ runner: "jest", end: results && results.success ? "passed" : "failed" });
	}
	getLastError() {
		return undefined;
	}
}

module.exports = OmpdeskCheckReporter;
