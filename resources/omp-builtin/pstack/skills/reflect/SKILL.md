---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

> OMPdesk built-in pack. Tool, agent and model names here are the omp and OMPdesk ones; the adapter is in the `<pstack>` section of your prompt, or `skill://pstack-adapter`.

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript in the omp session folder `~/.omp/agent/sessions/<cwd-slug>/` (the current session's `.jsonl`). Do not glob across other workspaces' folders under `~/.omp/agent/sessions/`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
ls -t ~/.omp/agent/sessions/<cwd-slug>/*.jsonl 2>/dev/null | head -10
```

That covers the legacy flat (`<id>.jsonl`), current nested (`<id>/<id>.jsonl`), and subagent (`<parent>/subagents/<child>.jsonl`) layouts. For each candidate, read the first JSONL line. Take the file whose `message.content[0].text` contains the conversation's opening user prompt. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One `task` call with three `tasks[]` entries, the default `task` agent (not `scout`: reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references).

Each reviewer and the synthesizer name a model role. If the `task` tool rejects a model, use the role's default and say so.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | `@slow` | `references/judgment-reviewer.md` |
| Tooling | `@task` | `references/tooling-reviewer.md` |
| Divergent | `@slow` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `task` result.

## 3. Synthesize

One `task` call on `@slow` with the default `task` agent. It spot-verifies citations through MCP, which `scout` cannot reach. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the user's skill-writing skill (`writing-great-skills`) when installed, else the `manage_skill` tool, and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `create-skill` and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to `create-skill`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
