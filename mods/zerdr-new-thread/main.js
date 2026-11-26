// New thread dialog (overlay, props { space? }): agent rail on the left, projects on the right.
// Keyboard, one set of keys: focus starts on the agents (up/down picks one); Tab (or Enter)
// moves to the project search, where typing filters (name, alias or folder), up/down highlights
// and Enter starts the thread; Shift+Tab goes back to the agents. The focused side fills, rings
// and accent-stamps its choice; the other side keeps its choice as a plain neutral fill.
// Projects are grouped by machine; the list ends in "New project…" (or "Create “x”…" for an
// unmatched search, which opens zerdr-new-project with that name). The footer says where the
// thread starts: machine / project (/ new worktree), then its folder.
// Alt+W toggles own git worktree (open spaces only), Esc clears the search, then closes.
// Mouse: click an agent, click a project to start.
// No first message: the thread starts and you talk to the agent in its tab.
// Projects = open spaces (any machine) + saved projects (shared "projects": [{name, folder, machine?}],
// added by zerdr-new-project, seeded from projects.seed.js) whose folder has no open space here,
// most recently started from this dialog first (localStorage "used"); the highlight starts on
// the first one that isn't the shown space. Starting: open space -> tab.new {space, argv}; saved project ->
// space.new {name, folder, argv, machine} (its space comes back in its folder); worktree -> the
// `worktree` mod with {space, branch, tab, argv}. The agent last started with is the default.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, spaces, knownAgents, run, openOverlay, closeOverlay, props, shared, setShared } from "herdr";
import SEED from "./projects.seed.js";

