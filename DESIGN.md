---
name: SIMM
description: Schedule I Mod Manager. A calm, dense desktop utility in the dark navy "modern-blue" identity.
colors:
  background: "#0f141d"
  chrome: "#151d2a"
  panel: "#1a2433"
  sunken: "#101824"
  raised: "#1a2434"
  raised-hover: "#27354c"
  hover-wash: "rgb(237 244 255 / 0.05)"
  pressed-wash: "rgb(237 244 255 / 0.09)"
  line: "#243246"
  line-strong: "#2b3950"
  line-input: "#2b3a50"
  text: "#edf4ff"
  text-secondary: "#9aabc6"
  text-tertiary: "#8696ae"
  accent: "#4e8ad9"
  accent-fill: "#3865a1"
  accent-fill-hover: "#4377bc"
  accent-text: "#71a2e3"
  accent-soft: "rgb(78 138 217 / 0.15)"
  accent-line: "rgb(78 138 217 / 0.55)"
  on-accent: "#ffffff"
  ok: "#3da571"
  ok-text: "#79bd9a"
  warn: "#c7a340"
  warn-text: "#d1b877"
  danger: "#cc6767"
  danger-text: "#d98f90"
  danger-solid: "#924848"
  info: "#3f9dc0"
  info-text: "#76b5d2"
  runtime-il2cpp: "#4e8ad9"
  runtime-mono: "#d28740"
  scrim: "rgba(10, 15, 24, 0.78)"
typography:
  display:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
    fontFeature: "'cv11', 'ss01'"
  headline:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "'cv11', 'ss01'"
  title:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    fontFeature: "'cv11', 'ss01'"
  body:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'cv11', 'ss01'"
  body-sm:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'cv11', 'ss01'"
  label:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
    fontFeature: "'cv11', 'ss01'"
  micro:
    fontFamily: "'Geist Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.1
    fontFeature: "'cv11', 'ss01'"
  mono:
    fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', ui-monospace, monospace"
    fontSize: "0.92em"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-fill-hover}"
  button-play:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 1.25rem"
    height: "2.25rem"
  button-secondary:
    backgroundColor: "{colors.raised-hover}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.text}"
  button-destructive:
    backgroundColor: "transparent"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-danger-solid:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2rem"
  button-small:
    typography: "{typography.label}"
    padding: "0 0.5rem"
    height: "1.75rem"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    height: "2rem"
  tab-line:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
    padding: "0 0.75rem"
    height: "2.5rem"
  tab-line-active:
    textColor: "{colors.text}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 0.75rem"
    height: "2.125rem"
  nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.text}"
  table-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "0.5rem 0.75rem"
    height: "2.5rem"
  table-row-selected:
    backgroundColor: "{colors.accent-soft}"
  tag:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 0.4rem"
    height: "1.25rem"
  callout:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1rem"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
  inspector:
    backgroundColor: "{colors.chrome}"
    padding: "1rem"
    width: "22rem"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    width: "34rem"
  toast:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    width: "22rem"
  status-bar:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    height: "1.75rem"
---

# Design System: SIMM

<!-- Recorded from the built redesign (src/styles/foundation.css and the per-surface sheets). Colour values above are the built-in modern-blue theme; every derived value is computed at runtime from the theme API variables, so other themes re-derive them. foundation.css is the source of truth when the two disagree. -->

## Overview

**Creative North Star: "The Quiet Workbench"**

SIMM is a tool people open right before they play, and again when something breaks. The redesign keeps the incumbent modern-blue identity on purpose (maintainer decision: recognition over reinvention): dark navy-graphite surfaces, one blue accent, the app icon, the sidebar-plus-workspace shell. What changed is execution. Every surface is built from one token system and one primitive vocabulary, density is that of a desktop utility rather than a web dashboard, and each screen leads with the next safe action while developer depth sits one tab away.

The world is flat and tonal. Regions separate by a step in surface tone and a 1px line, never by shadow; shadows exist only on things that float above the page (dialogs, popovers, toasts). Colour is spent sparingly: the accent marks the primary action, the current selection and focus, and the four status hues carry meaning only. Data carries the UI: lists, tables, key/value facts and inspectors come before cards.

Confirmed visual rejections (PRODUCT.md brand commitments): no landing-page heroes, bento grids, feature-card grids, glows, decorative gradients, or emoji in UI copy.

