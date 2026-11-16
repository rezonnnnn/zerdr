# Zerdr

An "OEM plus" take on Herdr in the threads style: the stock Herdr experience, kept as it is and refined. Every tab is a thread. A left sidebar lists threads by machine and project, the agents working right now get their own cards, and a slim header names the thread you are in. A slow mesh gradient at the top of the sidebar reflects how all your threads are doing at a glance. The terminal sits alone in a rounded card on black.

![Zerdr](preview.png)

## What you see

Left to right: a 272 px sidebar (`chrome` `#141416`, not draggable), then the work column on `canvas` black. No system title bar.

**Sidebar, top to bottom**

| Block | Size | Shows |
|---|---|---|
| Header (`zerdr-viz`) | 60 px, window drag | Mesh gradient: five soft blobs (blue, indigo, teal, violet, black at 55%) drifting over `#2a5fb0`, with grain on top. 2 px chrome bands fade it into the sidebar from 18 px down. One 28 px round frosted toggle (chrome at 60%, 1 px `#FFFFFF1F` ring, `panel-left` icon), vertically centred, 16 px from the right |
| Threads (`zerdr-sidebar`) | starts at 200 px, min 60 | Search field with New project (folder-plus) and New thread (square-pen) buttons. Then groups: machine ("This computer" first, then remotes by name) › project (folder icon, name, thread count, fold chevron) › thread rows. Each row is a two-line card (t3code style): on top, the breadcrumb (`monitor` icon, or `server` and the machine name if remote, `›` in `idle`, project in `muted`) with time worked as plain text at the right; below, the title (13 px; semibold until opened) with a state dot at the right. The 8 px dot is `working` teal when the thread finished and red `#ef4444` when it needs you. Bright until you open the thread, then it fades over 1.2 s to 30% and stays. Archived threads go in a folded "Archived" section at the bottom |
| Working (`zerdr-agents` part `list`) | starts at 150 px, min 60, sizes itself to its rows | "Working N" heading, then one card per thread with a busy agent. Each card has the same layout as a thread row: breadcrumb and time worked on top, title with the spinner at its right below. Working cards recede: the title is `muted` (medium weight) and the breadcrumb line is at 60%, while the spinner stays full `working` teal. The shown thread's card fills `selected` `#1d242d`. Sub-agents are listed under their thread, indented 22 px on an elbow connector, with their own marker on the left |
| Fill | flex | empty |
| Footer (`zerdr-agents` part `footer`) | 84 px | Status dot with halo plus "N threads working", an amber "N needs you →" link that jumps to that thread (only when there is one), a settings button, then key hints: `Ctrl + Tab next`, `F2 rename` |

**Work column**

- **Header (`zerdr-header`), 60 px, window drag:** a breadcrumb `machine / project / thread` (thread title semibold `foreground`, the rest `dim`), then a branch chip (branch icon + branch, or the worktree folder name). On the right are five 28 px round icon buttons (Files, Changes, Split, Archive, Commands), a divider, and the window buttons (minimise, maximise, close) where the system draws none.
- **Body:** padding 8 / 12 px, gap 12 px. The active tab's panes are drawn as cards: radius 12, 1 px `#ffffff0a` border, `#ffffff14` when focused, 8 px gap, framed even when alone. Terminal padding is 14 / 12 px.
- **Right panel, 340 px (280–900), hidden by default:** a stack with Files (`zerdr-files`: a lazy file browser with read-only previews and rendered Markdown) and Changes (`zerdr-changes`: git diff with stage and commit).

**Look:** base theme `ink`, with these overrides: `chrome #141416`, `canvas #000000`, `raised #151a21`, `selected #1d242d`, `border #23262c`, `foreground #eeeeef`, `muted #b4b7bd`, `dim #8a8f98`, `accent #06b6d4`, `working #14b8a6`, `blocked #f5b83d`, `done #d1d1d6`, `idle #6e6e73`. The UI font is Inter (bundled in `mods/zerdr-sidebar/fonts/`, SIL OFL).

## How it behaves

