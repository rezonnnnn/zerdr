import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, setShared } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Git's error text, said plainly: what went wrong and what to do next.
const firstLine = (text) => (text.split("\n").map((l) => l.replace(/^(error|fatal|hint):\s*/i, "").trim()).find(Boolean) ?? "unknown error");
function plain(e) {
  const text = String(e?.stderr || e?.stdout || e?.message || e).trim();
  if (/Please tell me who you are|unable to auto-detect email|empty ident/i.test(text)) return "Git doesn't know your name and email yet. Set user.name and user.email in git, then commit again.";
  if (/index\.lock/i.test(text)) return "Another git command is using this repository. Wait for it to finish, then try again.";
  if (/partial commit during a merge|cherry-pick|rebase/i.test(text)) return "A merge, rebase or cherry-pick is in progress, so git won't commit only some files. Finish it in a terminal first.";
  if (/nothing to commit|no changes added|nothing added/i.test(text)) return "The checked files have nothing new to commit.";
  if (/did not match any file/i.test(text)) return "A checked file no longer exists in git. The list has been refreshed; check your files and try again.";
  if (/hook/i.test(text)) return `A git hook stopped the commit: ${firstLine(text)}`;
  return `Git couldn't commit: ${firstLine(text)}`;
}
// Windows caps one command line near 32k characters; leave room for git's own arguments.
const MAX_ARGS = 24000;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.picks = {};
    this.input = TextareaState.new({ placeholder: "Commit message · Ctrl+Enter to commit", rows: 1 });
    this.input.set_auto_grow(1, 5);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    // A submit with the secondary modifier (Ctrl on Windows) commits; a plain Enter only adds a line.
    this.input.on("submit", (e, cx) => { if (e?.secondary) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.picks = {}; this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "This folder isn't in a git repository"; this.publish(null); return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        // Porcelain -z writes a rename as "XY new\0old\0", so the old path is the next field.
        const raw = status.stdout.split("\0"), entries = [];
        for (let i = 0; i < raw.length; i++) {
          if (!raw[i]) continue;
          const xy = raw[i].slice(0, 2), path = raw[i].slice(3);
          const orig = /[RC]/.test(xy) ? raw[++i] : null;
          entries.push({ xy, path, orig: xy.includes("R") ? orig : null });
        }
        for (const { xy, path, orig } of entries.slice(0, 1000)) {
          const fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : orig ? "R" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, orig, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.publish(files.length);
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = `Couldn't read this folder's changes: ${firstLine(String(e?.message ?? e))}`; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  // The top bar's Changes tooltip reads this; written only when it changes.
  publish(count) {
    if (this.published === count) return;
    this.published = count; setShared("changes.count", count);
  }

  // Tracked changes start checked; untracked files start unchecked.
  checked(f) { return this.picks[f.path] ?? !f.fresh; }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // Commits the checked files only. Checked untracked files are added first; `--only` leaves
  // anything else already staged out of the commit. A rename passes its old and new path.
  commit(cx) {
    const chosen = this.files.filter((f) => this.checked(f));
    if (!this.message.trim() || !chosen.length || !this.root || this.busy || this.loading || this.context !== key()) return;
    const fresh = chosen.filter((f) => f.fresh).map((f) => f.path);
    const paths = [...new Set(chosen.flatMap((f) => (f.orig ? [f.orig, f.path] : [f.path])))];
    if (paths.join(" ").length > MAX_ARGS) { this.note = "Too many files are checked for one commit. Uncheck some, or commit from a terminal."; cx.notify(); return; }
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const git = (args) => exec("git", ["--literal-pathspecs", ...args], { cwd: root, on });
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      let added = false, committed = false;
      try {
        if (fresh.length) {
          const r = await git(["add", "--", ...fresh]);
          if (r.code !== 0) throw r;
          added = true;
        }
        const r = await git(["commit", "-m", message, "--only", "--", ...paths]);
        if (r.code !== 0) throw r;
        committed = true;
        if (key() === context) { this.message = ""; this.input.set_value(""); this.picks = {}; }
      } catch (e) {
        // A failed commit must not leave the new files staged.
        if (added && !committed) await git(["rm", "--cached", "-q", "--ignore-unmatch", "--", ...fresh]).catch(() => null);
        if (key() === context) this.note = plain(e);
      }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  row(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), on = this.checked(f);
    const letter = { M: "#7fb4ff", R: "#7fb4ff", A: t.working, D: "#f2765a", U: t.blocked }[f.status] ?? t.muted;
    const box = div().id(`pick-${f.path}`).size(14).flex_none().flex().items_center().justify_center().rounded(4).border(1)
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).text_color(t.chrome).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.picks[f.path] = !on; cx.stop_propagation(); cx.notify(); })
      .when(on, (e) => e.child(svg("mods/zerdr-changes/check.svg").size(10)));
    return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(box)
      .child(div().w(14).text_size(11).text_color(letter).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const tracked = this.files.filter((f) => !f.fresh), untracked = this.files.filter((f) => f.fresh);
    const count = this.files.filter((f) => this.checked(f)).length;
    const newOnes = untracked.filter((f) => this.checked(f));
    const enabled = Boolean(this.message.trim() && count && this.root && !this.busy && !this.loading);
    const rows = this.files.length + (untracked.length ? 1 : 0);
    return v_flex().id("changes").size_full().min_h(0).rounded(12).overflow_hidden().bg(t.background).border_1().border_color("#ffffff14").text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, rows * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(tracked.map((f) => this.row(f, t)))
        .when(untracked.length > 0, (e) => e.child(h_flex().h(28).flex_none().px(8).items_center().text_size(11).text_color(t.dim).child(`Untracked · ${untracked.length}`)))
        .children(untracked.map((f) => this.row(f, t)))
        .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color("#f2765a").child(this.note)))
      // Scope line: a checked untracked file is about to be added to git.
      .when(newOnes.length > 0, (e) => e.child(div().px(12).pt(8).text_size(11).text_color(t.muted).truncate()
        .child(`Adds ${newOnes.length} new ${newOnes.length === 1 ? "file" : "files"} to git: ${newOnes.map((f) => f.path.split("/").pop()).join(", ")}`)))
      .child(h_flex().flex_none().p(10).gap(8).items_end().border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).min_h(32).px(10).py(6).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex_none().flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx))
          .child(this.busy ? "Committing…" : `Commit ${count} ${count === 1 ? "file" : "files"}`)));
  }
}
