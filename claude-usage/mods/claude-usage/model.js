// What the helper's answers mean, and where the mod sits in a layout. No drawing
// and no Herdr calls, so the tests run it as plain JavaScript.

export const MOD = "claude-usage";
export const TERMINAL_NAME = "Claude Usage";

// "ok", "warn" or "crit", the same rule as the helper's Level. The server's own
// severity wins when it is anything but normal.
export function levelOf(limit) {
  if (!limit) return "ok";
  const severity = String(limit.severity ?? "").toLowerCase();
  if (["critical", "exceeded", "rejected", "blocked", "error"].includes(severity)) return "crit";
  if (limit.percent >= 90) return "crit";
  if (limit.percent >= 75) return "warn";
  if (!["", "normal", "ok"].includes(severity)) return "warn";
  return "ok";
}

export const LEVEL_NAMES = { ok: "NOMINAL", warn: "ELEVATED", crit: "CRITICAL" };

const pad = (n) => String(n).padStart(2, "0");

// Time left to the minute: "01h 18m" under a day, "3d 17h 38m" above.
export function countdown(ms) {
  if (!(ms > 0)) return "00h 00m";
  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  return days > 0 ? `${days}d ${pad(hours)}h ${pad(rest)}m` : `${pad(hours)}h ${pad(rest)}m`;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
// "FRI 11:39" in local time.
export function resetClock(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${DAYS[at.getDay()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function clock(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function percentText(limit) {
  return String(Math.round(Math.max(0, Math.min(999, limit.percent))));
}

// How many of `count` segments the used share fills; any use shows at least one.
export function filledSegments(percent, count) {
  const share = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
  const filled = Math.round(share * count);
  return percent > 0 && filled === 0 ? 1 : filled;
}

// "#rrggbb" a share `t` of the way from `a` to `b`.
export function mix(a, b, t) {
  const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const part = (i) =>
    Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * Math.max(0, Math.min(1, t)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(0)}${part(1)}${part(2)}`;
}

// A colour along a list of stops, `t` from 0 to 1.
export function along(stops, t) {
  const span = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(span), stops.length - 2);
  return mix(stops[i], stops[i + 1], span - i);
}

// The three cards, each with its limit or why there is none.
export function cards(report, error, model) {
  const missing = error ? "NO DATA" : "AWAITING FIRST SYNC";
  if (!report)
    return [
      { id: "session", title: "SESSION · 5H", missing },
      { id: "weekly", title: "WEEKLY · ALL MODELS", missing },
      { id: "model", title: `WEEKLY · ${model.toUpperCase()}`, missing },
    ];
  const others = report.models?.length ? ` · HAS ${report.models.join(", ").toUpperCase()}` : "";
  return [
    { id: "session", title: "SESSION · 5H", limit: report.session, missing: "NOT ON THIS PLAN" },
    { id: "weekly", title: "WEEKLY · ALL MODELS", limit: report.weekly, missing: "NOT ON THIS PLAN" },
    {
      id: "model",
      title: `WEEKLY · ${(report.model_name || model).toUpperCase()}`,
      limit: report.model,
      missing: `NO ${model.toUpperCase()} LIMIT${others}`,
    },
  ];
}

// The helper's answer, or an error with a kind the panel can give advice for.
export function readAnswer(result) {
  let data = null;
  try {
    data = JSON.parse(result.stdout);
  } catch {}
  if (data && !data.error && result.code === 0) return { report: data };
  return {
    error: {
      message: data?.error || result.stderr?.trim() || "The usage helper gave no answer",
      kind: data?.kind || "api",
    },
  };
}

export const ADVICE = {
  login: "Run `claude` in a terminal and log in.",
  expired: "Start Claude Code once; it renews the login.",
  network: "Check the connection; the next sync retries.",
  missing: "Install the helper: go -C helper run ./install --update",
};

// Whether a mod's block is on screen: every parent shown, and the chosen child
// of any stack. Timers run while hidden, so this saves the endpoint's quota.
export function panelShown(node, mod = MOD) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === mod) return true;
  const children = node.children ?? [];
  if (node.type !== "stack") return children.some((child) => panelShown(child, mod));
  const active = children.find((child) => child.id === node.active) ?? children[0];
  return panelShown(active, mod);
}

// The nodes from the root down to the mod's block, or null.
export function pathTo(node, mod = MOD) {
  if (!node) return null;
  if (node.content?.mod === mod) return [node];
  for (const child of node.children ?? []) {
    const below = pathTo(child, mod);
    if (below) return [node, ...below];
  }
  return null;
}

// What puts the panel away once terminal mode has opened the TUI: pick another
// child of the stack it sits in, so showing the panel again doesn't land here,
// and hide the container around that stack, as Better Tabs' panel buttons do.
// Null when the mod isn't in a stack: it then stays on screen.
export function awayCommands(root, mod = MOD) {
  const path = pathTo(root, mod);
  if (!path) return null;
  for (let i = path.length - 2; i >= 1; i--) {
    const stack = path[i];
    const container = path[i - 1];
    if (stack.type !== "stack" || !container?.id || i - 1 === 0) continue;
    const other = (stack.children ?? []).find((child) => child !== path[i + 1] && child.id);
    const commands = other ? [["layout.select", { stack: stack.id, child: other.id }]] : [];
    return [...commands, ["layout.hide", { id: container.id }]];
  }
  return null;
}

// The argv a terminal runs for the TUI.
export function terminalArgv(binary, settings, everyMs) {
  return [
    binary,
    "tui",
    "--every",
    `${Math.max(30, Math.round(everyMs / 1000))}s`,
    "--model",
    settings.model,
    "--palette",
    settings.style.palette === "theme" ? "theme" : "neon",
  ];
}

// The TUI's terminal while the TUI still runs in it: once it quits, the terminal
// holds a shell. Herdr names a terminal by its address; hc's shape has `address`.
export function findTerminal(list) {
  const isTUI = (argv) => Array.isArray(argv) && /(^|\/)claude-usage$/.test(argv[0] ?? "") && argv[1] === "tui";
  const running = (list ?? []).find((t) => t?.state !== "finished" && isTUI(t?.foreground?.argv ?? t?.argv));
  if (!running) return null;
  return { ...running, address: running.address ?? running.terminal ?? running.id };
}
