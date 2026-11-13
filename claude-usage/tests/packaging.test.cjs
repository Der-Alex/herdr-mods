const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, 'mods/claude-usage');

test('package owns its helper and has no custom-mod or layout dependency', () => {
  const source = fs.readFileSync(path.join(runtime, 'main.js'), 'utf8');
  assert.doesNotMatch(source, /better-tabs|panel-body|estro/);
  assert.match(source, /appHome\(\)\}\/mods\/\$\{MOD\}\/bin\/claude-usage/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'mod.json'))).title, 'Claude Usage');
  for (const file of ['main.js', 'model.js', 'settings.js', 'mod.json', 'mod.schema.json', 'views/ui.js', 'icons/gauge.svg'])
    assert.ok(fs.existsSync(path.join(runtime, file)), file);
  for (const file of ['themes/neon.json', 'helper/go.mod', 'helper/main.go', 'helper/main_test.go', 'helper/install/main.go', 'README.md', 'RECIPE.md', '.gitignore'])
    assert.ok(fs.existsSync(path.join(root, file)), file);
  // The toolbar button RECIPE.md describes points at the shipped icon.
  assert.match(fs.readFileSync(path.join(root, 'RECIPE.md'), 'utf8'), /mods\/claude-usage\/icons\/gauge\.svg/);
});

test('settings.js is the shared copy', () => {
  assert.equal(
    fs.readFileSync(path.join(runtime, 'settings.js'), 'utf8'),
    fs.readFileSync(path.join(root, '../branch-pr/mods/branch-pr/settings.js'), 'utf8'),
  );
});

test('every name imported from another file of the mod is exported there', () => {
  for (const file of ['main.js', 'model.js', 'settings.js', 'views/ui.js']) {
    const code = fs.readFileSync(path.join(runtime, file), 'utf8');
    for (const [, names, from] of code.matchAll(/^import \{([^}]*)\} from "(\.[^"]+)";/gm)) {
      const target = fs.readFileSync(path.join(runtime, path.dirname(file), from), 'utf8');
      for (const name of names.split(',').map((n) => n.trim()).filter(Boolean))
        assert.match(target, new RegExp(`^export (async )?(function|const|class) ${name}\\b`, 'm'), `${file} imports ${name} from ${from}`);
    }
  }
});

test('the panel and the helper agree on the settings they pass', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(runtime, 'mod.schema.json'), 'utf8')).properties.settings.properties;
  assert.deepEqual(schema.style.properties.palette.enum, ['neon', 'theme']);
  assert.deepEqual(schema.terminal.properties.place.enum, ['right', 'down', 'tab']);
  const helper = fs.readFileSync(path.join(root, 'helper/main.go'), 'utf8');
  for (const flag of ['"model"', '"every"', '"palette"']) assert.ok(helper.includes(flag), flag);
});

test('every mod that follows the neon theme carries the same neon.js, reading colours the theme sets', () => {
  const repo = path.resolve(root, '..');
  const expected = ['better-changes', 'better-config', 'better-files', 'better-sidebar', 'better-tabs', 'branch-issue', 'branch-pr'];
  const copies = fs.readdirSync(repo).filter((d) => fs.existsSync(path.join(repo, d, 'mods', d, 'neon.js')));
  for (const mod of expected) assert.ok(copies.includes(mod), `${mod} has no neon.js`);
  const first = fs.readFileSync(path.join(repo, copies[0], 'mods', copies[0], 'neon.js'), 'utf8');
  for (const mod of copies)
    assert.equal(fs.readFileSync(path.join(repo, mod, 'mods', mod, 'neon.js'), 'utf8'), first, `${mod}/neon.js differs`);
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'themes/neon.json'), 'utf8'));
  for (const name of ['accent', 'chrome', 'unknown']) assert.ok(theme.colors[name], name);
  assert.ok(theme.background && theme.ansi[5] && theme.ansi[6]);
  assert.match(first, /name === NEON/);
  assert.match(first, /const NEON = "neon";/);
});

test('neon.js decorates a header only while the neon theme is the one in use', () => {
  const vm = require('node:vm');
  const theme = JSON.parse(fs.readFileSync(path.join(root, 'themes/neon.json'), 'utf8'));
  const neonColors = { ...theme.colors, background: theme.background, ansi5: theme.ansi[5], ansi6: theme.ansi[6] };
  let current = neonColors;
  const el = () => {
    const node = { calls: [], kids: [] };
    const proxy = new Proxy(node, {
      get: (t, k) => (k in t ? t[k] : (...a) => { if (k === 'child') t.kids.push(a[0]); else t.calls.push([k, ...a]); return proxy; }),
    });
    return proxy;
  };
  const chain = () => new Proxy({}, { get: () => () => chain() });
  const context = {
    div: el, h_flex: el,
    PathBuilder: { fill: chain },
    Background: { linear_gradient: chain, pattern_slash: chain },
    window: { paint_path: () => el() },
    theme: () => current,
    themes: () => [{ name: 'graphite', colors: { accent: '#a7b4c6' } }, { name: 'neon', colors: neonColors }],
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, '../better-files/mods/better-files/neon.js'), 'utf8')
    .replace(/^import\s+[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nObject.assign(globalThis, { neonTheme, NeonHeader, NeonRule });`, context);

  assert.equal(context.neonTheme(), true);
  const header = context.NeonHeader(el());
  assert.equal(header.kids.length, 2, 'hatch and rule');
  assert.ok(header.calls.some(([k, v]) => k === 'border_b' && v === 0));
  assert.equal(context.NeonHeader(el(), { hatch: false }).kids.length, 1, 'rule only');

  current = { ...neonColors, accent: '#a7b4c6', chrome: '#1b1d22' };
  assert.equal(context.neonTheme(), false);
  const plain = context.NeonHeader(el());
  assert.equal(plain.kids.length, 0);
  assert.equal(plain.calls.length, 0);
});
