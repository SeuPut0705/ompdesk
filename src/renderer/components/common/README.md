# Shared UI components

The renderer's design system: every primitive a surface is built from. Read this before you write UI; reach for a
component here before a raw element, and read the component's file header for its full rules. Import from the barrel
(`components/common` → `index.ts`). Every primitive renders in the internal style guide (`OMP_GUI_STYLEGUIDE=1`, or
`#/styleguide` on the dev harness).

`scripts/lint-controls.mjs` (run with the other surface rules by `scripts/lint-surfaces.mjs`, so by `bun run check` and
`bun run check:changed`) fails a renderer component
outside this folder that adds a raw `<button>`, a raw checkbox or radio, a hand-made `role="dialog"`, a hand-made
`role="tab"` or `role="tablist"` (`Tabs`, `SegmentedChoice`), a hand-made `role="progressbar"` (`ProgressBar`) or a
turning lucide loader (`Loader2` and the like with `animate-spin`; `Spinner`). A raw element
that has a real reason (a listbox option with `aria-activedescendant`, a row whose whole box is styled by an `omp-*`
class) says why on the line or the one above: `controls-ok: <reason>`. Any other raw element fails; there is no
allow-list beside the marker.

## Pick by need

| You need | Use | Not |
| --- | --- | --- |
| A text action | `Button` (primary: the one main action; secondary; ghost in dense UI and every dialog's Cancel; danger only to confirm a destructive flow; danger-soft for a destructive action that asks its own confirmation next; a disabled primary keeps the accent's soft wash, `disabledReason` says why on hover, focus and a tap) | a styled `<button>`, two primaries side by side, danger colours on another variant, a reason in a native `title` |
| An icon-only action | `IconButton` (`label` required: name and tooltip; `pressed` toggles, `loading` shows work; `size="inline"` for a glyph inside a line of text, `tone` `success`/`warning`/`danger` for a status glyph; with `disabled`, `disabledReason` keeps it focusable and puts the reason under its label in the Tooltip) | `Button` without text, a bare icon with a `title` |
| Copy to clipboard | `CopyButton` | your own icon swap |
| An action that reads as a link inside text (a name in a sentence, "Add a note", a commit hash) | `LinkButton` (`accent`, `muted`, `inherit` for a path that keeps its text's colour until hovered) | an underlined `<button>` of your own |
| A small pill among others in a row: a filter the person turns on and off, a queued message, a pasted text, a picked model, a mentioned file | `Chip` (24 px; a toggle with `pressed`/`onPressedChange`, or `onRemove` with `removeLabel` around a label that may be a button, `onClick`, refused alone by `labelDisabled`; `tone="warning"` for a value in trouble; `labelAttrs`/`removeAttrs` reach the label and the ✕ for a roving row, `ref` the root; a row of chips sets mobile.css's `--hit-gap-x`/`--hit-gap-y` on its container) | a `rounded-full` button of your own, `Button size="sm"` as a toggle |
| A list of actions | `MenuButton` (⋯ menus), `ContextMenu` (right click, `anchorFromEvent`); both, like `Modal`, give focus back to the opener or, when the chosen item removed it, to what took its place in the same session tab (`focus-place.ts`; a tab switch hands focus to the new composer instead); an item's `tooltip` (a disabled item's `disabledReason`) is the kit Tooltip on hover and keyboard focus, and the item's muted last line in the touch action sheet; the arrows land on a disabled item that has a reason (it never fires) and skip one without | a hand-made popover of buttons, an item's words in a native `title` |
| A setting that applies at once | `Switch` (bare), `SwitchField` (settings-style row), `SwitchTile` (two-column grid; `infoEnd` puts its (i) after the switch where the rows around it end in theirs) | a checkbox |
| A choice applied on submit, or rows picked from a list | `Checkbox` (`indeterminate` for select-all), `Radio` | a raw `<input type="checkbox">` |
| One of 2–5 short values, applied at once (thinking level, approval, rotation) | `SegmentedChoice` (a radio group; `fit`, `selectOnArrow`, `id`) | `Tabs` (they switch views), hand-made `role="radio"` buttons |
| One of a few options that each need a line of explanation or a picture (an MCP server's transport, its scope, a theme) | `ChoiceCards` (a radio group of cards with a hint; one tab stop, arrows pick; a card's `preview` makes it a picture to pick, `tooltip` says more; `groups` splits one group into headed parts) | hand-made `role="radio"` cards |
| A numbered list a person answers by pointing or a number key (the agent's question, an approval) | `ChoiceList` (`mode` `action`, `single` radio group or `multi` checkboxes, `selected`, a row's `aside`, `description`, `tone="danger"`; ↑/↓ move, the surface around it maps 1–9; on a touch screen the numbers are not drawn, a choosing row's box shows ✓ while checked) | numbered buttons of your own |
| One value from ≤ ~15 fixed options | `Select` (native popup) | a custom dropdown |
| A long, searchable or rich list (models, sessions, branches) | a picker: `Modal size="picker" placement="top"` | `Select` |
| Text entry | `Input`, `TextArea` (auto-grow), `SearchField`; long documents `TextEditor` | a raw `<input>` |
| The label over a control that is not an `Input` (a `SegmentedChoice`, a model select, a group of checkboxes) | `FieldLabel` (`Input`'s label look; `as` `label` with `htmlFor` for a form element, `legend` in a `<fieldset>`, `span` with an `id` the radio group's `aria-labelledby` names) | a hand `text-sc-sm font-medium` label |
| A field the kit has no primitive for (a list of chips, a folder picked by a button) with its label, hint and error | `FieldShell` (`controlId` when the label names a form element, `labelId` for a group's `aria-labelledby`; its error is announced, `role="alert"`) | a label `htmlFor` an id nothing has, an error nobody hears |
| A picker's search over its result list | `SearchField` with `listbox` (the field is the list's combobox; rows are `OptionRow`, no tab stops) | rows the Tab key walks |
| Sibling views of one surface | `Tabs` (`underline` sections, `segmented` 2–4 modes or a row of steps, `pills` for things open side by side or, `orientation="vertical"`, a page's sections that are one row on a phone; each scrolls sideways when it does not fit; a tab takes `tooltip`, `leading`/`trailing` marks, `attrs` hooks, `keyshortcuts`, `onDoubleClick`, `className`, and `onClose` with `closeLabel` for a ✕ and Delete; `onChange` says `click` or `key`) | buttons that look like tabs, a `<nav>` of `aria-current` buttons for views |
| A table column the rows sort by | `SortHeader` (the `<th>` with `aria-sort` and the direction glyph; `direction`, `onSort`, `align`) | a header button with its own arrows |
| A row of a picker's listbox driven from its field (`aria-activedescendant`) | `OptionRow` (`active` highlight, `selected`, `size` `md`/`sm`/`xs` for a dense 28 px list) | a copied row class string |
| A group of those rows under its name (a provider, a category) | `OptionGroup` (`role="group"` named by `label`; the header is `SectionLabel`'s look with an optional `icon`, `count`, `action`, `sticky`) | a heading inside a listbox, a header class of your own |
| A navigable row (sessions, agents, providers, a side panel's files and branches, pull requests) | `ListRow` (one click target, actions on hover/focus; `size="sm"` the dense panel row; `titleLines`/`descriptionLines={2}`; a `secondary` line of parts; `accessibleName="row"` names the button by the whole row; `tooltip` says more in the kit Tooltip on hover, keyboard focus and a tap, and makes a row with no `onClick` one tab stop for it; a current row that cannot be pressed stays undimmed) | a copied row class string, a panel row button of your own, the row's words only in `titleText` (a native title) |
| A header that opens and folds what is under it (a diff file, an entry, an Advanced group) | `DisclosureButton` (`open`, `onToggle`; owns `aria-expanded`, the turning chevron and the focus ring; `chevron` `start`, `end` for a card head that ends in it, `none` for a row that cannot open) | a `<button aria-expanded>` with its own chevron swap |
| The body such a header opens and folds | `Collapse` (`open`; grows and shrinks its height on the motion tokens, unmounts when closed, instant where motion is off) | `{open && <Body/>}`, `<details>`, a `grid-template-rows` trick of your own |
| A list whose rows are added, removed or reordered while on screen | `useListMotion` (`hooks/use-list-motion.ts`; `data-flip-key` on each row: rows glide to their new places) and `usePresence` (a removed row leaves with its exit) | rows that jump, a per-list FLIP |
| An overlay's exit (menu, popover, sheet, dialog) | `useOverlayPresence(open, exitToken)` with the matching exit class (`omp-pop-out`, `omp-scale-out`, `omp-sheet-out`; docs/motion-design.md) | a surface that unmounts on close, a `setTimeout` matching a CSS duration |
| An overlay whose content is its own data (a completion menu, a paste choice: `null` while closed) | `useHeldOverlay` (`useHeldOverlay(value, exitToken)`: the last value stays drawn while it leaves) | an overlay that empties itself while fading |
| A surface its owner unmounts the moment a request is answered, with no state to hold it (the agent's prompt card) | `leaveGhost(element)` from its layout-effect cleanup (`lib/motion-play.ts`: an inert copy plays the exit where it stood) | a card that vanishes |
| A "show N more" control that disappears once the rest shows | `revealAndFocus` (`lib/reveal-focus.ts`: focus moves to the first revealed row; a list whose rows land in groups names it with `firstRevealed`) | a button that unmounts and drops focus on the page |
| A tree | `TreeView` | nested lists with your own keys |
| List beside detail, one pane on a phone | `MasterDetail`, `useMasterDetail`, `MasterDetailBack` (a page that lays out its own list) | your own two-column switch |
| A destination page | `PageLayout` | a page frame of your own |
| A small form, confirm or picker | `Modal` (focus trapped, Escape closes, footer primary last, Cancel `ghost`; it opens on the control it marks with `data-dialog-autofocus`, else its first text field, else the first control of its body that a key cannot change (never a select, switch, checkbox or radio), else the panel, never on the header's ✕; `data-dialog-nofocus` opts a control out; on close focus returns to the opener, or to what took its place when the dialog's action removed it) | a dialog from a dialog |
| "Yes, really" before something irreversible | `ConfirmDialog` (the safe `ghost` Cancel focused, the danger button the one fill) | `window.confirm` |
| Detail too big for a popover, smaller than a page | `Sheet` (`right`, `left` drawer, `bottom` action sheet, `full`; `closeButton={false}` when the footer has Cancel; first focus as `Modal`'s) | a Sheet over a Modal |
| Quick contextual controls by their trigger | `Popover` | a Modal |
| A label for an unspelled control | `Tooltip` (prefer `IconButton`, which wires it) | essential information only in a tooltip |
| A longer explanation of a row | `SettingInfo` (the (i) glyph), `splitDescription` | a paragraph under a label |
| A short status or count | `Badge` (`dot` + `pulse` while live; text says the state; `size="xs"` 16 px in a dense line, `truncate` for a long one; DOM attributes reach it) | a clickable badge, a `rounded-full` span of your own |
| A state as a coloured dot and its word (a device online, a task running) | `StatusDot` (`tone`; the word beside it, or `labelHidden` where the row already says it, `labelClassName`; `decorative` for the dot alone where the row says the state in words; `ring` hollow; `pulse`, on by default for `working`; DOM attributes reach it, no native title unless given) | a bare `size-1.5 rounded-full` span, colour with no word |
| A section heading: the small label over a group of rows or fields, or a content page's section title | `SectionLabel` (`size` `label`/`title`; `as` `h3`/`h4`/`div`, `count`, one group `action`) | a hand `text-sc-xs uppercase` heading, a hand `text-sc-md font-semibold` `<h3>` |
| A bordered frame around content inside a surface (a code box, a result, a table, a group of fields, a featured card) | `Card` (`padding` incl. `row`, `surface` incl. `code`/`elevated`, `radius` `md`/`lg`, `as` the element: `ul`, `dl`, `li`, `section`, `pre`, or `button` for a pressable card) | a copied `rounded-(--sc-radius-md) border border-(--sc-border-subtle)` |
| A file path or URL on one line (a tool's location, a repository root) | `PathText` (the middle gives way, the tail stays; the full text is the tooltip) | `truncate` on the whole path, which cuts the file name |
| A session's name on a surface (a row, a header, the title bar) | `SessionTitle` (`parts` from `lib/session-title.ts`: the name the person set, then ` · ` and the automatic title muted; the automatic part is cut first; `live` puts the working shimmer on the name) | `sessionDisplayTitle` rendered as a bare string, which drops the automatic title |
| A persistent condition of a surface | `Banner` (one sentence, ≤ 2 actions; `neutral` for a quiet notice, `icon`, `compact` for one quiet row, `dismissLabel`; DOM attributes and `ref` reach the row) | a toast |
| One part of a surface failed or is degraded | `InlineNotice` (with Retry; cause as `ErrorDetail`; `output` for the original text whole, a stderr; `ErrorDetail raw` alone for such a block) | stacked Banners, a hand-made mono error box |
| Brief feedback after an action | a toast (`stores/toast`, drawn by `ToastStack`) | a Banner |
| Nothing to show yet | `EmptyState` (with the fixing action; `md` a page or detail pane, `sm` a panel or dialog, `row` one line in a list of rows such as a Settings list) | a sentence alone, a settings row of your own |
| A read with loading, error, empty and data | `AsyncSection` | your own state precedence |
| Loading with a known shape | `Skeleton`, `SkeletonRows` | a spinner |
| Work with no shape | `Spinner` (still ring; `spin` only for an action just started) | a turning ring for content |
| Known progress or fullness | `ProgressBar` (`meter`, `progress`; `ariaValueText`, `animate={false}` for a per-frame level, `labelCase="keep"`); shares of one whole in one bar with `segments` (`{ value, label, tone \| color }`, `total`; with `value` it is a progressbar of the whole) | a hand-drawn bar, a row of coloured spans |
| A keyboard shortcut | `Kbd`, or `shortcut` on `Tooltip`/`IconButton` | shortcuts baked into labels |
| The keys a picker answers to, at the foot of its list | `KeyHints` (`hints` of `{ keys, label }`, `children` for an action that ends the row; nothing on a touch screen) | a hint row of your own, a picker that hides its keys |
| A panel fed by free-form data | `PanelErrorBoundary` (the app root alone has `RootErrorBoundary`) | an unguarded subtree |
| Back to the newest row of a scrolled transcript | `JumpToLatest` | another floating button |
| An image that opens full size | `ZoomableImage` | your own viewer |
| Content that zooms with two fingers on a touch screen (an opened file) | `PinchZoomArea` | the browser's page zoom (the page never zooms) |
| Ages, costs, account usage | `TimeAgo`, `CostAmount`, `UsageGauges` | formatting them again |
| Work going on | `LiveText`/`LiveSweep` (`LiveShimmer`), `WorkingArc` | a new animation |
| Text that changes in place (an automatic title evolving) | `SwapText` (`scope` names what it belongs to) | a fade of your own |
| A title editor's ask-for-a-title button | `AutoTitleButton` | a sparkle button of your own |
| A code a phone camera reads (pairing) | `QrCode` (drawn locally, never by an image service) | an image URL |
| The app's mark | `BrandMark` | an inline copy of the π |
| The UI language switch | `LangSwitcher` | a language select of your own |

## Layer plumbing

For a layer the kit does not draw itself (a full-screen takeover, a custom dropdown, the composer's own sheet). Reach
for `Modal`, `Sheet` or `Popover` first; these give a surface the same behaviour when it cannot be one of them.

- `useModalLayer` (`open`, `panelRef`, `onClose`): what `Modal` and `Sheet` do for their panel (topmost layer, the
  first focus above, the Tab trap, Escape when topmost, focus back to the opener, the touch guard, the back gesture).
- `registerDialogLayer` and `isTopmostDialog` (each takes the layer's element): put a floating list or menu on the
  layer stack, so an Escape or a key handler of the layer beneath defers to it.
- `popoverTabStops`, `tabOutOfPopover` and `isTabbable`: a non-modal popover's Tab order (Tab past its last control
  closes it and moves on from its anchor).
- `PopoverSurface`: the popover's panel look, for a popover laid out by its owner.
- `SheetHandle`: a bottom or left sheet's drag grabber (pulling it toward the edge dismisses).

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
- Say the state the control has. A row whose detail shows beside or under the list (Memory's pages, a changed file,
  a `/copy` target) is the list's current item: `aria-current="true"`, which `ListRow` sets from `selected` and
  Memory's rows draw from. `aria-pressed` is for a toggle the person turns on and off (a filter
  chip, a held modifier key, a pause); on a row a screen reader reads it as "toggle button, pressed". A picker row
  driven from its field is an `OptionRow` (`aria-selected`).
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
