import { MEMORY_POLICY_WASM_BASE64 } from "./memory-policy-wasm";

/** ABI 1 of the single Rust prompt policy, also used by native upkeep. No app or network is needed. */
export interface MemoryPromptFacts {
	agent: boolean;
	junk: boolean;
	title: string | null;
	explicit: string | null;
	body: string;
	firstLine: string | null;
	agentMessage: boolean;
	subagentAssignment: boolean;
}

interface MemoryPolicyExports {
	memory: WebAssembly.Memory;
	policy_abi_version(): number;
	policy_alloc(length: number): number;
	policy_eval(pointer: number, length: number): bigint;
	policy_free(pointer: number, length: number): void;
}

const policyInstance = new WebAssembly.Instance(
	new WebAssembly.Module(Buffer.from(MEMORY_POLICY_WASM_BASE64, "base64")),
);
const policyExports = policyInstance.exports;
if (
	!(policyExports.memory instanceof WebAssembly.Memory) ||
	["policy_abi_version", "policy_alloc", "policy_eval", "policy_free"].some(
		name => typeof policyExports[name] !== "function",
	)
) {
	throw new Error("Memory prompt policy has an invalid WASM interface");
}
const policy = policyExports as unknown as MemoryPolicyExports;
if (policy.policy_abi_version() !== 1) throw new Error("Memory prompt policy ABI is not supported");
const policyEncoder = new TextEncoder();
const policyDecoder = new TextDecoder("utf-8", { fatal: true });

export function memoryPromptFacts(text: string, sessionName?: string): MemoryPromptFacts {
	const input = policyEncoder.encode(JSON.stringify({ text, sessionName }));
	const pointer = policy.policy_alloc(input.length);
	let output: number | undefined;
	let length = 0;
	try {
		new Uint8Array(policy.memory.buffer, pointer, input.length).set(input);
		const packed = policy.policy_eval(pointer, input.length);
		output = Number(BigInt.asUintN(64, packed) >> 32n);
		length = Number(packed & 0xffff_ffffn);
		const response = JSON.parse(policyDecoder.decode(new Uint8Array(policy.memory.buffer, output, length))) as
			| MemoryPromptFacts
			| { error: { code: string; message: string } };
		if ("error" in response) throw new Error(`${response.error.code}: ${response.error.message}`);
		return response;
	} finally {
		if (output !== undefined) policy.policy_free(output, length);
		policy.policy_free(pointer, input.length);
	}
}
