// Thread header for the Zerdr layout: 60 px, inside a `window_drag` block.
// Left: breadcrumb machine / project / thread (the thread title click: tab.rename), then its worktree crumb (branch icon + branch,
// or the worktree folder name), sharing a baseline. Right: five round icon buttons (Files,
// Changes, Split, Archive, Commands), a divider, then window buttons where the system draws none.
// No status chip or live text.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, theme, window, shared, layout, home, notify } from "herdr";
import { Press } from "./press.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A theme colour at an alpha (theme colours are #rrggbb; anything else is returned as is).
const tint = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
const norm = (p) => (p ?? "").replace(/\\/g, "/").toLowerCase();

// Title rule shared with zerdr-sidebar: named tab, else the lead agent's telling
// terminal title, else its program (not a shell), else "Thread N".
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const SHELL = /^(pwsh|powershell|cmd|bash|zsh|sh|fish)(\.exe)?$/i;
const telling = (s, prog) => {
  const own = clean(s);
  return own && own !== prog?.name && own.toLowerCase() !== prog?.key && !/^\d+$/.test(own)
    && !/^[~/]|^[A-Za-z]:\\/.test(own) && !own.includes("@") && !SHELL.test(own) ? own : null;
};

export default class ThreadHeader extends View {
  init() {
    // A corrupt stored value must not kill the header: start with no memory instead.
    try { const v = JSON.parse(localStorage.getItem("panels") ?? "{}"); this.panels = v && typeof v === "object" ? v : {}; } catch { this.panels = {}; }
  }

  // Same as the shipped tabs mod: the side panel is remembered per space.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    const tab = space?.tabs.find((c) => c.id === f?.tab) ?? space?.tabs.find((c) => c.active);
    const all = panes();
    const mine = all.filter((p) => p.tab === tab?.id);
    const pane = mine.find((p) => p.focused) ?? mine.find((p) => p.terminal) ?? mine[0];
    const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
    const title = !tab ? "" : tab.named ? tab.name
      : telling(lead?.title, lead?.program) ?? (lead?.program && !lead.program.shell ? lead.program.name : null) ?? `Thread ${tab.index}`;
    // Worktree crumb: the branch, else the folder name of a herdr worktree; nothing else.
    const wtRoot = norm(`${home()}/.herdr/worktrees/`);
    const cwd = norm(pane?.cwd ?? "");
    const wtName = cwd.startsWith(wtRoot) ? (pane.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || null) : null;
    const crumb = pane?.branch ?? wtName;

    // One round 28 px icon button (sidebar style); `on` is the teal pressed state of an open panel.
    const press = (this.press ??= new Press());
    const icon = (name) => svg(`mods/zerdr-header/icons/${name}.svg`);
    const button = (id, name, tip, on, action) => press.wire(div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded_full()
      .border(1).border_color(on ? tint(t.accent, 0.4) : "#FFFFFF1F").bg(on ? tint(t.accent, 0.1) : t.canvas)
      .text_color(on ? t.accent : t.muted).cursor_pointer()
      .when(!on, (el) => el.hover((s) => s.bg("#ffffff12").text_color(t.foreground)))
      .tooltip(tip).on_click(action).child(press.icon(id, icon(name), 16)), id);

    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, tip) => {
      const on = Boolean(panel && !panel.hidden && body?.active === id);
      return button(`panel-${id}`, id, tip, on, () => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
      });
    };
    // zerdr-changes publishes its file count; until it has, the tooltip carries no number.
    const count = shared("changes.count");
    const changesTip = typeof count === "number" ? `Changes · ${count} ${count === 1 ? "file" : "files"}` : "Changes";
    const archive = () => {
      const id = tab.id;
      run("tab.settle", { id });
      notify({ title: "Archived · click to undo", body: title, level: "info", timeout: 6000, action: { name: "tab.unsettle", args: { id } } });
    };

    const w = window();
    const winButton = (id, glyph, action, danger = false) => press.wire(div().id(id).w(32).h(28).flex_none().flex().items_center().justify_center().rounded(8)
      .text_color(t.dim).hover((s) => (danger ? s.bg("#e5484d").text_color("#ffffff") : s.bg("#ffffff12").text_color(t.foreground)))
      .on_click(action).child(press.icon(id, glyph, 16)), id);

    return h_flex().id("zerdr-header").size_full().min_w(0).pl(27).pr(19).gap(12).items_center().bg(t.canvas)
      // Breadcrumb and branch crumb share a baseline; the title click renames the tab (herdr asks for the name).
      .child(h_flex().id("heading").flex_shrink_1().min_w(0).gap(8).items_baseline()
        .when(Boolean(space), (el) => el.child(h_flex().flex_none().gap(8).items_baseline().text_size(18).font_medium().text_color(t.dim)
          .child(space.machine ?? "Local").child(div().text_color(t.idle).child("/"))
          .child(div().max_w(200).truncate().child(space.name)).child(div().text_color(t.idle).child("/"))))
        .when(Boolean(tab), (el) => el.child(div().id("title").flex_shrink_1().min_w(0).max_w(420).truncate().px(4).ml(-4).rounded(6)
          .text_size(18).font_semibold().text_color(t.foreground).hover((s) => s.bg(t.raised))
          .on_mouse_down("left", stop).on_click(() => run("tab.rename", { id: tab.id })).child(title)))
        // Branch chip: inline beside the title, outlined.
        .when(Boolean(crumb), (el) => el.child(h_flex().id("crumb").flex_shrink_1().min_w(0).max_w(320).h(22).px(8).gap(5).items_center()
          .rounded(6).border(1).border_color("#FFFFFF1A").text_size(12).text_color(t.muted)
          .child(svg("mods/zerdr-header/icons/branch.svg").size(12).flex_none().text_color(t.dim)).child(div().min_w(0).truncate().child(crumb)))))
      .child(div().flex_1())
      .child(h_flex().id("tools").flex_none().gap(6).items_center()
        .when(enabled.includes("files"), (el) => el.child(panelButton("files", "Files")))
        .when(enabled.includes("changes"), (el) => el.child(panelButton("changes", changesTip)))
        .when(Boolean(pane), (el) => el.child(button("split", "split", "Split right (Ctrl+Shift+O)", false, () => run("pane.split", { direction: "right", pane: pane.pane }))))
        .when(Boolean(tab), (el) => el.child(button("archive", "archive", "Archive thread", false, archive)))
        .child(button("commands", "commands", "Commands (Ctrl+Shift+P)", false, () => run("app.palette"))))
      .when(w?.buttons, (el) => el
        .child(div().w(1).h(22).flex_none().bg(t.input))
        .child(h_flex().flex_none().gap(2).items_center()
          .child(winButton("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
          .child(winButton("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
          .child(winButton("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"), true))));
  }
}
