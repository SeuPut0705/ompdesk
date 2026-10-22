# Shared UI components

The renderer's design system: every primitive a surface is built from. Read this before you write UI; reach for a
component here before a raw element, and read the component's file header for its full rules. Import from the barrel
(`components/common` → `index.ts`). Every primitive renders in the internal style guide (`OMP_GUI_STYLEGUIDE=1`, or
`#/styleguide` on the dev harness).

`scripts/lint-controls.mjs` (run with the other surface rules by `scripts/lint-surfaces.mjs`, so by `bun run check` and
`bun run check:changed`) fails a renderer component
outside this folder that adds a raw `<button>`, a raw checkbox or radio, or a hand-made `role="dialog"`. A raw element
that has a real reason (a listbox option with `aria-activedescendant`, a row whose whole box is styled by an `omp-*`
class) says why on the line or the one above: `controls-ok: <reason>`. Existing raw elements are frozen per file in
`scripts/lint-controls-baseline.json`: a file may hold at most its count, and one below it fails until
`node scripts/lint-controls.mjs --update` lowers the count (it never raises one or adds a file).

## Pick by need

| You need | Use | Not |
| --- | --- | --- |
| A text action | `Button` (primary: the one main action; secondary; ghost in dense UI; danger only to confirm a destructive flow) | a styled `<button>`, two primaries side by side |
| An icon-only action | `IconButton` (`label` required: name and tooltip; `pressed` toggles, `loading` shows work) | `Button` without text, a bare icon with a `title` |
| Copy to clipboard | `CopyButton` | your own icon swap |
| An action that reads as a link inside text (a name in a sentence, "Add a note", a commit hash) | `LinkButton` (`accent`, `muted`) | an underlined `<button>` of your own |
| A list of actions | `MenuButton` (⋯ menus), `ContextMenu` (right click, `anchorFromEvent`); both, like `Modal`, give focus back to the opener or, when the chosen item removed it, to what took its place (`focus-place.ts`) | a hand-made popover of buttons |
| A setting that applies at once | `Switch` (bare), `SwitchField` (settings-style row), `SwitchTile` (two-column grid) | a checkbox |
| A choice applied on submit, or rows picked from a list | `Checkbox` (`indeterminate` for select-all), `Radio` | a raw `<input type="checkbox">` |
| One of 2–5 short values, applied at once (thinking level, approval, rotation) | `SegmentedChoice` (a radio group; `fit`, `selectOnArrow`) | `Tabs` (they switch views), hand-made `role="radio"` buttons |
| One of a few options that each need a line of explanation (an MCP server's transport, its scope) | `ChoiceCards` (a radio group of cards with a hint; one tab stop, arrows pick) | hand-made `role="radio"` cards |
| One value from ≤ ~15 fixed options | `Select` (native popup) | a custom dropdown |
| A long, searchable or rich list (models, sessions, branches) | a picker: `Modal size="picker" placement="top"` | `Select` |
| Text entry | `Input`, `TextArea` (auto-grow), `SearchField`; long documents `TextEditor` | a raw `<input>` |
| A picker's search over its result list | `SearchField` with `listbox` (the field is the list's combobox; rows are `OptionRow`, no tab stops) | rows the Tab key walks |
| Sibling views of one surface | `Tabs` (`underline` sections, `segmented` 2–4 modes) | buttons that look like tabs |
| A row of a picker's listbox driven from its field (`aria-activedescendant`) | `OptionRow` (`active` highlight, `selected`, `size`) | a copied row class string |
| A navigable row (sessions, agents, providers) | `ListRow` (one click target, actions on hover/focus) | a copied row class string |
| A header that opens and folds what is under it (a diff file, an entry, an Advanced group) | `DisclosureButton` (`open`, `onToggle`; owns `aria-expanded`, the turning chevron and the focus ring) | a `<button aria-expanded>` with its own chevron swap |
| A "show N more" control that disappears once the rest shows | `revealAndFocus` (`lib/reveal-focus.ts`: focus moves to the first revealed row; a list whose rows land in groups names it with `firstRevealed`) | a button that unmounts and drops focus on the page |
| A tree | `TreeView` | nested lists with your own keys |
| List beside detail, one pane on a phone | `MasterDetail`, `useMasterDetail`, `MasterDetailBack` (a page that lays out its own list) | your own two-column switch |
| A destination page | `PageLayout` | a page frame of your own |
| A small form, confirm or picker | `Modal` (focus trapped, Escape closes, footer primary last; on close focus returns to the opener, or to what took its place when the dialog's action removed it) | a dialog from a dialog |
| "Yes, really" before something irreversible | `ConfirmDialog` (safe action focused) | `window.confirm` |
| Detail too big for a popover, smaller than a page | `Sheet` (`right`, `left` drawer, `bottom` action sheet, `full`) | a Sheet over a Modal |
| Quick contextual controls by their trigger | `Popover` | a Modal |
| A label for an unspelled control | `Tooltip` (prefer `IconButton`, which wires it) | essential information only in a tooltip |
| A longer explanation of a row | `SettingInfo` (the (i) glyph), `splitDescription` | a paragraph under a label |
| A short status or count | `Badge` (`dot` + `pulse` while live; text says the state) | a clickable badge |
| A persistent condition of a surface | `Banner` (one sentence, ≤ 2 actions) | a toast |
| One part of a surface failed or is degraded | `InlineNotice` (with Retry; cause as `ErrorDetail`) | stacked Banners |
| Brief feedback after an action | a toast (`stores/toast`, drawn by `ToastStack`) | a Banner |
| Nothing to show yet | `EmptyState` (with the fixing action) | a sentence alone |
| A read with loading, error, empty and data | `AsyncSection` | your own state precedence |
| Loading with a known shape | `Skeleton`, `SkeletonRows` | a spinner |
| Work with no shape | `Spinner` (still ring; `spin` only for an action just started) | a turning ring for content |
| Known progress or fullness | `ProgressBar` (`meter`, `progress`) | a hand-drawn bar |
| A keyboard shortcut | `Kbd`, or `shortcut` on `Tooltip`/`IconButton` | shortcuts baked into labels |
| A panel fed by free-form data | `PanelErrorBoundary` | an unguarded subtree |
| Back to the newest row of a scrolled transcript | `JumpToLatest` | another floating button |
| An image that opens full size | `ZoomableImage` | your own viewer |
| Ages, costs, account usage | `TimeAgo`, `CostAmount`, `UsageGauges` | formatting them again |
| Work going on | `LiveText`/`LiveSweep` (`LiveShimmer`), `WorkingArc` | a new animation |
| The app's mark | `BrandMark` | an inline copy of the π |
| The UI language switch | `LangSwitcher` | a language select of your own |

## Container policy

- Destinations with navigation of their own (Settings, Agents, Insights, PRs) are pages, not dialogs.
- Dialogs (`Modal`) are for short, self-contained tasks and pickers. Never open a dialog from a dialog: swap the
  content in place or close the first. Never stack a Sheet on a Dialog or the other way round.
- A `Popover` must fit without long scrolling; anything bigger is a `Sheet` or a page. A plain list of actions is a menu.
- Every floating layer that can reach the 48 px top bars cuts itself out of the window's drag area (`no-drag`); the
  primitives above already do.

## Rules every component follows

- Control scale: `sm` 28 px, `md` 32 px (default), `lg` 36 px, so mixed rows line up. Touch hit areas come from
  `styles/mobile.css`, never from drawing a control bigger.
- Every control has a name: a visible label (preferred) or `aria-label`; a placeholder is an example, never the label.
- Colour is never the only cue: a state is also a word, a shape or an icon.
- Content surfaces are colourless; the surface policy in `styles/global.css` says which tokens may paint
  (`scripts/lint-surfaces.mjs`). Tokens and contrast floors: `styles/tokens.css`, `lib/theme-contrast.ts`.
- User-visible text goes through `useT()` with the same key in `locales/en.ts` and `locales/ko.ts`.

## Adding or changing a component

- A need no component covers gets a component here, not a second private copy in a feature folder. Two copies of the
  same control are merged into one.
- Write the rules in the file's header comment, export it from `index.ts`, add a row to the table above (every
  exported component is named in it; `catalog.test.ts` fails otherwise) and a sample to
  `components/styleguide/StyleGuide.tsx`.
- Test behaviour (roles, names, keyboard, callbacks) with the linkedom harness, as `Switch.test.tsx` does.
