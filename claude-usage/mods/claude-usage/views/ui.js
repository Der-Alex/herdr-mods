// The design kit: Herdr's sizes and type, with only what this mod uses, plus the
// telemetry look: a neon palette, segmented meters and gradient rules. UI only:
// values in, callbacks out. Components return ordinary elements, so callers can chain.
import { div, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings } from "herdr";
import { along, levelOf, LEVEL_NAMES } from "../model.js";

// Plain px: Herdr scales a mod's sizes by zoom itself.
export const TEXT = { badge: 10, caption: 11, small: 12, body: 13, big: 34 };

export const codeFont = () => settings().font_family ?? "JetBrains Mono";

// The fixed neon look: cyan to magenta on near black.
const NEON = {
  ground: "#07080d",
  card: "#0b1120",
  frame: "#00e5ff2e",
  strong: "#00e5ff66",
  text: "#d8f6ff",
  muted: "#8aa3c2",
  dim: "#4e607c",
  cyan: "#00e5ff",
  violet: "#8b5cff",
  magenta: "#ff2bd6",
  amber: "#ffb000",
  orange: "#ff6e3c",
  red: "#ff3b5c",
  hatch: "#00e5ff0c",
};

const solid = (color) => String(color ?? "#888888").slice(0, 7);

// The colours to draw with: the neon set, or the same roles from Herdr's theme.
export function palette(name) {
  if (name !== "theme") return NEON;
  const t = theme();
  return {
    ground: t.background,
    card: `${solid(t.raised)}80`,
    frame: t.border,
    strong: t.input ?? t.border,
    text: t.foreground,
    muted: t.muted,
    dim: t.dim,
    cyan: solid(t.ansi6),
    violet: solid(t.ansi4),
    magenta: solid(t.ansi5),
    amber: solid(t.ansi3),
    orange: solid(t.ansi9 ?? t.ansi3),
    red: solid(t.ansi1),
    hatch: `${solid(t.foreground)}08`,
  };
}

// Each level's gradient, from the start of a meter to its end.
export function stops(p, level) {
  if (level === "crit") return [p.red, p.magenta];
  if (level === "warn") return [p.amber, p.orange];
  return [p.cyan, p.violet, p.magenta];
}

const levelColor = (p, level) => (level === "crit" ? p.red : level === "warn" ? p.amber : p.cyan);

const RECT = () =>
  PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();

// A layer that fills its (relative) parent with a gradient or a pattern.
const layer = (background) =>
  window.paint_path(RECT(), background).absolute().top(0).left(0).size_full();

export const GradientLayer = (from, to, angle = 90) =>
  layer(Background.linear_gradient(angle, from, to).color_space("oklab"));

const Hatch = (p) => layer(Background.pattern_slash(p.hatch, 1, 7));

// A thin line running cyan, violet, magenta.
export function Rule(p, height = 2) {
  return h_flex()
    .flex_none()
    .w_full()
    .h(height)
    .child(div().relative().flex_1().h_full().child(GradientLayer(p.cyan, p.violet)))
    .child(div().relative().flex_1().h_full().child(GradientLayer(p.violet, p.magenta)));
}

// The panel's frame.
export function Frame(p, id) {
  return v_flex()
    .id(id)
    .size_full()
    .min_w(0)
    .min_h(0)
    .overflow_hidden()
    .bg(p.ground)
    .text_color(p.text)
    .text_size(TEXT.body)
    .font_family(codeFont())
    .rounded(10)
    .border_1()
    .border_color(p.frame);
}

// A dot that breathes while the link is up.
export function Pulse(color, alive = true) {
  const dot = div().flex_none().w(7).h(7).rounded_full().bg(color);
  return alive ? dot.loop("opacity", { from: 0.25, to: 1, period: 1400 }) : dot;
}

// Header: the name, the link state and the plan, over a hatched ground.
export function Header(p, { link, linkColor, alive, plan, synced }) {
  const title = h_flex()
    .gap(0)
    .items_center()
    .text_size(TEXT.small)
    .font_weight(700)
    .child(div().text_color(p.magenta).child("◢◤ "))
    .child(div().text_color(p.cyan).child("CLAUDE"))
    .child(div().text_color(p.dim).font_weight(400).child(" // "))
    .child(div().text_color(p.text).child("TELEMETRY"));
  const state = h_flex()
    .gap(6)
    .items_center()
    .flex_none()
    .child(Pulse(linkColor, alive))
    .child(div().text_size(TEXT.badge).font_weight(700).text_color(p.text).child(link));
  const facts = h_flex()
    .justify_between()
    .text_size(TEXT.badge)
    .child(h_flex().gap(5).child(div().text_color(p.dim).child("PLAN")).child(div().text_color(p.muted).child(plan)))
    .child(h_flex().gap(5).child(div().text_color(p.dim).child("SYNC")).child(div().text_color(p.muted).child(synced)));
  return v_flex()
    .relative()
    .flex_none()
    .child(Hatch(p))
    .child(h_flex().h(36).px(14).pt(4).items_center().justify_between().child(title).child(state))
    .child(div().px(14).pb(9).child(facts))
    .child(Rule(p));
}

// A meter of `count` segments; the share used runs along the level's gradient
// and its leading segment pulses.
export function Segments(p, { percent, level, count, filled }) {
  const colors = stops(p, level);
  const row = h_flex().w_full().h(10).gap(3).items_center();
  for (let i = 0; i < count; i++) {
    const on = i < filled;
    let seg = div()
      .flex_1()
      .h(on ? 10 : 6)
      .rounded(2)
      .bg(on ? along(colors, count > 1 ? i / (count - 1) : 0) : p.frame);
    if (on && i === filled - 1 && percent < 100) seg = seg.loop("opacity", { from: 0.45, to: 1, period: 1600 });
    row.child(seg);
  }
  return row;
}

