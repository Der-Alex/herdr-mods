// Claude Usage: Claude's plan limits as telemetry. The current session, the
// week across all models and the week of one model, each with the time to its
// reset. It draws in its panel, or runs as a TUI in a terminal pane, as
// `display.mode` says. The helper in bin/ does the reading for both.
//   model.js       what the helper's answers mean, and where the panel sits
//   views/ui.js    the look: palette, cards, meters
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, run, layout, terminals, nextCommand, appHome } from "herdr";
import { loadSettings, duration } from "./settings.js";
import {
  MOD,
  TERMINAL_NAME,
  ADVICE,
  cards,
  clock,
  countdown,
  filledSegments,
  awayCommands,
  findTerminal,
  panelShown,
  percentText,
  readAnswer,
  resetClock,
  terminalArgv,
} from "./model.js";
import { palette, Frame, Header, Card, Action, Alert, TerminalNotice } from "./views/ui.js";

// Short, so terminal mode answers the toolbar button at once; a tick only walks the layout.
const TICK_MS = 500;
const REFRESH_MS = 60000;
// The endpoint is shared with Claude Code itself: never read it more often.
const MIN_REFRESH_MS = 30000;
// Countdowns show minutes, so the panel redraws twice a minute, not every second.
const REDRAW_MS = 30000;
const SEGMENTS = 24;
// Preferences a person may change in the installed mod.json under `settings`.
const DEFAULT_SETTINGS = {
  display: { mode: "panel" },
  refresh: { every: "60s" },
  model: "Fable",
  style: { palette: "neon" },
  terminal: { place: "right" },
};

// Copies share module code: two copies loading at once open one terminal.
let lastOpened = 0;

const binary = () => `${appHome()}/mods/${MOD}/bin/claude-usage`;

class ClaudeUsage extends View {
  init(_props, cx) {
    this.settings = DEFAULT_SETTINGS;
    this.problems = [];
    this.ready = false;
    this.report = null;
    this.error = null;
    this.loading = false;
    this.syncedAt = null;
    this.triedAt = 0;
    this.shown = false;
    this.slot = 0;
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings(MOD, DEFAULT_SETTINGS);
      this.settings = settings;
      this.problems = problems;
      this.ready = true;
      this.tick(cx);
      cx.notify();
    });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    this.listen(cx);
  }

  get mode() {
    return this.settings.display.mode === "terminal" ? "terminal" : "panel";
  }

  get every() {
    return Math.max(MIN_REFRESH_MS, duration(this.settings.refresh.every, REFRESH_MS));
  }

  // Reads only while the panel is on screen and drawing itself; a terminal
  // reads on its own.
  tick(cx) {
    if (!this.ready) return;
    const shown = panelShown(layout());
    if (shown !== this.shown) {
      this.shown = shown;
      if (shown && this.mode === "terminal") this.handOff();
      cx.notify();
    }
    if (!shown || this.mode !== "panel") return;
    if (!this.loading && Date.now() - this.triedAt >= this.every) this.refresh(cx);
    const slot = Math.floor(Date.now() / REDRAW_MS);
    if (slot !== this.slot) {
      this.slot = slot;
      cx.notify();
    }
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    this.triedAt = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await exec(binary(), ["json", "--model", this.settings.model], { timeout: 30000 });
        const { report, error } = readAnswer(result);
        if (report) {
          this.report = report;
          this.error = null;
          this.syncedAt = new Date();
        } else this.error = error;
      } catch (e) {
        this.error = { message: `The usage helper didn't start: ${e.message}`, kind: "missing" };
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // While shown: claude-usage.refresh, and claude-usage.terminal for the TUI.
  listen(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        else if (command === "terminal") this.openTerminal();
        cx.notify();
      }
    });
  }

  // In terminal mode, coming on screen is the request (the toolbar button shows
  // this panel): start or focus the TUI and put the panel away.
  handOff() {
    this.openTerminal();
    for (const [name, args] of awayCommands(layout()) ?? []) run(name, args);
  }

  // Focuses the TUI if it is already running, else starts it.
  openTerminal() {
    if (Date.now() - lastOpened < 1000) return;
    lastOpened = Date.now();
    const running = findTerminal(terminals());
    if (running?.address) return run("pane.focus", { terminal: running.address });
    run("terminal.open", {
      argv: terminalArgv(binary(), this.settings, this.every),
      place: this.settings.terminal.place,
      name: TERMINAL_NAME,
    });
  }

  linkState(p) {
    if (this.mode === "terminal") return { link: "TERMINAL", linkColor: p.violet, alive: false };
    if (!this.report && this.error) return { link: "OFFLINE", linkColor: p.red, alive: false };
    if (!this.report) return { link: "SYNCING", linkColor: p.dim, alive: true };
    if (this.error) return { link: "STALE", linkColor: p.amber, alive: true };
    return { link: "LIVE", linkColor: p.cyan, alive: true };
  }

  render() {
    const p = palette(this.settings.style.palette);
    const now = Date.now();
    const root = Frame(p, "claude-usage-root").child(
      Header(p, {
        ...this.linkState(p),
        plan: this.report?.plan || "—",
        synced: this.syncedAt ? clock(this.syncedAt) : "--:--",
      }),
    );
    const body = v_flex().id("claude-usage-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10);
    if (this.mode === "terminal") body.child(TerminalNotice(p, { onOpen: () => this.openTerminal() }));
    else
      for (const card of cards(this.report, this.error, this.settings.model)) {
        const resets = card.limit?.resets_at;
        body.child(
          Card(p, {
            ...card,
            percent: card.limit ? percentText(card.limit) : "",
            filled: card.limit ? filledSegments(card.limit.percent, SEGMENTS) : 0,
            segments: SEGMENTS,
            left: resets ? countdown(Date.parse(resets) - now) : "",
            at: resets ? resetClock(resets) : "",
          }),
        );
      }
    root.child(body);
    if (this.mode === "panel" && this.error) root.child(Alert(p, this.error.message, ADVICE[this.error.kind]));
    if (this.problems.length) root.child(Alert(p, `Settings: ${this.problems.join("; ")}`));
    return root.child(
      h_flex()
        .flex_none()
        .h(34)
        .px(6)
        .items_center()
        .justify_between()
        .border_t(1)
        .border_color(p.frame)
        .child(
          Action(p, {
            id: "sync",
            label: this.loading ? "SYNCING" : "SYNC",
            glyph: "⟳",
            spinning: this.loading,
            disabled: this.loading || this.mode === "terminal",
            onClick: (cx) => this.refresh(cx),
          }),
        )
        .child(div().flex_1())
        .child(Action(p, { id: "tui", label: "TERMINAL", glyph: "⌁", onClick: () => this.openTerminal() })),
    );
  }
}

export default ClaudeUsage;