- **Status markers** are the same everywhere: working = teal braille spinner (10 frames, 80 ms); waiting on sub-agents or background shells = the same spinner; blocked = amber dot in a soft amber halo; done = green `circle-check`; idle = 9 px hollow ring. The threads list uses the state dots described above in place of these markers.
- **Gradient header** follows all your threads together. It drifts at half speed when nothing is working, and an amber layer fades in (1.2 s) when any thread needs you. It uses native loops and transitions only, no timers.
- **Sidebar toggle** (button or `Ctrl+Shift+B`) collapses the sidebar to a 44 px rail (76 px on macOS) that keeps the toggle and the status markers. The content slides out its full width to the left (200 ms, ease-in), the sidebar resizes once (so the terminal reflows once), and on expand the content slides back in (260 ms, ease-out). The offset sits on an inner element: Herdr ignores `left` on a mod's root. The last width is remembered.
- **Thread rows and cards:** click focuses the thread. Hovering a row offers Rename (F2) and Archive. Archive settles the tab, and opening an archived thread brings it back (Unarchive on hover too). `Ctrl+Tab` / `Ctrl+Shift+Tab` and `Alt+]` / `Alt+[` step through threads. New rows slide in from above, and the selected row gets a short 2 px accent stamp on its left edge.
- **Time worked** adds up each thread's working runs (stored per machine in the mod's localStorage and shared as `threads.worked`). Fresh installs show "Not started" until a thread works.
- **New thread** (`Ctrl+Shift+T` or square-pen) opens a 540×400 dialog with an agent rail on the left (detected installed agents) and project search on the right. Tab / Shift+Tab switch sides, arrows pick, Enter starts, `Alt+W` gives the thread its own git worktree (via the shipped `worktree` mod), Esc clears then closes. The agent you last started with is the default.
- **New project** (folder-plus) opens a 340×236 dialog: a name and/or a folder, then Create (`space.new`). The project is saved (shared `projects`), so it stays listed after its space closes.
- **Header buttons:** Files and Changes toggle the right panel and its tab, Split splits the pane, Archive settles the thread, and Commands opens the palette. Clicking the thread title renames it.

## Built from

- `layouts/Zerdr.json`: root row → `sidebar` column [`viz` block (`zerdr-viz`, 60 px) · `threads` (`zerdr-sidebar`, 200 px) · `agents` (`zerdr-agents` `{part:"list"}`, 150 px) · `sidebar-fill` (weight 1) · `sidebar-foot` (`zerdr-agents` `{part:"footer"}`, 84 px)], `work` column [`header` (`zerdr-header`, 60 px) · `work-body` row [`main` (active tab, pane cards) · `panel` column (hidden) → `panel-body` stack [`files` (`zerdr-files`) · `changes` (`zerdr-changes`)]]].
- Overlays: `zerdr-new-thread`, `zerdr-new-project`, plus the shipped `worktree`.
- `keys.json` (section `layout:Zerdr`): `ctrl-shift-t` `mod.open:zerdr-new-thread`, `ctrl-shift-b` `zerdr-viz.toggle`, `ctrl-tab`/`alt-]` `zerdr-sidebar.next`, `ctrl-shift-tab`/`alt-[` `zerdr-sidebar.prev`.
- Shipped Herdr icons used by path: `mods/workspace-chrome/*.svg` (archive, check, chevrons, circle-check, folder, monitor, panel-left, search, server, settings, square-pen, x), `mods/pane/close.svg`, `mods/tabs/win-min.svg`, `mods/tabs/win-close.svg`.
- Commands: `layout.resize`, `layout.show`/`hide`/`select`, `tab.select`/`rename`/`settle`/`unsettle`, `tab.new`, `space.new`, `space.select`, `agent.focus`, `terminal.peek`, `pane.split`, `app.palette`, `app.settings`, `window.*`.
- Shared keys: `sidebar.width`, `sidebar.collapsed`, `sidebar.phase` (the same ones `workspace-chrome` uses), `threads.worked`, `projects`.
- `press.js` is the same file in four mods (press feedback for buttons), because mods can't import from each other.
- `zerdr-files` and `zerdr-changes` started as clones of Herdr's shipped `files` and `changes`.

## Watch out

- **Programs it runs**, all where the thread is (on its machine):
  - `zerdr-sidebar` runs `hc read` on agent terminals to spot background shells.
  - `zerdr-files` runs `git rev-parse` / `git status` (`--no-optional-locks`, fsmonitor off) and `sh` or PowerShell to list folders.
  - `zerdr-changes` runs `git status` / `diff`, plus `git add` / `rm` / `commit` when you stage or commit.
  - Clicking a web link in a Markdown preview opens it in your browser (`rundll32` / `open` / `xdg-open`).
  - Nothing else leaves the machine; no mod makes network requests.
- The sidebar is not draggable (`resizable: false`). Width changes go through the toggle, which resizes to 44/76 px and back to the remembered width.
- The gradient's fade is drawn as 2 px chrome bands, not an image, because Herdr keeps image aspect ratios. The bands use the theme's `chrome`, so change the colour there and the fade follows.
- The header height (60) matches `zerdr-header`'s height, so the toggle centres on the header's icon row. Change both together.
- `projects.seed.js` (in `zerdr-new-thread`) is empty. Add `{ name, folder }` entries there to pre-fill projects on first run.

## Done when

- `herdr-app check` passes for each of the eight `mods/zerdr-*` folders.
- `herdr-app do layout.switch '{"name":"Zerdr"}'` succeeds and `herdr-app status` shows `"layout": "Zerdr"` with no errors.
- A `herdr-app shot` matches `preview.png`: a 60 px gradient header with the toggle level with the header's icon buttons, threads grouped by machine and project, thread and working cards in the t3code two-line layout, and the terminal in a rounded card.
- `herdr-app do mod.open '{"name":"zerdr-new-thread"}'` lists `zerdr-new-thread` under `overlays`.
- `herdr-app do zerdr-viz.toggle` collapses the sidebar to the rail, and running it again restores the width.