// A card's left edge: rounded segments running down the gradient, set in from
// the border so they stay inside its rounded corners (a painted gradient isn't
// clipped to them).
const SPINE_SEGMENTS = 8;
function Spine(colors) {
  const spine = v_flex().absolute().top(12).bottom(12).left(6).w(3).gap(2);
  for (let i = 0; i < SPINE_SEGMENTS; i++)
    spine.child(div().flex_1().w_full().rounded(2).bg(along(colors, i / (SPINE_SEGMENTS - 1))));
  return spine;
}

function Tag(p, text, color) {
  return div()
    .flex_none()
    .px(6)
    .py(1)
    .rounded(3)
    .border_1()
    .border_color(`${solid(color)}88`)
    .bg(`${solid(color)}14`)
    .text_size(TEXT.badge)
    .font_weight(700)
    .text_color(color)
    .child(text);
}

// One limit: title and state, the big number, the meter and the reset.
export function Card(p, { title, limit, missing, percent, filled, segments, left, at }) {
  const level = levelOf(limit);
  const color = limit ? levelColor(p, level) : p.dim;
  const head = h_flex()
    .items_center()
    .justify_between()
    .gap(8)
    .child(
      h_flex()
        .min_w(0)
        .gap(6)
        .items_center()
        .child(div().flex_none().text_size(TEXT.badge).text_color(p.magenta).child("◆"))
        .child(div().min_w(0).truncate().text_size(TEXT.caption).font_weight(700).text_color(p.text).child(title)),
    )
    .child(limit ? Tag(p, LEVEL_NAMES[level], color) : Tag(p, "NO SIGNAL", p.dim));
  const number = h_flex()
    .items_end()
    .gap(3)
    .child(div().text_size(TEXT.big).line_height(1).font_weight(700).text_color(color).child(limit ? percent : "--"))
    .child(div().pb(4).text_size(TEXT.body).text_color(p.dim).child("%"))
    .child(div().flex_1())
    .child(div().pb(4).text_size(TEXT.badge).text_color(p.dim).child(limit ? "USED" : ""));
  const reset = limit
    ? h_flex()
        .justify_between()
        .text_size(TEXT.badge)
        .child(
          h_flex()
            .gap(6)
            .child(div().text_color(p.dim).child("RESET IN"))
            .child(div().font_weight(700).text_color(p.text).child(left || "--")),
        )
        .child(div().text_color(p.muted).child(at || ""))
    : div().text_size(TEXT.badge).text_color(p.dim).truncate().child(missing);
  return div()
    .relative()
    .flex_none()
    .rounded(8)
    .border_1()
    .border_color(limit ? p.strong : p.frame)
    .bg(p.card)
    .overflow_hidden()
    .child(Spine(limit ? stops(p, level) : [p.frame, p.frame]))
    .child(
      v_flex()
        .pl(18)
        .pr(12)
        .py(11)
        .gap(9)
        .child(head)
        .child(number)
        .child(Segments(p, { percent: limit?.percent ?? 0, level, count: segments, filled: limit ? filled : 0 }))
        .child(reset),
    );
}

// A text button in the footer, lit on hover.
export function Action(p, { id, label, glyph, spinning = false, onClick, disabled = false }) {
  const mark = div().flex_none().w(12).text_color(p.cyan).child(glyph);
  return h_flex()
    .id(id)
    .h(24)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(4)
    .text_size(TEXT.badge)
    .font_weight(700)
    .text_color(disabled ? p.dim : p.muted)
    .accessibility_label(label)
    .child(spinning ? mark.frames(["◜", "◝", "◞", "◟"], 120) : mark)
    .child(label)
    .when(!disabled, (el) =>
      el
        .cursor_pointer()
        .hover((s) => s.bg(`${solid(p.cyan)}18`).text_color(p.text))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          onClick(cx);
        }),
    );
}

// A strip under the cards for an error and what to do about it.
export function Alert(p, message, advice) {
  return v_flex()
    .flex_none()
    .mx(12)
    .mb(10)
    .p(10)
    .gap(4)
    .rounded(6)
    .border_1()
    .border_color(`${solid(p.red)}66`)
    .bg(`${solid(p.red)}12`)
    .text_size(TEXT.badge)
    .child(div().text_color(p.red).font_weight(700).whitespace_normal().child(`▲ ${message}`))
    .when(Boolean(advice), (el) => el.child(div().text_color(p.muted).whitespace_normal().child(advice)));
}

// Shown in the panel while the telemetry runs in a terminal instead.
export function TerminalNotice(p, { onOpen }) {
  return v_flex()
    .relative()
    .flex_none()
    .rounded(8)
    .border_1()
    .border_color(p.strong)
    .bg(p.card)
    .overflow_hidden()
    .child(Spine(stops(p, "ok")))
    .child(
      v_flex()
        .pl(18)
        .pr(12)
        .py(12)
        .gap(10)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().text_size(TEXT.badge).text_color(p.magenta).child("◆"))
            .child(div().text_size(TEXT.caption).font_weight(700).child("TERMINAL MODE")),
        )
        .child(
          div()
            .text_size(TEXT.small)
            .text_color(p.muted)
            .whitespace_normal()
            .child("Telemetry runs as a TUI in a terminal pane. Set display.mode to \"panel\" to show it here."),
        )
        .child(h_flex().child(Action(p, { id: "open-terminal", label: "OPEN TERMINAL", glyph: "⌁", onClick: onOpen }))),
    );
}
