import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker.
describe.skipIf(!fs.existsSync(stockRoot))("stock session display adapter", () => {
	it("preserves full compacted branches, generated row ids, collision matching and flat tree semantics", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-display-"));
		fs.chmodSync(dir, 0o700);
		try {
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "dir");
			fs.copyFileSync("resources/gui-bridge/session-display.ts", path.join(dir, "session-display.ts"));
			const script = `
import assert from "node:assert/strict";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { attachEntryIds, buildTranscript, flattenSessionTree } from "./session-display.ts";
const manager = SessionManager.inMemory(process.cwd());
const at = "2026-01-01T00:00:00.000Z";
const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const entry = (id, parentId, fields) => ({ id, parentId, timestamp: at, ...fields });
const entries = [
 entry("u1", null, {type:"message", message:user("  first\\nquestion  ")}),
 entry("c1", "u1", {type:"compaction", summary:"old", tokensBefore:10, firstKeptEntryId:"u1"}),
 entry("u2", "c1", {type:"message", message:user("abandoned",2)}),
 entry("u3", "c1", {type:"message", message:user("live",3)}),
 entry("c2", "u3", {type:"compaction", summary:"rescue source", method:"snapcompact", tokensBefore:20, firstKeptEntryId:"u3"}),
 entry("c3", "c2", {type:"compaction", summary:"rescue replacement", method:"snapcompact", tokensBefore:20, firstKeptEntryId:"u3"}),
 entry("b1", "c3", {type:"branch_summary", summary:"went back", fromId:"u1"}),
 entry("x1", "b1", {type:"custom_message", customType:"note", content:"hello", display:true}),
 entry("l1", "x1", {type:"label", targetId:"u1", label:"checkpoint"}),
 entry("l2", "l1", {type:"label", targetId:"u2", label:"temporary"}),
 entry("l3", "l2", {type:"label", targetId:"u2"}),
];
for(const item of entries) manager.ingestReplicatedEntry(item);
const display=buildTranscript(manager);
assert.deepEqual(display.messages.map(message=>message.entryId),["u1","c1","u3","c3","b1","x1"]);
assert.equal(display.messages[3].summary,"rescue replacement");
const stock=buildSessionContext(manager.getEntries(),manager.getLeafId(),undefined,{transcript:true}).messages;
assert.deepEqual(display.messages.map(({entryId,...message})=>message),stock);
const tree=flattenSessionTree(manager.getTree(),manager.getBranch());
assert.deepEqual(tree.tree.map(node=>[node.entryId,node.parentId]),[["u1",null],["u2","u1"],["u3","u1"]]);
assert.equal(tree.activeLeafId,"u3");
assert.equal(tree.tree[0].label,"checkpoint");
assert.equal(tree.tree[0].textPreview,"first question");
assert.equal(tree.tree[1].label,undefined);
assert.equal(tree.tree[1].onActiveBranch,false);
assert.equal(tree.tree[2].isLeaf,true);
const collision=[entry("a",null,{type:"message",message:user("one")}),entry("b","a",{type:"message",message:user("two")})];
assert.equal(attachEntryIds([user("two")],collision)[0].entryId,"b");
assert.equal(attachEntryIds([user("missing")],collision)[0].entryId,undefined);
manager.branch("u2");
assert.deepEqual(buildTranscript(manager).messages.map(message=>message.entryId),["u1","c1","u2"]);
assert.deepEqual(flattenSessionTree([],[]),{tree:[],activeLeafId:null});
const duplicate = SessionManager.inMemory(process.cwd());
duplicate.ingestReplicatedEntry(entry("d1",null,{type:"message",message:user("same")}));
duplicate.ingestReplicatedEntry(entry("d2","d1",{type:"message",message:user("same")}));
duplicate.ingestReplicatedEntry(entry("bash","d2",{type:"message",message:{role:"bashExecution",command:"true",output:"",exitCode:0,cancelled:false,truncated:false,timestamp:1}}));
assert.deepEqual(buildTranscript(duplicate).messages.map(message=>message.entryId),["d1","d2","bash"]);
assert.deepEqual(buildTranscript({getEntries:()=>duplicate.getEntries(),getLeafId:()=>null,getBranch:()=>{throw new Error("null leaf has no branch");}}).messages,[]);
const dangling = SessionManager.inMemory(process.cwd());
dangling.ingestReplicatedEntry(entry("call",null,{type:"message",message:{role:"assistant",provider:"p",model:"m",stopReason:"stop",timestamp:2,content:[{type:"text",text:"calling"},{type:"toolCall",id:"paired",name:"read",arguments:{}},{type:"toolCall",id:"orphan",name:"read",arguments:{}}]}}));
dangling.ingestReplicatedEntry(entry("result","call",{type:"message",message:{role:"toolResult",toolCallId:"paired",toolName:"read",content:[{type:"text",text:"ok"}],timestamp:3}}));
const stripped=buildTranscript(dangling).messages[0];
assert.equal(stripped.entryId,"call");
assert.equal(stripped.strippedToolCalls,1);
assert.deepEqual(stripped.content.map(block=>block.type),["text","toolCall"]);
assert.deepEqual(flattenSessionTree(dangling.getTree(),dangling.getBranch()).tree.map(node=>[node.entryId,node.role]),[["call","assistant"]]);
const reordered = SessionManager.inMemory(process.cwd());
reordered.ingestReplicatedEntry(entry("later",null,{type:"message",timestamp:new Date(2000).toISOString(),message:user("second")}));
reordered.ingestReplicatedEntry(entry("earlier","later",{type:"message",timestamp:new Date(1000).toISOString(),message:user("first")}));
assert.deepEqual(flattenSessionTree(reordered.getTree(),reordered.getBranch()).tree.map(node=>node.entryId),["earlier","later"]);
const deep = SessionManager.inMemory(process.cwd());
for(let index=0;index<4000;index++) deep.ingestReplicatedEntry(entry(String(index),index===0?null:String(index-1),{type:"message",message:user("x".repeat(300),index)}));
const deepTree=flattenSessionTree(deep.getTree(),deep.getBranch());
assert.equal(deepTree.tree.length,4000);
assert.equal(deepTree.tree[0].textPreview.length,200);
assert.ok(deepTree.tree[0].textPreview.endsWith("…"));
assert.equal(deepTree.tree.at(-1).isLeaf,true);
const cyclic = SessionManager.inMemory(process.cwd());
cyclic.ingestReplicatedEntry(entry("cycle-x","cycle-y",{type:"model_change",model:"p/m"}));
cyclic.ingestReplicatedEntry(entry("cycle-y","cycle-x",{type:"model_change",model:"p/m"}));
cyclic.ingestReplicatedEntry(entry("cycle-user","cycle-x",{type:"message",message:user("hi")}));
const cyclicTree=flattenSessionTree(cyclic.getTree(),cyclic.getBranch());
assert.equal(cyclicTree.activeLeafId,"cycle-user");
assert.deepEqual(cyclicTree.tree.map(node=>[node.entryId,node.parentId,node.onActiveBranch]),[["cycle-user",null,true]]);
console.log("stock display assertions passed");
`;
			fs.writeFileSync(path.join(dir, "check.ts"), script);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts")], {
					encoding: "utf8",
					env: { ...process.env, PI_CODING_AGENT_DIR: dir },
					timeout: 30_000,
				}),
			).toContain("stock display assertions passed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
