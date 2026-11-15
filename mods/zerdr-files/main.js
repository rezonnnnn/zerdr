// A lazy file browser for the focused pane's folder, or a folder chosen per space,
// with bounded read-only previews and rendered Markdown.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, shared, setShared, pickFolder, home } from "herdr";

// Chosen folders, per space id; shared state persists across restarts.
const PINS = "zerdr-files.pins";
const pins = () => shared(PINS) ?? {};
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const extOf = path => (path.split(/[\\/]/).pop().match(/\.([^.]+)$/)?.[1] ?? "txt").toLowerCase();

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pin = space ? pins()[space.id] : null;
  if (pin) return { cwd: pin, on: space.machine ?? null, space: space.id, pinned: true };
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id, pinned: false };
}

const isAbsolute = path => /^([a-zA-Z]:)?[\\/]/.test(path);

const isWindows = () => window()?.platform === "windows";
// Comparable path: forward slashes; case-insensitive on Windows.
const same = path => { const p = String(path).replace(/\\/g, "/"); return isWindows() ? p.toLowerCase() : p; };
// Splits an absolute path into its prefix ("C:/", "//server/share/", "/") and the rest.
function splitAbsolute(path) {
  const m = path.replace(/\\/g, "/").match(/^([a-zA-Z]:\/?|\/\/[^/]+\/[^/]+\/?|\/)(.*)$/);
  return m ? [m[1].endsWith("/") ? m[1] : m[1] + "/", m[2]] : ["", path];
}

