// Working agents of every thread: each main agent titled by its thread (as the sidebar names
// it), then its sub-agents (hc run children via `parent`) indented. A group shows only while
// something in it is working. Everything comes from herdr; this mod does no file I/O. Footer: working / needs-you totals over every thread, settings,
// then a line of key hints. With no part it sizes its own block (layout.resize) to its rows.
// props().part: "list" or "footer" draws only that part; absent draws both.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, shared, setShared, run, theme, props, layout } from "herdr";
import { Press } from "./press.js";

const TILE = "#151517"; // program badge tile: no token is this dark
// As zerdr-sidebar: all work done (green).
const DONE = "#22c55e";
const ICONS = "mods/workspace-chrome";
// The light braille "dots" spinner (2-4 of 6 dots lit): it reads as motion. The 8-dot set with 7 lit
// read as a drag grip once centred on a two-line row.
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// The agents block grows to fit its rows, but never past SHARE of the sidebar below the
// header (VIZ_PX): past that its list scrolls, so it never covers the threads list. The layout
// does not hold the threads block's min against a large px sibling, so the cap lives here.
const MIN_PX = 90;
const VIZ_PX = 96;
const SHARE = 0.45;
function capPx() {
  let h = 0;
  try { h = globalThis.window?.viewport_size?.()?.height ?? 0; } catch { h = 0; }
  return h > 0 ? Math.max(MIN_PX, Math.floor((h - VIZ_PX) * SHARE)) : 320;
}

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
  // Slide (2026-11-16): content travels its full width (leaving 200 ms ease-in, idle 260 ms ease-out);
  // the layout still resizes once per toggle, so the terminal reflows once.
  const spec = p === "idle" ? { duration: 260, easing: "ease-out" } : p === "leaving" ? { duration: 200, easing: "ease-in" } : 1;
  const off = -(shared("sidebar.width") ?? 272);
  // The offset must sit on a child: Herdr places a mod's root element itself and ignores its left.
  return div().id("settle").size_full().overflow_hidden().child(el.relative().left(p === "idle" ? 0 : off)
    .opacity(p === "idle" ? 1 : 0).transition("left", spec).transition("opacity", spec));
};

// A sub-agent's raw word; error counts as needing you, done reports to its parent.
const word = (s) => (s === "error" ? "blocked" : s === "done" ? "idle" : s ?? null);

// A thread's title exactly as zerdr-sidebar shows it, so a row maps to its thread at a glance:
// its F2 name, else the lead agent's own title (Claude Code's session topic), else program, else "Thread N".
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const SHELL = /^(pwsh|powershell|cmd|bash|zsh|sh|fish)(\.exe)?$/i;
const telling = (s, prog) => {
  const own = clean(s);
  return own && own !== prog?.name && own.toLowerCase() !== prog?.key && !/^\d+$/.test(own)
    && !/^[~/]|^[A-Za-z]:\\/.test(own) && !own.includes("@") && !SHELL.test(own) ? own : null;
};
function threadTitle(tab, allPanes) {
  const mine = allPanes.filter((p) => p.tab === tab.id && p.terminal);
  const lead = mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
  const live = telling(lead?.title, lead?.program);
  return tab.named ? tab.name : live ?? (lead?.program && !lead.program.shell ? lead.program.name : null) ?? `Thread ${tab.index}`;
}

// A thread's phase, exactly as zerdr-sidebar computes it (keep the two in step).
const BUSY = new Set(["blocked", "working", "agents"]);

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

// Sliding rows (FLIP), an identical copy of zerdr-sidebar's Slide (keep the two in step).
// Here new rows drop in from above: a thread that started working came down from the list above.
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

// Line 2 of a thread row, an identical copy of zerdr-sidebar's (keep the two in step): the
// harness's own icon and the context on the left; the time worked on the right behind a stopwatch.
const TIMER = "mods/zerdr-sidebar/icons/timer.svg";
const progIcon = (prog, size) => !prog?.icon ? null
  : (prog.tint ? svg(prog.icon).text_color(prog.color ?? theme().muted) : image(prog.icon)).size(size).flex_none();
const duration = (t, text) => h_flex().flex_none().gap(4).items_center().text_size(12).text_color(t.dim)
  .child(svg(TIMER).size(12).flex_none()).child(text);

