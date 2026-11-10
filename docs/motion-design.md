# Motion design

How OMPdesk moves, why it moves that way, and the rules that keep it so. One motion scale (`src/renderer/styles/tokens.css`), one set of CSS utilities (`src/renderer/styles/global.css`, sheets in `mobile.css`), one script side (`src/renderer/lib/motion.ts` and the hooks built on it). The rules are tests, not prose: `src/renderer/styles/motion-system.test.ts`.

The owner's decisions this system keeps (each pinned by its own tests; see `.omp/rules/composer.md` › Working cue, `.omp/rules/no-loading-screens.md`, `.omp/rules/work-board.md`):

- Working state is a light over content already on screen: no border light, no comet. Background work is the same light at lower contrast.
- No loading shimmer and no skeleton sweep; a spinner turns only for work happening.
- Unfocused window: endless cues step at 10 fps (`lib/cue-clock.ts`); hidden: paused.
- Reduced motion: still or instant. `html[data-gpu="software"]`: one-shots instant, the loops held at 10 fps by the cue clock (4 Nov 2026; a still cue read as the app having stopped).
- Anything that loops animates transform and opacity only; the work board runs one animation.

## 1. Prior art

Numbers are labelled: **measured** (read from shipped CSS/JS or an official token file), **stated** (official docs or a blog), **inferred** (computed). Linear, Raycast, Arc and Cursor numbers come from their public websites' CSS, not their apps. ChatGPT web and the Codex desktop app (`/Applications/ChatGPT.app`, `openai-codex-electron` 26.1013.40934, its `app.asar` unpacked) ship the same motion tokens, so they share a table.

### Apple (HIG, SwiftUI)

