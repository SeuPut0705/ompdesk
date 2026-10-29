import { describe, expect, it } from "vitest";
import { pipeDaclProblem, secureFolder, securePipe } from "./windows-acl";

const ME = "S-1-5-21-1-2-3-1001";

describe("pipeDaclProblem", () => {
	it("accepts a protected DACL that allows this user alone and denies network logons", () => {
		expect(pipeDaclProblem(`D:P(D;;GA;;;NU)(A;;GA;;;${ME})`, ME)).toBeNull();
		expect(pipeDaclProblem(`D:P(D;;FA;;;S-1-5-2)(A;;FA;;;${ME})`, ME)).toBeNull();
		// The script's own read-back shape: SIDs, no rights.
		expect(pipeDaclProblem(`D:P(D;;;;;S-1-5-2)(A;;;;;${ME})`, ME)).toBeNull();
	});

	it("refuses libuv's default DACL and every way short of it", () => {
		const defaults = `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ME})(A;;FR;;;WD)(A;;FR;;;AN)`;
		for (const [sddl, problem] of [
			[defaults, "not protected"],
			[`D:P(D;;GA;;;NU)(A;;GA;;;${ME})(A;;FR;;;WD)`, "allows WD"],
			[`D:P(D;;GA;;;NU)(A;;GA;;;S-1-5-21-9-9-9-1002)`, "allows S-1-5-21-9-9-9-1002"],
			[`D:P(A;;GA;;;${ME})`, "network"],
			["D:P(D;;GA;;;NU)", "does not allow this user"],
		] as const)
			expect(pipeDaclProblem(sddl, ME), sddl).toContain(problem);
	});
});

describe("securePipe", () => {
	it("passes only when the DACL read back is this user's alone", async () => {
		const scripts: string[] = [];
		const ok = async (script: string) => {
			scripts.push(script);
			return `D:P(D;;GA;;;NU)(A;;GA;;;${ME})|${ME}\r\n`;
		};
		await securePipe("\\\\.\\pipe\\ompdesk-abc", ok);
		// The script reads the DACL back as SIDs, so the check never meets an alias such as `LA` for this user.
		expect(scripts[0]).toContain("GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])");
		expect(scripts[0]).toContain("'ompdesk-abc'");
		expect(scripts[0]).toContain("SetAccessControl");
		await expect(
			securePipe("\\\\.\\pipe\\ompdesk-abc", async () => `D:(A;;FA;;;${ME})(A;;FR;;;WD)|${ME}`),
		).rejects.toThrow("not protected");
		await expect(securePipe("/tmp/control.sock", ok)).rejects.toThrow("no local named pipe");
	});
});

describe("secureFolder", () => {
	it("reads the script's verdict and refuses any other answer", async () => {
		for (const verdict of ["ok", "repaired", "foreign"] as const)
			expect(await secureFolder("C:\\u\\control", "C:\\u\\control\\token", async () => `${verdict}\r\n`)).toBe(
				verdict,
			);
		await expect(secureFolder("C:\\u\\control", "C:\\u\\control\\token", async () => "")).rejects.toThrow(
			"no answer",
		);
	});
});
