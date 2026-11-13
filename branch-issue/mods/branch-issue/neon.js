// neon.js: the look Claude Usage's neon theme gives a header, drawn only while
// that theme is on: a faint hatched ground and a cyan, violet, magenta rule in
// place of the bottom border. With any other theme a header is left as it is.
// Shared byte for byte between the mods in this repository.
import { PathBuilder, Background, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, themes } from "herdr";

const NEON = "neon";
const neonSolid = (color) => String(color ?? "").slice(0, 7).toLowerCase();

// Whether the colours in use are the neon theme's, however it was picked
// (a layout, settings.json or the theme menu).
export function neonTheme() {
  const neon = themes().find((t) => t.name === NEON);
  if (!neon) return false;
  const t = theme();
  return ["accent", "chrome", "background"].every(
    (name) => !neon.colors?.[name] || neonSolid(neon.colors[name]) === neonSolid(t[name]),
  );
}

const NEON_RECT = () =>
  PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();

// A layer filling its (relative) parent. `window` here is the global painter,
// not herdr's window(): this file never imports that.
const neonLayer = (background) => window.paint_path(NEON_RECT(), background).absolute().top(0).left(0).size_full();

const neonHalf = (from, to) =>
  div().relative().flex_1().h_full().child(neonLayer(Background.linear_gradient(90, neonSolid(from), neonSolid(to)).color_space("oklab")));

// The 2px rule along the bottom of a relative parent.
export function NeonRule() {
  const t = theme();
  return h_flex()
    .absolute()
    .left(0)
    .right(0)
    .bottom(0)
    .h(2)
    .child(neonHalf(t.ansi6, t.unknown))
    .child(neonHalf(t.unknown, t.ansi5));
}

// The rule's last colour alone, for a bar that continues one drawn beside it
// (Better Sidebar's panel toggle, right of Better Tabs' bar).
export function NeonRuleEnd() {
  return div().absolute().left(0).right(0).bottom(0).h(2).bg(neonSolid(theme().ansi5));
}

// The rule's first colour alone, as a 2px line in the flow: the top of Better
// Sidebar's lists, under Herdr's own sidebar header, level with Better Tabs' rule.
export function NeonRuleStart() {
  return div().flex_none().w_full().h(2).bg(neonSolid(theme().ansi6));
}

// A header in the neon look while the theme is on; `hatch: false` keeps only the rule.
export function NeonHeader(el, { hatch = true } = {}) {
  if (!neonTheme()) return el;
  const t = theme();
  let header = el.relative().border_color("#00000000");
  if (hatch) header = header.child(neonLayer(Background.pattern_slash(`${neonSolid(t.accent)}0c`, 1, 7)));
  return header.child(NeonRule());
}
