# Frozen properties: <concern>

<!-- Adapted from opum-ai/proof-skills (MIT, Opum AI). See LICENSES/proof-skills-MIT.txt in the OMPdesk app resources. A TLA+ property is a formula over the model's variables, so it cannot live in a module of its own that exists before the model: the frozen text is this file, and the named definitions sit in the spec (SKILL.md step 3). Delete this comment. -->

Frozen at: `<git sha, or the date and the user's OK>`. Any change to a definition below, to a `CONSTRAINT`, or to the fairness of `Spec` is a **model change**: say so in the report, with the old and the new text and the evidence. Never make one to turn a failing check green.

How to see that nothing moved: the definitions are the lines between the `\* FROZEN PROPERTIES` and `\* END FROZEN PROPERTIES` banners of `<tla/Spec.tla>`, so `git diff <frozen sha> -- <tla/Spec.tla>` shows every change to them. (Lean: the statements are in `Properties.lean`, a separate file that imports the system.)

## <PropertyName>

- Kind: invariant | action property | liveness | theorem
- Statement (copied from the spec): `<formal text>`
- Meaning: <one plain sentence>
- Source: <doc, comment, issue, commit, API contract: `README.md:40`, `#1234`>
- Level: protocol (any correct implementation holds it) | code (this implementation only)
- Config: `<MC.cfg>` (`INVARIANT <PropertyName>`)
- Result: holds | violated (finding `F<n>`) | not run

<!-- Repeat the section for every property. A property you added later is marked "added after freezing" with the reason. -->
