// Threads list, grouped as the macOS sidebar groups locations: machine (this computer first, then
// remotes by name), then project (space order), then one-line thread rows (needs-you first, then
// newest). A project header folds its threads. Working threads show in zerdr-agents.
// Archive = tab.settle; archived threads sit in a folded "Archived" section at the bottom.
// Opening one brings it back (Herdr unsettles a shown tab); hover offers Unarchive (tab.unsettle).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, terminals, focused, run, theme, layout, setAgentOrder, openOverlay, nextCommand, setShared, shared, hc } from "herdr";
import { Press } from "./press.js";

const TILE = "#151517"; // program badge tile: no token is this dark
// Marker colour with no theme token: all work done (green).
const DONE = "#22c55e";
const ICONS = "mods/workspace-chrome";
// Dock sizing (fit): search row (mt 8 + 32 + mb 6), list padding (pt 4 + pb 8), floor, header.
const HEAD_PX = 46, LIST_PAD = 12, MIN_PX = 60, VIZ_PX = 96;
// The light braille "dots" spinner (2-4 of 6 dots lit): it reads as motion. The 8-dot set with 7 lit
// read as a drag grip once centred on a two-line row.
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
// Sidebar fold: zerdr-viz resizes the sidebar once per toggle (each width step resized the
// terminal, and the agent in it redrew its whole screen per step). Smoothness comes from here
// instead: shared "sidebar.phase" is leaving (fade out, 12 px drift, 120 ms) -> arriving (one
// frame hidden at the new width) -> idle (fade in, 180 ms). Native transitions only.
const settle = (el) => {
  const p = shared("sidebar.phase") ?? "idle";
  const spec = p === "idle" ? { duration: 180, easing: "ease-out" } : p === "leaving" ? { duration: 120, easing: "ease-in" } : 1;
  return el.relative().left(p === "idle" ? 0 : -12).opacity(p === "idle" ? 1 : 0).transition("left", spec).transition("opacity", spec);
};

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const SHELL = /^(pwsh|powershell|cmd|bash|zsh|sh|fish)(\.exe)?$/i;
// A title says something when it isn't a path, a prompt, a number or the program's own name.
const telling = (s, prog) => {
  const own = clean(s);
  return own && own !== prog?.name && own.toLowerCase() !== prog?.key && !/^\d+$/.test(own)
    && !/^[~/]|^[A-Za-z]:\\/.test(own) && !own.includes("@") && !SHELL.test(own) ? own : null;
};
const tail = (p) => (p ?? "").split(/[\\/]/).filter(Boolean).slice(-2).join("\\") || p || "";

// What a thread is doing, for its marker, from herdr alone: its tab status says needs-you /
// working / done; agents = the lead agent is done but an `hc run` child it started still works.
function phase(tab, allPanes, all) {
  if (tab.status === "blocked") return "blocked";
  if (tab.status === "working") return "working";
  const own = new Set(allPanes.filter((p) => p.tab === tab.id && p.terminal).map((p) => p.terminal));
  for (let grew = true; grew;) {
    grew = false;
    for (const k of all) if (k.parent && own.has(k.parent) && !own.has(k.address) && k.state === "live") { own.add(k.address); grew = true; }
  }
  // Paneless hc children (hc run --bg agents) report their own status.
  if (all.some((k) => k.parent && own.has(k.address) && !allPanes.some((p) => p.terminal === k.address) && k.status === "working")) return "agents";
  // Background work inside the agent (Claude Code's background shells and agents) outlives its
  // turn, so Herdr says done while the thread still waits on it; zerdr-sidebar reads it from the
  // agent's footer and shares it as "threads.bg" ({ terminal: { shells } }).
  const bg = shared("threads.bg") ?? {};
  if ([...own].some((a) => bg[a])) return "agents";
  return tab.status === "done" || tab.status === "idle" ? "done" : null;
}

// Claude Code's footer, under its prompt line, counts background shells still running after the
// turn ("· 3 shells"). Only the lines below the last prompt are read, so a count quoted in the
// transcript never matches. Its "← N agent" hint is not used: it shows on idle sessions too.
// Other agents print no such footer and read as nothing.
function footerBg(screen) {
  const lines = screen.split(/\r?\n/);
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[❯>]/.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const foot = lines.slice(at + 1).join(" ");
  const shells = Number(/\b(\d+) shells?\b/.exec(foot)?.[1] ?? 0);
  return shells ? { shells } : null;
}

