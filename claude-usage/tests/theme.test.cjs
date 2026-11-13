const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const theme = JSON.parse(fs.readFileSync(path.join(root, 'themes/neon.json'), 'utf8'));

// The colour names Herdr's theme() hands to mods (herdr.d.ts), plus ring.
const NAMES = ['canvas', 'chrome', 'surface', 'popover', 'raised', 'hover', 'selected', 'border', 'input', 'foreground', 'muted', 'dim',
  'accent', 'accent_foreground', 'solid', 'solid_foreground', 'ring', 'working', 'blocked', 'done', 'idle', 'unknown'];
const HEX = /^#[0-9a-f]{6}$/;

// WCAG contrast between two #rrggbb colours.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the theme has Herdr\'s shape, every colour #rrggbb', () => {
  for (const key of ['background', 'foreground', 'selection', 'cursor']) assert.match(theme[key], HEX, key);
  assert.equal(theme.ansi.length, 16);
  theme.ansi.forEach((c, i) => assert.match(c, HEX, `ansi${i}`));
  for (const [name, value] of Object.entries(theme.colors)) {
    assert.ok(NAMES.includes(name), `unknown colour ${name}`);
    assert.match(value, HEX, name);
  }
  for (const name of NAMES) assert.ok(theme.colors[name], `missing ${name}`);
});

test('text stays readable on the terminal and panel grounds', () => {
  for (const ground of [theme.background, theme.colors.chrome, theme.colors.surface, theme.colors.raised]) {
    assert.ok(contrast(theme.foreground, ground) >= 7, `foreground on ${ground}`);
    assert.ok(contrast(theme.colors.muted, ground) >= 4.5, `muted on ${ground}`);
    assert.ok(contrast(theme.colors.dim, ground) >= 3, `dim on ${ground}`);
  }
  theme.ansi.forEach((c, i) => {
    if (i === 0) return; // black is a ground, not a text colour
    const need = i === 8 ? 3 : 4.5;
    assert.ok(contrast(c, theme.background) >= need, `ansi${i} ${c}: ${contrast(c, theme.background).toFixed(2)}`);
  });
  assert.ok(contrast(theme.colors.solid_foreground, theme.colors.solid) >= 7, 'button text');
  assert.ok(contrast(theme.colors.accent_foreground, theme.colors.accent) >= 7, 'accent text');
  assert.ok(contrast(theme.foreground, theme.selection) >= 7, 'selected text');
});

test('the theme and the panel\'s neon palette are the same colours', () => {
  const ui = fs.readFileSync(path.join(root, 'mods/claude-usage/views/ui.js'), 'utf8');
  const neon = (name) => new RegExp(`^\\s*${name}: "(#[0-9a-f]{6})"`, 'm').exec(ui)[1];
  assert.equal(theme.ansi[6], neon('cyan'));
  assert.equal(theme.ansi[5], neon('magenta'));
  assert.equal(theme.ansi[1], neon('red'));
  assert.equal(theme.ansi[3], neon('amber'));
  assert.equal(theme.colors.accent, neon('cyan'));
  assert.equal(theme.colors.unknown, neon('violet'));
});
