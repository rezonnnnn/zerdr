// New project dialog (opened as an overlay from zerdr-sidebar's folder-plus button).
// A project is a Herdr space. Name it, or pick a folder, or both: space.new {name?, folder?}.
// A named space keeps its name; an unnamed one is called after its folder. With neither,
// space.new would open a copy of the current space under the same folder name, so Create
// waits for one of them. The folder defaults to where the focused terminal is.
// The project is also saved (shared "projects": [{name, folder}]) so zerdr-sidebar keeps
// listing it after its space closes; starting a thread there makes the space again.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, run, closeOverlay, props, focused, pickFolder, shared, setShared } from "herdr";

const ICONS = "mods/workspace-chrome";
const PROJECTS = "projects";
const key = (f) => (f ?? "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const base = (f) => (f ?? "").split(/[\\/]/).filter(Boolean).pop() ?? f;

export default class NewProject extends View {
  init(_props, cx) {
    this.folder = null;
    this.name = InputState.new({ placeholder: "e.g. Rooms dashboard" });
    this.name.on("change", (_e, cx) => cx.notify());
    this.name.on("submit", (_e, cx) => this.create(cx));
    this.name.focus();
  }

  ready() { return Boolean(this.name.value().trim() || this.folder); }

  create() {
    if (!this.ready()) return;
    const name = this.name.value().trim() || undefined;
    closeOverlay(props().overlay);
    run("space.new", { name, folder: this.folder ?? undefined });
    const folder = this.folder ?? focused()?.cwd;
    if (folder) {
      const saved = (shared(PROJECTS) ?? []).filter((p) => key(p.folder) !== key(folder));
      setShared(PROJECTS, [...saved, { name: name ?? base(folder), folder }]);
    }
  }

  choose(cx) {
    cx.spawn(async (cx) => {
      const f = await pickFolder({ prompt: "Choose the project's folder" });
      if (f) { this.folder = f; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const head = (label) => div().px(10).pt(8).pb(6).text_size(12).font_weight(600).text_color(t.muted).child(label);
    const field = () => h_flex().w_full().rounded(9).border(1).border_color(t.border).bg(t.raised).text_color(t.foreground).text_size(13);
    const here = focused()?.cwd ?? "the current folder";
    const ok = this.ready();

    const folder = field().id("folder").h(34).pl(10).pr(4).gap(6).items_center()
      .child(svg(`${ICONS}/folder.svg`).size(14).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(this.folder ? t.foreground : t.dim)
        .tooltip(this.folder ?? here).child(this.folder ?? `Current: ${here}`))
      .when(Boolean(this.folder), (el) => el.child(div().id("clear").size(24).flex_none().flex().items_center().justify_center()
        .rounded(6).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Use the current folder")
        .on_click((_e, cx) => { this.folder = null; cx.notify(); })
        .child(svg(`${ICONS}/x.svg`).size(12))))
      .child(div().id("choose").h(26).px(10).flex_none().flex().items_center().rounded(6).text_size(12)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.choose(cx)).child("Choose…"));

    return v_flex().id("zerdr-new-project").size_full().min_h(0).bg(t.chrome).p(8).text_size(13)
      .child(head("Name"))
      .child(div().px(10).child(field().h(34).px(10).items_center().child(Input.new(this.name).w_full().text_size(13).text_color(t.foreground))))
      .child(head("Folder (optional)"))
      .child(div().px(10).child(folder))
      .child(h_flex().justify_end().px(10).pt(14).pb(4)
        // The one primary style (as Start and Commit): solid when it can run, raised when it can't.
        .child(h_flex().id("create").h(32).px(14).gap(7).items_center().rounded(8)
          .font_weight(500).bg(ok ? t.solid : t.raised).text_color(ok ? t.solid_foreground : t.dim)
          .when(ok, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)))
          .tooltip(ok ? "Create project" : "Give it a name or choose a folder")
          .on_click((_e, cx) => this.create(cx))
          .child("Create project ↵")));
  }
}