const PHASE_TIP = { working: "Working", agents: "Background work running", blocked: "Needs you", done: "All work done" };

// Total time an agent has worked in a tab ("1h 12m"). herdr only gives the current run's start
// (working_since), so runs are added up here: { acc, since, seen } per tab, kept in localStorage
// and shared as "threads.worked" ({ tab: { acc, since } }) for zerdr-agents.
// Line 2 of a thread row, shared with zerdr-agents (keep the two in step): the harness's own
// icon and the context on the left; the time worked on the right behind a stopwatch, so "when"
// and "how long" differ in place, icon and word.
const TIMER = "mods/zerdr-sidebar/icons/timer.svg";
const progIcon = (prog, size) => !prog?.icon ? null
  : (prog.tint ? svg(prog.icon).text_color(prog.color ?? theme().muted) : image(prog.icon)).size(size).flex_none();
const duration = (t, text) => h_flex().flex_none().gap(4).items_center().text_size(12).text_color(t.dim)
  .child(svg(TIMER).size(12).flex_none()).child(text);
const fmtWorked = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const workedMs = (r) => (r ? r.acc + (r.since ? Date.now() - r.since : 0) : 0);
// Time since a thread last changed state ("2h ago"), for its second line.
const fmtAgo = (at) => {
  if (!at) return "";
  const m = Math.floor((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

// Sliding rows (FLIP). Each render lays rows out from their measured heights; a row whose place
// changed is drawn one frame at its old place (instant), then released so .transition slides it
// home natively. A new row starts one row below (enterDy > 0, it rose from the Agents panel) or
// above (< 0) and fades in. zerdr-agents keeps an identical copy, entering from above.
class Slide {
  constructor(enterDy) { this.enterDy = enterDy; this.pos = null; this.h = new Map(); this.off = new Map(); this.fresh = new Set(); }
  reset() { this.pos = null; }
  plan(keys, gap, cx) {
    const pos = new Map();
    let y = 0;
    for (const k of keys) { pos.set(k, y); y += (this.h.get(k) ?? 56) + gap; }
    if (this.pos) for (const k of keys) {
      const was = this.pos.get(k);
      if (was === undefined) { this.off.set(k, Math.sign(this.enterDy) * ((this.h.get(k) ?? Math.abs(this.enterDy)) + gap)); this.fresh.add(k); }
      else if (was !== pos.get(k)) this.off.set(k, was - pos.get(k));
    }
    this.pos = pos;
    if (this.off.size && !this.pending) {
      this.pending = true;
      cx.timer.after(30, (cx) => { this.off.clear(); this.fresh.clear(); this.pending = false; cx.notify(); });
    }
  }
  apply(el, key) {
    const d = this.off.get(key) ?? 0;
    const fresh = this.fresh.has(key);
    return el.on_size_change((s) => { this.h.set(key, s.height); })
      .top(d).opacity(fresh ? 0 : 1)
      .transition("top", d ? 1 : { duration: 340, easing: "ease-out" })
      .transition("opacity", fresh ? 1 : { duration: 260, easing: "ease-out" });
  }
}

// The shown thread's highlight. Every switch of thread (Ctrl+Tab, click, or into the other list,
// zerdr-sidebar <-> zerdr-agents) settles instead of travelling: the old highlight fades where
// it is (140 ms; across lists the other mod fades its own), the new one resolves at its row with a
// 4 px drift from the side the old one was on (200 ms), and a 2 px accent stamp on its left edge
// fades in (160 ms), holds, then fades out (600 ms). Only when the shown thread's own row moves
// (the list reorders) does the highlight glide with it (280 ms). dir = +1 if the other list is
// below, -1 if above. Positions come from Slide.pos.
// Herdr animates from the last painted value, so: stage 1 is held 32 ms (long enough to paint),
// each stage keeps its policies until the next (a re-render can't snap a fade), and the stamp and
// ghost get a fresh id per switch (a reused element would animate from its old, invisible state).
// Stages: 1 frame one, 2 settle + stamp in, 3 stamp out, 4 rest.
class Glide {
  constructor(dir) { this.dir = dir; this.top = 0; this.h = 32; this.was = false; this.drawn = false; this.stage = 0; this.key = null; this.ghost = null; this.arrival = 0; }
  el(slide, key, margin, color, cx) {
    const t = theme();
    const y = key != null ? slide.pos?.get(key) : undefined;
    const on = y !== undefined;
    let spec = { duration: 280, easing: "ease-out" }; // the shown row moved within its list
    if (on) {
      const top = y + margin, h = slide.h.get(key) ?? this.h;
      if (this.drawn && (!this.was || key !== this.key)) { // a switch: arrive here
        this.from = this.was ? Math.sign(this.top - top) : this.dir;
        this.ghost = this.was ? { top: this.top, h: this.h } : null;
        const n = ++this.arrival;
        const at = (stage, ms, then) => cx.timer.after(ms, (cx) => { if (this.arrival !== n) return; this.stage = stage; cx.notify(); then?.(cx); });
        this.stage = 1;
        at(2, 32, (cx) => cx.timer.after(700, (cx) => { if (this.arrival !== n) return; this.stage = 3; cx.notify();
          cx.timer.after(700, (cx) => { if (this.arrival !== n) return; this.stage = 4; this.ghost = null; cx.notify(); }); }));
      } else if (!this.was) spec = 1; // first draw: in place
      this.top = top; this.h = h;
    }
    this.was = on; this.drawn = true; this.key = on ? key : null;
    const s = this.stage;
    let fade = on ? 1 : { duration: 140, easing: "ease-out" }; // leaving to the other list: fade in place
    if (s === 1) spec = 1;
    else if (s === 2 && on) { spec = { duration: 200, easing: "ease-out" }; fade = { duration: 180, easing: "ease-out" }; }
    const stamp = (s === 1 || s === 2 || s === 3) && div().id(`glide-stamp-${this.arrival}`).absolute().left(0).top(8).w(2).h(Math.max(0, this.h - 16)).rounded(1).bg(t.accent)
      .opacity(s === 2 ? 1 : 0)
      .transition("opacity", s === 2 ? { duration: 160, easing: "ease-out" } : s === 3 ? { duration: 600, easing: "ease-in-out" } : 1);
    const hl = div().id("glide-hl").absolute().left(0).w_full().top(s === 1 ? this.top + 4 * this.from : this.top).h(this.h).rounded(8).bg(color)
      .opacity(on && s !== 1 ? 1 : 0)
      .transition("top", spec).transition("height", spec).transition("opacity", fade)
      .when(Boolean(stamp), (el) => el.child(stamp));
    const g = this.ghost;
    const ghost = g && div().id(`glide-ghost-${this.arrival}`).absolute().left(0).w_full().top(g.top).h(g.h).rounded(8).bg(color)
      .opacity(s === 1 ? 1 : 0).transition("opacity", s === 1 ? 1 : { duration: 140, easing: "ease-out" });
    return div().absolute().top(0).left(0).size_full().when(Boolean(ghost), (el) => el.child(ghost)).child(hl);
  }
}

export default class ThreadsSidebar extends View {
  init(_props, cx) {
    this.q = "";
    this.input = InputState.new({ placeholder: "Search" });
    this.needsOnly = false;
    this.input.on("change", (_e, cx) => { this.q = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.hovered = null;
    this.press = new Press();
    this.slide = new Slide(36); // new rows rise one row (36 px) from below
    this.listH = 600;
    this.glide = new Glide(1); // the Agents panel is below
    try { this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.archivedOpen = localStorage.getItem("archivedOpen") === "1";
    try { this.worked = JSON.parse(localStorage.getItem("worked") ?? "{}") ?? {}; } catch { this.worked = {}; }
    try { this.autoNames = JSON.parse(localStorage.getItem("autoNames") ?? "{}") ?? {}; } catch { this.autoNames = {}; }
    this.workedShared = false;
    // Worked times only change by the minute; the saved totals follow.
    cx.timer.every(60000, (cx) => { localStorage.setItem("worked", JSON.stringify(this.worked)); cx.notify(); });
    // Background work: every 8 s, read the visible screen of each agent whose turn is over.
    this.bg = {};
    cx.timer.every(8000, (cx) => this.scanBg(cx));
    this.scanBg(cx);
    // keys.json: "zerdr-sidebar.next" / ".prev" walk the list exactly as it is drawn.
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "next" || c === "prev") this.cycle(c === "next" ? 1 : -1); } });
  }

  // One pass at a time; shares "threads.bg" only when it changed. A thread still working is
  // skipped (Herdr already says so), as is a full-screen read: --lines 0 never scrolls.
  scanBg(cx) {
    if (this.scanning) return;
    this.scanning = true;
    const open = new Set(spaces().flatMap((s) => s.tabs.filter((x) => !x.settled && x.status !== "working" && x.status !== "blocked").map((x) => x.id)));
    const leads = panes().filter((p) => open.has(p.tab) && p.terminal && p.app === "claude-code").map((p) => p.terminal);
    cx.spawn(async (cx) => {
      const next = {};
      for (const t of leads) {
        try {
          const r = await hc(["read", "--lines", "0", t]);
          const found = r.code === 0 ? footerBg(r.stdout) : null;
          if (found) next[t] = found;
        } catch { /* unreachable terminal: no background work known */ }
      }
      this.scanning = false;
      if (JSON.stringify(next) !== JSON.stringify(this.bg)) {
        this.bg = next;
        setShared("threads.bg", next);
        cx.notify();
      }
    });
  }

  // Close finished runs and open new ones. A run ends when its tab's state changed (changed_at),
  // else the last time it was seen working. Shares only when a run starts or ends.
  track() {
    const now = Date.now();
    let changed = !this.workedShared;
    for (const tab of spaces().flatMap((sp) => sp.tabs)) {
      const ws = tab.working_since;
      const r = this.worked[tab.id] ??= { acc: 0, since: null, seen: null };
      if (r.since && r.since !== ws) {
        const end = ws ? (r.seen ?? r.since) : Math.max(r.since, tab.changed_at ?? r.seen ?? r.since);
        r.acc += Math.max(0, end - r.since);
        r.since = null;
        changed = true;
      }
      if (ws && !r.since) { r.since = ws; changed = true; }
      if (ws) r.seen = now;
    }
    if (changed) {
      this.workedShared = true;
      localStorage.setItem("worked", JSON.stringify(this.worked));
      setShared("threads.worked", Object.fromEntries(Object.entries(this.worked).map(([k, r]) => [k, { acc: r.acc, since: r.since }])));
    }
  }

  // Herdr's own notifications read "<space> / <tab name>", so each tab is named after its
  // session's live title (the lead agent's terminal title) and the title reaches every toast.
  // Only unnamed tabs and tabs named here are touched: a name the person gave (F2) sticks.
  syncNames() {
    const allPanes = panes();
    let changed = false;
    for (const tab of spaces().flatMap((sp) => sp.tabs)) {
      if (tab.named && tab.name !== this.autoNames[tab.id]) continue;
      const mine = allPanes.filter((p) => p.tab === tab.id && p.terminal);
      const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
      const live = telling(lead?.title, lead?.program);
      if (!live || live === tab.name) continue;
      this.autoNames[tab.id] = live;
      changed = true;
      run("tab.rename", { id: tab.id, name: live });
    }
    if (changed) localStorage.setItem("autoNames", JSON.stringify(this.autoNames));
  }

  clearSearch(cx) {
    this.input.set_value("");
    this.q = "";
    cx.notify();
  }

  // Inbox: one flat list across projects, in two sections. Working = anything still running;
  // Done = the rest, needs-you pinned first (the turn is over either way). Each newest first. nav =
  // the walk for the keys and agent.next. Search matches title, preview and project.
  model() {
    const allPanes = panes();
    const all = terminals();
    const q = this.q;
    const byRecent = (a, b) => (b.tab.changed_at ?? 0) - (a.tab.changed_at ?? 0) || a.tab.index - b.tab.index;
    const items = spaces().flatMap((space) => space.tabs.map((tab) => ({ tab, space, d: this.describe(tab, space, allPanes, all) })))
      .filter(({ d, space }) => !q || `${d.title} ${d.preview} ${space.name}`.toLowerCase().includes(q))
      .filter(({ d }) => !this.needsOnly || d.phase === "blocked");
    const open = items.filter((i) => !i.tab.settled);
    const busy = (i) => ["working", "agents"].includes(i.d.phase);
    // Machine, then project: this computer first, remote machines by name, projects in space order.
    const at = new Map(spaces().map((s, n) => [s.id, n]));
    const byGroup = (a, b) => (a.space.machine ? 1 : 0) - (b.space.machine ? 1 : 0)
      || (a.space.machine ?? "").localeCompare(b.space.machine ?? "") || at.get(a.space.id) - at.get(b.space.id);
    const working = open.filter(busy).sort((a, b) => byGroup(a, b) || byRecent(a, b));
    const done = open.filter((i) => !busy(i)).sort((a, b) => byGroup(a, b) || (b.d.phase === "blocked") - (a.d.phase === "blocked") || byRecent(a, b));
    const archived = items.filter((i) => i.tab.settled).sort((a, b) => (b.tab.settled ?? 0) - (a.tab.settled ?? 0));
    // nav: the keys' walk, top to bottom as drawn. Done (this panel, folded projects skipped),
    // then Working in the Agents panel's order (zerdr-agents publishes it as "agents.order"),
    // only the threads it draws.
    const rank = new Map((shared("agents.order") ?? []).map((id, n) => [id, n]));
    const shown = (rank.size ? working.filter((i) => rank.has(i.tab.id)) : [...working]).sort((a, b) => (rank.get(a.tab.id) ?? 1e9) - (rank.get(b.tab.id) ?? 1e9));
    const nav = [...done.filter((i) => !this.folded.has(i.space.id)), ...shown];
    return { working, done, archived, order: [...working, ...done], nav };
  }

  // Wraps at both ends; from outside the list, next starts at the top and prev at the bottom.
  cycle(step) {
    const list = this.model().nav;
    if (!list.length) return;
    const at = list.findIndex((i) => i.tab.id === focused()?.tab);
    const next = list[(((at < 0 ? (step > 0 ? -1 : 0) : at) + step) % list.length + list.length) % list.length];
    this.select(next.space, next.tab);
  }

  // What a thread shows: title, preview, program, sub-agent count.
  describe(tab, space, allPanes, all) {
    const mine = allPanes.filter((p) => p.tab === tab.id && p.terminal);
    const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
    const live = telling(lead?.title, lead?.program);
    const title = tab.named ? tab.name : live ?? (lead?.program && !lead.program.shell ? lead.program.name : null) ?? `Thread ${tab.index}`;
    const preview = live && live !== title ? live : tail(lead?.cwd ?? space.folder);
    const own = new Set(mine.map((p) => p.terminal));
    let subs = 0;
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of all) if (t.parent && own.has(t.parent) && !own.has(t.address) && t.state === "live") { own.add(t.address); subs++; grew = true; }
    }
    return { title, preview, live: live && live !== title ? live : null, program: lead?.program ?? null, subs, phase: phase(tab, allPanes, all) };
  }

  // Shape and colour, never colour alone. working: teal spinner (the lead agent's turn);
  // agents (sub-agents or background shells still work): the same spinner; blocked: steady amber haloed dot; done: green check;
  // no agent: hollow ring. Loops are native (no timers); ids keyed by thread and phase.
  marker(t, phase, key) {
    const box = (el) => div().size(16).flex_none().flex().items_center().justify_center().child(el);
    // Working, or waiting on sub-agents or background shells: one braille spinner (native frames).
    if (phase === "working" || phase === "agents") return box(div().id(`mk-wk-${key}`).text_size(15).text_color(t.working).frames(BRAILLE, 80));
    if (phase === "blocked") return box(div().size(13).rounded_full().bg(t.blocked + "38").flex().items_center().justify_center()
      .child(div().size(7).rounded_full().bg(t.blocked)));
    if (phase === "done") return box(svg(`${ICONS}/circle-check.svg`).size(14).text_color(DONE));
    return box(div().size(9).rounded_full().border(2).border_color(t.idle));
  }

  badge(t, prog) {
    const tile = div().size(16).flex_none().rounded(5).border(1).border_color(t.input).bg(TILE).flex().items_center().justify_center();
    if (prog?.icon) return tile.child(prog.tint ? svg(prog.icon).size(10).text_color(prog.color ?? t.muted) : image(prog.icon).size(10));
    return tile.text_size(9).font_bold().text_color(t.dim).child(prog?.shell ? "$" : (prog?.name ?? "?").slice(0, 1).toUpperCase());
  }

  // Header action, as t3code: bare icon, dim until hovered; `on` tints it (an active filter).
  hbtn(id, icon, tip, on, onClick) {
    const t = theme();
    return this.press.wire(div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.blocked : t.dim).cursor_pointer()
      .hover((s) => s.bg("#FFFFFF12").text_color(on ? t.blocked : t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(this.press.icon(id, svg(`${ICONS}/${icon}.svg`), 15)), id);
  }

  // The one icon-button style: round, input-coloured ring, muted icon.
  ibtn(id, icon, tip, size, onClick) {
    const t = theme();
    return this.press.wire(div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded_full()
      .border(1).border_color(t.input).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg("#FFFFFF12").text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(this.press.icon(id, svg(`${ICONS}/${icon}.svg`), 12)), id);
  }

  select(space, tab) {
    run("tab.select", { id: tab.id }); // switches project too, in one step (space.select first glided twice)
  }

  // Machine header: icon and name (this computer = display, remote = server).
  machineHead(t, machine, key) {
    return this.slide.apply(div().id(`hm-${key}`), key).relative().flex_none().my(2).h(24).px(8).pt(6)
      .flex().items_center().gap(6).text_size(11).font_medium().text_color(t.dim)
      // The icon sits on the 16px edge with the thread titles; display = this computer, server = remote.
      .tooltip(machine ? `Remote machine: ${machine}` : "This computer")
      .child(svg(`${ICONS}/${machine ? "server" : "monitor"}.svg`).size(13).flex_none())
      .child(div().truncate().child(machine ?? "This computer"));
  }

  // Project header: a disclosure group with its thread count; click folds it (kept across restarts).
  spaceHead(t, space, n, key) {
    const shut = this.folded.has(space.id);
    return this.slide.apply(div().id(`hs-${space.id}`), key).relative().flex_none().my(2).h(26).px(8).rounded(6)
      .flex().items_center().gap(6).cursor_pointer()
      .hover((s) => s.bg("#FFFFFF08"))
      .tooltip(shut ? "Show threads" : "Hide threads")
      .on_click((_e, cx) => {
        if (shut) this.folded.delete(space.id); else this.folded.add(space.id);
        localStorage.setItem("folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      // As the machine header: a folder icon on the 16px edge, the name beside it, one step bolder
      // (12px semibold, foreground); count, then the fold chevron, at the right.
      .child(svg(`${ICONS}/folder.svg`).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(space.name))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(String(n)))
      .child(svg(`${ICONS}/${shut ? "chevron-right" : "chevron-down"}.svg`).size(12).flex_none().text_color(t.dim));
  }

  // Archived header: the project header's shape with the archive icon; click folds it (kept across restarts).
  archivedHead(t, n, key) {
    const open = this.archivedOpen;
    return this.slide.apply(div().id("ha-archived"), key).relative().flex_none().mt(10).mb(2).h(26).px(8).rounded(6)
      .flex().items_center().gap(6).cursor_pointer()
      .hover((s) => s.bg("#FFFFFF08"))
      .tooltip(open ? "Hide archived threads" : "Show archived threads")
      .on_click((_e, cx) => {
        this.archivedOpen = !open;
        localStorage.setItem("archivedOpen", this.archivedOpen ? "1" : "0");
        cx.notify();
      })
      .child(svg(`${ICONS}/archive.svg`).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.dim).child("Archived"))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(String(n)))
      .child(svg(`${ICONS}/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim));
  }

  // Two lines, the same shape as zerdr-agents' Working rows: the title has the row's whole
  // width (one shared line with the time left it ~120px at a 229px sidebar), and under it when it
  // last changed and the time worked. Machine and project are said once, in the headers above.
  row(t, item, shownTab) {
    const { tab, space, d } = item;
    const on = tab.id === shownTab;
    const hover = this.hovered === tab.id;
    const unseen = tab.status === "done";
    const where = `${space.machine ?? "This computer"} / ${space.name}`;
    const done = () => { this.hovered = null; };
    // No leading column: the title starts on the 16px edge and gets the width. State is carried by
    // line 2's colour (needs you: amber "Needs you"; unseen: accent time, with a semibold title).
    const pic = progIcon(d.program, 12);
    const ms = workedMs(this.worked[tab.id]);
    const when = d.phase === "blocked" ? "Needs you" : ms ? fmtAgo(tab.changed_at) : "Not started";
    const whenColor = d.phase === "blocked" ? t.blocked : unseen ? t.accent : t.dim;
    return this.slide.apply(div().id(`th-${tab.id}`), tab.id).relative().flex_none().my(2).px(8).py(6).rounded(8)
      .flex().items_start().gap(8).cursor_pointer()
      .when(!on, (el) => el.hover((s) => s.bg("#FFFFFF08")))
      .tooltip([d.title, where, PHASE_TIP[d.phase]].filter(Boolean).join("\n"))
      .on_hover((h, cx) => {
        if (h) this.hovered = tab.id;
        else if (this.hovered === tab.id) this.hovered = null;
        cx.notify();
      })
      .on_click(() => this.select(space, tab))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground)
          .when(unseen, (el) => el.font_semibold())
          .when(!unseen, (el) => el.font_medium())
          .child(d.title))
        .child(h_flex().min_w(0).gap(6).items_center()
          .when(Boolean(pic), (el) => el.child(div().flex_none().tooltip(d.program?.name ?? "").child(pic)))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(whenColor)
            .tooltip(d.phase === "blocked" ? "Waiting for you" : unseen ? "Finished · not opened yet" : "Last active").child(when))
          .when(ms > 0 && !hover, (el) => el.child(duration(t, fmtWorked(ms)).tooltip("Time worked")))))
      // Hover shows Rename and Archive (or Unarchive, for an archived thread) at the right, centred on the row.
      .when(hover && Boolean(tab.settled), (el) => el.child(h_flex().flex_none().self_center()
        .child(this.ibtn(`unarc-${tab.id}`, "archive", "Unarchive", 22, (cx) => { run("tab.unsettle", { id: tab.id }); done(); cx.notify(); }).bg(t.raised))))
      .when(hover && !tab.settled, (el) => el.child(h_flex().flex_none().self_center().gap(4)
        .child(this.ibtn(`ren-${tab.id}`, "square-pen", "Rename (F2)", 22, (cx) => { run("tab.rename", { id: tab.id }); done(); cx.notify(); }).bg(t.raised))
        .child(this.ibtn(`arc-${tab.id}`, "archive", "Archive", 22, (cx) => { run("tab.settle", { id: tab.id }); done(); cx.notify(); }).bg(t.raised))));
  }

  rail(t, items, shownTab) {
    return v_flex().id("root").size_full().bg(t.chrome).items_center().pt(8).gap(4)
      .children(items.map(({ tab, space, d }) => div().id(`rail-${tab.id}`).size(28).flex_none().flex().items_center().justify_center().rounded(6)
        .when(tab.id === shownTab, (el) => el.bg(t.selected))
        .hover((s) => s.bg("#FFFFFF08"))
        .tooltip([`${d.title} · ${space.name}`, PHASE_TIP[d.phase]].filter(Boolean).join("\n"))
        .on_click(() => this.select(space, tab))
        .child(this.marker(t, d.phase, `rail-${tab.id}`))));
  }

  render(cx) { return settle(this.body(cx)); }

  body(cx) {
    const t = theme();
    this.track();
    this.syncNames();
    const shownTab = focused()?.tab ?? null;
    const q = this.q;
    const { done, archived, order, nav } = this.model();

    // agent.next / agent.prev follow the threads as listed.
    const at = new Map(nav.map((i, n) => [i.tab.id, n]));
    setAgentOrder(agents().filter((a) => at.has(a.tab)).sort((x, y) => at.get(x.tab) - at.get(y.tab)).map((a) => a.address));

    if (narrow()) { this.fit(16 + order.length * 32); return this.rail(t, order, shownTab); }

    // Rows slide to new places; nothing moves on the first render or when the filter changed.
    const filter = `${q}|${this.needsOnly}`;
    if (this.filter !== filter) this.slide.reset();
    this.filter = filter;
    // Working threads are listed once, in the Agents panel (zerdr-agents); this list is the rest,
    // under machine and project headers, then the Archived section (folded by default).
    const plan = [];
    let lastM = null, lastS = null;
    for (const i of done) {
      const mk = `m:${i.space.machine ?? ""}`;
      if (mk !== lastM) { lastM = mk; lastS = null; plan.push({ key: mk, head: "m", machine: i.space.machine ?? null }); }
      if (i.space.id !== lastS) {
        lastS = i.space.id;
        plan.push({ key: `s:${i.space.id}`, head: "s", space: i.space, n: done.filter((x) => x.space.id === i.space.id).length });
      }
      if (!this.folded.has(i.space.id)) plan.push({ key: i.tab.id, item: i });
    }
    if (archived.length) {
      plan.push({ key: "a:head", head: "a", n: archived.length });
      if (this.archivedOpen) for (const i of archived) plan.push({ key: i.tab.id, item: i });
    }
    this.slide.plan(plan.map((p) => p.key), 4, cx); // rows and headers carry my(2)
    // Dock: size the block to its rows' measured heights (estimates until measured), each with my(2).
    const est = (p) => this.slide.h.get(p.key) ?? (p.head === "m" ? 24 : p.head ? 26 : 52);
    this.fit(HEAD_PX + LIST_PAD + plan.reduce((n, p) => n + est(p) + 4, 0));
    const rows = plan.map((p) => p.head === "m" ? this.machineHead(t, p.machine, p.key)
      : p.head === "s" ? this.spaceHead(t, p.space, p.n, p.key)
      : p.head === "a" ? this.archivedHead(t, p.n, p.key) : this.row(t, p.item, shownTab));
    if ((q || this.needsOnly) && !order.length && !archived.length) {
      rows.length = 0;
      rows.push(v_flex().flex_none().mx(8).my(18).p(14).gap(8).rounded(10).border(1).border_dashed().border_color(t.input)
        .text_size(13).text_color(t.muted)
        .child(div().child(this.needsOnly && !q ? "No threads need you." : `No threads match “${this.input.value().trim()}”.`))
        .child(div().id("empty-clear").text_color(t.accent).cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => { this.needsOnly = false; this.clearSearch(cx); }).child(this.needsOnly ? "Show all" : "Clear search")));
    }

    // t3code header: flat search, then filter / new project (a space) / new thread.
    const search = h_flex().id("search").relative().h(32).gap(8).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.key === "escape" && this.q) { cx.stop_propagation(); this.clearSearch(cx); } })
      .child(div().size(16).flex_none().flex().items_center().justify_center().child(svg(`${ICONS}/search.svg`).size(14).text_color(t.dim)))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).font_medium().text_color(t.foreground))
      .when(Boolean(q), (el) => el.child(div().id("search-clear").size(20).flex_none().flex().items_center().justify_center().rounded_full()
        .text_color(t.dim).cursor_pointer().hover((s) => s.bg("#FFFFFF14").text_color(t.foreground))
        .tooltip("Clear search (Esc)")
        .on_click((_e, cx) => this.clearSearch(cx))
        .child(svg(`${ICONS}/x.svg`).size(12))))
      .child(h_flex().flex_none().gap(2).items_center()
        .child(this.hbtn("filter", "list-filter", this.needsOnly ? "Showing threads that need you · show all" : "Show only threads that need you",
          this.needsOnly, (cx) => { this.needsOnly = !this.needsOnly; cx.notify(); }))
        // New project: a dialog for its name and, optionally, its folder (mods/zerdr-new-project).
        .child(this.hbtn("new-space", "folder-plus", "New project", false,
          () => openOverlay({ mod: "zerdr-new-project", kind: "dialog", width: 340, height: 236 })))
        .child(this.hbtn("zerdr-new-thread", "square-pen", "New thread (Ctrl+Shift+T)", false,
          () => openOverlay({ mod: "zerdr-new-thread", kind: "dialog", width: 540, height: 400, props: { space: focused()?.space } }))));

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(div().flex_none().mx(16).mt(8).mb(6).child(search))
      .child(v_flex().id("threads-list").flex_1().min_h(0).px(8).pt(4).pb(8).overflow_y_scrollbar().on_size_change((s) => { this.listH = s.height; })
        .child(v_flex().relative().flex_none().w_full()
          .child(this.glide.el(this.slide, shownTab, 2, t.selected, cx)).children(rows)));
  }

  // Dock: the block is as tall as its rows, so Working (the agents block) sits right under the
  // last thread and the spare height falls to the spacer below it. Capped so the footer and the
  // agents block always fit; past the cap the list scrolls. Resize only on change (no loop: the
  // rows' natural height does not depend on the block's).
  fit(px) {
    let h = 0;
    try { h = globalThis.window?.viewport_size?.()?.height ?? 0; } catch { h = 0; }
    const agentsPx = find(layout(), "agents")?.size?.px ?? 90;
    const footPx = find(layout(), "sidebar-foot")?.size?.px ?? 84;
    const cap = h > 0 ? Math.max(MIN_PX, h - VIZ_PX - footPx - Math.min(agentsPx, 140)) : 600;
    const want = Math.max(MIN_PX, Math.min(cap, px));
    if (want === this.sized) return;
    this.sized = want;
    if (find(layout(), "threads")?.size?.px !== want) run("layout.resize", { id: "threads", px: want });
  }
}