**Key Characteristics:**
- Dark navy-graphite tonal stack: background, chrome, panel, sunken, each one step apart.
- One blue accent, deepened for fills so white labels pass 4.5:1 on every theme.
- Fixed rem type scale (11 to 22px) in Geist, monospace only for data.
- 4px spacing grid; 32px controls, 40px rows, 28px status bar.
- Flat at rest; shadows only on overlays.
- One status per object (dot + word), compact outlined tags for runtime and source.
- Derived from the theme API, so built-in and custom themes restyle the whole app.

## Colors

A cool, low-chroma navy neutral stack with a single mid-blue accent and four muted status hues; everything except the neutrals is rare.

### Primary
- **Workbench Blue** (`accent`): the theme's `--primary-btn-color`. Used raw only for thin marks: the 2px active-tab underline, focused field borders, the focus ring line (`accent-line`, 55% alpha).
- **Deep Workbench Blue** (`accent-fill`, hover `accent-fill-hover`): the accent mixed 80% (90% on hover) with black in OKLab. Fill of the one primary button per surface, checked switches, the status-bar app-update pill. White label on it is about 5.9:1 in modern-blue.
- **Lifted Blue** (`accent-text`): the accent mixed 78% toward the text colour. Accent-coloured text and icons: active sidebar icon, active tab icon, link buttons, "update available" notes.
- **Blue Wash** (`accent-soft`, 15% alpha): background of the selected sidebar item, selected environment, selected table row.

### Neutral
- **Night Desk** (`background`): app background and workspace canvas (`--app-bg-color`).
- **Chrome Navy** (`chrome`): title bar, sidebar, status bar, inspectors, launch-feedback strip (`--header-bg-color`).
- **Panel Slate** (`panel`): bounded panels, the Home environment list, dialogs, popovers, menus, toasts, sticky table headers (`--card-bg-color`).
- **Well** (`sunken`): field backgrounds, callouts without tone, dialog option rows (`--input-bg-color`).
- **Raised** / **Raised Hover** (`raised`, `raised-hover`): secondary button fill and the neutral count pill (`--btn-secondary-bg`, `--btn-secondary-hover`).
- **Hover Wash** / **Pressed Wash**: the text colour at 5% / 9% alpha. The universal hover for rows, nav items, ghost buttons and menu items, so hover works on any surface and any theme.
- **Hairline** (`line`): default 1px separators: header bottoms, sidebar edge, tab rail, table row lines (at 70%), dialog header/footer rules.
- **Strong Hairline** (`line-strong`): borders of things you can act on or that float: secondary/outline buttons, tags, popovers, dialogs, toasts.
- **Input Hairline** (`line-input`): field borders.
- **Paper White** (`text`), **Fog** (`text-secondary`), **Slate Fog** (`text-tertiary`): primary copy; secondary copy, inactive tabs and nav labels, meta lines; table headers, kv labels, separators and timestamps. In modern-blue, text-tertiary still clears 5:1 on the panel.

