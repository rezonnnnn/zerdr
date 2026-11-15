// Same file in zerdr-viz, zerdr-sidebar, zerdr-agents and zerdr-header (mods cannot import
// across folders): edit one, copy to all.
// Icon-button motion, native only: the icon grows ~15% while hovered and dips to 90% for a
// moment when pressed, easing back each time. Herdr can't scale, so this animates the icon's size.
import { div } from "gpui-kit";

// Critically damped: eases in and out with no overshoot.
const SPRING = { response: 280, damping: 1 };

export class Press {
  constructor() { this.hover = null; this.down = null; }

  // The button: tracks hover and press for its icon. Takes over the left mouse-down,
  // so it also stops propagation (no window drag).
  wire(el, id) {
    return el
      .on_hover((on, cx) => {
        if (on) this.hover = id; else if (this.hover === id) this.hover = null;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.down = id;
        cx.notify();
        cx.timer.after(140, (cx) => { if (this.down === id) { this.down = null; cx.notify(); } });
      });
  }

  // The icon, in a box whose size springs. `glyph` is an svg/image element or text.
  icon(id, glyph, size) {
    if (typeof glyph === "string") return glyph;
    const k = this.down === id ? 0.9 : this.hover === id ? 1.15 : 1;
    return div().id(`${id}-icon`).size(size * k).flex_none()
      .spring("width", SPRING).spring("height", SPRING)
      .child(glyph.size_full());
  }
}
