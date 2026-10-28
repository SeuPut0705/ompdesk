# Correspondence: <concern>

<!-- Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources. Delete this comment when you fill the template. -->

Sync commit: `<git sha at which this map was last confirmed against the code; the same value as syncCommit in formal/manifest.json>`

The `@code path:lines` tags in the model files are the machine-checked half of this map (`verify-all.ts` fails on a tag that does not resolve). This table records what each tag abstracts, and the assumptions the model relies on. Keep the two in step: when a tag changes, change its row.

## Map

| Model element | Code | Kind | Abstraction | Notes |
|---|---|---|---|---|
| `ActionName(p)` | `path/to/file.ext:10-24` `function_name()` | action | what is merged or omitted | |
| `varName` | `path/to/file.ext:5` `self.field` | variable | domain reduced to {...} | |

## Assumptions

Facts about the environment that the model relies on. Each is a place a bug could hide.

- A1: ...
- A2: ...

## Granularity

State the atomicity rule used (for example "one action per await-delimited block" or "one action per locked section") and list any place where the model merges steps the code performs separately.