| Pattern | Duration | Curve / spring | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Frequent interactions avoid motion; feedback brief and precise; motion optional | — | — | — | stated | [HIG Motion](https://developer.apple.com/design/human-interface-guidelines/motion) |
| `Animation.default` (iOS 17+) | response 0.55 s | spring, damping fraction 1.0 | any | measured | [Animation.default](https://developer.apple.com/documentation/swiftui/animation/default) |
| `.smooth` / `.snappy` / `.bouncy` | perceptual 0.5 s | bounce 0 / 0.15 / 0.3 | any | measured | [snappy(duration:extraBounce:)](https://developer.apple.com/documentation/swiftui/animation/snappy(duration:extrabounce:)) |
| Bounce guide: 0 by default, 0.15 brisk, 0.3 visible, above 0.4 too much; gesture ends hand their velocity to a spring | — | — | — | stated | [WWDC23 Animate with springs](https://developer.apple.com/videos/play/wwdc2023/10158/) |

### Material 3

| Pattern | Duration | Curve / spring | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Duration tokens | short 50–200, medium 250–400, long 450–600 ms | — | — | measured | [material-web `_md-sys-motion.scss`](https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-motion.scss) |
| Easing tokens | — | emphasized (.2,0,0,1); emphasized-decelerate (.05,.7,.1,1); emphasized-accelerate (.3,0,.8,.15); legacy (.4,0,.2,1) | — | measured | same |
| Expressive springs | — | default spatial ζ .8 k 380; fast spatial ζ .6 k 800; effects ζ 1 k 1600 | spatial = position/size, effects = colour/alpha | measured | [ExpressiveMotionTokens.kt](https://raw.githubusercontent.com/androidx/androidx/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ExpressiveMotionTokens.kt) |
| Shared-axis page change | out 90 ms opacity + 300 ms −30 px; in 210 ms opacity after 90 ms + 300 ms | (.4,0,1,1) out, (0,0,.2,1) in | opacity, translateX | stated | [Chrome: same-document view transitions](https://developer.chrome.com/docs/web-platform/view-transitions/same-document) |

### Fluent 2

| Pattern | Duration | Curve | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Duration tokens | 50, 100, 150, 200, 250, 300, 400, 500 ms | — | — | measured | [`@fluentui/tokens` durations.ts](https://raw.githubusercontent.com/microsoft/fluentui/master/packages/tokens/src/global/durations.ts) |
| Curve tokens | — | DecelerateMax (.1,.9,.2,1); AccelerateMax (.9,.1,1,.2); EasyEase (.33,0,.67,1) | — | measured | [curves.ts](https://raw.githubusercontent.com/microsoft/fluentui/master/packages/tokens/src/global/curves.ts) |
| Scale presence (menus, popovers) | in 250, out 200 | DecelerateMax / AccelerateMax | scale .9→1, opacity | measured | [Scale.ts](https://raw.githubusercontent.com/microsoft/fluentui/master/packages/react-components/react-motion-components-preview/library/src/components/Scale/Scale.ts) |
| Collapse | 200, symmetric | EasyEaseMax | size + opacity | measured | [Collapse.ts](https://raw.githubusercontent.com/microsoft/fluentui/master/packages/react-components/react-motion-components-preview/library/src/components/Collapse/Collapse.ts) |
| Top-level navigation fades instead of sliding; larger elements move longer | — | — | opacity | stated | [Fluent 2 Motion](https://fluent2.microsoft.design/motion) |

### Linear, Raycast, Arc, Cursor (website CSS)

| Pattern | Duration | Curve | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Linear tooltip | 120 in / 120 out | out-quad (.25,.46,.45,.94) | opacity, scale .9→1, origin at the trigger | measured | [linear.app](https://linear.app/) |
| Linear context menu | 100 / 100 | out-quad in, in-quad out | opacity, scale .9↔1 | measured | same |
| Linear dialog | 180 / 180 | default | opacity, scale .95→1, 1 % rise | measured | same |
| Raycast spring | 0.5–0.59 s | `linear()` spring, peak 1.043 at 40 % | transform | measured | [raycast.com](https://www.raycast.com/) |
| Raycast most frequent curves | — | (.23,1,.32,1) ×15, (.165,.84,.44,1) ×10 | — | measured | same |
| Arc ease | — | (.16,1,.3,1) | translate | measured | [arc.net](https://arc.net/) |
| Cursor tokens | 140 / 250 | out (0,0,.2,1), out-spring (.25,1,.5,1) | — | measured | [cursor.com](https://cursor.com/) |

### Claude (claude.ai bundle)

| Pattern | Duration | Curve | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Duration tokens `--cds-dur-*` | fast 60, snap 120, base 200, sheet 300, slow 450 | — | — | measured | claude.ai shared-styles CSS |
| Curve tokens `--cds-ease-*` | — | out (.165,.84,.44,1); snap (.32,.72,0,1); overshoot (.34,1.3,.64,1) | — | measured | same |
| Item enter (`cds-chip-in`) | 200, 30 ms stagger up to the 8th | out | opacity, scale .8→1, blur 2 px | measured | same |
| Streaming words | 100 | linear | opacity | measured | same |
| Working text shine | 3 s loop, hold at each end | (.714,.121,.211,.888) | translate | measured | same |
| Press | — | — | `active:scale` .92–.995 | measured | same |

### ChatGPT web and the Codex app

| Pattern | Duration | Curve | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| Duration tokens | basic 150, moderate 200, relaxed 300 | — | — | measured | chatgpt.com CSS; Codex `app.asar` `webview/assets/app-initial-*.css` |
| Curve tokens | — | enter (.19,1,.22,1); exit (.8,0,.4,1); move (.65,0,.35,1); spring-snappy `linear()` without overshoot | — | measured | same |
| Menu | in 150 / out 100 | enter / exit | opacity, scale .95↔1 | measured | same |
| Side panel | open 250 / close 200 | enter / exit | opacity, translateX | measured | same |
| New element | 150 | enter | opacity, −4 px rise, scale .98 | measured | same |
| Streamed block | 700 | near-linear | opacity | measured | same |
| Reduced motion | streaming duration 0 | — | — | measured | same |

### Shared React primitives and guidance

| Pattern | Duration | Curve | Properties | Label | Source |
| --- | --- | --- | --- | --- | --- |
| shadcn Dialog | 200 | ease | opacity, scale .95 | measured | [dialog.tsx](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/dialog.tsx) |
| shadcn Accordion | 200 | ease-out | height to `--radix-*-content-height` | measured | same registry |
| Sonner toast | 400 transitions, 200 exit unmount, 4 s life, 14 px gap | ease (transitions, so they retarget) | transform, opacity, height | measured | [sonner styles.css](https://raw.githubusercontent.com/emilkowalski/sonner/main/src/styles.css) |
| Vaul drawer | 500 | (.32,.72,0,1) | translate3d; dismiss at 25 % or velocity 0.4 | measured | [vaul style.css](https://raw.githubusercontent.com/emilkowalski/vaul/main/src/style.css) |
| Press scale .97; never start from scale 0 (≥ .9); a tooltip opened while another just closed shows at once; UI motion under 300 ms; ease-out for enters | — | — | — | stated | [Emil Kowalski, 7 practical animation tips](https://emilkowal.ski/ui/7-practical-animation-tips) |
| FLIP: animate the inverse transform, compute within 100 ms of the input | 300 example | (0,0,.32,1) | transform, opacity | stated | [FLIP your animations](https://aerotwist.com/blog/flip-your-animations/) |
| View Transition default | 250 | ease | opacity cross-fade, group geometry | measured | [CSS View Transitions 1](https://drafts.csswg.org/css-view-transitions-1/) |
| Animation from interactions (WCAG 2.3.3) | — | — | non-essential motion can be turned off | stated | [Understanding 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) |
| Reduced motion: remove, reduce or replace (scale → dissolve) | — | — | — | stated | [MDN prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) |

### What the sources agree on

| Moment | Consensus | Properties |
| --- | --- | --- |
| Hover, colour change | 80–160 ms, ease-out | colour, background |
| Press | at once (≤ 90 ms) to scale .97–.98; cards .99 or none | scale |
| Tooltip | 100–150 ms, scale .9–.97; a hand-over shows at once | opacity, scale |
| Menu or popover in | 120–180 ms, scale .95–.98, origin at the trigger | opacity, scale |
| Exit | 50–80 % of its enter (median about two thirds), accelerating | opacity, scale |
| Dialog | 180–300 ms felt, scale .95 or a 8–20 px rise; scrim fades | opacity, transform |
| Sheet, drawer | 300–500 ms on a strong decelerate such as (.32,.72,0,1) | translate |
| Page or tab | 150–250 ms cross-fade, little or no travel | opacity |
| Expand, collapse | 200–300 ms | height (or rows) + opacity |
| List insert, message arrival | 140–200 ms, 3–12 px rise, 30 ms stagger capped near 8 | opacity, translate |
| Reflow (FLIP) | 200–300 ms, ease-out or spring | transform |
| Done or success | 120–300 ms, scale .8→1 with at most 5 % overshoot, once | scale, opacity |
| Springs | for moves and resizes the eye follows and for gesture ends; bounce 0–0.15; never on colour or opacity | transform |

## 2. Audit (before)

Inventory of `main` at 4d8e3398, from reading the styles and components (notes kept per slice while the work ran). "Raw" means a number or curve that is not a token.

| Surface | Before | Problems |
| --- | --- | --- |
| Tokens | `--sc-duration-*` and three curves, plus `--omp-motion-*`/`--omp-ease*` aliases and a `--omp-ease-spring` cubic with 42 % overshoot | Two names for one scale (about 40 alias uses); no exit rule; no spring, distance or stagger token; the motion lint checked only `styles/*.css` bare `ms` |
| Enter utilities | `omp-fade-up` 10 px + .995, `omp-scale-in` .93 + 10 px, `omp-toast-in` 14 px + .95, `omp-pop-in` −6 px + .95, `omp-slide-in-right` 28 px | Five distances and four scales; enters on an overshooting cubic |
| Exits | Modal, Sheet (left and bottom), drawer, toasts, context-ring popover had exits; `OVERLAY_EXIT_MS = 150` and `usePresence` 180 ms constants | Popover, context menu, tooltip, completion, history, paste, skill picker, composer sheet, prompt card, right sheet, side panel, What's new card unmounted on close; timers did not match their CSS (strip 160 vs 150, board rows 180 vs 150) |
| Press feedback | `.omp-pressable:active` opacity .72 on a few controls; `Button` `brightness-95` | No consistent press; opacity reads as disabled |
| Disclosures | `{open && body}` in ToolCard, ExecutionGroup, ThinkingBlock, StepGroups, ReadGroupCard; native `<details>` in MessageBubble, CustomMessageCard, TurnErrorNotice; inline `rotate` in DockCard; `grid-template-rows` in LiveStepPeek | Bodies jumped open and shut; four implementations |
| Transcript | `.omp-row-arrive` one-shot rise per arriving row; caret loop; thinking label `omp-text-shimmer` (background-position, 2.4 s loop) and a JS glyph clock | A paint loop against the loop rule; the glyph clock ignored software compositing |
| Work card | Stage cross-fade, `omp-work-arrival` animating `background` | A paint per frame per arriving line |
| Turn finish | Nothing | No signal that a turn ended well |
| Sidebar | Rows added, removed and reordered at once; selection colour instant | Rows jumped; the unseen-finish ✓ appeared with no cue |
| Side panel | Slid in (`omp-slide-in-right` 28 px); vanished on close | Asymmetric |
| Split workspace | Drop preview eased `inset` | Layout per frame |
| Work board | Head pulse (the one loop); rows faded in on every mount and left after 180 ms | Fade replayed on every remount |
| Phone work strip | `max-height` keyframes and a 160 ms timer | Layout per frame; timer off its CSS |
| Bars and meters | ProgressBar, usage gauges, todo bars, update card, context breakdown eased `width`; Switch knob eased `width`/`height`; the dictation meter eased `height` every frame | Layout per frame, and meters smoothed twice |
| Phone page | Host sheets (install, confirm, editor, paths, save image, models, folder browser) unmounted at once; sheet drag snapped back | No exits; no spring-back |
| Tailwind leftovers | `transition-all` (JumpToLatest), `ease-out`, `duration-300`, `animate-pulse` (Preview agent dot) | Outside the scale and the software-GPU rule |

## 3. The system

### Tokens (`styles/tokens.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--sc-duration-instant` | 90 ms | a control's own state: press, knob, an exit of a small surface |
| `--sc-duration-fast` | 150 ms | small surfaces: menus, popovers, tooltips, a row, a page cross-fade; exits of dialogs |
| `--sc-duration-med` | 220 ms | cards and dialogs: enter, expand, a list's reflow, message rise; exits of sheets |
| `--sc-duration-slow` | 320 ms | crossing the window: sheets, drawers, the done mark |
| `--sc-ease-standard` | cubic-bezier(.25,1,.35,1) | a change in place: colour, chevrons, knobs |
| `--sc-ease-enter` | cubic-bezier(.16,1,.3,1) | arriving, decelerating (Arc, Cursor and Codex's family) |
| `--sc-ease-exit` | cubic-bezier(.4,0,1,1) | leaving, accelerating |
| `--sc-ease-emphasized` | cubic-bezier(.32,.72,0,1) | a large surface crossing the window (Vaul, Claude's snap) |
| `--sc-ease-spring` | `linear()` of M3 Expressive's default spatial spring (k 380, ζ .8; 1.5 % overshoot) | moves and resizes the eye follows: reflow, the press release, chevrons, the done mark; never opacity or colour |
| `--sc-ease-loop` | cubic-bezier(.37,0,.63,1) | a loop's there-and-back (breathing, a pulse); a loop's period stays its own clock, never a duration token |
| `--sc-motion-rise` | 6 px | how far an arriving surface rises |
| `--sc-motion-pop-scale` | .96 | where menus, popovers and dialogs grow from |
| `--sc-motion-press-scale` | .97 | how far a pressed control gives |
| `--sc-motion-stagger` | 30 ms | between siblings arriving together, at most 8 |

**Exits run one step shorter than their enter** (popover fast → instant, dialog med → fast, sheet slow → med): the consensus puts exits at 50–80 % of enters.

**Motion off in one place.** Under `prefers-reduced-motion: reduce` and `html[data-gpu="software"]` every duration token and the stagger read `0s` (the tail of `tokens.css`). Every transition and one-shot animation timed by a token is instant there, and so is everything the script side times (`motionMs` reads 0), without a rule per surface. Loops keep their own clocks (`--sc-motion-spin`, the working cue's `--live-period`) and `global.css` rests them as before.

### Patterns

| Need | Use |
| --- | --- |
| Enter | `.omp-fade-up` (rise, med), `.omp-fade-in` (fast), `.omp-scale-in` (dialog), `.omp-pop-in` (menu or popover from `--omp-pop-origin`), `.omp-toast-in`, `.omp-slide-in-right`, sheets `.omp-sheet-in-bottom`/`-left` (slow, emphasized) |
| Exit | `.omp-fade-out`, `.omp-scale-out`, `.omp-pop-out`, `.omp-toast-out`, `.omp-sheet-out`; kept mounted by `useOverlayPresence(open, exitToken)` (or `useHeldOverlay` for an overlay whose content is its data), or by a clone that plays the exit where it stood (`leaveGhost` in `lib/motion-play.ts`) for a surface whose owner unmounts it at once (context menu, the agent's prompt card) |
| Press | `.omp-pressable`: `scale: var(--sc-motion-press-scale)` at once on `:active`, springing back on release; compact controls only (buttons, icon buttons, chips, segments). Rows and cards never scale |
| Expand and collapse | `common/Collapse.tsx`: mounts on open and grows its height from 0 (med, enter), shrinks on close (fast, exit) inert, then unmounts. No animation on the first render, where motion is off, or above the window's height. The two always-mounted live shells of the work card keep their `grid-template-rows` (they follow content that grows while open) |
| A list that changes on screen | `useListMotion(listRef)` with `data-flip-key` per row: rows that moved glide from where they were (transform, med, spring); `enter` rises new rows in with the stagger; `usePresence(items, key, exitToken)` keeps a removed row for its exit. The list's own DOM says when it changed (a MutationObserver), not the commits of the component holding the hook: a family block that opens itself commits without its list's owner, and a FLIP keyed to the owner's commits glided every row from its old place on the owner's next commit, under a pressed pointer. Places are layout offsets (`offsetTop`), never the drawn box: a row read again mid-glide kept the glide's passing offset as its resting place |
| A page or section swap | `transitionView` (View Transitions API): opacity cross-fade, fast |
| A finished thing | `.omp-done-pop` once: scale .6 → 1.12 → 1 (slow, enter). Played on the live finish only (claimed once per card or row key: never on hydration, scroll back or remount) |
| Bars and meters | `transform: scaleX/scaleY` from their origin; a per-frame meter has no transition |

### Choosing the values: three directions

The system is tokens all the way down, so a direction is a token set, not code. Three sets ran over the same capture flows (`e2e/motion-captures.e2e.ts` with `OMP_GUI_MOTION_TOKENS`):

| Direction | Durations (instant/fast/med/slow) | Curves | Distances |
| --- | --- | --- | --- |
| Calm, native macOS (Apple `.smooth`, Fluent, M3 standard) | 100 / 160 / 240 / 360 | standard (.4,0,.2,1), enter (.05,.7,.1,1), exit (.3,0,.8,.15), spring without overshoot | rise 6, pop .97, press .98 |
| Snappy (Linear, Raycast) | 60 / 100 / 160 / 250 | out-quad, out-quint (.23,1,.32,1), in-quad, M3 fast spring | rise 4, pop .96, press .97 |
| Expressive spring (Claude, M3 Expressive) | 90 / 150 / 240 / 400 | M3 emphasized, Apple `.bouncy` (4.5 % overshoot) | rise 8, pop .92, press .96 |
| **Chosen** (the shipped tokens) | 90 / 150 / 220 / 320 | enter (.16,1,.3,1), exit (.4,0,1,1), emphasized (.32,.72,0,1), M3 Expressive default spring (1.5 %) | rise 6, pop .96, press .97 |

**Why the shipped set.** The three sets ran the dialog, model picker, toast, work card, sheet and strip flows at one tenth of speed (`OMP_GUI_MOTION_TOKENS`). Counted in distinct frames per step (one frame per 44 ms of real time), snappy ran about one frame shorter and calm and spring about one frame longer than the shipped set on every flow; nothing else separated them. The choice is therefore a judgment against the research, made on these grounds:

- Every shipped value sits inside the consensus range of its moment (menus 150 in the 120–180 band, dialogs 220 in 180–300, sheets 320 in 300–500, exits two thirds of their enters). Calm's 360 ms sheets and 240 ms dialogs sit at the slow edge for an app the owner keeps open all day; snappy's 100 ms menus and 60 ms exits read as cuts on a 60 Hz Windows display (two frames).
- Spring's .92 pop and 4.5 % overshoot draw the eye on every menu and dialog; Apple's guide puts frequent interactions at no bounce, and the owner's working cue is the one thing meant to draw attention. The shipped spring (1.5 %) is used only where a move is followed (reflow, the release of a press, the done mark).
- Enter on (.16,1,.3,1) is Arc's ease and the Codex app's `card` curve, and was already the app's; the scale only had to be completed, not replaced.

## 4. Rules and their tests

`src/renderer/styles/motion-system.test.ts` reads every stylesheet and every renderer source (tests aside, comments blanked):

1. Every `@keyframes` sets only `transform`, `translate`, `scale`, `rotate` and `opacity`.
2. Every `transition` and `animation` duration and curve in a stylesheet is a token (`var(…)`); a loop with its own clock says why with `motion-ok: <reason>` on the line.
3. No transition of a layout property (`width`, `height`, `inset`, edges, `margin`, `padding`, `grid-template-*`, `all`) in a stylesheet or a Tailwind `transition-[…]`/`transition-all`; the two live work-card shells and the tour spotlight are the marked exceptions.
4. No Tailwind default `duration-NNN`, `ease-in/out/in-out`, `delay-NNN` or `animate-pulse/bounce/ping` in a component.
5. `element.animate([…])` only in `lib/motion-play.ts` (the play-time half of the script side, loaded right after the first screen so the paired phone's first screen does not carry it).
6. Every duration token and the stagger are zeroed both under reduced motion and under software compositing.

`lib/motion.test.ts` pins the script side (tokens read, motion off in the three places, FLIP glides and enters, height open and close), `common/Collapse.test.tsx` the disclosure (first render at once, open, inert close, instant where motion is off). The motion lint that `scripts/lint-surfaces.mjs` ran over `styles/*.css` is gone: rule 2 covers it and TSX too.

## 5. Results

### Frame strips

`e2e/motion-captures.e2e.ts` filmed 26 flows on the dev harness, each wide (1440 × 900) and on a phone (390 × 844, touch), light and dark: 78 tests per side, run on `main` (the before) and on this change (the after) with the same spec. Strips and frames are in `~/motion-shots/{before,after}/<step>/<viewport>-<theme>.png`, an index per side in `index.md`. Light theme, distinct frames of 8 (0 = the change was complete before the first frame: a cut):

| Step | Wide before → after | Phone before → after | What changed |
| --- | --- | --- | --- |
| Menu close (this computer's row) | 0 → 5 | 4 → 6 | the menu leaves (pop-out) instead of vanishing |
| Menu close (a paired host's row) | 0 → 5 | 4 → 6 | same as this computer's |
| Slash and @ completion close | 0 → 3 | 0 → 3 | the list leaves instead of vanishing |
| Row added (this computer) | 0 → 6 | 0 → 6 | rows below glide down, the new row rises in |
| Row added (a paired host) | 0 → 6 | 0 → 6 | same as this computer's |
| Row moved (Move down) | 0 → 5 | 4 → 6 | both rows glide (FLIP) |
| Row moved (a paired host) | 0 → 5 | 0 → 6 | same as this computer's |
| Host section fold / unfold | 4 / 0 → 5 / 6 | 0 / 0 → 5 / 4 | the section's height opens and closes (Collapse) |
| Turn finish | 0 → 8 | 5 → 8 | the row's ✓ pops once on the live finish |
| Work card expand | 5 → 6 | 2 → 6 | the steps grow in instead of appearing |
| Tool card expand | 5 → 6 | 5 → 6 | same |
| Dialog close | 4 → 5 | 4 → 6 | exit one step shorter than the enter, accelerating |
| Bottom sheet close | n/a | 0 → 6 | the sheet slides out with its scrim |
| Side panel close | 6 → 8 | 4 → 6 | the panel steps back out the way it came |
| Toast out | 5 → 5 | 4 → 8 | the toast leaves on its token |

Unchanged on purpose: page and Settings cross-fades, the working cue, the strip's chevron. Still a cut: a session row pressed on a phone (a touch press in Chromium's emulation shows no `:active` frame in either version) and an incoming reply's row (it is claimed as arriving only while a turn streams).

### The same in three places

`bun run parity -- session-idle sidebar` (e2e/parity.e2e.ts: one host's session in its own window, from a paired computer's section, and on its phone page at 390) shows the same rows and folds in all three views before and after. The motion itself runs through the same components and tokens in each: the capture flows film this computer's list and a paired host's section side by side (row added, row moved, menu, fold, press), and the phone at 390 for every flow above.

### Cost

`e2e/flow-performance.e2e.ts` on the built app, this change against `main` (c4391f5a) in alternating order on this Mac (16 GB), median of 5 runs per side (3 for `daily` at 1600 px), renderer CPU % with its range, frame p99 ms:

| Flow, phase | Renderer CPU before | after | Frame p99 before → after | Note |
| --- | --- | --- | --- | --- |
| compose, typing | 12.6 (11.3–13.6) | 11.9 (11.6–12.5) | 19 → 19 | no difference |
| expand, open the biggest card | 8.3 (5.8–9.0) | 10.2 (9.4–10.4) | 18 → 18 | the card's height animation is the added work; no long frame |
| expand, close it | 8.0 (5.3–8.4) | 10.0 (8.8–15.8) | 18 → 18 | same; `collapseMs` (body gone from the DOM) 9 → 181 ms is the exit playing, the header answers in the next frame |
| settings, walk the sections | 18.0 (17.9–18.1) | 18.2 (17.7–19.9) | 34 → 33 | no difference |
| sidebar of 500, scroll | 23.2 (22.5–23.3) | 22.7 (21.8–23.6) | 18 → 18 | no difference |
| sidebar of 500, filter typed | 29.0 (27.9–29.3) | 31.0 (30.4–31.8) | 18 → 18 | +2 points, no blocking time; the first build measured every row per keystroke (35.6, 25 ms blocking per 10 s) until a filtering list was held still |
| daily (board, gauges, streaming) | 43.7 (43.3–44.1) | 44.7 (44.3–45.8) | 18 → 19 | +1 point while streaming beside the docked board |
| daily, idle and hidden | 0.6 / 0.4 | 0.7 / 0.5 | 0 → 0 | nothing runs at rest: no new loop |

The list hook was rebuilt last (it watches the list's DOM, see Patterns), so the flows it touches ran again on the final build against `main` (8ba43458), same method (5 runs per side; `daily` 4 before, the fifth cut by the test's time limit):

| Flow, phase | Renderer CPU before | after | Frame p99 before → after | Blocking ms per 10 s before → after |
| --- | --- | --- | --- | --- |
| sidebar of 500, scroll | 22.7 (21.9–23.1) | 22.2 (21.3–23.5) | 19 → 19 | 0 → 0 |
| sidebar of 500, filter typed | 29.3 (28.8–30.1) | 30.5 (29.3–30.6) | 19 → 19 | 0 → 0 |
| sidebar of 500, a row streaming | 19.1 (19.0–37.6) | 21.6 (20.2–24.5) | 19 → 19 | 0 → 0 |
| daily, streaming beside the board | 45.4 (43.7–46.4) | 44.5 (43.1–46.0) | 18 → 19 | 0 → 0 |
| daily, typing | 8.8 (8.6–9.7) | 9.3 (8.6–10.6) | 19 → 19 | 0 → 0 |
| daily, switching tabs | 21.8 (21.2–22.2) | 21.4 (20.0–22.1) | 66 → 50 | 101 → 83 |
| daily, idle / hidden | 0.7 / 0.45 | 0.7 / 0.4 | 0 → 0 | 0 → 0 |

A streaming row in a 500-row sidebar costs about 2 points more: each burst of changes reads the rows' places once, on a task after the frame's layout, so the next added or moved row glides from where it really was.

The paired phone's first-screen JavaScript grew 15,148 bytes (3,294,067 → 3,309,215 on 3dbeeff4; the budget rose by exactly that, 3,294,200 → 3,309,348): the exits, folds and list keys of the components on that screen. The play-time half (`lib/motion-play.ts`: FLIP, height, the leaving clone) loads right after the first screen and is not counted.