function elapsed(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
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

export default class ThreadsAgents extends View {
  init(_props, cx) {
    // Elapsed shows minutes, and a done sub-agent leaves 30 s after it ends: refresh every 15 s.
    cx.timer.every(15000, (cx) => cx.notify());
    this.slide = new Slide(-53); // new rows drop one row (53 px) from above
    this.glide = new Glide(-1); // the threads list is above
  }

  // The sidebar's markers. A main row shows its thread's phase; a working sub-agent row shows
  // the same spinner (one working marker everywhere).
  marker(t, status, key) {
    const box = (el) => div().size(16).flex_none().flex().items_center().justify_center().child(el);
    // Working, or waiting on sub-agents or background shells: one braille spinner (native frames).
        if (status === "working" || status === "agents") return box(div().id(`mk-wk-${key}`).text_size(15).text_color(t.working).frames(BRAILLE, 80));
    if (status === "blocked") return box(div().size(13).rounded_full().bg(t.blocked + "38").flex().items_center().justify_center()
      .child(div().size(7).rounded_full().bg(t.blocked)));
    if (status === "done") return box(svg(`${ICONS}/circle-check.svg`).size(14).text_color(DONE));
    return box(div().size(9).rounded_full().border(2).border_color(t.idle));
  }

  rows(t) {
    const listed = new Map(agents().map((a) => [a.address, a]));
    const all = terminals();
    const allPanes = panes();
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((x) => [x.id, { tab: x, space: s }])));
    const mine = allPanes.filter((p) => tabs.has(p.tab) && p.terminal);
    const agentsHere = mine.filter((p) => listed.has(p.terminal) || p.program?.agent);
    // A child with its own pane stays indented under its parent, not listed as a main.
    const parentOf = new Map(all.map((k) => [k.address, k.parent]));
    const here = new Set(agentsHere.map((p) => p.terminal));
    const underAnother = (address) => {
      for (let up = parentOf.get(address), n = 0; up && n < 32; up = parentOf.get(up), n++) if (here.has(up)) return true;
      return false;
    };
    // Same order as the threads list: this computer first, remote machines by name, projects in space order.
    const at = new Map(spaces().map((s, n) => [s.id, n]));
    const mains = agentsHere.filter((p) => !underAnother(p.terminal)).sort((a, b) => {
      const A = tabs.get(a.tab).space, B = tabs.get(b.tab).space;
      return (A.machine ? 1 : 0) - (B.machine ? 1 : 0) || (A.machine ?? "").localeCompare(B.machine ?? "") || at.get(A.id) - at.get(B.id);
    });
    const out = [];
    const seen = new Set();
    const kids = (address, depth) => {
      for (const k of all.filter((k) => k.parent === address && k.state === "live")) {
        if (seen.has(k.address)) continue;
        seen.add(k.address);
        out.push({ key: k.address, depth, status: word(listed.get(k.address)?.status ?? k.status),
          name: k.name || k.template || k.program?.name || k.address,
          fallback: listed.get(k.address)?.title, click: () => run("terminal.peek", { terminal: k.address }) });
        kids(k.address, depth + 1);
      }
    };
    // One group per main agent; a group shows only while something in it is working.
    let working = 0;
    for (const p of mains) {
      if (seen.has(p.terminal)) continue;
      seen.add(p.terminal);
      const a = listed.get(p.terminal);
      const { tab: tabInfo, space } = tabs.get(p.tab);
      const program = a?.program ?? p.program;
      const start = out.length;
      out.push({ key: p.terminal, depth: 0, phase: phase(tabInfo, allPanes, all), status: a?.status ?? p.status, name: threadTitle(tabInfo, allPanes),
        program, since: tabInfo?.working_since, fallback: a?.title ?? p.title,
        where: [program?.name, space.name].filter(Boolean).join(" · "), tabId: p.tab, space,
        click: () => run("agent.focus", { terminal: p.terminal }) });
      kids(p.terminal, 1);
      // Keep the main row as the group's heading; sub-agents only while working (or just done).
      const group = out.splice(start);
      const n = group.filter((r) => r.status === "working").length;
      // Same rule as the sidebar's Working section: a thread waiting on hc sub-agents
      // stays listed even when its lead agent's turn is over. Needs-you threads list in Done.
      const busy = group[0].phase !== "blocked" && BUSY.has(group[0].phase);
      // A just-finished sub-agent (done, inside its 30 s) keeps its group up so "Done" shows.
      if (n > 0 || busy || group.some((r) => r.depth > 0 && r.status === "done")) {
        out.push(...group.filter((r) => r.depth === 0 || r.status === "working" || r.status === "done"));
        working += n || (busy ? 1 : 0);
      }
    }
    return { out, working };
  }

  // A thread row: state, title and total time worked (kept by zerdr-sidebar, shared as
  // "threads.worked"); under it, machine · project with the machine icon (display = this computer,
  // server = remote), so where a working thread runs is always in view.
  threadRow(t, r) {
    const w = shared("threads.worked")?.[r.tabId];
    const ms = w ? w.acc + (w.since ? Date.now() - w.since : 0) : 0;
    const m = Math.floor(ms / 60000);
    const worked = m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
    const machine = r.space.machine;
    // The shown thread is highlighted here as in the threads list, so switching moves it between them.
    const on = r.tabId === focused()?.tab;
    // Dim: a working thread recedes (muted title, faded line 2); brightness is kept for threads that need you.
    const busy = ["working", "agents"].includes(r.phase ?? r.status);
    return this.slide.apply(div().id(`ag-${r.key}`), r.key).relative().flex_none().px(8).py(6).rounded(8).cursor_pointer()
      .when(!on, (el) => el.hover((s) => s.bg("#FFFFFF08")))
      .tooltip([r.name, `${machine ?? "This computer"} / ${r.space.name}`, "Focus"].join("\n"))
      .on_click(() => r.click())
      // The state marker sits top right, on the title line; text starts flush left like the threads list.
      .child(h_flex().gap(8).items_center()
        // t3code card, as zerdr-sidebar: machine › project and time worked on top, title and spinner below.
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(8).items_center().min_w(0).h(16).text_size(12).text_color(t.dim).opacity(busy ? 0.6 : 1)
            .child(h_flex().flex_1().min_w(0).gap(5).items_center()
              .child(svg(`${ICONS}/${machine ? "server" : "monitor"}.svg`).size(12).flex_none())
              .child(div().flex_none().child(machine ?? "Local"))
              .child(div().flex_none().text_color(t.idle).child("›"))
              .child(div().min_w(0).truncate().text_color(t.muted).child(r.space.name)))
            .child(div().flex_none().tooltip("Time worked").child(worked)))
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(busy ? t.muted : t.foreground).child(r.name))
            .child(div().flex_none().child(this.marker(t, r.phase ?? r.status, r.key))))));
  }

  row(t, r) {
    if (r.depth === 0) return this.threadRow(t, r);
    const pic = r.program?.icon && r.depth === 0
      ? div().size(16).flex_none().rounded(5).border(1).border_color(t.input).bg(TILE).flex().items_center().justify_center()
        .child(r.program.tint ? svg(r.program.icon).size(10).text_color(r.program.color ?? t.muted) : image(r.program.icon).size(10))
      : null;
    // Two lines: title = agent name; subtitle = its terminal title, else program and space.
    const fb = r.fallback && clean(r.fallback) !== r.name ? clean(r.fallback) : "";
    const task = fb || r.where || "";
    const sub = r.status === "done" && r.depth ? (task ? `Done · ${task}` : "Done") : task;
    const tip = [r.depth ? null : r.name, r.where && r.where !== task ? r.where : null, task, r.depth ? "Peek" : "Focus"].filter(Boolean).join("\n");
    // Sub-agents hang off the parent's status column with an elbow connector.
    return this.slide.apply(div().id(`ag-${r.key}`), r.key).relative().flex_none().px(8).py(6).rounded(8).cursor_pointer()
      .ml(r.depth * 22)
      .hover((s) => s.bg("#FFFFFF08"))
      .tooltip(tip)
      .on_click(() => r.click())
      .when(r.depth > 0, (el) => el.child(div().absolute().left(-12).top(-6).w(9).h(29)
        .border_l(1).border_b(1).border_color(t.input).rounded_bl(6)))
      .child(v_flex().gap(1)
        .child(h_flex().gap(8).items_center()
          .child(this.marker(t, r.depth === 0 ? r.phase ?? r.status : r.status === "working" ? "agents" : r.status, r.key))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .when(Boolean(pic), (el) => el.child(pic))
            .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(r.name)))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(elapsed(r.since))))
        .child(div().pl(24).min_w(0).truncate().text_size(12).text_color(sub ? t.muted : t.dim).child(sub || "No task")));
  }

  // The one icon-button style: 28px, round, input-coloured ring.
  ibtn(id, icon, tip, onClick) {
    const t = theme();
    this.press ??= new Press();
    return this.press.wire(div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded_full()
      .border(1).border_color("#FFFFFF1F").text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg("#FFFFFF12").text_color(t.foreground))
      .tooltip(tip)
      .on_click(onClick)
      .child(this.press.icon(id, svg(`${ICONS}/${icon}.svg`), 14)), id);
  }

  footer(t) {
    const all = spaces().flatMap((s) => s.tabs.filter((x) => !x.settled).map((tab) => ({ space: s, tab })));
    const allPanes = panes();
    const terms = terminals();
    const working = all.filter((x) => x.tab.status !== "blocked" && BUSY.has(phase(x.tab, allPanes, terms))).length;
    const needs = all.filter((x) => x.tab.status === "blocked");
    // Status dot with a soft halo of its own colour.
    const dot = (color) => div().size(13).flex_none().rounded_full().bg(color + "26").flex().items_center().justify_center()
      .child(div().size(7).rounded_full().bg(color));
    const settings = this.ibtn("threads-settings", "settings", "Settings (Ctrl+,)", () => run("app.settings"));
    if (narrow()) return h_flex().flex_none().h(48).justify_center().items_center().bg(t.chrome).border_t(1).border_color(t.border).child(settings);
    // Units named; the needs-you count only when there is one, and it jumps to that thread.
    return h_flex().flex_none().px(16).py(12).gap(10).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .text_size(12).text_color(t.muted)
      .child(h_flex().gap(6).items_center().child(dot(t.working)).child(`${working} ${working === 1 ? "thread" : "threads"} working`))
      .when(needs.length > 0, (el) => el.child(h_flex().id("needs-jump").gap(6).items_center().text_color(t.blocked).cursor_pointer()
        .hover((s) => s.underline())
        .tooltip("Go to the thread that needs you")
        .on_click(() => {
          const { space, tab } = needs[0];
          if (focused()?.space !== space.id) run("space.select", { id: space.id });
          run("tab.select", { id: tab.id });
        })
        .child(dot(t.blocked)).child(`${needs.length} needs you →`)))
      .child(div().flex_1())
      .child(settings);
  }

  // Bound keys only (keys.json), one line: Ctrl+Tab cycles threads, F2 renames. Both fit from
  // 225px (the sidebar is kept at 229); narrower, the F2 hint goes rather than clip mid-word.
  keys(t) {
    const kbd = (k) => div().px(6).py(1).rounded(5).bg("#FFFFFF08").border(1).border_b(2).border_color("#FFFFFF1A")
      .text_size(11).font_medium().text_color(t.muted).child(k);
    const hint = (ks, what) => h_flex().gap(3).items_center().children([...ks.flatMap((k, i) => (i ? [div().child("+"), kbd(k)] : [kbd(k)])), div().ml(2).child(what)]);
    return h_flex().flex_none().mx(16).mb(12).gap(8).items_center().whitespace_nowrap().overflow_hidden().text_size(11).text_color(t.dim)
      .child(hint(["Ctrl", "Tab"], "next"))
      .when((find(layout(), "sidebar")?.size?.px ?? 272) >= 225, (el) => el.child(hint(["F2"], "rename")));
  }

  list(t, out, working, cx) {
    const body = out.length
      ? out.map((r) => this.row(t, r))
      : [div().px(8).py(4).text_size(12).text_color(t.dim).child("No agents working.")];
    return v_flex().flex_1().min_h(0).px(8).pt(4).pb(6).border_t(1).border_color(t.border)
      .child(h_flex().flex_none().px(8).pt(10).pb(6).gap(6).items_center().text_size(12).font_semibold().text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child("Working"))
        .child(div().flex_none().child(String(working))))
      .child(v_flex().id("agents-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(v_flex().relative().flex_none().w_full()
          .child(this.glide.el(this.slide, out.find((r) => r.depth === 0 && r.tabId === focused()?.tab)?.key, 0, t.selected, cx))
          .children(body)));
  }

  // Size the block to its rows, clamped to capPx(); the list scrolls past that.
  // Resize only when the clamped size changes, so a resize never re-triggers itself.
  fit(out, listOnly) {
    const rows = Math.max(out.length, 1) * 53;
    const px = Math.min(capPx(), Math.max(listOnly ? 60 : MIN_PX, 41 + rows + 10 + (listOnly ? 0 : 53 + 32)));
    const now = find(layout(), "agents")?.size?.px;
    if (px === this.sized) return;
    this.sized = px;
    if (now !== px) run("layout.resize", { id: "agents", px });
  }

  render(cx) { return settle(this.body(cx)); }

  body(cx) {
    const t = theme();
    const part = props()?.part;
    // Footer block (the dock layout): status line and key hints, pinned to the sidebar's bottom.
    if (part === "footer") return v_flex().id("root").size_full().bg(t.chrome).justify_end().child(this.footer(t)).when(!narrow(), (el) => el.child(this.keys(t)));
    if (narrow()) return v_flex().id("root").size_full().bg(t.chrome).justify_end().when(part !== "list", (el) => el.child(this.footer(t)));
    const { out, working } = this.rows(t);
    // Publish the drawn thread order so zerdr-sidebar.next/prev walk this panel as shown.
    const order = [...new Set(out.filter((r) => r.depth === 0).map((r) => r.tabId))];
    if (JSON.stringify(order) !== JSON.stringify(shared("agents.order") ?? [])) setShared("agents.order", order);
    this.slide.plan(out.map((r) => r.key), 0, cx);
    if (part === "list") { this.fit(out, true); return v_flex().id("root").size_full().bg(t.chrome).child(this.list(t, out, working, cx)); }
    this.fit(out);
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).child(this.list(t, out, working, cx)).child(this.footer(t)).child(this.keys(t));
  }
}