### Status
Each status has a base hue (from the theme's `--badge-*` variables) used for dots and tints, a `-text` variant mixed toward the text colour for legible words, and a `-soft` 14% tint for backgrounds.
- **Ready Green** (`ok`): "Ready", successful operations.
- **Update Amber** (`warn`): game and mod updates, attention counts, warnings. The most frequent status in practice.
- **Fault Red** (`danger`): folder missing, needs attention, failed scans, destructive actions. `danger-solid` (danger mixed 78% with black) appears only on the confirm button inside a destructive dialog.
- **Signal Cyan** (`info`): downloading, background work, informational callouts.
- Muted (text-tertiary dot): not installed, unknown.

### Runtime tags
- **IL2CPP Blue** (`runtime-il2cpp`, theme `--badge-blue`) and **Mono Orange** (`runtime-mono`, theme `--badge-orange`). Used only as the outline and text of the runtime tag (55% alpha border, text mixed 72% toward the text colour), never as fills or status.

### Named Rules
**The Three Jobs Rule.** The accent marks the primary action, the current selection, and focus. Nothing else: no accent headings, accent icons in content, or accent borders on panels.

**The Meaning-Only Rule.** Status hues appear only when they report a state. A green or amber element that is not a status, tag or callout is a defect.

**The Derived-Not-Declared Rule.** Surfaces never hard-code a colour. They read `--simm-*` tokens, and those derive from the theme API (`--app-bg-color`, `--primary-btn-color`, `--badge-*` ...). A literal hex in a surface stylesheet breaks light and custom themes.

## Typography

**Body Font:** Geist Variable (with Segoe UI Variable, Segoe UI, system-ui, sans-serif), stylistic sets `cv11` and `ss01` on.
**Mono Font:** Cascadia Code (with Cascadia Mono, Consolas, JetBrains Mono, ui-monospace), set at 0.92em of its context.

**Character:** One neutral grotesk does all the work at small, steady sizes; weight (400/500/600) and the three text tones carry hierarchy, not size jumps. Monospace is a material for data, not a style.

### Hierarchy
- **Display** (600, 1.375rem/22px, 1.2, -0.015em): the Home heading ("3 installs need attention") and large empty states. One per screen at most.
- **Headline** (600, 1.125rem/18px, 1.25, -0.01em): workspace and environment titles in the page header; the selected environment's name on Home.
- **Title** (600, 1rem/16px, 1.3): dialog titles, empty-state titles, the primary Play label on Home.
- **Body** (400 to 600, 0.875rem/14px, 1.45): base size of the app: rows, sidebar items, environment names, dialog messages (line-height 1.55 there).
- **Body small** (400 to 500, 0.8125rem/13px): secondary copy, meta lines, buttons, fields, tabs, callouts, toasts, section titles (600, text-secondary).
- **Label** (500, 0.75rem/12px): table headers, tags, small buttons, status bar, the sidebar "Environments" heading. Sentence case, no tracking.
- **Micro** (600, 0.6875rem/11px): count pills and dense diagnostic paths only.
- Release-note summaries clamp at 2 lines; empty-state copy is capped at 42ch.

### Named Rules
**The Fixed Scale Rule.** Type sizes come from the seven `--simm-text-*` steps in rem on a 16px root. No `vw`, no `clamp()`, no root-font scaling at 1440p or 4K; the layout must look the same at 1080p, 1440p and 4K.

**The Mono-Is-Data Rule.** Monospace only for things a user might copy or compare character by character: paths, version numbers, log lines, config keys and raw config, hashes, IDs. Never for labels, headings or decoration. Tables and `.ui-num` use tabular numerals instead of mono.

**The No-Eyebrow Rule.** No uppercase tracked kickers above titles. A section is named by a sentence-case `section title` (13px, 600, text-secondary) that is the name of the block, not a category label.

## Layout

The shell is a fixed desktop frame: a 36px title bar (`chrome`, brand icon + "SIMM Schedule I Mod Manager", drag region, window controls), a sidebar of 14.5rem (232px, collapsible to a 3.5rem icon rail showing environment initials), the workspace, and a 28px status bar. Toasts float bottom-right above the status bar; the game-launch feedback strip sits inline above the status bar and lifts toasts above it.

The sidebar holds, top to bottom: primary destinations (Home, Mod Library with count, Profiles, Saves), the Environments list (status dot, name, "runtime · status" meta line, add button), and a secondary group pinned to the bottom behind a hairline (Accounts, Telemetry, Help, Settings, Collapse).

Every workspace uses one page anatomy: a page header (min 56px; title + subtitle or meta line on the left, the surface's actions on the right), optional line tabs, then a body that owns its own scroll with 20px padding. The environment workspace is the reference: header with name, one status, meta line (runtime tag · source · game version · MelonLoader) and the Play button, then the tabs Overview, Mods, Plugins, UserLibs, Config, Logs. List surfaces use a split view: list on the left, a 18 to 22rem inspector on the right.

Home is a single column capped at 64rem with 24/32px padding: the selected environment leads as a taller row (88px, 18px name, large Play), the others follow in one bordered list of 56px rows (identity, status, one next-step button, Play), and release notes sit underneath as quiet reading (max 44rem).

Spacing is a 4px grid (`--simm-space-1..8`: 4, 8, 12, 16, 20, 24, 32px). Typical rhythm: 8px between controls in a toolbar or footer, 12 to 16px inside panels and callouts, 20px workspace gutters, 24px between Home sections. Fixed heights: controls 32px (small 28px, Play 36px), table rows 40px, line tabs 40px, nav items 34px, sidebar environments 44px.

Responsiveness is by container query on the workspace (`container-type: inline-size` on the workspace main, environment body and Home), so a collapsed sidebar or narrow window reflows content rather than the shell. Home drops the status column below 44rem; dialogs stack their actions below 40rem and pin to the top below 42.5rem of height.

## Elevation & Depth

Flat by default. Depth is tonal: background, then chrome and panel one step lighter, with sunken wells for fields. Separation is a 1px line. Shadows appear only on elements that leave the page plane.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 16px 40px rgb(0 0 0 / 0.36), 0 2px 8px rgb(0 0 0 / 0.22)`): dialogs and toasts.
- **Popover** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.3), 0 1px 3px rgb(0 0 0 / 0.2)`): select menus, dropdowns, context menus, popovers, the downloads panel.
- **Focus ring** (`box-shadow: 0 0 0 2px <background>, 0 0 0 4px <accent-line>`): every focusable control; fields instead shift their border to the accent and add a 3px `accent-soft` halo. Rows focus with an inset 2px `accent-line` ring.
- **Scrim** (`scrim`): flat dimming behind dialogs, no backdrop blur.

### Named Rules
**The Overlays-Only Shadow Rule.** If it does not float above the page, it has no shadow. Panels, rows, cards, buttons and the Home list are flat.

## Shapes

Gently rounded, small radii that read as a desktop tool: 4px (`sm`) for tags, status-bar buttons, menu items and skeletons; 6px (`md`) for buttons, fields, nav items, callouts and option rows; 8px (`lg`) for panels, the Home list, dialogs, popovers and toasts. Full pills (999px) only for count badges, status dots and scrollbar thumbs. The active tab underline is a 2px bar with 2px top corners. Borders are always 1px; the only dashed border is the Home empty state.

## Components

### Buttons
Restrained and compact; weight comes from fill, not size.
- **Shape:** gently rounded (6px), 32px tall, 12px side padding, 13px/500 label, icon gap 6px.
- **Primary:** `accent-fill` with white label, hover `accent-fill-hover`. One per surface: the action the surface exists for (Play, Install to..., Save). The environment Play is 36px with 20px padding at 14px/600; the Home lead Play is 40px at 16px.
- **Secondary:** `raised-hover` fill with a `line-strong` border; the default for every other labelled action (Review Updates, Update Game, Cancel).
- **Outline:** transparent with a `line-strong` border, hover wash; secondary weight on busy surfaces (tool rows).
- **Ghost:** transparent, text-secondary, hover wash; toolbars, icon buttons (32px square, 28px small), page-header links like "Find Mods".
- **Destructive:** quiet: transparent, danger-text label, danger border at 45% alpha, `danger-soft` on hover. It lives in a danger zone. **Danger solid** (`danger-solid`, white label) exists only as the confirm button of the dialog that performs the destruction.
- **Small:** 28px, 8px padding, 12px label. Disabled at 45% opacity, no pressed transform.
- Legacy `.btn*` classes and the shadcn `data-variant` buttons resolve to this same vocabulary.

### Fields
- **Style:** `sunken` background, 1px `line-input` border, 6px radius, 32px min height, 13px text, text-tertiary placeholder.
- **Focus:** border turns `accent`, plus a 3px `accent-soft` halo. No glow.
- **Switches:** checked = `accent-fill` with a white thumb; unchecked = 16% text wash with a `line-strong` inset ring.
- **Menus/popovers:** `panel` surface, `line-strong` border, 8px radius, popover shadow; items 32px, 4px radius, hover wash, danger items in danger-text.

### Page header
Title (headline) with an optional subtitle or meta line, actions right-aligned, 12/20px padding, a hairline underneath. In the environment workspace the title row also carries the environment's one status, and the meta line carries the runtime tag.

### Environment header and line tabs
- Name, status, meta line, and Play on the right, then a tab rail with a hairline bottom.
- **Line tabs:** 40px tall, 13px/500, text-secondary with a muted icon. Hover lifts text to `text`. Active: text `text`, icon `accent-text`, and a 2px `accent` underline inset 8px from the tab edges sitting on the rail. Counts sit in an 11px pill (neutral `raised-hover`, or `warn-soft` / `warn-text` when they ask for attention, e.g. mod updates).
- The same line tabs drive library modes and other workspace sections.

### Sidebar navigation
- Items 34px, 6px radius, 14px/500 text-secondary with a 16px icon. Hover: wash + `text`. Active: `accent-soft` wash, `text` label, `accent-text` icon. Counts use the same pill as tabs.
- Environment entries: status dot (8px, the status base hue), name (14px/500) over a 12px tertiary meta line; active entry gets the blue wash.

### Table rows
- Sticky header row 32px on `panel`, 12px/500 text-tertiary labels, left aligned.
- Rows 40px (library rows 52px for two-line content), 8/12px cell padding, a 70%-alpha hairline between rows, tabular numerals. Hover: wash. Selected: `accent-soft`. Keyboard focus: inset 2px `accent-line` ring.
- A row shows one status and its tags inline; actions for the selected row live in the inspector, not in every row.

### Inspector
`chrome` surface on the right of a split view (18 to 22rem), 1px left hairline, 16px padding, sections 20px apart, each named by a section title and built from key/value facts (12px tertiary labels, 13px values, wrap anywhere), a meta line, and the actions for the selected object. Destructive actions go last, in the danger zone.

### Status
One per object: an 8px dot in `currentColor` and a 13px/500 word ("Ready", "4 mod updates", "Game update · 5 mod updates", "Not installed", "Folder missing", "Downloading"), toned ok / warn / danger / info / muted with the `-text` colours. The same summary appears in the sidebar, on Home and in the environment header. Replaces badge clusters.

### Tag
Compact metadata: 20px tall, 4px radius, 1px `line-strong` outline, 12px/500 text-secondary, no fill. Variants: runtime IL2CPP (blue outline/text), runtime Mono (orange outline/text), ok (outline only), warn and danger (outline plus soft tint, e.g. "0.4.2b4 available").

### Meta line
A single line of facts separated by middle dots in text-tertiary ("by TylerMods · Thunderstore · IL2CPP + Mono · v2.0.4"), 13px text-secondary, 16px gaps. A separator that would start a wrapped line is clipped; a status inside a meta line gets no separator.

### Callout
A message that needs reading: 12/16px padding, 6px radius, 13px text. Neutral = `sunken` with `line-strong` border; info, warn and danger use the status's 14% tint and a 40 to 45% status border. Tone sits on the whole box, never on a side stripe.

### Empty state
Centered column, 32/24px padding: title (16px/600), one or two lines of copy (13px, max 42ch, text-secondary), and the one action that fills the area. On Home the empty list uses a dashed `line-strong` border.

### Danger zone
Destructive actions sit apart: a hairline rule above, 16px top padding, a short heading and one-sentence consequence on the left, the quiet destructive button on the right ("Delete Environment").

### Dialogs
- One anatomy: header (min 52px; 16px/600 title, optional tone icon and meta line, 28px close button), body (20px padding, 16px gaps, 14px text-secondary message at 1.55), footer (12/20px padding, hairline above, actions right-aligned: Cancel/secondary left of the primary).
- `panel` surface, `line-strong` border, 8px radius, overlay shadow over a flat scrim. Width 34rem by default (30rem nested, 38rem runtime prompts), top-anchored at 5rem; message and confirm dialogs are centered.
- Destructive confirms name the object and the consequence and use the danger-solid button; options (e.g. "Also delete game files from disk") are `sunken` option rows with the affected path in mono.

### Toasts
Bottom-right, 16px from the edge, above the status bar, 22rem wide. `panel` surface, `line-strong` border, 8px radius, overlay shadow. Title (14px/600), a short body (13px text-secondary, bold object names in `text`), at most two actions (secondary + primary), and a ghost dismiss icon. Danger notices tone only the border and the title. Game launch feedback is an inline `chrome` strip above the status bar, not a toast.

### Status bar
28px `chrome` strip with a top hairline, 12px text-secondary. Left: downloads button (spinner + "3 downloading" in info-text when active, opens the downloads popover above it), install count, attention stats in warn-text ("1 Game needs updating", clickable), last check with a refresh icon, online state. Right: app version in tabular numerals, and an `accent-fill` pill when an app update is available.

## Do's and Don'ts

### Do:
- **Do** build new surfaces from the foundation primitives (page, page header, toolbar, line tabs, panel, section title, table/row, split + inspector, kv, status, tag, meta line, callout, empty state, danger zone) before writing a new class; extend with a modifier.
- **Do** use exactly one primary (`accent-fill`) button per surface: the action the surface exists for. Everything else is secondary, outline or ghost.
- **Do** keep destructive actions quiet (outlined danger-text) and apart in a danger zone; reserve solid red for the confirm button of the dialog that performs the destruction.
- **Do** give every object one status (dot + word) and put runtime/source in outlined tags on a meta line.
- **Do** read colours only from `--simm-*` tokens and keep them derived from the theme API so light, dark, modern-blue and custom themes all work.
- **Do** use the fixed rem type steps (11, 12, 13, 14, 16, 18, 22px) and the 4px spacing grid.
- **Do** separate regions with tone and a 1px line; give shadows only to dialogs, popovers and toasts.
- **Do** verify a visual change with the screenshot harness at both 1600x1000 and 1280x800 before calling it done.

### Don't:
- **Don't** add eyebrows or uppercase tracked kickers above titles; name a block with a sentence-case section title.
- **Don't** build stat tiles, KPI rows or dashboard number cards; counts belong in a status, a tab count, or the status bar.
- **Don't** nest panels or put cards inside cards; a panel is one bounded region with one job.
- **Don't** use coloured side stripes (thick left borders) to mark tone or selection; tone goes on the whole callout, selection is the blue wash.
- **Don't** size type with `vw`, `clamp()` or root-font scaling at desktop breakpoints.
- **Don't** use monospace for labels, headings or decoration; mono is for paths, versions, logs, config and IDs.
- **Don't** use landing-page heroes, bento or feature-card grids, glows, decorative gradients, or emoji in UI copy.
- **Don't** use status hues decoratively or the accent for anything but the primary action, selection and focus.
- **Don't** hard-code hex values in surface stylesheets.

## Theming contract

Themes stay a runtime API. `src/utils/theme.ts` applies a built-in theme (light, dark, modern-blue) as inline custom properties on `<html>`, then layers a custom theme's `variables` over it (`baseTheme` picks which built-in sits underneath). The foundation reads only these inputs; every other `--simm-*` value is derived from them with `color-mix()`:

| Theme variable | Foundation token | Role |
|---|---|---|
| `--app-bg-color` | `--simm-bg` | app background |
| `--header-bg-color` | `--simm-chrome` | title bar, sidebar, status bar, inspector |
| `--card-bg-color` | `--simm-panel` | panels, dialogs, menus, toasts |
| `--input-bg-color` | `--simm-sunken` | fields, wells |
| `--btn-secondary-bg` / `--btn-secondary-hover` | `--simm-raised` / `--simm-raised-hover` | secondary button, count pills |
| `--border-color` / `--card-border-color` / `--input-border-color` | `--simm-line` / `--simm-line-strong` / `--simm-line-input` | hairlines |
| `--app-text-color` / `--text-secondary` / `--text-tertiary` | `--simm-text` / `-2` / `-3` | text tones; hover/pressed washes |
| `--primary-btn-color` | `--simm-accent` | accent and all accent derivatives |
| `--badge-green` / `-yellow` / `-red` / `-cyan` | `--simm-ok` / `warn` / `danger` / `info` | status hues and their text/soft variants |
| `--badge-blue` / `--badge-orange` | `--simm-runtime-il2cpp` / `--simm-runtime-mono` | runtime tags |
| `--modal-overlay` | `--simm-scrim` | dialog scrim |

A custom theme that sets only these variables restyles the whole app. Accent fills are deepened automatically so white labels stay legible; status text is mixed toward the theme's text colour so it stays readable on light themes. Other theme variables still set by `theme.ts` (`--primary-btn-hover`, `--bg-gradient`, `--bg-pattern`, `--info-box-*`, `--warning-box-*`, `--theme-workspace-*`, `--update-version-*`) feed only residual legacy styles and are not part of the contract for new work. shadcn/base-ui tokens (`--background`, `--primary`, `--ring`, ...) are mapped onto the same `--simm-*` tokens in foundation.css, so primitives under `src/components/ui` follow the theme too.

## Verifying with the screenshot harness

`node .design-harness/shoot.mjs [filter]` starts (or reuses) the Vite dev server on :1420, injects the Tauri mock, and screenshots every reachable screen (home, environments, dialogs, wizard, library, mods, logs, config, profiles, saves, telemetry, accounts, help, settings, welcome ...) into `.design-harness/shots/<viewport>/NN-<screen>.png`. Defaults: viewports `1600x1000,1280x800`; theme modern-blue. Useful variables: `SHOTS_THEME=light|dark|modern-blue` to check the theming contract, `SHOTS_VIEWPORTS` for 1080p/1440p/4K checks, `SHOTS_PLATFORM`, `SHOTS_OUT`. A filter (substring, comma list, or `/regex/`) shoots only matching screens and keeps the rest of the folder. Check every changed surface in at least modern-blue and light, at both default viewports.
