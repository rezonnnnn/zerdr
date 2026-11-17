// Sidebar header: a drifting mesh gradient (decorative; it follows the
// aggregate thread status from herdr), plus the sidebar toggle.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, layout, spaces, nextCommand } from "herdr";
import { Press } from "./press.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The rail goes by width, as workspace-chrome's does; same shared keys so both agree.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
// Sidebar fold: as zerdr-sidebar (keep the copies in step). "sidebar.phase" leaving slides the
// content out (200 ms ease-in) -> arriving (one frame hidden at the new width) -> idle (slides
// back in, 260 ms ease-out). Native transitions only.
const settle = (el) => {
  const p = shared("sidebar.phase") ?? "idle";
  const spec = p === "idle" ? { duration: 260, easing: "ease-out" } : p === "leaving" ? { duration: 200, easing: "ease-in" } : 1;
  const off = -(shared("sidebar.width") ?? 272);
  // The offset must sit on a child: Herdr places a mod's root element itself and ignores its left.
  return div().id("settle").size_full().overflow_hidden().child(el.relative().left(p === "idle" ? 0 : off)
    .opacity(p === "idle" ? 1 : 0).transition("left", spec).transition("opacity", spec));
};
// Collapse/expand: one layout.resize per toggle, so the terminal reflows once. Stepping the width
// (the old 200 ms slide) resized the terminal ~12 times and the agent in it redrew per step: lag.
// The motion is the content's (settle(), above): collapse slides out (200 ms), then resizes; expand
// resizes hidden, then slides in (260 ms). Toggles during the handover are ignored.
let busy = false;
function toggleSidebar(cx) {
  if (busy) return;
  busy = true;
  const width = find(layout(), "sidebar")?.size?.px ?? 272;
  const rail = window()?.platform === "macos" ? 76 : 44;
  const collapsing = !narrow();
  if (collapsing) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", collapsing);
  const to = collapsing ? rail : (shared("sidebar.width") ?? 272);
  const swap = (cx) => {
    setShared("sidebar.phase", "arriving");
    run("layout.resize", { id: "sidebar", px: to });
    cx.timer.after(16, () => { setShared("sidebar.phase", "idle"); busy = false; });
  };
  if (collapsing) { setShared("sidebar.phase", "leaving"); cx.timer.after(200, swap); }
  else swap(cx);
}

