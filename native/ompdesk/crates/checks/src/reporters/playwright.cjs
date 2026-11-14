"use strict";
// ompdesk check: one JSON line per finished test attempt into $OMPDESK_CHECK_RESULTS, written as each test ends, so a
// run cut off half way still says what passed. Playwright adds it beside the project's own reporters
// (PW_TEST_REPORTER), so it records a run started deep inside a script too. The last line of a test wins: a failed
// attempt that is retried and passes ends as "flaky".
const fs = require("node:fs");
const path = require("node:path");

const OUTCOME = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };

class OmpdeskCheckReporter {
	constructor() {
		this.out = process.env.OMPDESK_CHECK_RESULTS;
		this.root = process.cwd();
		this.config = "";
	}
	printsToStdio() {
		return false;
	}
	onBegin(config) {
		this.root = config.rootDir;
		this.config = config.configFile || "";
	}
	write(record) {
		if (!this.out) return;
		try {
			fs.appendFileSync(this.out, `${JSON.stringify(record)}\n`);
		} catch {}
	}
	onTestEnd(test, result) {
		// A reporter's titlePath() starts with the root suite's empty title, then the project, the file and the titles;
		// --test-list names project, file and titles (its own split runs on the path without the root).
		const [, project, , ...titles] = test.titlePath();
		const file = path.relative(this.root, test.location.file).split(path.sep).join("/");
		this.write({
			runner: "playwright",
			config: this.config,
			project,
			file,
			abs: test.location.file,
			titles,
			status: OUTCOME[test.outcome()] || "failed",
			ms: result.duration,
			first_error: result.errors?.[0]?.message ?? result.error?.message,
		});
	}
	onError(error) {
		// An error outside any test (global setup, a worker that crashed): no test result says it.
		this.write({ runner: "playwright", config: this.config, kind: "error", status: "failed", titles: [String(error?.message ?? error).split("\n")[0]] });
	}
	onEnd(result) {
		this.write({ runner: "playwright", config: this.config, end: result.status });
	}
}

module.exports = OmpdeskCheckReporter;