const KNOWN = "zerdr-new-thread.agents";
const ICONS = "mods/workspace-chrome";
const SHELL = { key: "shell", name: "Shell", icon: "icons/shell.svg", tint: true, run: null, installed: true };
const key = (f) => (f ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
// A saved project's machine (absent: this computer). space.new from a mod without `machine`
// follows the focused space's machine, so starting one always names it ("" = this computer);
// otherwise, focused on another machine's space, its folder isn't found there and nothing starts.
const mach = (p) => p.machine ?? null;
const same = (a, b) => mach(a) === mach(b) && key(a.folder) === key(b.folder);
const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ago = (at) => {
  if (!at) return "";
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

export default class NewThread extends View {
  init(_props, cx) {
    if (shared("projects") == null) setShared("projects", SEED);
    this.tagMachines();
    const start = spaces().find((s) => s.id === props()?.space) ?? spaces().find((s) => s.active);
    this.machine = start?.machine ?? null; // machine the agent list is for
    this.agents = shared(KNOWN)?.[this.machine ?? ""] ?? [];
    this.pick = this.lastAgent();
    this.userPicked = false; // the person chose an agent here: keep it over the remembered one
    this.worktree = false;
    try { this.used = JSON.parse(localStorage.getItem("used") ?? "{}") ?? {}; } catch { this.used = {}; }
    // Work usually goes to another project: start on the first one that isn't the shown space.
    this.current = start?.id ?? null;
    this.at = this.firstElsewhere();
    this.listScroll = ScrollHandle.new();
    this.railScroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Find a project" });
    this.input.on("change", (_e, cx) => {
      this.at = this.input.value().trim() ? 0 : this.firstElsewhere();
      this.follow(cx);
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.input.on("focus", (_e, cx) => { this.zone = "projects"; cx.notify(); });
    // Focus starts on the agents; Tab moves it to the project search.
    this.zone = "agents";
    this.handle.focus();
    cx.timer.after(300, () => this.refocus());
    this.loadAgents(cx, this.machine);
  }

  // Projects saved before they recorded a machine: one at or under an open space's folder on
  // another machine (and under no space here) belongs to that machine. Saved once; untouched otherwise.
  tagMachines() {
    const saved = shared("projects") ?? [];
    const within = (f, root) => key(f) === key(root) || key(f).startsWith(key(root) + "\\");
    let changed = false;
    const next = saved.map((p) => {
      if ("machine" in p) return p;
      const roots = spaces().filter((s) => s.folder && within(p.folder, s.folder))
        .sort((a, b) => key(b.folder).length - key(a.folder).length);
      const m = roots[0]?.machine ?? null;
      if (!m) return p;
      changed = true;
      return { ...p, machine: m };
    });
    if (changed) setShared("projects", next);
  }

  // Put the keyboard back where the zone says (agents: the dialog itself; projects: the search).
  refocus() {
    if (this.zone === "projects") this.input.focus(); else this.handle.focus();
  }

  firstElsewhere() {
    const i = this.projects().findIndex((p) => p.id !== this.current);
    return i < 0 ? 0 : i;
  }

  // Every project, most recently started from here first, filtered by the search text.
  // Recency is this dialog's own record, not agent activity, so a busy space can't pin itself on top.
  projects() {
    const saved = shared("projects") ?? [];
    const open = spaces().map((s) => {
      const last = Math.max(0, this.used[`space:${s.id}`] ?? 0, this.used[key(s.folder)] ?? 0);
      return { kind: "space", id: s.id, name: s.name, folder: s.folder, machine: s.machine ?? null, last,
        working: s.tabs.filter((x) => x.status === "working").length,
        aliases: saved.filter((p) => same(p, s)).map((p) => p.name) };
    });
    const idle = saved.filter((p) => !spaces().some((s) => same(s, p)))
      .map((p) => ({ kind: "saved", id: `saved:${mach(p) ?? ""}:${key(p.folder)}`, name: p.name, folder: p.folder,
        machine: mach(p), last: this.used[key(p.folder)] ?? 0, working: 0, aliases: [] }));
    const q = norm(this.input?.value());
    // Matches the name, an alias or the folder.
    const hit = (p) => !q || [p.name, ...p.aliases, p.folder].some((n) => norm(n).includes(q));
    const rank = (p) => (!q ? 0 : [p.name, ...p.aliases].some((n) => norm(n).startsWith(q)) ? 0 : 1);
    // Grouped by machine (this computer first, then remotes by name), as the sidebar lists them.
    const group = (p) => (p.machine ? 1 : 0);
    return [...open, ...idle].filter(hit).sort((a, b) => group(a) - group(b) || (a.machine ?? "").localeCompare(b.machine ?? "")
      || rank(a) - rank(b) || b.last - a.last || a.name.localeCompare(b.name));
  }

  // The list as drawn: the projects plus the closing "New project…" row (index = projects().length).
  rows() { return this.projects().length + 1; }

  // New project, named after an unmatched search when there is one.
  newProject() {
    const name = this.input.value().trim();
    closeOverlay(props().overlay);
    openOverlay({ mod: "zerdr-new-project", kind: "dialog", width: 340, height: 236, props: name ? { name } : {} });
  }

  // The highlighted project; null on the "New project…" row.
  target() {
    return this.projects()[this.at] ?? null;
  }

  // The agent list belongs to the highlighted project's machine.
  follow(cx) {
    const m = this.target()?.machine ?? null;
    if (m === this.machine) return;
    const was = this.agent().key;
    this.machine = m;
    this.agents = shared(KNOWN)?.[m ?? ""] ?? [];
    this.pick = this.agentIndex(this.userPicked ? was : null);
    this.loadAgents(cx, m);
  }

  // Index of the agent with this key if present, else the remembered one, else the first.
  agentIndex(want) {
    const i = want ? this.choices().findIndex((a) => a.key === want) : -1;
    return i < 0 ? this.lastAgent() : i;
  }

  loadAgents(cx, machine) {
    // Only the latest request may land: a reply for a machine picked earlier is dropped.
    const seq = (this.seq = (this.seq ?? 0) + 1);
    this.failed = false;
    cx.spawn(async (cx) => {
      try {
        const agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...(shared(KNOWN) ?? {}), [machine ?? ""]: agents });
        if (seq !== this.seq) return;
        // Until the person picks, a cold cache's fallback (often Shell) never sticks.
        const was = this.userPicked ? this.agent().key : null;
        this.agents = agents;
        this.pick = this.agentIndex(was);
      } catch { if (seq !== this.seq) return; this.failed = true; }
      cx.notify();
    });
  }

  choices() {
    return [...this.agents.filter((a) => a.installed), SHELL];
  }

  lastAgent() {
    const i = this.choices().findIndex((a) => a.key === localStorage.getItem("agent"));
    return i < 0 ? 0 : i;
  }

  agent() {
    return this.choices()[this.pick] ?? SHELL;
  }

  start(_cx, chosen) {
    if (!chosen && this.at >= this.projects().length) { this.newProject(); return; }
    const target = chosen ?? this.target();
    if (!target) return;
    const agent = this.agent();
    const argv = agent.run ?? undefined;
    localStorage.setItem("agent", agent.key);
    this.used[target.kind === "space" && target.machine ? `space:${target.id}` : key(target.folder)] = Date.now();
    localStorage.setItem("used", JSON.stringify(this.used));
    closeOverlay(props().overlay);
    if (target.kind === "saved") {
      run("space.new", { name: target.name, folder: target.folder, argv, machine: target.machine ?? "" });
    } else if (this.worktree) {
      // No folder: the worktree mod takes the repo from the chosen space.
      const space = spaces().find((s) => s.id === target.id);
      openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280,
        props: { space: target.id, action: "new", branch: `thread-${(space?.tabs.length ?? 0) + 1}`, tab: agent.name, argv } });
    } else {
      run("tab.new", { space: target.id, argv });
    }
  }

  keys(e, cx) {
    const k = e.key;
    const mod = e.modifiers ?? {};
    // One set of keys: up/down act on whichever side has focus; Tab / Shift+Tab switch sides.
    if (k === "tab") {
      this.zone = mod.shift ? "agents" : "projects";
      this.refocus();
    } else if (this.zone === "agents" && k === "enter") {
      this.zone = "projects";
      this.refocus();
    } else if (k === "up" || k === "down") {
      const step = k === "down" ? 1 : -1;
      if (this.zone === "agents") {
        const n = this.choices().length;
        this.pick = (this.pick + step + n) % n;
        this.userPicked = true;
        this.railScroll.scroll_to_item(this.pick);
      } else {
        const n = this.rows();
        this.at = (Math.min(this.at, n - 1) + step + n) % n;
        this.listScroll.scroll_to_item(this.drawnIndex(this.at));
        this.follow(cx);
      }
    } else if (mod.alt && k === "w") {
      if (this.target()?.kind !== "space") return;
      this.worktree = !this.worktree;
    } else if (k === "escape") {
      // Esc clears the search first, then closes.
      if (this.input.value()) { this.input.set_value(""); this.at = this.firstElsewhere(); }
      else closeOverlay(props().overlay);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }


  // Child index of list row i in the drawn list, which has a machine header before each group.
  drawnIndex(i) {
    const list = this.projects();
    let heads = 0, last;
    for (let n = 0; n <= Math.min(i, list.length - 1); n++) {
      const m = list[n].machine ?? "";
      if (m !== last) { heads++; last = m; }
    }
    return i + heads;
  }

  // Same system as zerdr-sidebar (keep in step): neutral fills, hairlines, 13 px medium rows,
  // 12 px idle labels, one field style, one primary button. Focus has one signal, the sidebar's:
  // the side with the keyboard fills its row, rings it and stamps its left edge in accent (and on
  // the projects side the search field rings in accent); the other side keeps its choice as a
  // plain neutral fill. The footer says exactly where the thread will start.
  render(cx) {
    const t = theme();
    const HOVER = "#FFFFFF08", SEL = "#FFFFFF0F", CHOSEN = "#FFFFFF0A", RING = "#FFFFFF0A", HAIR = "#FFFFFF0F";
    const choices = this.choices();
    const list = this.projects();
    const rows = list.length + 1;
    this.at = Math.min(this.at, rows - 1);
    const at = this.at;
    const target = list[at] ?? null;
    const onAdd = !target;
    const agent = this.agent();
    const onAgents = this.zone === "agents";
    const q = this.input.value().trim();
    const kbd = (label) => div().h(17).min_w(17).px(4).flex_none().flex().items_center().justify_center().rounded(4)
      .bg("#FFFFFF08").border(1).border_color("#FFFFFF12").text_size(10).font_medium().text_color(t.dim).child(label);
    // A list row in its state: focused (this side has the keyboard), chosen (the other side's
    // pick), or plain. The stamp is the sidebar's 2 px accent mark.
    const state = (el, on, focusSide) => on && focusSide
      ? el.bg(SEL).border(1).border_color(RING).child(div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(t.accent))
      : on ? el.bg(CHOSEN).border(1).border_color("#00000000")
      : el.border(1).border_color("#00000000").hover((s) => s.bg(HOVER));

    const agentRow = (a, i) => {
      const on = i === this.pick;
      return state(h_flex().id(`agent-${a.key}`).relative().h(32).px(8).gap(9).flex_none().items_center().rounded(7), on, onAgents)
        .text_color(on ? t.foreground : t.muted).font_medium().cursor_pointer()
        .on_click((_e, cx) => { this.pick = i; this.userPicked = true; this.zone = "agents"; this.refocus(); cx.notify(); })
        .child(div().size(16).flex_none().flex().items_center().justify_center()
          .when(Boolean(a.icon), (el) => el.child(a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14))))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(a.name));
    };

    // The name with the searched letters underlined, so it shows why a row matched.
    const named = (name, on) => {
      const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
      const box = h_flex().min_w(0).truncate().text_size(13);
      if (i < 0) return box.child(name);
      return box.child(div().flex_none().child(name.slice(0, i)))
        .child(div().flex_none().underline().text_color(t.foreground).child(name.slice(i, i + q.length)))
        .child(div().min_w(0).truncate().child(name.slice(i + q.length)));
    };

    // A project row: folder icon (faint when the project isn't open), name (and alias), and
    // "here" on the project you're in. Machine and folder are in the group header and footer.
    const projectRow = (p, i) => {
      const on = i === at;
      const alias = p.aliases.filter((n) => n !== p.name)[0];
      return state(h_flex().id(`project-${p.id}`).relative().h(32).px(8).gap(9).flex_none().items_center().rounded(7), on, !onAgents)
        .text_color(on ? t.foreground : t.muted).font_medium().cursor_pointer()
        .tooltip(p.kind === "saved" ? `${p.folder}\nNot open: starting opens its space on ${p.machine ?? "this computer"}` : p.folder ?? p.name)
        .on_click((_e, cx) => {
          if (on && !onAgents) { this.start(cx, p); return; }
          this.at = i; this.zone = "projects"; this.refocus(); this.follow(cx); cx.notify();
        })
        .child(svg(`${ICONS}/folder.svg`).size(14).flex_none().text_color(p.kind === "saved" ? "#4b4d53" : t.dim))
        .child(named(p.name, on))
        .when(Boolean(alias), (el) => el.child(div().flex_none().text_size(12).text_color(t.idle).child(alias)))
        .when(p.id === this.current, (el) => el.child(div().flex_none().h(17).px(5).flex().items_center().rounded(4)
          .border(1).border_color(HAIR).text_size(11).text_color(t.dim).child("here")));
    };

    const head = (m, n) => h_flex().id(`head-${m ?? "here"}`).flex_none().h(28).pt(6).px(8).gap(6).items_center()
      .text_size(12).font_medium().text_color(t.idle)
      .child(svg(`${ICONS}/${m ? "server" : "monitor"}.svg`).size(12).flex_none())
      .child(div().truncate().child(m ?? "This computer"))
      .child(div().flex_none().text_color("#4b4d53").child(String(n)));

    const drawn = [];
    let last;
    list.forEach((p, i) => {
      const m = p.machine ?? "";
      if (m !== last) { last = m; drawn.push(head(p.machine, list.filter((x) => (x.machine ?? "") === m).length)); }
      drawn.push(projectRow(p, i));
    });
    if (!list.length) drawn.push(div().id("empty").px(8).pt(14).pb(6).text_size(13).text_color(t.idle)
      .child(q ? `No project matches “${q}”.` : "No projects yet."));
    // The list never dead-ends: New project closes it, named after an unmatched search.
    drawn.push(state(h_flex().id("new-project").relative().mt(4).h(32).px(8).gap(9).flex_none().items_center().rounded(7), onAdd, !onAgents)
      .text_color(onAdd ? t.foreground : t.dim).font_medium().cursor_pointer()
      .on_click(() => this.newProject())
      .child(svg(`${ICONS}/folder-plus.svg`).size(14).flex_none().text_color(t.idle))
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(q && !list.length ? `Create “${q}”…` : "New project…")));

    // Agents follow the highlighted project's machine; the label says so for a remote one.
    const rail = v_flex().w(172).flex_none().min_h(0).pt(2)
      .child(h_flex().flex_none().h(24).px(8).gap(5).items_center().text_size(12).font_medium().text_color(t.idle)
        .child("Agent")
        .when(Boolean(this.machine), (el) => el.child("·").child(div().truncate().text_color(t.dim).child(`on ${this.machine}`))))
      .child(v_flex().id("agents").track_scroll(this.railScroll).flex_1().min_h(0).gap(1).overflow_y_scrollbar()
        .children(choices.map(agentRow))
        .when(this.agents.length === 0, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.idle)
          .child(this.failed ? "Could not load agents" : "Finding agents…"))))
      .child(v_flex().flex_none().px(8).pt(6).gap(6).text_size(12).text_color(t.idle)
        .child(h_flex().gap(5).items_center().child(kbd("↑")).child(kbd("↓")).child("agent"))
        .child(h_flex().gap(5).items_center().child(kbd("Tab")).child("projects")));

    // The shared field style; it rings in accent while the projects side has the keyboard.
    const search = h_flex().id("search").h(30).flex_none().pl(10).pr(6).gap(8).items_center().rounded(7)
      .bg("#FFFFFF06").border(1).border_color(onAgents ? HAIR : "#3b82f680")
      .on_click((_e, cx) => { this.zone = "projects"; this.refocus(); cx.notify(); })
      .child(svg(`${ICONS}/search.svg`).size(14).flex_none().text_color(t.idle))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
      .when(Boolean(q), (el) => el.child(div().id("search-clear").size(18).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.idle).cursor_pointer().hover((s) => s.bg("#FFFFFF14").text_color(t.foreground))
        .tooltip("Clear search (Esc)")
        .on_click((_e, cx) => { this.input.set_value(""); this.at = this.firstElsewhere(); this.refocus(); cx.notify(); })
        .child(svg(`${ICONS}/x.svg`).size(11))));

    // Where the thread will start: machine / project (/ new worktree), then its folder.
    const wtOk = target?.kind === "space";
    const wtOn = this.worktree && wtOk;
    const sep = () => div().flex_none().text_color("#4b4d53").child("/");
    const where = onAdd
      ? v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12).text_color(t.dim).child(q && !list.length ? `Opens New project named “${q}”` : "Opens New project"))
        .child(div().truncate().text_size(11).text_color("#4b4d53").child("Pick a name and folder next"))
      : v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(svg(`${ICONS}/${target.machine ? "server" : "monitor"}.svg`).size(12).flex_none())
          .child(div().flex_none().child(target.machine ?? "This computer")).child(sep())
          .child(div().min_w(0).truncate().font_medium().text_color(t.foreground).child(target.name))
          .when(wtOn, (el) => el.child(sep()).child(div().flex_none().text_color(t.foreground).child("new worktree"))))
        .child(div().truncate().text_size(11).text_color("#4b4d53")
          .child(`${target.kind === "saved" ? "Opens its space · " : ""}${target.folder ?? ""}`));

    const toggle = h_flex().id("worktree").h(28).px(8).gap(7).flex_none().items_center().rounded(7).cursor_pointer()
      .text_size(12).text_color(wtOn ? t.foreground : t.dim).opacity(wtOk ? 1 : 0.4)
      .when(wtOk, (el) => el.hover((s) => s.bg(HOVER).text_color(t.foreground)))
      .tooltip(wtOk ? "Give the thread its own branch and folder (git worktree)" : "Unopened projects start in their own folder")
      .on_click((_e, cx) => { if (wtOk) this.worktree = !this.worktree; this.refocus(); cx.notify(); })
      .child(div().relative().w(26).h(16).flex_none().rounded(8).bg(wtOn ? t.accent : "#FFFFFF14")
        .child(div().absolute().top(2).left(wtOn ? 12 : 2).size(12).rounded_full().bg(wtOn ? "#FFFFFF" : "#C9CBD0")
          .transition("left", { duration: 180, easing: "ease-out" })))
      .child("Worktree").child(kbd("Alt W"));

    const label = onAdd ? "Continue" : `Start in ${target.name}`;
    // The one primary style (as Create and Commit), with its key inside.
    const startBtn = h_flex().id("start").h(30).pl(12).pr(8).gap(8).flex_none().items_center().rounded(8)
      .bg(t.solid).text_color(t.solid_foreground).text_size(13).font_semibold().cursor_pointer()
      .hover((s) => s.opacity(0.92))
      .tooltip(onAdd ? "New project" : `Start ${agent.name} in ${target.name}`)
      .on_click((_e, cx) => this.start(cx))
      .child(div().max_w(150).truncate().child(label))
      .child(div().h(17).min_w(17).px(4).flex().items_center().justify_center().rounded(4).bg("#0000001A")
        .text_size(10).font_medium().text_color("#00000099").child("↵"));

    const footer = h_flex().flex_none().h(52).px(12).gap(10).items_center().border_t(1).border_color(HAIR)
      .child(where).child(toggle).child(startBtn);

    return v_flex().id("zerdr-new-thread").track_focus(this.handle).size_full().min_h(0)
      .bg(t.chrome).text_size(13)
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(h_flex().flex_1().min_h(0).items_stretch()
        .child(div().flex_none().p(8).pr(8).border_r(1).border_color(HAIR).flex().child(rail))
        .child(v_flex().flex_1().min_w(0).min_h(0).pt(10).px(10).gap(2)
          .child(search)
          .child(v_flex().id("projects").track_scroll(this.listScroll).flex_1().min_h(0).gap(1).pb(6).overflow_y_scrollbar()
            .children(drawn))))
      .child(footer);
  }
}
