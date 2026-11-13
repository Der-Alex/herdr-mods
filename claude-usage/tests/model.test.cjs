const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// model.js has no imports: run it as a script with its exports made plain.
const context = {};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../mods/claude-usage/model.js'), 'utf8').replace(/^export /gm, '') +
    '\nObject.assign(globalThis, { MOD, TERMINAL_NAME, levelOf, countdown, resetClock, percentText, filledSegments, mix, along, cards, readAnswer, panelShown, pathTo, awayCommands, terminalArgv, findTerminal });',
  context,
);
const m = context;
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b)); // values cross the vm boundary

test('levels follow the percentage, and the server severity when it is raised', () => {
  assert.equal(m.levelOf({ percent: 10, severity: 'normal' }), 'ok');
  assert.equal(m.levelOf({ percent: 75 }), 'warn');
  assert.equal(m.levelOf({ percent: 90 }), 'crit');
  assert.equal(m.levelOf({ percent: 10, severity: 'warning' }), 'warn');
  assert.equal(m.levelOf({ percent: 95, severity: 'warning' }), 'crit');
  assert.equal(m.levelOf({ percent: 1, severity: 'critical' }), 'crit');
  assert.equal(m.levelOf(null), 'ok');
});

test('countdowns, clocks and meters', () => {
  assert.equal(m.countdown(-5), '00h 00m');
  assert.equal(m.countdown((78 * 60 + 52) * 1000), '01h 18m');
  assert.equal(m.countdown(((3 * 24 + 17) * 60 + 38) * 60000 + 59000), '3d 17h 38m');
  assert.match(m.resetClock('2026-11-17T02:59:59Z'), /^(MON|TUE) \d\d:59$/);
  assert.equal(m.resetClock('soon'), '');
  assert.equal(m.percentText({ percent: 40.6 }), '41');
  assert.equal(m.filledSegments(0, 24), 0);
  assert.equal(m.filledSegments(0.5, 24), 1);
  assert.equal(m.filledSegments(50, 24), 12);
  assert.equal(m.filledSegments(140, 24), 24);
  assert.equal(m.mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(m.along(['#000000', '#ff0000', '#ffffff'], 1), '#ffffff');
  assert.equal(m.along(['#000000', '#ff0000', '#ffffff'], 0.5), '#ff0000');
});

test('cards say why a limit is missing', () => {
  same(m.cards(null, null, 'Fable').map((c) => c.missing), ['AWAITING FIRST SYNC', 'AWAITING FIRST SYNC', 'AWAITING FIRST SYNC']);
  assert.equal(m.cards(null, { message: 'x' }, 'Fable')[2].title, 'WEEKLY · FABLE');
  const report = { session: { percent: 7 }, weekly: { percent: 23 }, model: null, model_name: 'Opus', models: ['Fable'] };
  const [, weekly, model] = m.cards(report, null, 'Opus');
  assert.equal(weekly.limit.percent, 23);
  assert.equal(model.missing, 'NO OPUS LIMIT · HAS FABLE');
});

test('helper answers become a report or an error with a kind', () => {
  same(m.readAnswer({ code: 0, stdout: '{"session":{"percent":7}}' }), { report: { session: { percent: 7 } } });
  same(m.readAnswer({ code: 1, stdout: '{"error":"expired","kind":"expired"}' }), { error: { message: 'expired', kind: 'expired' } });
  same(m.readAnswer({ code: 1, stdout: '', stderr: 'boom\n' }), { error: { message: 'boom', kind: 'api' } });
});

// Herdr's own layout around a right-hand panel, as Better Tabs uses it.
const layout = (panelHidden, active) => ({
  type: 'row', id: 'root', children: [
    { type: 'block', id: 'main', content: { terminal: 't1' } },
    { type: 'column', id: 'panel', hidden: panelHidden, children: [
      { type: 'stack', id: 'panel-body', active, children: [
        { type: 'block', id: 'files', content: { mod: 'better-files' } },
        { type: 'block', id: 'usage', content: { mod: 'claude-usage' } },
      ] },
    ] },
  ],
});

test('the panel is found, and put away for the terminal', () => {
  assert.equal(m.panelShown(layout(false, 'usage')), true);
  assert.equal(m.panelShown(layout(false, 'files')), false);
  assert.equal(m.panelShown(layout(true, 'usage')), false);
  same(m.awayCommands(layout(false, 'usage')), [['layout.select', { stack: 'panel-body', child: 'files' }], ['layout.hide', { id: 'panel' }]]);
  const loose = { type: 'row', id: 'root', children: [{ type: 'block', id: 'usage', content: { mod: 'claude-usage' } }] };
  assert.equal(m.awayCommands(loose), null);
  assert.equal(m.awayCommands({ type: 'row', children: [] }), null);
});

test('the terminal runs the TUI with the settings, and is found again by name', () => {
  const settings = { model: 'Fable', style: { palette: 'theme' } };
  same(m.terminalArgv('/bin/cu', settings, 60000), ['/bin/cu', 'tui', '--every', '60s', '--model', 'Fable', '--palette', 'theme']);
  same(m.terminalArgv('/bin/cu', { model: 'Opus', style: { palette: 'x' } }, 5000).slice(2), ['--every', '30s', '--model', 'Opus', '--palette', 'neon']);
  const tui = { argv: ['/app/mods/claude-usage/bin/claude-usage', 'tui', '--every', '60s'] };
  assert.equal(m.findTerminal([{ terminal: 't1', foreground: { argv: ['zsh'] } }, { terminal: 't9', ...tui, foreground: tui }]).address, 't9');
  assert.equal(m.findTerminal([{ address: 't9', ...tui, foreground: { argv: ['zsh'] } }]), null);
  assert.equal(m.findTerminal([{ address: 't9', ...tui, state: 'finished' }]), null);
  assert.equal(m.findTerminal([{ address: 't9', argv: ['/bin/claude-usage', 'json'] }]), null);
  assert.equal(m.findTerminal(undefined), null);
});
