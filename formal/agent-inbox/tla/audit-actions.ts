interface Definition {
	name: string;
	body: string;
}

export interface ActionCoverage {
	name: string;
	assigned: string[];
	unchanged: string[];
	missing: string[];
	repeated: string[];
}

export interface CoverageAudit {
	variables: string[];
	actions: ActionCoverage[];
	ok: boolean;
}

function maskCommentsAndStrings(source: string): string {
	let result = "";
	let block = 0;
	let string = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		const pair = source.slice(index, index + 2);
		if (block) {
			if (pair === "(*") { block++; result += "  "; index++; }
			else if (pair === "*)") { block--; result += "  "; index++; }
			else result += char === "\n" ? "\n" : " ";
		} else if (string) {
			if (char === "\\") { result += "  "; index++; }
			else { if (char === '"') string = false; result += char === "\n" ? "\n" : " "; }
		} else if (pair === "\\*") {
			while (index < source.length && source[index] !== "\n") { result += " "; index++; }
			if (index < source.length) result += "\n";
		} else if (pair === "(*") {
			block = 1; result += "  "; index++;
		} else if (char === '"') {
			string = true; result += " ";
		} else result += char;
	}
	if (block || string) throw new Error("Unterminated TLA comment or string");
	return result;
}

function names(tuple: string): string[] {
	const result = tuple.trim().split(/\s*,\s*/);
	if (result.some(name => !/^[A-Za-z_]\w*$/.test(name)))
		throw new Error("Expected a nonempty tuple of plain state-variable names");
	return result;
}

function nextActions(body: string): string[] {
	const branches: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < body.length; index++) {
		if (body[index] === "(") depth++;
		else if (body[index] === ")") depth--;
		else if (depth === 0 && body.startsWith("\\/", index)) {
			branches.push(body.slice(start, index).trim());
			start = index + 2;
			index++;
		}
		if (depth < 0) throw new Error("Unbalanced Next action parentheses");
	}
	if (depth !== 0) throw new Error("Unbalanced Next action parentheses");
	branches.push(body.slice(start).trim());
	return branches.map(branch => {
		const direct = /^([A-Za-z_]\w*)(?:\([^()]*\))?$/.exec(branch);
		const quantified = /^\(\\E\s+[\s\S]+:\s*([A-Za-z_]\w*)\([^()]*\)\s*\)$/.exec(branch);
		const name = direct?.[1] ?? quantified?.[1];
		if (!name) throw new Error(`Unsupported Next branch: ${branch}`);
		return name;
	});
}

/** Syntactic assignment coverage for this model's conjunctive actions, not a TLA semantic checker. */
export function auditActions(source: string): CoverageAudit {
	const masked = maskCommentsAndStrings(source);
	const declared = /\bVARIABLES\b([\s\S]*?)^vars\s*==/m.exec(masked);
	const tuple = /^vars\s*==\s*<<([\s\S]*?)>>/m.exec(masked);
	if (!declared || !tuple) throw new Error("Expected VARIABLES and the vars tuple");
	const variables = names(tuple[1]);
	const declarations = names(declared[1]);
	if (new Set(variables).size !== variables.length || new Set(declarations).size !== declarations.length
		|| variables.length !== declarations.length || variables.some(name => !declarations.includes(name)))
		throw new Error("VARIABLES and vars must name the same unique state variables");
	const headers = [...masked.matchAll(/^([A-Za-z_]\w*)(?:\([^()\n]*\))?\s*==/gm)];
	const definitions = new Map<string, Definition>();
	for (let index = 0; index < headers.length; index++) {
		const header = headers[index];
		const name = header[1];
		if (definitions.has(name)) throw new Error(`Duplicate definition: ${name}`);
		definitions.set(name, { name, body: masked.slice(header.index + header[0].length, headers[index + 1]?.index ?? masked.length) });
	}
	const next = definitions.get("Next");
	if (!next) throw new Error("Expected Next");
	const selected = new Set(nextActions(next.body));
	for (const definition of definitions.values()) {
		if (definition.name !== "Init" && (/\b[A-Za-z_]\w*'/.test(definition.body) || /\bUNCHANGED\b/.test(definition.body)))
			selected.add(definition.name);
	}
	const actions = [...selected].map(name => {
		const definition = definitions.get(name);
		if (!definition) throw new Error(`Undefined action: ${name}`);
		const assigned = [...definition.body.matchAll(/\b([A-Za-z_]\w*)'\s*=/g)].map(match => match[1]);
		const primed = [...definition.body.matchAll(/\b([A-Za-z_]\w*)'/g)].map(match => match[1]);
		if (primed.some(variable => !assigned.includes(variable)))
			throw new Error(`Unsupported primed expression in ${name}`);
		const tuples = [...definition.body.matchAll(/\bUNCHANGED\s*<<([^<>]*)>>/g)];
		if (tuples.length !== [...definition.body.matchAll(/\bUNCHANGED\b/g)].length)
			throw new Error(`Unsupported UNCHANGED expression in ${name}`);
		const unchanged = tuples.flatMap(tuple => names(tuple[1]));
		const covered = [...assigned, ...unchanged];
		if (covered.some(variable => !variables.includes(variable)))
			throw new Error(`Unknown state variable in ${name}`);
		return { name, assigned, unchanged,
			missing: variables.filter(variable => !covered.includes(variable)),
			repeated: variables.filter(variable => covered.filter(held => held === variable).length > 1) };
	});
	return { variables, actions, ok: actions.every(action => action.missing.length === 0 && action.repeated.length === 0) };
}

if (import.meta.main) {
	try {
		const path = process.argv[2] ?? new URL("InboxHop.tla", import.meta.url);
		const report = auditActions(await Bun.file(path).text());
		console.log(JSON.stringify({ path, ...report }, null, 2));
		if (!report.ok) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
