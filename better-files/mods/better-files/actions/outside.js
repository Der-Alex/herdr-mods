// The world outside Herdr: code editors, the file manager and the clipboard. This computer
// only: a path on another machine means nothing to an app here.
import { appHome, exec, knownAgents, readTextFile, run, setShared, shared, window } from "herdr";
import {
  DOLPHIN,
  FINDER,
  LINUX_EDITORS,
  MAC_EDITORS,
  TERMINAL_EDITORS,
  XDG_FILES,
  parentOf,
  settingsEditor,
} from "../files/model.js";

const FOUND = "better-files.editors";
const FILE_MANAGER = "better-files.file-manager";
const ERROR = "better-files.error";
// Starts a Linux app detached (setsid -f), so exec doesn't wait for its window to close.
const LAUNCH =
  'command -v "$1" >/dev/null || { echo "$1 not found" >&2; exit 127; }; setsid -f "$@" >/dev/null 2>&1 </dev/null';

const isMac = () => window()?.platform === "macos";

export const foundEditors = () => shared(FOUND) ?? [];

// Finder on macOS; on Linux Dolphin once it's found, until then the default one. Windows: none.
export const fileManager = () => {
  const platform = window()?.platform;
  if (platform === "windows") return null;
  return platform === "macos" ? FINDER : (shared(FILE_MANAGER) ?? XDG_FILES);
};

const onPath = async (cmd) => {
  const r = await exec("sh", ["-c", 'command -v "$1"', "find-editor", cmd], {}).catch(() => null);
  return r?.code === 0 && Boolean(r.stdout.trim());
};

export const outsideMethods = {
  // One lookup per editor, done once: on macOS Spotlight knows apps wherever they're
  // installed; on Linux, and for terminal editors anywhere, it's PATH.
  findEditors(cx, extra = []) {
    const platform = window()?.platform;
    if (platform === "windows") return;
    const mac = platform === "macos";
    const more = extra.map((e) => settingsEditor(e, mac)).filter(Boolean);
    cx.spawn(async (cx) => {
      const found = [];
      const seen = (editor) => found.some((f) => f.bundle === editor.bundle && f.cmd === editor.cmd);
      const editors = mac
        ? [...MAC_EDITORS, ...TERMINAL_EDITORS, ...more]
        : [...LINUX_EDITORS, ...TERMINAL_EDITORS, ...more];
      for (const editor of editors) {
        if (seen(editor)) continue;
        if (editor.bundle) {
          const r = await exec(
            "mdfind",
            [`kMDItemCFBundleIdentifier == '${String(editor.bundle).replace(/'/g, "")}'`],
            {},
          ).catch(() => null);
          if (r?.code === 0 && r.stdout.trim()) found.push(editor);
        } else if (await onPath(editor.cmd)) found.push(editor);
      }
      setShared(FOUND, found);
      if (!mac) setShared(FILE_MANAGER, (await onPath(DOLPHIN.cmd)) ? DOLPHIN : XDG_FILES);
      cx.notify();
    });
  },

  // Show diff is only offered where Better Changes can answer it.
  findBetterChanges(cx) {
    cx.spawn(async (cx) => {
      const manifest = await readTextFile(`${appHome()}/mods/better-changes/mod.json`).catch(
        () => null,
      );
      setShared("better-files.has-changes", Boolean(manifest));
      cx.notify();
    });
  },

  findNewAgents(on, cx) {
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents({ on: on ?? null });
        setShared(
          "better-files.new-agents",
          known.filter((a) => a.installed).map((a) => ({ key: a.key, name: a.name, run: a.run })),
        );
      } catch {
        setShared("better-files.new-agents", []);
      }
      cx.notify();
    });
  },

  // macOS's `open` returns at once; a Linux app is started detached.
  async launch(argv, what) {
    const [cmd, ...args] = isMac() ? argv : ["sh", "-c", LAUNCH, "launch", ...argv];
    const r = await exec(cmd, args, {}).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) setShared(ERROR, `Could not ${what}: ${r.stderr?.trim() || "it failed"}`);
    else setShared(ERROR, null);
  },

  // A terminal editor gets a Herdr terminal tab, started in `folder` so it sees the project.
  openInEditor(editor, path, folder) {
    if (!editor) return;
    if (editor.terminal) {
      run("terminal.open", { argv: [editor.cmd, path], folder, place: "tab" });
      setShared(ERROR, null);
      return;
    }
    const what = `open it in ${editor.name}`;
    if (editor.bundle) return this.launch(["open", "-b", editor.bundle, path], what);
    return this.launch([editor.cmd, path], what);
  },

  // Whatever macOS opens the file with. Linux has no item for it.
  openWithDefault(path) {
    return this.launch(["open", path], "open it");
  },

  // The file or folder, selected in its parent folder where the file manager can do that.
  revealInFileManager(path) {
    const fm = fileManager();
    if (!fm) return;
    const what = `show it in ${fm.name}`;
    if (fm === FINDER) return this.launch(["open", "-R", path], what);
    if (fm.select) return this.launch([fm.cmd, "--select", path], what);
    return this.launch([fm.cmd, parentOf(path)], what);
  },

  // The folder itself.
  openInFileManager(path) {
    const fm = fileManager();
    if (fm) return this.launch([fm.cmd, path], `open it in ${fm.name}`);
  },
};