export default class ThreadsViz extends View {
  // keys.json: "zerdr-viz.toggle" (Ctrl+Shift+B) runs the same slide as the button.
  init(_props, cx) {
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "toggle") toggleSidebar(cx); } });
  }

  // The mesh gradient at the sidebar-header scale (60px, the thread-header's height so the toggle centres on its icon row). There is one soft blob per
  // colour (art/blob-*.png), each drifting on its own path, over the
  // mid blue. Grain sits on top, then a chrome alpha ramp, so the art
  // thins out towards the search box (herdr has no CSS mask; chrome over art is the same picture).
  // The header follows the aggregate thread state: working = the blobs drift at full strength;
  // idle = they hold still at 35% (nothing to report, nothing moving); a thread needs you = an
  // amber layer fades in. The blob ids are keyed by state, so the loops remount or stop.
  // Native loops and transitions only; no timers.
  mesh(mode, blocked) {
    const live = mode === "active";
    const blob = (name, size, x, y, px, py) => div().id(`blob-${name}-${mode}`).absolute().size(size)
      .left(x[0]).top(y[0])
      .when(live, (el) => el.loop("left", { from: x[0], to: x[1], period: px }).loop("top", { from: y[0], to: y[1], period: py }))
      .child(image(`mods/zerdr-viz/art/blob-${name}.png`).size_full());
    const over = (file) => image(`mods/zerdr-viz/art/${file}`).absolute().top(0).left(0).size_full();
    return div().absolute().top(0).left(0).size_full().overflow_hidden().bg("#2a5fb0")
      // Stable id for the dim, so idle <-> working fades (1.2 s) instead of snapping.
      .child(div().id("blobs-dim").absolute().top(0).left(0).size_full()
        .opacity(live ? 1 : 0.35).transition("opacity", { duration: 1200, easing: "ease-out" })
        .child(div().id(`blobs-${mode}`).absolute().top(0).left(0).size_full()
        .child(blob("blue", 210, [-50, 130], [-60, -30], 13000, 9000))
        .child(blob("indigo", 200, [120, -70], [-90, -50], 11000, 7600))
        .child(blob("teal", 160, [160, -10], [-10, -70], 9400, 6800))
        .child(blob("violet", 180, [30, 220], [-40, -70], 12400, 8200))
        .child(blob("black", 160, [200, 50], [-80, -50], 15000, 10400).opacity(0.55))))
      // Stable id: only its opacity target changes, so the transition runs instead of a remount.
      .child(div().id("blob-amber").absolute().top(0).left(0).size_full()
        .opacity(blocked ? 0.55 : 0).transition("opacity", { duration: 1200, easing: "ease-out" })
        .child(div().id(`amber-${mode}`).absolute().size(190).left(50).top(-50)
          .when(live, (el) => el.loop("left", { from: 50, to: 240, period: 7000 }).loop("top", { from: -50, to: -80, period: 5200 }))
          .child(image("mods/zerdr-viz/art/blob-amber.png").size_full())))
      .child(over("grain.png"))
      .child(this.fade());
  }

  // The mask ramp as chrome bands over the art: alpha = 1 - mask, 2px rows, solid
  // from 30% down. An image overlay can't do this: herdr keeps image aspect, so it won't stretch to the width.
  fade() {
    const stops = [[0, 1], [0.3, 1], [0.45, 0.85], [0.6, 0.62], [0.74, 0.38], [0.87, 0.17], [0.95, 0.05], [1, 0]];
    const mask = (y) => {
      for (let i = 1; i < stops.length; i++) {
        const [y0, m0] = stops[i - 1], [y1, m1] = stops[i];
        if (y <= y1) return m0 + ((m1 - m0) * (y - y0)) / (y1 - y0);
      }
      return 0;
    };
    const base = theme().chrome.slice(0, 7);
    const H = 60, B = 2;
    const bands = [];
    for (let top = 18; top < H; top += B) {
      const a = Math.round((1 - mask((top + B / 2) / H)) * 255);
      if (a > 0) bands.push(div().absolute().left(0).w_full().top(top).h(top + B >= H ? H - top + 40 : B).bg(`${base}${a.toString(16).padStart(2, "0")}`));
    }
    return div().absolute().top(0).left(0).size_full().children(bands);
  }

  render(cx) { return settle(this.body(cx)); }

  body(cx) {
    const t = theme();
    this.press ??= new Press();
    // Aggregate state across every open thread, as the sidebar shows it.
    const open = spaces().flatMap((s) => s.tabs.filter((x) => !x.settled));
    const blocked = open.some((x) => x.status === "blocked");
    const mode = open.some((x) => x.status === "working") ? "active" : "idle";
    const collapsed = narrow();
    // The one solid 28px button.
    const toggle = this.press.wire(div().id("threads-toggle").size(28).flex_none().flex().items_center().justify_center().rounded_full()
      // Frosted: translucent chrome with a hairline ring and a soft drop, over the mesh.
      .bg(t.chrome.slice(0, 7) + "99").border(1).border_color("#FFFFFF1F").shadow_sm().text_color("#FFFFFFE6").cursor_pointer()
      .hover((s) => s.text_color(t.accent))
      .tooltip(collapsed ? "Expand sidebar (Ctrl+Shift+B)" : "Collapse sidebar (Ctrl+Shift+B)")
      .on_click((_e, cx) => toggleSidebar(cx))
      .child(this.press.icon("threads-toggle", svg("mods/workspace-chrome/panel-left.svg"), 14)), "threads-toggle");
    return h_flex().id("root").size_full().relative().bg(t.chrome)
      .child(this.mesh(mode, blocked))
      .when(collapsed, (el) => el.items_center().justify_center().child(toggle))
      .when(!collapsed, (el) => el.items_center().justify_end().pr(16).child(toggle));
  }
}