// Folds "a/../b" and "./" out of a slash path; leading ".." stays (the OS resolves it).
function normalize(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop(); else out.push(part);
  }
  return out.join("/");
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", mdx: "markdown" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw 'Not a folder' }; @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.history = []; this.mode = "preview";
    this.input = InputState.new({ placeholder: "Paste a folder path, Enter to open" });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; this.input.set_value(this.root ?? ""); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(this.input.value(), cx));
    // Opened as a viewer: props { file } (absolute, or under the folder shown); kept across focus changes.
    this.viewer = _props?.file ?? null;
    this.refresh(cx);
    if (this.viewer) this.show(this.viewer, cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  async close() { this.code?.release(); this.input?.release(); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, history: this.history });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.pathError = null;
      if (this.viewer && this.file) { if (this.text === null) this.load(this.file, cx, false); }
      else { this.show(null); this.history = saved?.history ?? []; if (saved?.file) this.show(saved.file, cx); }
      // Not from render: keep the path bar in step with the folder shown.
      cx.spawn(async cx => { if (!this.typing) this.input.set_value(this.root ?? ""); cx.notify(); });
    } else if (this.file) this.load(this.file, cx, true);
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[same(`${top.stdout.trim()}/${entry.slice(3)}`)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Opens a file (a path under the root; may start with ".." after a link). null closes it.
  show(path, cx) {
    this.code?.release(); this.code = null; this.text = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    this.load(path, cx, false);
  }

  // Reads the file; on a reload, changes nothing unless its text changed (keeps scroll).
  load(path, cx, reload) {
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      let changed = false;
      try {
        const raw = await readTextFile(isAbsolute(path) ? path : `${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (raw === null) { if (!reload) { this.fileError = "This file is no longer available"; changed = true; } return; }
        if (raw.includes("\0")) { changed = this.fileError === null; this.fileError = "Binary file · no text preview"; return; }
        const text = raw.length > 400000 ? raw.slice(0, 400000) + "\n\n… (file truncated)" : raw;
        if (reload && text === this.text && !this.fileError) return;
        changed = true;
        this.text = text; this.fileError = null;
        if (MARKDOWN.has(extOf(path)) && this.mode === "preview") { this.code?.release(); this.code = null; return; }
        if (this.code && reload) this.code.set_value(text); else { this.code?.release(); this.makeCode(path); }
      } catch { if (this.file === path && this.current(context) && !reload) { this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; changed = true; } }
      finally { if (changed) cx.notify(); }
    });
  }

  makeCode(path) {
    const t = theme(), ext = extOf(path);
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: this.text, soft_wrap: true,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  setMode(mode, cx) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.code?.release(); this.code = null;
    if (mode === "source" && this.text !== null) this.makeCode(this.file);
    cx.notify();
  }

  open(path, cx) {
    if (this.file) this.history.push(this.file);
    if (this.history.length > 50) this.history.shift();
    this.show(path, cx); cx.notify();
  }

  back(cx) {
    this.show(this.history.pop() ?? null, cx); cx.notify();
  }

  // Markdown links: web links go to the browser, file links open here.
  link(url, cx) {
    if (/^[a-z][a-z0-9+.-]+:/i.test(url) && !/^file:/i.test(url) && !/^[a-zA-Z]:[\\/]/.test(url)) {
      const [cmd, args] = window()?.platform === "windows" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : window()?.platform === "macos" ? ["open", [url]] : ["xdg-open", [url]];
      exec(cmd, args).catch(() => {});
      return;
    }
    let target = url.replace(/^file:\/\/(\/(?=[a-zA-Z]:))?/i, "").split("#")[0];
    if (!target) return;
    try { target = decodeURIComponent(target); } catch {}
    target = target.replace(/\\/g, "/");
    const root = (this.root ?? "").replace(/\\/g, "/");
    // "/docs/x.md" on Windows means the folder shown, not the drive root.
    if (isWindows() && /^\/(?!\/)/.test(target)) target = `${root}${target}`;
    this.notice = null;
    if (isAbsolute(target)) {
      const [prefix, rest] = splitAbsolute(target), full = prefix + normalize(rest);
      const inside = same(full).startsWith(same(root) + "/");
      this.open(inside ? normalize(full.slice(root.length + 1)) : full, cx); return;
    }
    const file = this.file.replace(/\\/g, "/"), dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    if (!isAbsolute(file)) { this.open(normalize(`${dir}/${target}`), cx); return; }
    const [prefix, rest] = splitAbsolute(`${dir}/${target}`);
    this.open(prefix + normalize(rest), cx);
  }

  // Shows a typed or picked folder for this space; "" goes back to following the pane.
  choose(value, cx) {
    let path = (value ?? "").trim().replace(/^["']|["']$/g, "");
    const active = spaces().find(s => s.active), space = active?.id, on = active?.machine ?? null;
    if (!space) return;
    if (!on && (path === "~" || path.startsWith("~/") || path.startsWith("~\\"))) path = home() + path.slice(1);
    if (path.length > 3) path = path.replace(/[\\/]+$/, "");
    if (!path) { this.pin(space, null); return; }
    if (!isAbsolute(path)) { this.pathError = "Use a full path, e.g. C:\\Users\\…"; cx.notify(); return; }
    cx.spawn(async cx => {
      try { await directory(path, on); this.pathError = null; this.pin(space, path); }
      catch { this.pathError = `Not a folder: ${path}`; }
      cx.notify();
    });
  }

  pin(space, path) {
    const next = { ...pins() };
    if (path) next[space] = path; else delete next[space];
    setShared(PINS, next);
  }

  browse(cx) {
    if (spaces().find(s => s.active)?.machine) { this.pathError = "Browse is local only: type the remote path"; cx.notify(); return; }
    cx.spawn(async cx => {
      const path = await pickFolder({ prompt: "Choose a folder for Files" });
      if (path) this.choose(path, cx);
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[same(`${this.root}/${path}`)];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { if (entry.dir) this.toggle(path, cx); else { this.history = []; this.notice = null; this.show(path, cx); cx.notify(); } })
        .child(entry.dir ? svg(`mods/zerdr-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/zerdr-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), pinned = Boolean(this.context && JSON.parse(this.context.key).pinned);
    const md = Boolean(this.file) && MARKDOWN.has(extOf(this.file));
    const button = (id, label, onClick, active = false) => div().id(id).px(8).h(24).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).border_1().border_color(active ? t.input : t.border)
      .hover(s => s.bg(t.hover)).on_click(onClick).child(label);
    const pathBar = v_flex().flex_none().px(10).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().id("files-path").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).w_full().text_size(12).text_color(t.foreground)))
        .child(button("files-browse", "Browse…", (_e, cx) => this.browse(cx))))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_1().min_w(0).truncate().text_color(this.pathError ? t.blocked : pinned ? t.accent : t.dim)
          .child(this.pathError ?? (pinned ? "Pinned folder for this project" : "Following the focused pane")))
        .when(pinned, el => el.child(button("files-follow", "Follow pane", (_e, cx) => { this.pathError = null; this.choose("", cx); }))));
    const viewer = () => {
      if (this.fileError || this.text === null) return div().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
      if (md && this.mode === "preview")
        return v_flex().id("files-md").flex_1().min_h(0).px(16).py(10)
          .child(TextView.markdown(`files-md-${this.file}`, this.text).scrollable(true).selectable(true).size_full().text_size(13)
            .on_link_click((url, cx) => this.link(url, cx)));
      return this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("Loading file…");
    };
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.notice = null; this.back(cx); }).child("←")))
        .child(div().font_semibold().flex_none().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(md, el => el.child(h_flex().flex_none().gap(4)
          .child(button("files-preview", "Preview", (_e, cx) => this.setMode("preview", cx), this.mode === "preview"))
          .child(button("files-source", "Source", (_e, cx) => this.setMode("source", cx), this.mode === "source")))))
      .when(!this.file, el => el.child(pathBar).child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && Boolean(this.notice), el => el.child(div().flex_none().px(14).py(6).text_size(11).text_color(t.blocked).border_b(1).border_color(t.border).child(this.notice)))
      .when(Boolean(this.file), el => el.child(viewer()));
  }
}
