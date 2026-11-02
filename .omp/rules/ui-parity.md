---
description: "OMPdesk rules: the parity sheet every UI change reports: the same surface in this computer's window, a paired computer's view and the phone. Read before changing any renderer file."
globs:
  - "src/renderer/**"
  - "e2e/parity.e2e.ts"
  - "e2e/responsive-*.ts"
  - "scripts/parity.ts"
---
## UI parity

### Parity sheet: this computer, a paired computer, the phone
- **A UI change's final report attaches the parity sheet of every surface it touched** (the owner's rule, 3 Nov 2026, after agents kept checking only their own window): `bun run parity -- <surface…>` (`scripts/parity.ts`, `e2e/parity.e2e.ts`) captures the same session of one computer three ways (its own desktop window at 1280×860, another OMPdesk paired with it viewing that session from its section of the sidebar, and its phone page at 390×844 in Chromium), en light on the fake omp, and puts them side by side in `<dir>/<surface>/sheet.png` beside each view's PNG (default dir `tmp/parity/<time>`; it prints every path). It builds `out/` first, runs under the lock, and exits non-zero naming the surface and view when a view could not reach the surface; a report never carries a partial set as a pass.
- The surfaces are the responsive audit's (`e2e/responsive-surfaces.ts`); one with a `parity` session (`work`: a session with one answered turn, `bot`: the bot's with a duty and an open decision) can be captured: `sidebar`, `sidebar-family`, `session-idle`, `bot-bar` so far. `sidebar-family` (`remoteChild`, parity only: the audits skip it) first pairs B with A both ways, leaves a session B's bot opened on A running with only the bot's ended conversation naming its opener, and runs a session of A's own; it opens the bot's family and folds every other device section. A touched surface without one gets it in the same change, when its `open` works on a real window (a click on a real control); one driven through `window.__stores` (harness only) gets a real-window `open` first. Look at the three panels before reporting: a difference the change did not mean is a bug of the change.

