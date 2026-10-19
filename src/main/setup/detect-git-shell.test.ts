import { describe, expect, it } from "vitest";
import { gitShellProblem } from "./detect";

// What Git for Windows' sh printed on a machine with Mandatory ASLR on (Windows 11 26220, Git 2.55 and PortableGit 2.56).
const ASLR_OUTPUT = `      0 [main] sh 244 dofork: child -1 - forked process 56652 died unexpectedly, retry 0, exit code 0xC0000142, errno 11
sh: fork: retry: Resource temporarily unavailable
sh: fork: Resource temporarily unavailable
`;

describe("gitShellProblem", () => {
	it("names Mandatory ASLR from its fork failure, keeps any other failure's last line, and passes a started child", () => {
		expect(gitShellProblem({ code: 0, output: "" })).toBeNull();
		expect(gitShellProblem({ code: 254, output: ASLR_OUTPUT })).toEqual({ kind: "mandatory-aslr" });
		expect(gitShellProblem({ code: 127, output: "sh: /usr/bin/true: No such file or directory\n" })).toEqual({
			kind: "spawn-failed",
			detail: "sh: /usr/bin/true: No such file or directory",
		});
		expect(gitShellProblem({ code: 1, output: "" })).toEqual({ kind: "spawn-failed", detail: "exit 1" });
	});
});
