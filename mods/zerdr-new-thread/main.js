// New thread dialog (overlay, props { space? }): agent rail on the left, projects on the right.
// Keyboard, one set of keys: focus starts on the agents (up/down picks one); Tab (or Enter)
// moves to the project search, where typing filters, up/down highlights and Enter starts the
// thread; Shift+Tab goes back to the agents. The focused side fills its selection; the other side shows its choice as bright text.
// Alt+W toggles own git worktree (open spaces only), Esc clears the search, then closes.
// Mouse: click an agent, click a project to start.
// No first message: the thread starts and you talk to the agent in its tab.
// Projects = open spaces (any machine) + saved projects (shared "projects": [{name, folder}],
// added by zerdr-new-project, seeded from projects.seed.js) whose folder has no open space here,
// most recently started from this dialog first (localStorage "used"); the highlight starts on
// the first one that isn't the shown space. Starting: open space -> tab.new {space, argv}; saved project ->
// space.new {name, folder, argv} (its space comes back in its folder); worktree -> the
// `worktree` mod with {space, branch, tab, argv}. The agent last started with is the default.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, spaces, knownAgents, run, openOverlay, closeOverlay, props, shared, setShared } from "herdr";
import SEED from "./projects.seed.js";

const KNOWN = "zerdr-new-thread.agents";
const ICONS = "mods/workspace-chrome";
const SHELL = { key: "shell", name: "Shell", icon: "icons/shell.svg", tint: true, run: null, installed: true };
const key = (f) => (f ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
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
        aliases: s.machine ? [] : saved.filter((p) => key(p.folder) === key(s.folder)).map((p) => p.name) };
    });
    const idle = saved.filter((p) => !spaces().some((s) => !s.machine && key(s.folder) === key(p.folder)))
      .map((p) => ({ kind: "saved", id: `saved:${key(p.folder)}`, name: p.name, folder: p.folder, machine: null,
        last: this.used[key(p.folder)] ?? 0, working: 0, aliases: [] }));
    const q = norm(this.input?.value());
    const hit = (p) => !q || [p.name, ...p.aliases].some((n) => norm(n).includes(q));
    const rank = (p) => (!q ? 0 : [p.name, ...p.aliases].some((n) => norm(n).startsWith(q)) ? 0 : 1);
    return [...open, ...idle].filter(hit).sort((a, b) => rank(a) - rank(b) || b.last - a.last || a.name.localeCompare(b.name));
  }

  target() {
    const list = this.projects();
    return list[Math.min(this.at, list.length - 1)] ?? null;
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
    const target = chosen ?? this.target();
    if (!target) return;
    const agent = this.agent();
    const argv = agent.run ?? undefined;
    localStorage.setItem("agent", agent.key);
    this.used[target.kind === "space" && target.machine ? `space:${target.id}` : key(target.folder)] = Date.now();
    localStorage.setItem("used", JSON.stringify(this.used));
    closeOverlay(props().overlay);
    if (target.kind === "saved") {
      run("space.new", { name: target.name, folder: target.folder, argv });
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
        const n = this.projects().length;
        if (!n) return;
        this.at = (Math.min(this.at, n - 1) + step + n) % n;
        this.listScroll.scroll_to_item(this.at);
        this.follow(cx);
      }
    } else if (mod.alt && k === "w") {
      if (this.target()?.kind === "saved") return;
      this.worktree = !this.worktree;
    } else if (k === "escape") {
      // Esc clears the search first, then closes.
      if (this.input.value()) { this.input.set_value(""); this.at = this.firstElsewhere(); }
      else closeOverlay(props().overlay);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const choices = this.choices();
    const list = this.projects();
    const at = Math.min(this.at, list.length - 1);
    const target = list[at] ?? null;
    const agent = this.agent();
    const keycap = (label) => div().px(5).rounded(4).border(1).border_color(t.input).text_size(11).text_color(t.muted).child(label);
    // Minimal focus cue, no rings: the side with the keyboard fills its selection with the
    // selected tone; the other side's choice is just bright, medium-weight text. Unchosen rows
    // are muted on both sides.
    const onAgents = this.zone === "agents";
    // One flat surface in the Zerdr layout's tones (zerdr-sidebar): chrome ground, the
    // selected fill only on the focused choice, the sidebar's faint white hovers, hairlines.
    const HOVER = "#FFFFFF08";

    const agentRow = (a, i) => {
      const on = i === this.pick;
      return h_flex().id(`agent-${a.key}`).h(30).px(8).gap(8).flex_none().items_center().rounded(7)
        .when(on && onAgents, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_medium())
        .hover((s) => s.bg(on && onAgents ? t.selected : HOVER).text_color(t.foreground))
        .cursor_pointer()
        .on_click((_e, cx) => { this.pick = i; this.userPicked = true; this.zone = "agents"; this.refocus(); cx.notify(); })
        .child(div().size(16).flex_none().flex().items_center().justify_center()
          .when(Boolean(a.icon), (el) => el.child(a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14))))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(a.name));
    };

    // Right-hand tag: last used, then where it is. Working threads say so in the working colour.
    const tag = (p) => {
      const where = p.kind === "saved" ? "not open" : p.machine ? p.machine : "open";
      const when = ago(p.last);
      return h_flex().flex_none().gap(6).items_center().text_size(12)
        .when(p.working > 0, (el) => el.child(div().text_color(t.working).child(`${p.working} working`)))
        .child(div().text_color(t.dim).child(when ? `${when} · ${where}` : where));
    };

    const projectRow = (p, i) => {
      const on = i === at;
      const alias = p.aliases.filter((n) => n !== p.name)[0];
      return h_flex().id(`project-${p.id}`).h(32).px(10).gap(8).flex_none().items_center().rounded(7)
        .when(on && !onAgents, (el) => el.bg(t.selected)).cursor_pointer()
        .hover((s) => s.bg(on && !onAgents ? t.selected : HOVER))
        .tooltip(p.kind === "saved" ? `${p.folder}\nNot open: starting opens its space here` : p.folder ?? p.name)
        .on_click((_e, cx) => { this.at = i; this.start(cx, p); })
        .child(div().flex_1().min_w(0).truncate().text_size(13)
          .text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_medium())
          .child(alias ? `${p.name}  ·  ${alias}` : p.name))
        .child(tag(p));
    };

    const empty = div().px(10).py(14).text_size(13).text_color(t.dim)
      .child(this.input.value().trim() ? `No project matches “${this.input.value().trim()}”` : "No projects yet: add one with New project");

    const worktreeOff = target?.kind === "saved";
    const toggle = h_flex().id("worktree").gap(6).items_center().cursor_pointer()
      .text_color(worktreeOff ? t.dim : t.muted)
      .tooltip(worktreeOff ? "Unopened projects start in their own folder" : "Give the thread its own branch and folder (git worktree)")
      .on_click((_e, cx) => { if (!worktreeOff) this.worktree = !this.worktree; this.refocus(); cx.notify(); })
      .child(div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border(1).border_color(t.muted)
        .when(this.worktree && !worktreeOff, (el) => el.bg(t.foreground))
        .when(this.worktree && !worktreeOff, (el) => el.child(svg(`${ICONS}/check.svg`).size(10).text_color(t.background))))
      .child(keycap("Alt+W")).child("worktree");

    // The rail scrolls; its key hint stays pinned under it.
    const rail = v_flex().w(156).flex_none().min_h(0)
      .child(v_flex().id("agents").track_scroll(this.railScroll).flex_1().min_h(0).gap(2)
        .overflow_y_scrollbar()
        .children(choices.map(agentRow))
        .when(this.agents.length === 0, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim)
          .child(this.failed ? "Could not load agents" : "Finding agents…"))))
      .child(h_flex().flex_none().px(8).pt(4).h(30).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(keycap("↑↓")).child("agent"));

    // Clicking anywhere on the search box moves the keyboard to the projects side.
    const search = h_flex().id("search").h(34).flex_none().px(10).gap(8).items_center().rounded(9)
      .border(1).border_color(t.border)
      .on_click((_e, cx) => { this.zone = "projects"; this.refocus(); cx.notify(); })
      .child(svg(`${ICONS}/search.svg`).size(14).flex_none().text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
      .when(onAgents, (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(keycap("Tab")).child("projects")));

    const startLabel = target ? `Start ${agent.name} in ${target.name}` : "Start";
    const footer = h_flex().flex_none().pt(8).gap(10).items_center().text_size(11).text_color(t.dim)
      .child(toggle)
      .child(div().flex_1())
      // The one primary style (as Create and Commit): solid when it can run, raised when it can't.
      .child(h_flex().id("start").h(32).px(14).gap(6).flex_none().items_center().rounded(8)
        .bg(target ? t.solid : t.raised).text_color(target ? t.solid_foreground : t.dim)
        .text_size(12).font_medium()
        .when(Boolean(target), (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)))
        .tooltip(startLabel)
        .on_click((_e, cx) => this.start(cx))
        .child(div().max_w(150).truncate().child(target ? `Start in ${target.name} ↵` : "Start")));

    return h_flex().id("zerdr-new-thread").track_focus(this.handle).size_full().min_h(0).p(10).gap(10)
      .bg(t.chrome).text_size(13).items_stretch()
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(rail)
      .child(div().w(1).flex_none().bg(t.border))
      .child(v_flex().flex_1().min_w(0).min_h(0).gap(6)
        .child(search)
        .child(v_flex().id("projects").track_scroll(this.listScroll).flex_1().min_h(0).gap(1).overflow_y_scrollbar()
          .children(list.map(projectRow))
          .when(list.length === 0, (el) => el.child(empty)))
        .child(footer));
  }
}
