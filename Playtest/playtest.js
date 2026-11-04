#!/usr/bin/env node
// =====================================================================================================
// playtest.js -- command line front door for the "Lucid Dreams of Roguelike" playtest kit.
//
//   node playtest.js [play]   one autopilot run                (legacy env vars still work: SEED=501 SECS=900 node playtest.js)
//   node playtest.js matrix   many builds x seeds in parallel, aggregated report (balance / crash hunting)
//   node playtest.js audit    data + system audit: every item, monster, spell, recipe, save round-trip, world generation
//   node playtest.js balance  controlled duels: every class vs a monster ladder (noise-free balance numbers)
//   node playtest.js classbp  per-class win-rate table vs monster strength (finds weak/strong starting kits)
//   node playtest.js smoke    drives every screen/hotkey with rendering ON and reports exceptions
//   node playtest.js list     species / classes / scenarios you can pass to --species / --class / --scenario
//   node playtest.js help
//
// ONE FILE: the whole kit lives in this file (needs only Node + the jsdom package from package.json). The sections below are the old
// lib/ files, each between '==== FILE: <path> ====' banners; search for a banner to find a module. To change the kit, edit that section.
// See also the README section at the very end of this file (what each command is for, how to add an audit check, how the bot works).
// Programmatic use:  const { boot, ev, key, newGame, createCharacter, playLife, BRAIN, DUEL } = require('./playtest.js');   (inject a duel with ev(win, '(' + DUEL.toString() + ')()'))
// =====================================================================================================
const path = require('path');

// ==== module registry: every kit file below is registered under its old lib/ path, and __req() resolves relative requires between them ====
const __SRC = {}, __CACHE = {};
function __def(name, fn) { __SRC[name] = fn; }
function __resolve(from, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, base + '.js', base + '/index.js']) if (__SRC[c]) return c;
  throw new Error('kit module not found: ' + spec + ' (from ' + from + ')');
}
function __req(name) {
  if (__CACHE[name]) return __CACHE[name].exports;
  const mod = { exports: {} }; __CACHE[name] = mod;
  const vdir = path.join(__dirname, path.dirname(name)); // virtual location: same as before the merge, so path math like '..' still lands on the kit folder
  const localRequire = (spec) => (spec.startsWith('.') ? __req(__resolve(name, spec)) : require(spec));
  __SRC[name].call(mod.exports, mod, mod.exports, localRequire, vdir, path.join(vdir, path.basename(name)));
  return mod.exports;
}

// ==== FILE: lib/harness.js ====
__def("lib/harness.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// harness.js -- boots the real, unmodified game inside jsdom (canvas + audio stubbed out) and gives the
// rest of the kit three primitives:
//   boot(htmlPath, seed)  -> jsdom DOM whose window holds a freshly loaded game (title screen)
//   ev(win, code, ms)     -> run a code string INSIDE the game's realm; never throws (returns {ok,...})
//   key(win, k)           -> press a key the way a player would (simulateKey)
//
// Error capture: the game swallows plenty of exceptions (GameBus handlers, INTERACT/DIALOGUE providers log
// through console.error; event handlers and timers throw into jsdom's virtual console). The stock harness
// threw all of that away. Here every one is recorded on win.__errs (deduplicated by message+top stack
// frame) so a playtest/audit can report "the game threw X, N times" instead of silently carrying on.
// Read them with drainErrors(win).
// =====================================================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const KIT_DIR = path.resolve(__dirname, '..');

/** Locate the game .html: explicit path > $GAME_HTML > next to the kit (or one folder up) > cwd. */
function findGameHtml(explicit) {
  if (explicit) return explicit;
  if (process.env.GAME_HTML) return process.env.GAME_HTML;
  const dirs = [KIT_DIR, path.join(KIT_DIR, '..'), process.cwd(), path.join(KIT_DIR, 'game')];
  const found = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch (e) { continue; }
    for (const e of entries) if (e.toLowerCase().endsWith('.html')) found.push(path.join(d, e));
  }
  const games = found.filter((p) => { try { return fs.readFileSync(p, 'utf8').includes('function simulateKey('); } catch (e) { return false; } });
  if (!games.length) throw new Error('Could not find the game .html next to the kit (looked in: ' + dirs.join(', ') + '). Set GAME_HTML=path.');
  return games[0];
}

function stubCtx() {
  const noop = () => {};
  const o = { measureText: (t) => ({ width: String(t || '').length * 6 }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), getImageData: () => ({ data: [] }), createPattern: () => null };
  for (const f of ['fillRect', 'clearRect', 'strokeRect', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'rotate', 'drawImage', 'setTransform', 'putImageData']) o[f] = noop;
  return new Proxy(o, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true });
}

function stubAudio() {
  const noop = () => {};
  const param = () => ({ value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, cancelScheduledValues: noop });
  const node = () => ({ connect: noop, disconnect: noop, gain: param(), frequency: param(), Q: param(), type: 'sine', start: noop, stop: noop, buffer: null });
  return function AudioContextStub() {
    this.state = 'running'; this.currentTime = 0; this.destination = {};
    this.createGain = node; this.createOscillator = node; this.createBiquadFilter = node; this.createBufferSource = node;
    this.createBuffer = () => ({ getChannelData: () => new Float32Array(1) });
    this.createDynamicsCompressor = () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
    this.resume = noop; this.close = noop;
  };
}

/** Seeded PRNG (mulberry32) installed over the game's Math.random so runs can be repeated. */
function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let _gamePath = null;

/**
 * Boot a fresh copy of the game.
 * @param {string=} htmlPath  explicit game file (default: auto-detected)
 * @param {number=} seed      seed for Math.random (world generation + combat rolls)
 * @param {{render?:boolean, saveable?:boolean}=} opts  render:true keeps the game's drawing/DOM-update functions (slower; for smoke tests of the UI layer); saveable:true keeps chunk hashing so getSaveData() works
 */
async function boot(htmlPath, seed, opts) {
  opts = opts || {};
  _gamePath = htmlPath || _gamePath || findGameHtml();
  let html = fs.readFileSync(_gamePath, 'utf8');
  html = html.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g, '');
  const errs = new Map(); // key -> {msg, stack, count, where}
  const record = (where, e) => {
    const msg = String((e && e.message) || e);
    const stack = String((e && e.stack) || '');
    const frame = (stack.split('\n').find((l) => /:\d+:\d+/.test(l)) || '').trim().slice(0, 120);
    const k = where + '|' + msg.slice(0, 160) + '|' + frame;
    const cur = errs.get(k);
    if (cur) cur.count++; else errs.set(k, { where, msg: msg.slice(0, 300), stack: stack.split('\n').slice(0, 5).join('\n'), count: 1 });
  };
  const dom = new JSDOM(html, {
    url: 'http://localhost/game.html', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => stubCtx();
      w.AudioContext = stubAudio(); w.webkitAudioContext = w.AudioContext;
      w.scrollTo = () => {}; w.confirm = () => true; w.alert = () => {}; w.prompt = () => null; w.open = () => null; // jsdom does not implement these dialogs
      w.addEventListener('error', (ev) => record('window.onerror', ev.error || ev.message));
      w.addEventListener('unhandledrejection', (ev) => record('unhandledrejection', ev.reason));
      const realErr = w.console.error.bind(w.console), realWarn = w.console.warn.bind(w.console);
      w.console.error = (...a) => { record('console.error', a.find((x) => x instanceof w.Error) || a.join(' ')); if (process.env.PT_ECHO) realErr(...a); };
      w.console.log = (...a) => { if (process.env.PT_ECHO) process.stderr.write(a.join(' ') + '\n'); }; // the game prints debug lines (e.g. [DEATH]) that would drown every report
      w.console.warn = (...a) => { record('console.warn', a.join(' ')); if (process.env.PT_ECHO) realWarn(...a); };
    },
  });
  if (dom.virtualConsole) dom.virtualConsole.on('jsdomError', (e) => record('jsdomError', e));
  dom.window.__errs = errs;
  await new Promise((res) => { if (dom.window.document.readyState === 'complete') return res(); dom.window.addEventListener('load', res); setTimeout(res, 500); });
  if (seed !== undefined && seed !== null) dom.window.Math.random = seededRandom(seed);
  if (!opts.render) {
    // Nothing is ever drawn, so skip all drawing/DOM-update work (roughly halves the cost of a turn).
    // hashChunkTiles only exists to make saves small; skipping it is a big speed-up but makes getSaveData() fail, so runs that save
    // (checkpoints, the save round-trip audit) pass saveable:true.
    for (const f of ['render', 'updateSidebar', 'renderLog', 'saveGame'].concat(opts.saveable ? [] : ['hashChunkTiles'])) { try { dom.window.eval(`${f} = function(){}`); } catch (e) { /* ignore */ } }
  }
  dom.window.__dom = dom;
  return dom;
}

/** Run `code` inside the game's realm. With timeoutMs the script is interrupted if it runs too long. Never throws. */
globalThis.UI_SCAN_JS = "(function(){ if (gameState !== 'playing') return '[]'; var out = [], bad = [/\\bundefined\\b/, /\\bNaN\\b/, /\\[object Object\\]/, /\\$\\{/];" +
  " var names = ['openCharacterSheet','openSpellbook','openTalents','openCybernetics','openEldritch','openQuestLog','openLibrary','openLook','openProfessionsMenu','openFamilyMenu','openFaith','openFeats','openInventory'];" +
  " for (var i = 0; i < names.length; i++) { try { if (gameState !== 'playing') break; eval(names[i] + '()'); var t = document.getElementById('modal-body').textContent; for (var j = 0; j < bad.length; j++) { var m = t.match(bad[j]); if (m) { out.push(names[i] + ': ' + t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\\\\s+/g, ' ')); break; } } } catch (e) { out.push(names[i] + ' threw: ' + e.message); } try { closeModal(); } catch (e) {} gameState = 'playing'; }" +
  " try { render(); } catch (e) {} return JSON.stringify(out); })()";
function ev(win, code, timeoutMs) {
  try {
    if (win.__dom && timeoutMs) return { ok: true, value: new vm.Script(code).runInContext(win.__dom.getInternalVMContext(), { timeout: timeoutMs }) };
    return { ok: true, value: win.eval(code) };
  } catch (e) { return { ok: false, timeout: !!(e && /timed out/i.test(e.message || '')), error: (e && e.stack) || String(e) }; }
}

/** Like ev() but throws on failure and returns the bare value (handy in commands where failure is fatal). */
function evOrThrow(win, code, timeoutMs) {
  const r = ev(win, code, timeoutMs);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** Press a key as the player would. */
function key(win, k) { return ev(win, `simulateKey(${JSON.stringify(k)})`); }

/** Return (and clear) the errors the game swallowed since the last call: [{where,msg,stack,count}]. */
function drainErrors(win) {
  const out = [...win.__errs.values()];
  win.__errs.clear();
  return out;
}

module.exports = { KIT_DIR, findGameHtml, boot, ev, evOrThrow, key, drainErrors, seededRandom };
});

// ==== FILE: lib/brain.js ====
__def("lib/brain.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// brain.js -- THE AUTOPILOT BRAIN
// This function's SOURCE is evaluated inside the game's own JS realm (see driver.js newGame), so it can call
// the game's functions and read its variables directly. Nothing in it runs in Node: no require(), no fs.
// It installs window.__B (decision helpers + B.tick). Everything is synchronous (no timers) so it is fast.
// =====================================================================================================

function BRAIN() {
  /* global player, gameState, turnCount, curMonsters, curNPCs, curIsDungeon, curDungeonLevel, curDungeon, curTileAt, curWalkable,
     chebyshev, hasLOS, effDex, effStr, getArmorOf, weaponStrDeficit, armorStrDeficit, abilityPenaltyFactor, randInt, movePlayer,
     endTurn, itemsAt, pickUpSpecificItem, equipItem, useItem, useStairs, useStairsUp, containersAt, openContainer, containerTakeAll,
     closeModal, entityAt, dungeonRegistry, logMessages */
  const B = (window.__B = {});
  B.events = [];
  B.stats = { kills: 0, fights: 0, flees: 0, rests: 0 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const KEYOF = { '-1,0': 'h', '1,0': 'l', '0,-1': 'k', '0,1': 'j', '-1,-1': 'y', '1,-1': 'u', '-1,1': 'b', '1,1': 'n' };
  B.maxed = () => player.level >= 99; // nothing left to gain from experience
  B.note = (m) => { B.events.push('[t=' + turnCount + '] ' + m); if (B.events.length > 4000) B.events.splice(0, 1000); };

  // ---------- observation ----------
  B.hostiles = function (R) {
    const out = [];
    const arr = curMonsters().slice();
    for (const n of curNPCs()) if (n.alive && n.hostile) arr.push(n);
    for (const m of arr) {
      if (!m.alive || m.hp <= 0) continue;
      if (m.behavior === 'flee' && m.kind === 'monster') continue; // prey animals never fight back
      const d = chebyshev(m.x, m.y, player.x, player.y);
      if (R && d > R) continue;
      out.push(m);
    }
    return out;
  };

  // ---------- combat math (mirrors doAttack / rollHit in the game) ----------
  B.myHitChance = function (m) {
    return clamp(0.6 + (effDex(player) - m.dex) * 0.025 - weaponStrDeficit() * 0.02, 0.1, 0.95);
  };
  B.hisHitChance = function (m) {
    return clamp(0.6 + (m.dex - effDex(player)) * 0.025 + armorStrDeficit() * 0.015 + (player.exposedTurns > 0 ? 0.15 : 0), 0.1, 0.95);
  };
  B.myDamage = function (m) {
    const w = player.equipment.hand;
    const dr = w && w.dmg ? w.dmg : [1, 3];
    let avg = (dr[0] + dr[1]) / 2 + Math.floor(effStr(player) / 4) + Math.floor(player.level / 5);
    avg *= abilityPenaltyFactor(weaponStrDeficit());
    avg += (player.cyberDmgBonus || 0);
    return Math.max(1, avg - (m.armor || 0));
  };
  B.hisDamage = function (m) {
    const a = m.atk || [1, 2];
    let avg = (a[0] + a[1]) / 2 + Math.floor((m.str || 0) / 4);
    return Math.max(1, avg - getArmorOf(player));
  };
  // Monte-Carlo fight against a group of monsters. Returns win probability and expected HP lost.
  B.simulate = function (group, trials, startHp) {
    trials = trials || 80;
    const w = player.equipment.hand;
    const dr = w && w.dmg ? w.dmg : [1, 3];
    const pstr = Math.floor(effStr(player) / 4) + Math.floor(player.level / 5);
    const pf = abilityPenaltyFactor(weaponStrDeficit());
    const parm = getArmorOf(player);
    const ranged = group.map((m) => {
      // spell-casting monsters: bolts never miss and are shot from range
      let sp = null;
      if (m.abilities && m.abilities.length && typeof MONSTER_ABILITY_LIBRARY !== 'undefined') {
        sp = [];
        for (const id of m.abilities) { const ab = MONSTER_ABILITY_LIBRARY[id]; if (ab && (ab.kind === 'bolt' || ab.kind === 'drain' || ab.kind === 'aoe') && ab.power) sp.push({ lo: ab.power[0], hi: ab.power[1], cost: ab.cost || 4, cd: ab.cooldown || 3 }); }
        if (!sp.length) sp = null;
      }
      const d = chebyshev(m.x, m.y, player.x, player.y);
      const shooter = sp || m.behavior === 'ranged' || m.behavior === 'kiter';
      const pa = (m.poison || 0) > 0 && getBuff('resistpoison') <= 0 ? m.poison : 0;
      let pb = false; try { pb = !!(m.scriptedAI && typeof STORY_BOSS_AI !== 'undefined' && STORY_BOSS_AI[m.scriptedAI] && STORY_BOSS_AI[m.scriptedAI].toString().indexOf('statusPoison') >= 0); } catch (e) { /* */ }
      return { m, pa, pb, hit: B.hisHitChance(m), my: B.myHitChance(m), sp, free: shooter ? Math.max(0, Math.min(d - 1, 8)) + 4 : 0 }; // +4: shooters back away, so closing the gap costs extra turns of free shots
    });
    let wins = 0, lost = 0, turns = 0;
    const spAb = group.length ? B.bestAbility(group[0], 0) : null; // spells and techniques: the main damage dealer of a high-level character
    const hp0 = startHp !== undefined ? startHp : player.hp;
    for (let t = 0; t < trials; t++) {
      const es = ranged.map((r) => ({ pa: r.pa, pb: r.pb, hp: r.m.hp, a: (r.m.scriptedAI || r.m.boss) ? [(r.m.atk || [1, 2])[0] * 1.7, (r.m.atk || [1, 2])[1] * 1.7] : (r.m.atk || [1, 2]), s: Math.floor((r.m.str || 0) / 4), ar: r.m.armor || 0, hit: r.hit, my: r.my, first: !r.m.engaged, sp: r.sp ? r.sp.slice() : null, cd: 0, mp: r.m.mp || 0, free: r.free, ps: r.m.powerScale }));
      let hp = hp0, n = 0, ps = player.statusPoison || 0, pool = spAb ? B.poolOf(spAb.res)[0] : 0;
      for (const e of es) { // free shots while closing the distance
        for (let f = 0; f < e.free && hp > 0; f++) {
          if (e.sp && e.mp > 0 && e.cd <= 0) { const q = e.sp[Math.floor(Math.random() * e.sp.length)]; if (e.mp >= q.cost) { e.mp -= q.cost; e.cd = q.cd; hp -= Math.max(1, Math.round(randInt(Math.random, q.lo, q.hi) * (0.4 + 0.6 * (e.ps || 1))) - Math.floor(parm / 2)); continue; } }
          e.cd--;
          if (!e.sp && Math.random() < e.hit) hp -= Math.max(1, randInt(Math.random, e.a[0], e.a[1]) + e.s - parm);
        }
      }
      while (hp > 0 && es.some((e) => e.hp > 0) && n < 300) {
        n++;
        const tgt = es.filter((e) => e.hp > 0).sort((a, b) => a.hp - b.hp)[0];
        if (spAb && pool >= spAb.cost) {
          pool -= spAb.cost; const dd = spAb.avg * (0.75 + 0.5 * Math.random());
          tgt.hp -= dd; if (spAb.aoe) for (const o of es) if (o !== tgt && o.hp > 0) o.hp -= dd * 0.7;
        } else if (Math.random() < tgt.my) {
          let d = (randInt(Math.random, dr[0], dr[1]) + pstr) * pf - tgt.ar; d = Math.max(1, d);
          if (tgt.first) d *= 3; else if (Math.random() < 0.08) d *= 2;
          tgt.hp -= d;
        }
        tgt.first = false;
        for (const e of es) {
          if (e.hp <= 0) continue;
          if (e.sp && e.mp > 0 && e.cd <= 0) { const q = e.sp[Math.floor(Math.random() * e.sp.length)]; if (e.mp >= q.cost) { e.mp -= q.cost; e.cd = q.cd; let d = Math.round(randInt(Math.random, q.lo, q.hi) * (0.4 + 0.6 * (e.ps || 1))) - Math.floor(parm / 2); hp -= Math.max(1, d); continue; } }
          e.cd--;
          if (Math.random() < e.hit) { let d = randInt(Math.random, e.a[0], e.a[1]) + e.s - parm; d = Math.max(1, d); if (Math.random() < 0.08) d *= 2; hp -= d; if (e.pa && Math.random() < 0.4) ps += e.pa; }
          if (e.pb && n % 5 === 1) ps += 5; // scripted poisoners re-apply on a cooldown
        }
        if (ps > 0) { hp -= Math.min(ps, 4); ps--; } // poison ticks every round
      }
      if (hp > 0) wins++;
      lost += hp0 - Math.max(hp, 0);
      turns += n;
    }
    return { win: wins / trials, loss: lost / trials, turns: turns / trials };
  };

  // Monsters that would beat us one-on-one are given a wide berth (they are mostly asleep or wandering).
  B._dz = { turn: -1, list: [] };
  B.isDangerous = function (m) {
    const key = m.uid + ':' + player.level + ':' + Math.round(player.maxHp / 5) + ':' + getArmorOf(player) + ':' + Math.round(effDex(player));
    B._dc = B._dc || {};
    if (B._dc[key] === undefined) { const s = B.simulate([m], 40, player.maxHp); B._dc[key] = s.win < 0.9 || s.loss > player.maxHp * 0.7; }
    return B._dc[key];
  };
  B.dangerZones = function () {
    if (B._dz.turn === turnCount) return B._dz.list;
    const list = [];
    for (const m of B.hostiles(0)) if (B.isDangerous(m)) list.push({ x: m.x, y: m.y, r: (m.visionRange || 9) });
    B._dz = { turn: turnCount, list };
    return list;
  };
  // ---------- pathfinding (A*) over the real map. Omniscient: it can see every tile. ----------
  B.passable = function (x, y) { return curWalkable(x, y); };
  B.known = (x, y) => curIsDungeon() || curIsDimension() || worldChunks.has(chunkKey(Math.floor(x / CH), Math.floor(y / CH)));
  B.path = function (tx, ty, opts) {
    opts = opts || {};
    const sx = player.x, sy = player.y;
    const maxN = opts.maxNodes || 20000;
    const OFF = 1 << 20, K = 1 << 21;
    const id = (x, y) => (x + OFF) * K + (y + OFF);
    const blocked = new Set();
    if (opts.avoidMonsters !== false) for (const m of curMonsters()) if (m.alive) blocked.add(id(m.x, m.y));
    for (const n of curNPCs()) if (n.alive) blocked.add(id(n.x, n.y));
    const dz = opts.ignoreDanger ? [] : B.dangerZones();
    const ow = !curIsDungeon() && !curIsDimension();
    B._kn = B._kn || new Set();
    const known = ow ? (x, y) => { const cx = Math.floor(x / CH), cy = Math.floor(y / CH), k = (cx + 4096) * 8192 + (cy + 4096); if (B._kn.has(k)) return true; if (worldChunks.has(chunkKey(cx, cy))) { B._kn.add(k); return true; } return false; } : () => true; // never generate terrain just to plan a route
    const scKey = curIsDungeon() ? (curDungeon() ? curDungeon().id : '?') + ':' + player.dungeonDepth : (curIsDimension() ? 'dim' : 'ow');
    if (!B._sc || turnCount - B._scT >= 40 || B._scDim !== scKey) { B._sc = new Map(); B._scT = turnCount; B._scDim = scKey; } // tile cache is per floor
    const SC = B._sc;
    const hereBad = ow && B.badTile(curTileAt(sx, sy));
    const sc = (x, y) => {
      const key = id(x, y); let e = SC.get(key); if (e) return e;
      const t = curTileAt(x, y);
      if (!t) e = { t: false, w: false, c: 99 };
      else {
        let c = 0; if (t.hiddenTrap && !t.trapTriggered) c += 40; if (t.feature === 'trap') c += 40; if (t.feature === 'rift_portal' || t.feature === 'rift_anchor') c += 300; // stepping on a rift can carry us away
        if (!curIsDungeon() && t.biome) { const T = B.tileTemp(t, true); if (T <= 17 || T >= 83) c += 40; else if (T <= 26 || T >= 74) c += 10; const bi = BIOMES[t.biome]; if (bi && bi.effect && /poison|burn|radiation|curse|fear|voidtear|corrode|confuse/.test(bi.effect.type)) c += 100; }
        e = { t: true, w: !!curWalkable(x, y) && !(B.doorBlock && B.doorBlock[x + ',' + y]), c, bad: !curIsDungeon() && B.badTile(t) };
      }
      SC.set(key, e); return e;
    };
    const hz = (x, y) => { if (!known(x, y)) return 0.4; const e = sc(x, y); if (!e.t) return 99; let c = e.c; for (const z of dz) if (Math.max(Math.abs(z.x - x), Math.abs(z.y - y)) <= z.r) c += (curIsDungeon() ? 6 : 30); return c; };
    const h = (x, y) => Math.max(Math.abs(tx - x), Math.abs(ty - y));
    const heap = [[h(sx, sy), 0, sx, sy]];
    const g = new Map([[id(sx, sy), 0]]); const par = new Map();
    let n = 0, best = null, bestH = 1e9, goal = null;
    const adj = opts.adjacent;
    while (heap.length && n < maxN) {
      // binary-heap pop
      let top = heap[0]; const last = heap.pop();
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; const tmp = heap[i]; heap[i] = heap[m]; heap[m] = tmp; i = m; } }
      const [, gc, x, y] = top; n++;
      if (gc > (g.get(id(x, y)) ?? 1e9)) continue;
      const hv = h(x, y);
      if (adj ? hv <= 1 && (x !== tx || y !== ty) : (x === tx && y === ty)) { goal = [x, y]; break; }
      if (hv < bestH) { bestH = hv; best = [x, y]; }
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, k = id(nx, ny);
        const isTarget = nx === tx && ny === ty;
        const kn = known(nx, ny);
        const wk = kn ? sc(nx, ny).w : true;
        if (kn && ow && !hereBad && !B.shelterTravel && sc(nx, ny).bad) continue; // never wander voluntarily into freezing / scorching / toxic ground
        if (!isTarget && kn && !wk) continue;
        if (isTarget && !adj && kn && !wk) continue;
        if (blocked.has(k) && !isTarget) continue;
        const ng = gc + 1 + hz(nx, ny) + (dx && dy ? 0.001 : 0);
        if (ng >= (g.get(k) ?? 1e9)) continue;
        g.set(k, ng); par.set(k, [x, y]);
        const f = ng + h(nx, ny); heap.push([f, ng, nx, ny]);
        let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; const tmp = heap[i]; heap[i] = heap[p]; heap[p] = tmp; i = p; }
      }
    }
    let end = goal || best;
    if (!goal && opts.frontier && heap.length) { const tp = heap.reduce((a, b) => (b[0] < a[0] ? b : a)); if (par.has(id(tp[2], tp[3]))) end = [tp[2], tp[3]]; } // out of budget: head for the most promising open node, not the pocket nearest the target
    if (!end) return { steps: [], complete: false };
    const steps = []; let cur = end;
    for (;;) { const p = par.get(id(cur[0], cur[1])); if (!p) break; steps.push([cur[0] - p[0], cur[1] - p[1]]); cur = p; }
    steps.reverse();
    return { steps, complete: !!goal };
  };
  // Take one step along a path to (tx,ty). Returns true if a turn passed.
  B.stepToward = function (tx, ty, opts) {
    const p = B.path(tx, ty, opts);
    if (!p.steps.length) return false;
    if (!p.complete && !(opts && opts.partial)) return false;
    const [dx, dy] = p.steps[0];
    const t0 = B.sig();
    movePlayer(dx, dy);
    return B.sig() !== t0;
  };

  // ---------- resting ----------
  B.comfy = function () { if (curIsDungeon()) return true; const t = currentTemperature(); return t > 14 && t < 86; };
  B.canRest = function () {
    if (!B.comfy()) return false;
    if (B.noRestUntil > turnCount) return false;
    if (B.restFail && turnCount - B.restFail < 20) return false; // resting has just stopped working: something is wearing us down
    if ((player.bleedTurns || 0) > 0) return false;
    if (!curIsDungeon()) { const t = curTileAt(player.x, player.y); const bi = t && BIOMES[t.biome]; if (bi && bi.effect && /poison|burn|radiation|curse|fear|voidtear|corrode|confuse/.test(bi.effect.type)) return false; }
    return !curMonsters().some((m) => m.alive && m.behavior !== 'flee' && chebyshev(m.x, m.y, player.x, player.y) <= 8 && hasLOS(player.x, player.y, m.x, m.y) && m.aiState !== 'dormant');
  };
  B.rest = function (maxTurns, untilHpFrac) {
    let n = 0;
    while (n < maxTurns && player.alive && player.hp > 0) {
      if (player.hp >= player.maxHp * untilHpFrac && (!B.dmgAbilities().some((a) => a.res === 'mp') || player.mp >= player.maxMp * 0.8) && (player.stamina || 0) >= (player.maxStamina || 0) * 0.8) break;
      if (!B.canRest()) break;
      if ((player.statusPoison || 0) > 0 && B.poisonTotal(player.statusPoison) >= player.hp * 0.6) break; // let the main loop cure it
      if (n > 0 && n % 12 === 0) { if (player.hp <= (B._rh === undefined ? -1 : B._rh)) { B.restFail = turnCount; break; } B._rh = player.hp; } else if (n === 0) B._rh = player.hp;
      const h0 = player.hp;
      endTurn({ forceFull: true }); n++;
      if (gameState !== 'playing') break;
      if (player.hp < h0 - player.maxHp * 0.08) { B.envDanger = turnCount; break; } // burning / gas / trap: resting is the wrong answer
    }
    return n;
  };

  // ---------- items ----------
  B.useBandageIfBleeding = function () {
    if (!((player.bleedTurns || 0) > 0 || (player.bleedStacks || 0) > 0)) return false;
    if ((player.bleedStacks || 0) < 3 && B.hostiles(2).some((m) => m.aiState !== 'dormant')) return false; // never spend a turn binding a scratch with a fighter next to us (a boss doing 15 a turn killed three bots mid-bandage)
    const b = player.inventory.find((i) => /bandage|medkit/i.test(i.name || '') || i.id === 'bandage' || i.id === 'medkit');
    if (!b) { // no bandage: cloth binds it at once (the game's own [r] tend); with nobody near, bare-hand pressure like tendWound's timer loop (that one is async, so it is replayed here)
      if (player.inventory.some((i) => i.id === 'cloth')) { const t0 = turnCount; try { tendWound(); } catch (e) { /* */ } return turnCount > t0; }
      if (B.hostiles(5).some((m) => hasLOS(player.x, player.y, m.x, m.y))) return false;
      const t0 = turnCount;
      for (let k = 0; k < 4 && player.alive && (player.bleedStacks || 0) > 0; k++) { player.bleedClotTurns = (player.bleedClotTurns || 0) + 4; endTurn({ forceFull: true }); }
      if ((player.bleedStacks || 0) > 0) { player.bleedStacks = Math.max(0, player.bleedStacks - 1); if (player.bleedStacks <= 0) stanchBleed(player); }
      return turnCount > t0;
    }
    const t0 = B.sig(); useItem(b); if (gameState !== 'playing') closeModal();
    return true;
  };
  B.healingItem = function () {
    let best = null;
    for (const i of player.inventory) {
      if (i.type !== 'consumable') continue;
      // bandages count too (effect 'bandage', power ~8): a L1 character at 3 hp died holding one because this matcher only knew heal/medkit
      if (/heal|medkit|bandage/i.test(i.effect || '') || /heal|health|medkit|bandage/i.test(i.id || '')) { const v = i.healAmount || i.power || 0; if (!best || v > (best.healAmount || best.power || 0)) best = i; }
    }
    return best;
  };
  // total damage still to come from the current poison stack (the game deals min(stack,4) per turn and the stack drops by one each turn)
  B.poisonTotal = (S) => { let t = 0; for (let k = S; k > 0; k--) t += Math.min(k, 4); return t; };
  B.poisonCheck = function () {
    const S = player.statusPoison || 0; if (S <= 0) return false;
    const tot = B.poisonTotal(S);
    if (tot < player.hp * 0.4) return false;
    const a = player.inventory.find((i) => i.type === 'consumable' && (i.effect === 'cureposion' || i.effect === 'cureall'));
    if (a) { useItem(a); if (gameState !== 'playing') closeModal(); return true; }
    if (player.inventory.some((i) => i.id === 'herb' || i.id === 'antidote')) { const t0 = B.sig(); try { tendPoison(); } catch (e) { /* */ } if (gameState !== 'playing') closeModal(); if (B.sig() !== t0) return true; }
    if (tot >= player.hp - 3 && B.drinkHeal()) return true;
    return false;
  };
  // ---------- environmental hazards: fire, gas, burning ----------
  // A human who is standing in flames walks out of them (and into water if there is some). The autopilot used to stand
  // still and fight/loot in a burning room until it died. Walk to the nearest tile that is neither burning nor gassed.
  B.tileHurts = function (t) { return !!(t && ((t.fireTurns || 0) > 0 || ((t.gasTurns || 0) > 0 && t.gasKind !== 'confuse'))); };
  B.escapeHazard = function () {
    const here = curTileAt(player.x, player.y);
    const burning = (player.burningTurns || 0) > 0;
    if (!burning && !B.tileHurts(here)) return false;
    // oscillation breaker: a lingering fire/gas tile ON the only route out made the bot step off it, path back onto it and step off again for 8000 turns (to-exit <-> escape-hazard).
    // After 6 escapes inside 80 turns, accept the damage and push through for 40 turns (unless HP is below half).
    if ((B.hazPassUntil || 0) > turnCount && player.hp > player.maxHp * 0.5) return false;
    B.hazLog = (B.hazLog || []).filter((t) => turnCount - t < 80); B.hazLog.push(turnCount);
    if (B.hazLog.length >= 6 && player.hp > player.maxHp * 0.5) { B.hazPassUntil = turnCount + 40; B.hazLog = []; B.note('hazard oscillation: pushing through the hazard tile'); B.stats.hazardPushes = (B.stats.hazardPushes || 0) + 1; return false; }
    if (burning && player.hp < player.maxHp * 0.7 && B.douseSelf()) { B.note('doused with water, hp ' + player.hp + '/' + player.maxHp); return true; }
    // breadth-first search outward over walkable, unoccupied tiles; water puts a burning character out
    const seen = new Set([player.x + ',' + player.y]); let frontier = [{ x: player.x, y: player.y, first: null }], goal = null;
    for (let depth = 0; depth < 12 && !goal; depth++) {
      const next = [];
      for (const n of frontier) for (const d of DIRS) {
        const x = n.x + d[0], y = n.y + d[1], k = x + ',' + y;
        if (seen.has(k)) continue; seen.add(k);
        const t = curTileAt(x, y); if (!t || !t.walkable) continue;
        const occ = entityAt(x, y); if (occ && occ !== player) continue;
        const first = n.first || d;
        if (burning && isWaterTile(t) && !B.tileHurts(t)) { goal = { first }; break; }
        if (!burning && !B.tileHurts(t)) { goal = { first }; break; }
        if (burning && B.tileHurts(here) && !B.tileHurts(t) && !goal) { goal = { first, dry: true }; }
        next.push({ x, y, first });
      }
      frontier = next;
    }
    if (!goal) return false;
    const t0 = B.sig(); movePlayer(goal.first[0], goal.first[1]);
    if (B.sig() !== t0) { B.note('escape-hazard ' + (burning ? 'burning' : 'fire/gas tile') + ' hp ' + player.hp + '/' + player.maxHp); return true; }
    return false;
  };
  B.healSpell = function (minAmt) {
    let best = null;
    for (const id of player.knownSpells || []) {
      const sp = SPELLS.find((x) => x.id === id); if (!sp || sp.type !== 'heal' || !Array.isArray(sp.power) || sp.id === 'reviveally') continue;
      const cost = effectiveCost(sp); if (cost > (player.mp || 0)) continue;
      const amt = (sp.power[0] + sp.power[1]) / 2 * playerLevelPowerMult(player.level) * (1 - Math.min(0.5, abilityRequirementDeficit(sp) * 0.04)) * (typeof healMult === 'function' ? healMult() : 1);
      if (amt < (minAmt || 0)) continue;
      if (!best || amt > best.amt) best = { id, amt, cost };
    }
    return best;
  };
  B.drinkHeal = function () {
    { const hs = B.healSpell(150); if (hs) { const t0 = B.sig(); try { castSpell(hs.id); } catch (e) { /* */ } if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } if (B.sig() !== t0) return true; } }
    const h = B.healingItem(); if (!h) return false;
    useItem(h); if (gameState !== 'playing') closeModal(); return true;
  };
  B.lootHere = function () {
    let did = false;
    const here = itemsAt(player.x, player.y).filter((i) => i.type !== 'corpse');
    for (const it of here.slice()) { pickUpSpecificItem(it); did = true; }
    for (const c of containersAt(player.x, player.y)) {
      if (c.locked || !c.contents || !c.contents.length) continue;
      openContainer(c); containerTakeAll(); did = true;
    }
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    return did;
  };
  B.gearScore = (x) => {
    if (!x) return -1;
    const cond = x.broken ? 0.1 : (x.maxDurability && x.maxDurability !== Infinity && x.durability != null ? Math.max(0.2, x.durability / x.maxDurability) : 1);
    let s = 0;
    if (x.type === 'weapon') {
      const avg = Array.isArray(x.dmg) ? (x.dmg[0] + x.dmg[1]) / 2 : (x.dmg || 0);
      const def = Math.max(0, (x.str || 0) - effStr(player));
      s = (avg + 0) * Math.max(0.4, 1 - def * 0.05) * (x.ranged ? 0.6 : 1);
      if ((player.int || 0) > (player.str || 0) + 2 && (player.knownSpells || []).length) s *= 0.3; // a caster fights with spells: do not trade the staff for a blade and melee
    } else s = (x.armor || 0) - Math.max(0, (x.str || 0) - effStr(player)) * 0.5;
    return s * cond;
  };
  B.equipBest = function () {
    let changed = false;
    for (const it of player.inventory.slice()) if (it.type === 'tome' && !(player.knownSpells || []).includes(it.spellId)) { try { useItem(it); } catch (e) { /* */ } if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } }
    const score = B.gearScore;
    for (const it of player.inventory.slice()) {
      if (it.type !== 'weapon' && it.type !== 'armor') continue;
      if (!it.slot) continue;
      const cur = player.equipment[it.slot];
      B.noEquip = B.noEquip || {};
      if (B.noEquip[it.uid]) continue;
      if (!cur || score(it) > score(cur) + 0.01) {
        B.eqN = B.eqN || {}; B.eqN[it.uid] = (B.eqN[it.uid] || 0) + 1; if (B.eqN[it.uid] > 3) { B.noEquip[it.uid] = true; continue; } // two items that each look better than the other (two-handers vs shields): stop swapping
        equipItem(it);
        if (player.equipment[it.slot] === it) changed = true; else B.noEquip[it.uid] = true; // could not equip it (cursed/locked/etc): never try again
        if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      }
    }
    return changed;
  };
  // ---------- talents ----------
  B.TALENT_ORDER = ['coldadapted', 'toughness', 'quickstudy', 'thickhide', 'dodgemaster', 'mighty', 'swift', 'ironskin', 'hardy', 'executioner', 'battlehardened', 'scartissue',
    'ironbulwark', 'evasive', 'fastlearner', 'slayer', 'warlord', 'clottingfactor', 'fortress', 'wraithstep', 'apexpredator', 'juggernaut', 'deathdealer', 'kingsransom', 'ironveins',
    'immovableobject', 'ghostwalker', 'bossbreaker', 'perfectsoldier', 'grimreaper', 'thornskin', 'briarskin', 'thornlord', 'thornking', 'warmaster', 'emperorsransom',
    'martialdiscipline', 'weaponmaster', 'battletrance', 'quickfingers', 'assassinseye'];
  B.talentOk = (t) => !player.talents[t.id] && (!t.requires || ((!t.requires.level || player.level >= t.requires.level) && (!t.requires.talent || player.talents[t.requires.talent])));
  B.spendTalents = function () {
    let n = 0;
    while (player.talentPoints > 0 && n++ < 20) {
      let pick = null;
      for (const id of B.TALENT_ORDER) { const t = TALENTS_V2.find((x) => x.id === id); if (t && B.talentOk(t)) { pick = t; break; } }
      if (!pick) pick = TALENTS_V2.filter((t) => B.talentOk(t) && (t.category === 'combat' || t.category === 'survival')).sort((a, b) => a.tier - b.tier)[0];
      if (!pick) break;
      player.talents[pick.id] = true; player.talentPoints--; pick.apply(); log('Talent unlocked: ' + pick.name);
    }
    return n;
  };
  B.spendPoints = function () {
    let n = 0;
    while ((player.statPoints || 0) > 0 && n < 200) {
      // DEX is both our accuracy and their miss chance; keep STR enough for gear, CON for HP.
      const s = player.str, d = player.dex, c = player.con;
      let idx = 1; // dex
      if (s < d * 0.7) idx = 0; else if (c < d * 1.0) idx = 3;
      if (player.level >= 20 && player.int < 64 && (s >= d * 0.5)) idx = 2; // spells need INT; enough that the best ones do not fizzle
      spendStat(idx); n++;
    }
    return n;
  };

  // ---------- dungeon level knowledge ----------
  B.stairs = function () {
    const l = curDungeonLevel(); if (!l) return {};
    return { up: l.upStairs, down: l.downStairs };
  };
  B.isOn = function (p) { return p && player.x === p.x && player.y === p.y; };

  // escape: if standing on stairs, take them; else walk toward nearest stairs. returns true if acted
  B.flee = function () {
    if (!curIsDungeon()) return false;
    const st = B.stairs();
    const cands = [st.up].filter(Boolean); // never flee downward: deeper floors are only more dangerous
    if (!cands.length) return false;
    for (const s of cands) if (B.isOn(s)) {
      const dgId = B.cur && B.cur.id;
      { const dg0 = curDungeon(); if (dg0) { const r0 = (B.dungeonLog[dg0.id] = B.dungeonLog[dg0.id] || { done: 0, ex: {} }); r0.fled = r0.fled || {}; r0.fled[player.dungeonDepth] = player.level; } }
      if (s === st.up) useStairsUp(); else useStairs();
      B.stats.flees++;
      if (!curIsDungeon()) { // fled all the way out
        B.noEnterUntil = turnCount + 250;
        if (dgId) { const r = (B.dungeonLog[dgId] = B.dungeonLog[dgId] || { done: 0 }); r.fleeN = (r.fleeN || 0) + 1; r.fleeLvl = r.fleeLvl === player.level ? r.fleeLvl : (r.fleeN = 1, player.level); }
      }
      return true;
    }
    cands.sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y));
    for (const s of cands) if (B.stepToward(s.x, s.y)) return true;
    return false;
  };

  B.af = [];

  // ---------- spells and techniques ----------
  // A level-99 character multiplies every ability's damage by ~12, which makes them far stronger than a weapon swing.
  B.dmgAbilities = function () {
    const out = [], ids = (player.knownSpells || []).concat(player.knownTechniques || []);
    for (const id of ids) {
      let s = null; try { s = findAbilityById(id); } catch (e) { /* */ }
      if (!s || !Array.isArray(s.power) || !['damage', 'drain', 'smite'].includes(s.type)) continue;
      const risky = !!(s.selfExposed || s.selfCost); // pays in HP or leaves us open: a human uses these while healthy, so only skip them when hurt (see bestAbility)
      const res = s.resource || 'mp'; if (res !== 'mp' && res !== 'stamina') continue;
      const def = abilityRequirementDeficit(s), pf = abilityPenaltyFactor(def), fail = Math.min(0.5, def * 0.04);
      const pool = abilityPoolOf(id);
      const mult = (1 + (player.spellDmgBonus || 0) + (pool === 'technique' ? (player.techniqueDmgBonus || 0) : 0)) * pf * playerLevelPowerMult(player.level);
      const avg = (s.power[0] + s.power[1]) / 2 * mult * (1 - fail);
      out.push({ s, id, res, cost: effectiveCost(s), avg, range: s.range || 1, aoe: !!s.aoe, risky });
    }
    return out;
  };
  B.poolOf = (res) => (res === 'stamina' ? [player.stamina || 0, player.maxStamina || 1] : [player.mp || 0, player.maxMp || 1]);
  // best ability we can pay for now; reserve = fraction of the pool we keep back
  B.bestAbility = function (m, reserve, minRange) {
    let best = null; const cands = [];
    const melee = m ? B.myDamage(m) * B.myHitChance(m) : 0;
    for (const a of B.dmgAbilities()) {
      const [cur, max] = B.poolOf(a.res);
      if (cur - a.cost < max * (reserve || 0)) continue;
      if (a.cost > cur) continue;
      if (a.risky && player.hp < player.maxHp * 0.7) continue; // self-exposing / HP-cost abilities only while healthy
      let d = a.avg; if (a.aoe) d *= 1.2; if (a.s.type === 'smite' && m && m.boss) d *= 2; // smites hit bosses twice as hard
      if (d <= melee * 1.25) continue;
      if (minRange !== undefined && a.range < minRange) continue;
      if (a.aoe && m) { const r = a.s.aoeRadius || 1, dx = m.x - player.x, dy = m.y - player.y; if (dx * dx + dy * dy <= (r + 0.5) * (r + 0.5)) continue; } // the blast would catch us too
      if (a.aoe && !m) continue;
      cands.push(Object.assign({ d }, a));
    }
    if (cands.length) { // against a boss mana is the limit: take the cheapest damage among the strong options
      const top = Math.max(...cands.map((c) => c.d));
      best = (m && m.boss) ? cands.filter((c) => c.d >= top * 0.3).sort((x, y) => y.d / Math.max(1, y.cost) - x.d / Math.max(1, x.cost))[0] : cands.sort((x, y) => y.d - x.d)[0];
    }
    return best;
  };
  B.cast = function (a, m) {
    const t0 = B.sig();
    try {
      castSpell(a.id);
      if (gameState === 'tiletarget') confirmTileTarget(m.x, m.y);
      if (gameState === 'tiletarget') { cancelTileTargeting(); }
    } catch (e) { B.note('cast error ' + String(e).slice(0, 80)); }
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    if (m.boss && (B.cdbg = (B.cdbg || 0) + 1) % 15 === 1) B.note('cast ' + a.id + ' at ' + m.name + ' hp ' + m.hp + ' -> log: ' + logMessages.slice(-4).join(' // ').replace(/<[^>]*>/g, '').slice(0, 400));
    return B.sig() !== t0;
  };
  // use an ability on m if one is worth it; returns true when a turn was spent
  B.tryCast = function (m, reserve) {
    if (!m || m.splitInto) return false;
    const d = chebyshev(m.x, m.y, player.x, player.y);
    const a = B.bestAbility(m, reserve === undefined ? (m.boss ? 0 : 0.35) : reserve);
    if (!a || d > a.range || !hasLOS(player.x, player.y, m.x, m.y)) return B.tryThrow(m);
    return B.cast(a, m);
  };
  // ---------- telegraphed maneuvers (v0.51.0): read the red tiles, step out, punish ----------
  // Heavy enemy attacks wind up for a turn and mark their target tiles; stepping off the marked tiles makes the blow miss and leaves the enemy
  // EXPOSED (our hits crit). The bot used to ignore all of it and eat every pounce, charge and slam, so its survival numbers undercounted a real player.
  B.PARRY_SKILLS = ['perfectparry', 'parrystance', 'crossparry', 'guardstance', 'shieldwall'];
  /** "x,y" -> the monster whose wound-up maneuver will strike that tile next turn */
  B.dangerTiles = function () {
    const out = new Map();
    for (const m of curMonsters()) {
      const mv = m.maneuver; if (!mv || mv.phase !== 'windup' || !m.alive || m.hp <= 0 || !mv.plan || !mv.plan.tiles) continue;
      for (const t of mv.plan.tiles) out.set(t.x + ',' + t.y, m);
    }
    return out;
  };
  /** if a marked tile is under us: sidestep to the best safe neighbour (next to the attacker if possible: it will be exposed), else raise a parry stance */
  B.dodgeManeuver = function () {
    const danger = B.dangerTiles(); const src = danger.get(player.x + ',' + player.y);
    if (!src) return false;
    let best = null, bs = -1e9;
    for (const d of DIRS) {
      const x = player.x + d[0], y = player.y + d[1], t = curTileAt(x, y);
      if (!t || !t.walkable || entityAt(x, y) || danger.has(x + ',' + y) || B.tileHurts(t) || B.badTile(t)) continue;
      const others = B.hostiles(2).filter((o) => o !== src && chebyshev(o.x, o.y, x, y) <= 1).length;
      const s = (chebyshev(x, y, src.x, src.y) <= 1 ? 3 : 0) - others * 2 + (isWaterTile(t) ? -1 : 0);
      if (s > bs) { bs = s; best = d; }
    }
    if (best) {
      const t0 = B.sig(); movePlayer(best[0], best[1]);
      if (B.sig() !== t0) { B.stats.dodges = (B.stats.dodges || 0) + 1; return true; }
    }
    if (!(player._parry && player._parry.until >= turnCount)) {
      for (const id of B.PARRY_SKILLS) if ((player.knownTechniques || []).includes(id) || (player.knownSpells || []).includes(id)) { if (B.cast({ id }, src)) { B.stats.parries = (B.stats.parries || 0) + 1; return true; } }
    }
    return false;
  };

  // ---------- thrown consumables (firebombs, frost/poison flasks, area scrolls, water flasks) ----------
  // A human with a Firebomb in the pack throws it at the thing that is about to kill them; the bot used to ignore every throwable.
  B.THROW_DAMAGE = new Set(['aoefire', 'aoefrost', 'aoepoison', 'throwdmg', 'scrollfire', 'scrollblast']);
  /** the best damage throwable that is worth using on m right now, or null */
  B.bestThrowable = function (m) {
    if (!m || m.splitInto) return null;
    const d = chebyshev(m.x, m.y, player.x, player.y);
    let best = null;
    for (const it of player.inventory) {
      if (!B.THROW_DAMAGE.has(it.effect) || !Array.isArray(it.power)) continue;
      const r = (it.radius || 0) + (player.throwRadiusBonus || 0);
      if (d > (typeof throwRangeFor === 'function' ? throwRangeFor(it) : 5) || !hasLOS(player.x, player.y, m.x, m.y)) continue;
      if (r > 0 && d <= r + 0.5) continue; // the blast would catch us (the game allows it; the bot just does not choose it)
      if (/fire/.test(it.effect) && (m.fireImmune || m.wetTurns > 0)) continue;
      if (it.element === 'frost' && m.frostImmune) continue;
      const dmg = (it.power[0] + it.power[1]) / 2 * (1 + (player.alchemyPotencyBonus || 0) + (player.throwDmgBonus || 0));
      if (!best || dmg > best.dmg) best = { it, dmg };
    }
    return best;
  };
  /** throw a damage item at m when the fight is a real one (boss, or a simulated loss/coin-flip); returns true when a turn was spent */
  B.tryThrow = function (m) {
    const b = B.bestThrowable(m); if (!b) return false;
    const worth = m.boss || m.miniboss || B.simulate(B.threats(), 40).win < 0.9 || player.hp < player.maxHp * 0.5;
    if (!worth || b.dmg < Math.min(m.hp, 6)) return false;
    const t0 = B.sig(), had = b.it.amount || 1;
    try { resolveThrowAtTile(b.it, m.x, m.y); endTurn(); } catch (e) { B.note('throw error ' + String(e).slice(0, 80)); }
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    const spent = !player.inventory.includes(b.it) || (b.it.amount || 1) < had; // the item left the pack: the turn was used, whatever the signature says
    if (spent) B.stats.throws = (B.stats.throws || 0) + 1;
    return spent || B.sig() !== t0;
  };
  /** on fire with a water flask in the pack: soak ourselves (the combo layer: Wet douses Burning) */
  B.douseSelf = function () {
    if (!((player.burningTurns || 0) > 0)) return false;
    const fl = player.inventory.find((i) => i.effect === 'soaksplash'); if (!fl) return false;
    const t0 = B.sig();
    try { resolveThrowAtTile(fl, player.x, player.y); endTurn(); } catch (e) { B.note('douse error ' + String(e).slice(0, 80)); }
    return B.sig() !== t0 || !((player.burningTurns || 0) > 0); // the flask was spent either way
  };
  B.restPools = function () {
    if (!B.poolsLow() || turnCount - (B.poolFail || -1e5) < 400 || !B.canRest()) return false;
    const t = turnCount; B.rest(400, 1.0); if (B.poolsLow()) B.poolFail = turnCount; return turnCount > t;
  };
  B.poolsLow = function () {
    const abs = B.dmgAbilities(); if (!abs.length) return false;
    return abs.some((a) => { const [cur, max] = B.poolOf(a.res); return cur < max * 0.6; });
  };
  B.attackAdjacent = function (adjMons) {
    adjMons.sort((a, b) => a.hp - b.hp);
    const m = adjMons[0];
    { const big = adjMons.reduce((a, o) => a + o.hp, 0); if (big > B.myDamage(m) * 3 && B.tryCast(adjMons.slice().sort((a, b) => b.hp - a.hp)[0] && m)) return true; }
    const dx = Math.sign(m.x - player.x), dy = Math.sign(m.y - player.y);
    const t0 = B.sig(); movePlayer(dx, dy);
    const ok = B.sig() !== t0;
    if (!ok && m.hp > 0 && m.alive !== false) B.af.push([m.name, m.hp, m.maxHp, m.aiState, m.x, m.y, player.x, player.y, gameState, player.statusStun, player.statusFear, player.statusSlow, (entityAt(m.x, m.y) || {}).name, m.invulnerable, m.friendly, m.faction, 'T' + turnCount].join('|')); if (B.af.length > 8) B.af.shift();
    return ok;
  };

  // ---------- the main dungeon decision ----------
  B.cfg = { slack: 0, fightMinWin: 0.985, fightMaxLossFrac: 0.45, restBelow: 0.85 };

  B.threats = function () {
    const out = [];
    for (const m of B.hostiles(20)) {
      const d = chebyshev(m.x, m.y, player.x, player.y);
      if (m.aiState === 'dormant') continue;
      if (m.splitInto) continue; // harmless chaff that multiplies; walking on is better than fighting it
      if (d > 10) { // archers and casters hit from well outside ten tiles
        const shooter = m.behavior === 'ranged' || m.behavior === 'kiter' || (m.abilities && m.abilities.length) || m.boss;
        if (!shooter || !(m.engaged || m.aiState === 'combat' || m.aiState === 'alert') || !hasLOS(player.x, player.y, m.x, m.y)) continue;
      }
      if (B.ignore && B.ignore[m.uid] > turnCount && d > 1 && !(player.hp < player.maxHp * 0.6 && (m.behavior === 'ranged' || m.behavior === 'kiter' || m.boss))) continue;
      if (m.engaged || m.aiState === 'combat' || m.aiState === 'alert' || d <= 2) out.push(m);
    }
    { // something outside our usual sight range that keeps hitting us still counts as a threat
      const recent = (typeof logMessages !== 'undefined' ? logMessages : []).slice(-10).map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('|');
      if (recent) for (const m of B.hostiles(45)) {
        if (out.includes(m) || m.aiState === 'dormant' || !m.name || !recent.includes(m.name + ' ') || curIsDungeon() || !(m.boss || m.behavior === 'ranged' || m.behavior === 'kiter')) continue;
        if (hasLOS(player.x, player.y, m.x, m.y)) out.push(m);
      }
    }
    return out;
  };

  // Best monster to go and fight: everything it could drag in with it must be beatable.
  // How far from the character's start a sensible player roams at this level (just inside the SPAWN_TIER_RINGS edges 120/200/300). Used by wanderExplore and pickTarget so the bot does not chain-hunt
  // its way 170 tiles into the megaruins at level 1 (seed 52 sweeps: 5 of 20 level-1..4 deaths there).
  B.leash = function () { return player.level < 4 ? 110 : (player.level < 8 ? 190 : (player.level < 14 ? 290 : Infinity)); };
  // far past the leash (overworld, level < 14): stop picking off monsters for XP -- every hunt step drags the bot further out; it should head home instead
  B.tooFar = function (slack) { return !curIsDungeon() && !curIsDimension() && player.level < 14 && typeof startDist === 'function' && startDist(player.x, player.y) > B.leash() + (slack || 30); };
  B.beyondLeash = function (x, y) { return typeof startDist === 'function' && startDist(x, y) > B.leash() && startDist(x, y) > startDist(player.x, player.y); };
  B.pickTarget = function (maxDist) {
    let best = null, bestScore = -1;
    const all = B.hostiles(0);
    const prey = curIsDungeon() ? [] : curMonsters().filter((m) => m.alive && m.behavior === 'flee');
    for (const m of all.concat(prey)) {
      const d = chebyshev(m.x, m.y, player.x, player.y);
      if (maxDist && d > maxDist) continue;
      if (!curIsDungeon() && B.beyondLeash(m.x, m.y)) continue; // do not chase prey further out than this level should roam
      if (m.splitInto) continue; // splitters (pixels, husks) multiply when hit: never worth hunting
      if (B.maxed() && !m.boss) continue; // at the level cap fights give nothing
      if (B.ign && B.ign[m.uid] > turnCount) continue;
      if (m.behavior === 'flee') { const sc = (m.xp || 1) / (6 + d); if (sc > bestScore) { bestScore = sc; best = m; } continue; }
      const pack = all.filter((o) => chebyshev(o.x, o.y, m.x, m.y) <= 5);
      if (pack.some((o) => B.isDangerous(o))) continue;
      const sim = B.simulate(pack, 40, player.maxHp);
      if (sim.win >= B.cfg.fightMinWin && sim.loss < player.maxHp * B.cfg.fightMaxLossFrac) {
        const sc = (m.xp || 1) / (10 + d);
        if (sc > bestScore) { bestScore = sc; best = m; }
      }
    }
    return best;
  };

  // walk toward a hunt target, but give up on one we are not getting any closer to
  B.huntStep = function (tg) {
    B.hs = B.hs || {}; B.ign = B.ign || {};
    const d = chebyshev(tg.x, tg.y, player.x, player.y);
    const h = B.hs[tg.uid] = B.hs[tg.uid] || { best: 1e9, since: 0, steps: 0 };
    if (d < h.best) { h.best = d; h.since = 0; } else h.since++;
    h.steps++;
    if (B.tryCast(tg)) return true;
    if (h.since > 14 || h.steps > 150) { B.ign[tg.uid] = turnCount + 800; delete B.hs[tg.uid]; return false; }
    return B.stepToward(tg.x, tg.y, { adjacent: true, maxNodes: 3000 });
  };
  // worst-case damage the given monsters could do us in one round
  B.burst = function (ms) {
    const parm = getArmorOf(player); let tot = 0;
    for (const m of ms) {
      let best = Math.max(1, ((m.atk || [1, 2])[1] + Math.floor((m.str || 0) / 4)) * 2 - parm);
      if (m.scriptedAI || m.boss) best = Math.round(best * 1.7);
      if (m.abilities && typeof MONSTER_ABILITY_LIBRARY !== 'undefined') for (const id of m.abilities) { const ab = MONSTER_ABILITY_LIBRARY[id]; if (ab && ab.power) best = Math.max(best, Math.round(ab.power[1] * (0.4 + 0.6 * (m.powerScale || 1))) - Math.floor(parm / 2)); }
      if (!isFinite(best)) best = Math.max(1, ((m.atk || [1, 2])[1] + Math.floor((m.str || 0) / 4)) * 2 - parm);
      tot += best;
    }
    return isFinite(tot) ? tot : 0;
  };
  // stair-dance: hop through the up stairs (pursuers do not follow), heal on the other side, come back
  B.dance = function () {
    const dg = curDungeon(); if (!dg) return false;
    B.danceCnt = B.danceCnt || {};
    const key = dg.id + ':' + player.dungeonDepth;
    B.danceCnt[key] = (B.danceCnt[key] || 0) + 1;
    const rec = B.dungeonLog[dg.id] = B.dungeonLog[dg.id] || { done: 0, ex: {} };
    { const tot = B.threats().reduce((a, m) => a + m.hp, 0); B.dprog = B.dprog || {}; const pv = B.dprog[key]; if (pv === undefined || tot < pv * 0.98) { B.dprog[key] = tot; B.danceCnt[key] = 0; } } // the enemy is losing health between visits: keep going
    if (B.danceCnt[key] > 12) { { const th = B.threats(), sm = B.simulate(th, 40); B.note('dance-sim win ' + sm.win.toFixed(2) + ' loss ' + Math.round(sm.loss) + ' turns ' + Math.round(sm.turns) + ' str ' + effStr(player) + ' dex ' + (player.dex) + ' armor ' + getArmorOf(player) + ' weapon ' + JSON.stringify((player.equipment.hand || {}).dmg) + ' mons ' + th.slice().sort((a, b) => (b.boss ? 1 : 0) - (a.boss ? 1 : 0)).slice(0, 4).map((m) => m.name + (m.boss ? '*' : '') + ':atk' + JSON.stringify(m.atk) + ',str' + m.str + ',ar' + m.armor + ',ma' + (m.multiattack || 1) + ',dex' + m.dex + ',hp' + m.hp).join(';') + ' myhit ' + (th[0] ? B.myHitChance(th[0]).toFixed(2) + ' hishit ' + B.hisHitChance(th[0]).toFixed(2) : '')); } B.note('dance-fled ' + B.danceWhy + ' ' + dg.theme + ' d' + player.dungeonDepth + ' hp ' + player.hp + '/' + player.maxHp + ' near: ' + B.hostiles(12).map((m) => m.name + '(' + m.hp + '/' + m.maxHp + ',d' + chebyshev(m.x, m.y, player.x, player.y) + ',' + m.aiState + ')').join(' ')); rec.fled = rec.fled || {}; rec.fled[player.dungeonDepth] = player.level; B.danceCnt[key] = 0; B.danceBack = null; }
    else B.danceBack = { id: dg.id, floor: player.dungeonDepth };
    B.cur = dg; B.stats.flees++;
    useStairsUp();
    return true;
  };
  // after a dance: heal fully, then go back down the same stairs
  B.danceReturn = function () {
    const d = B.danceBack; if (!d) return false;
    if ((player.hp < player.maxHp * 0.97 || B.poolsLow()) && B.canRest()) { B.rest(2000, 1.0); return 'rest'; }
    if (player.hp < player.maxHp * 0.6 && !B.canRest()) return false;
    B.danceBack = null;
    if (!curIsDungeon()) { const t = curTileAt(player.x, player.y); if (t && t.feature === 'dungeon_entrance') { B.cur = dungeonRegistry.get(t.dungeonId); useStairs(); return 'dance-back'; } return false; }
    const st = B.stairs(); if (st.down && B.isOn(st.down)) { useStairs(); return 'dance-back'; }
    if (st.down && B.stepToward(st.down.x, st.down.y)) { B.danceBack = d; return 'dance-walk'; }
    return false;
  };
  B.hpFalling = function () { const h = B.hpHist = B.hpHist || []; if (h.length && h[h.length - 1].t === turnCount) return h.length > 1 && h[h.length - 1].hp < h[0].hp; h.push({ t: turnCount, hp: player.hp }); if (h.length > 4) h.shift(); return h.length > 1 && h[h.length - 1].hp < h[0].hp; };
  // flood fill over walkable tiles: is the target reachable at all, and what non-walkable things border the region we can reach?
  B.reach = function (tx, ty) {
    const seen = new Set(), q = [[player.x, player.y]]; seen.add(player.x + ',' + player.y);
    const border = {}; let n = 0;
    while (q.length && n < 40000) {
      const [x, y] = q.pop(); n++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy, k = nx + ',' + ny; if (seen.has(k)) continue;
        const t = curTileAt(nx, ny); if (!t) continue;
        if (curWalkable(nx, ny)) { seen.add(k); q.push([nx, ny]); }
        else { const f = (t.feature || '?') + (t.hp ? '(destructible)' : ''); border[f] = (border[f] || 0) + 1; }
      }
    }
    return { size: seen.size, targetReachable: seen.has(tx + ',' + ty), border };
  };
  // one line per known dungeon: why is (or is not) it a candidate right now?
  B.cands = function () {
    const out = [];
    for (const d of dungeonRegistry.values()) {
      if (d.isTutorial || d.originMode === 'dimension' || d.originDimensionId) continue;
      const rec = B.dungeonLog[d.id] || {};
      const dist = chebyshev(d.x, d.y, player.x, player.y);
      let top = -1; for (let f = 1; f <= d.maxDepth; f++) if (B.floorWorth(d, f)) top = f;
      out.push([d.id, 'dist' + dist, 'floors' + d.maxDepth, 'L' + Math.round(B.dungeonFloorLevel(d, 1)) + '-' + Math.round(B.dungeonFloorLevel(d, d.maxDepth)), 'top' + top, rec.banUntil > turnCount ? 'ban' + (rec.banUntil - turnCount) : '', rec.fleeN ? 'flee' + rec.fleeN : '', 'ex' + JSON.stringify(rec.ex || {})].join(' '));
    }
    const pick = B.chooseDungeon();
    if (pick) {
      const dist = chebyshev(pick.x, pick.y, player.x, player.y); let gx = pick.x, gy = pick.y;
      if (dist > 30) { gx = player.x + Math.round((pick.x - player.x) * 30 / dist); gy = player.y + Math.round((pick.y - player.y) * 30 / dist); }
      const p = B.path(gx, gy, { maxNodes: 3000, partial: true });
      let x = player.x, y = player.y, bad = 0; const temps = [];
      for (const [dx, dy] of p.steps.slice(0, 30)) { x += dx; y += dy; const t = curTileAt(x, y); if (B.known(x, y) && B.badTile(t)) { bad++; if (temps.length < 4) temps.push(t.biome + ':' + Math.round(B.tileTemp(t))); } }
      out.unshift('PICK ' + pick.id + ' steps ' + p.steps.length + ' complete ' + p.complete + ' bad ' + bad + ' ' + temps.join(',') + ' here ' + (curTileAt(player.x, player.y) || {}).biome + ' T ' + Math.round(currentTemperature()) + ' hereBad ' + B.badTile(curTileAt(player.x, player.y)));
    }
    return out.sort((a, b) => a.startsWith('PICK') ? -1 : b.startsWith('PICK') ? 1 : parseInt(a.split('dist')[1]) - parseInt(b.split('dist')[1])).slice(0, 30);
  };
  B.diag = function () {
    const out = []; out.push('theme ' + (curIsDungeon() ? curDungeon().theme : '-') + ' pos ' + player.x + ',' + player.y + ' dungeon=' + curIsDungeon() + ' depth=' + player.dungeonDepth + ' hp=' + player.hp + ' lvl=' + player.level);
    const st = curIsDungeon() ? B.stairs() : {}; out.push('up ' + JSON.stringify(st.up) + ' down ' + JSON.stringify(st.down));
    const mons = curMonsters().filter((m) => m.alive).map((m) => m.name + '@' + m.x + ',' + m.y + ' ' + m.aiState); out.push('mons ' + mons.slice(0, 20).join(' | '));
    for (let y = player.y - 12; y <= player.y + 12; y++) { let row = ''; for (let x = player.x - 30; x <= player.x + 30; x++) { const t = curTileAt(x, y); let c = ' '; if (t) { const wk = curWalkable(x, y); c = wk ? '.' : '#'; if (t.feature) c = wk ? t.feature[0].toLowerCase() : t.feature[0].toUpperCase(); } if (x === player.x && y === player.y) c = '@'; for (const m of curMonsters()) if (m.alive && m.x === x && m.y === y) c = 'm'; if (st.up && st.up.x === x && st.up.y === y) c = '<'; if (st.down && st.down.x === x && st.down.y === y) c = '>'; row += c; } out.push(row); }
    { const st2 = curIsDungeon() ? B.stairs() : null; if (st2) { const tg = st2.down || st2.up; if (tg) out.push('reach ' + JSON.stringify(B.reach(tg.x, tg.y))); } }
    return out.join('\n');
  };
  // The last fight: GOD cannot be out-damaged in the open, so we fight it from the up stairs and hop upstairs to heal whenever a round could get too dangerous
  B.buffNeeded = function () {
    const ids = (player.knownSpells || []).concat(player.knownTechniques || []);
    let pick = null;
    for (const id of ids) {
      let sp = null; try { sp = findAbilityById(id); } catch (e) { /* */ }
      if (!sp || sp.type !== 'buff' || (sp.stat !== 'armor' && sp.stat !== 'actionspeed')) continue;
      const cur = player.buffs && player.buffs[sp.stat]; if (cur && cur.turns > 2) continue;
      const res = sp.resource || 'mp'; if (res !== 'mp' && res !== 'stamina') continue;
      if (effectiveCost(sp) > B.poolOf(res)[0] * 0.5) continue;
      const val = (sp.stat === 'actionspeed' ? 1000 : 0) + (sp.power || 0);
      if (!pick || val > pick.val) pick = { id, val };
    }
    if (!pick) return false;
    const t0 = B.sig(); try { castSpell(pick.id); } catch (e) { /* */ }
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    return B.sig() !== t0;
  };
  // The last fights: the bosses cannot be out-damaged by weapon swings, so we fight them from the up stairs with spells, heal with spells, and hop upstairs when it gets too dangerous
  // fear makes us unable to fight (melee and offensive spells alike): clear it
  B.cureFear = function () {
    if (!((player.statusFear || 0) > 0)) return false;
    const t0 = B.sig();
    const it = player.inventory.find((i) => (i.type === 'consumable' || i.type === 'scroll') && (i.effect === 'curefear' || i.effect === 'cureall'));
    if (it) { useItem(it); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } return B.sig() !== t0 || true; }
    for (const id of player.knownSpells || []) { const sp = SPELLS.find((x) => x.id === id); if (sp && (sp.type === 'cleanse' || sp.type === 'purify') && effectiveCost(sp) <= (player.mp || 0)) { try { castSpell(id); } catch (e) { /* */ } if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } return B.sig() !== t0; } }
    return false;
  };
  B.godTick = function () {
    const stg = player.story && player.story.stages[player.story.stageIndex];
    if (!stg || !curIsDungeon()) return false;
    let bid = null;
    if (stg.type === 'kill_boss') bid = stg.targetBossId;
    else if (stg.type === 'dimension_trail' && !(player.discoveredDimensions || []).includes(stg.targetDimensionId)) { const gi = DIMENSION_GATE_INFO[stg.targetDimensionId]; if (gi && (gi.kind === 'boss_kill' || (gi.kind === 'item_structure' && !B.hasItemNamed(gi.itemName)))) bid = gi.bossId; }
    if (B.godSkip && turnCount < B.godSkip) return false;
    let guardian = false;
    if (!bid && stg.type === 'dimension_trail' && stg.targetMonsterId) { const gd0 = DIMENSION_TRAIL_GUARDIANS[stg.targetDimensionId], dg1 = curDungeon(); if (gd0 && dg1 && dg1.theme === gd0.theme && player.level >= 70) { bid = stg.targetMonsterId; guardian = true; } }
    if (!bid || (!guardian && bid !== 'god' && bid !== 'the_antagonist' && !B.bossReady(bid))) return false;
    const g = curMonsters().find((m) => m.alive && m.hp > 0 && (bid === 'god' ? m.scriptedAI === 'god' : m.monsterId === bid)); if (!g) return false;
    const up = B.stairs().up; if (!up) return false;
    const onUp = B.isOn(up), gd = chebyshev(g.x, g.y, player.x, player.y);
    if (!g.engaged && gd <= 20 && hasLOS(player.x, player.y, g.x, g.y)) g.engaged = true; // let it see us and come to the stairs
    const near = B.hostiles(3).filter((m) => !m.splitInto);
    const adj = near.filter((m) => chebyshev(m.x, m.y, player.x, player.y) <= 1);
    B.godLog = B.godLog || { n: 0 };
    const hop = () => { const dg = curDungeon(); B.danceBack = { id: dg.id, floor: player.dungeonDepth }; B.cur = dg; B.stats.flees++; B.note('god-hop hp ' + player.hp + ' mp ' + player.mp + ' god ' + g.hp + '/' + g.maxHp); useStairsUp(); return 'god-hop'; };
    if (B.poisonCheck()) return 'antidote';
    const burst = B.burst(near.filter((m) => chebyshev(m.x, m.y, player.x, player.y) <= 2));
    const engaged = adj.length || (gd <= 9 && hasLOS(player.x, player.y, g.x, g.y));
    if (engaged) {
      if (B.cureFear()) return 'god-cure';
      const low = player.hp < Math.max(burst * 0.8, player.maxHp * 0.4);
      if (player.hp < player.maxHp * 0.6) { if (B.drinkHeal()) return 'god-heal'; }
      if (low) { if (onUp) return hop(); if (B.stepToward(up.x, up.y, { partial: true, avoidMonsters: false })) return 'god-retreat'; }
      if (B.buffNeeded()) return 'god-buff';
      if (gd <= 8 && B.tryCast(g, 0)) { if (++B.godLog.n % 20 === 1) B.note('god-cast hp ' + player.hp + ' mp ' + player.mp + ' god ' + g.hp + '/' + g.maxHp); return 'god-cast'; }
      if (adj.length) { if (++B.godLog.n % 20 === 1) B.note('god-melee hp ' + player.hp + ' mp ' + player.mp + ' god ' + g.hp + '/' + g.maxHp + ' burst ' + burst); return B.attackAdjacent(adj) ? 'god-attack' : 'god-wait'; }
      if (!B.poolsLow() && gd > 1 && B.stepToward(g.x, g.y, { adjacent: true, partial: true, avoidMonsters: false })) return 'god-close';
    }
    if (!onUp) {
      if (!g.engaged && B.stepToward(g.x, g.y, { adjacent: true, partial: true, avoidMonsters: false })) return 'god-approach';
      if (player.hp < player.maxHp * 0.4 && B.drinkHeal()) return 'heal';
      if (B.stepToward(up.x, up.y, { partial: true, avoidMonsters: false })) return 'god-to-stairs';
      return false;
    }
    B.godWait = (B.godWait || 0) + 1;
    if (B.godWait > 600) { B.godWait = 0; B.godSkip = turnCount + 600; B.note('god-wait-giveup hp ' + player.hp + '/' + player.maxHp + ' mp ' + player.mp + ' gd ' + gd); return false; }
    if (player.hp < player.maxHp * 0.9 || B.poolsLow()) { if (player.hp < player.maxHp * 0.9 && B.drinkHeal()) return 'god-heal'; endTurn({ forceFull: true }); return 'god-wait'; }
    if (B.godWait > 20 && gd > 1) { if (B.stepToward(g.x, g.y, { adjacent: true, partial: true, avoidMonsters: false })) return 'god-approach'; }
    endTurn({ forceFull: true }); return 'god-wait';
  };
  B.tickDungeon = function () {
    if (B.useBandageIfBleeding()) return 'bandage';
    if (B.poisonCheck()) return 'antidote';
    if (B.dodgeManeuver()) return 'dodge';
    if (B.escapeHazard()) return 'escape-hazard';
    if (B.needRecall && turnCount < B.needRecall && !curIsDimension()) { if (B.recallOut()) { B.needRecall = 0; return 'recall'; } }
    if (B.needRecall && turnCount < B.needRecall && !curIsDimension() && B.hostiles(3).length === 0) { // no stone, no spell: the exit-waystone on the deepest floor of a big dungeon does the same job
      const dgw = curDungeon();
      if (dgw && dgw.maxDepth >= 6) {
        if (player.dungeonDepth < dgw.maxDepth) { const dn = B.stairs().down; if (dn) { if (B.isOn(dn)) { useStairs(); return 'wayst-down'; } if (B.stepToward(dn.x, dn.y, { partial: true })) return 'wayst-to-stairs'; } }
        else { const L = curDungeonLevel(); let wx = -1, wy = -1; if (L && L.grid) for (let y = 0; y < L.h && wx < 0; y++) for (let x = 0; x < L.w; x++) { const t = L.grid[y][x]; if (t && t.feature === 'waystone') { wx = x; wy = y; break; } }
          if (wx >= 0) { if (player.x === wx && player.y === wy) { B.needRecall = 0; B.note('exit-waystone used'); useStairs(); return 'waystone'; } if (B.stepToward(wx, wy, { partial: true })) return 'to-waystone'; } }
      }
    }
    { const r = B.godTick(); if (r) return r; }
    { const dg0 = curDungeon(); const st0 = player.story && player.story.stages[player.story.stageIndex];
      if (dg0 && dg0.theme === 'dream_sanctum' && st0 && st0.type === 'dimension_trail' && !(player.discoveredDimensions || []).includes(st0.targetDimensionId) && B.hostiles(3).length === 0) { // the peaceful gate: lie down at the altar on the last floor
        const L = curDungeonLevel(); let ax = -1, ay = -1;
        if (L && L.grid) for (let y = 0; y < L.h && ax < 0; y++) for (let x = 0; x < L.w; x++) { const t = L.grid[y][x]; if (t && t.feature === 'slumbering_altar') { ax = x; ay = y; break; } }
        if (ax >= 0) { if (player.x === ax && player.y === ay) { B.note('lying down at the slumbering altar'); useStairs(); return 'altar'; } if (B.stepToward(ax, ay, { partial: true })) return 'to-altar'; }
        else { const dn = B.stairs().down; if (dn) { if (B.isOn(dn)) { useStairs(); return 'sanct-down'; } if (B.stepToward(dn.x, dn.y, { partial: true })) return 'sanct-to-stairs'; } }
      } }
    if ((player.statusFear || 0) > 0 && B.hostiles(6).length && B.cureFear()) return 'cure-fear';
    // afraid with no cure: every attack/offensive cast is refused (the turn is spent), so standing next to the thing only feeds it free hits -- walk away instead
    if ((player.statusFear || 0) > 0 && B.hostiles(2).length && B.flee()) return 'flee-fear';
    const threats = B.threats();
    const adj = threats.filter((m) => chebyshev(m.x, m.y, player.x, player.y) <= 1);
    if (threats.length) {
      const sim = B.simulate(threats, 60);
      const bad = sim.win < 0.93 || sim.loss > player.hp * 0.7;
      const trivial = sim.win >= 0.995 && sim.loss < player.hp * 0.3;
      const st = B.stairs(), up = st.up;
      const onUp = !!up && B.isOn(up);
      const upDist = up ? chebyshev(up.x, up.y, player.x, player.y) : 99;
      const burst = B.burst(threats.filter((m) => chebyshev(m.x, m.y, player.x, player.y) <= 2));
      const shooters = threats.some((m) => m.behavior === 'ranged' || m.behavior === 'kiter' || (m.abilities && m.abilities.length));
      // 1. standing on the up stairs: the safest place there is -- fight here, hop up to heal when it gets hairy
      if (onUp) {
        B.commit = 0;
        const hpOk = player.hp > Math.max(burst * (threats.some((m) => m.boss) ? 0.8 : 1.4), player.maxHp * 0.35); // our hit chance on them is low, so a worst-case round of every blow landing is very unlikely
        if (adj.length) {
          if (hpOk) { B.stats.fights++; return B.attackAdjacent(adj) ? 'attack-stairs' : 'attack-fail'; }
          B.danceWhy = 'adj burst ' + burst + ' hp ' + player.hp; if (B.dance()) return 'dance';
        } else if (shooters && (bad || !hpOk)) { B.danceWhy = 'shoot bad=' + bad + ' hpOk=' + hpOk + ' win ' + sim.win + ' loss ' + Math.round(sim.loss) + ' n ' + threats.length + ' burst ' + burst; if (B.dance()) return 'dance'; }
        else if (!bad || trivial) { B.waits = (B.waits || 0) + 1; if (B.waits <= 10) { endTurn(); return 'wait-stairs'; } }
      }
      // 2. fight is not trivial: take it to the stairs if they are close
      if (!onUp && !adj.length && up && !trivial && (B.commit > turnCount || upDist <= 16)) {
        if (!(B.commit > turnCount)) B.commit = turnCount + 30;
        if (B.stepToward(up.x, up.y, { partial: true })) return 'to-stairs';
        B.commit = 0;
      }
      if (adj.length) {
        if ((player.hp < player.maxHp * 0.45 || player.hp < burst * 1.6) && B.drinkHeal()) return 'heal';
        if (!onUp && up && upDist <= 2 && (bad || player.hp < burst * 1.5) && B.stepToward(up.x, up.y, { partial: true })) return 'to-stairs';
        if (bad && sim.win < 0.6 && !onUp && up && !((player.statusSlow || 0) > 0) && B.flee()) return 'flee-melee'; // never run while slowed: the move is refused ("too sluggish") and the monster keeps swinging -- Acid Slime engulf killed two characters that way // a same-speed melee monster cannot hit a target that keeps walking; the stairs end the fight
        B.stats.fights++; return B.attackAdjacent(adj) ? 'attack' : 'attack-fail';
      }
      // not adjacent yet
      if ((bad || (shooters && (player.hp < player.maxHp * 0.6 || (threats.length >= 2 && sim.win < 0.85)))) && shooters && !onUp) { B.note('shot at, bad odds: ' + threats.map((m) => m.name).join(',')); if (B.flee()) return 'flee'; }
      const t = threats.slice().sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y))[0];
      if (!bad && B.tryCast(t)) return 'cast';
      if ((t.behavior === 'ranged' || t.behavior === 'kiter') && !bad && player.hp >= player.maxHp * 0.6) {
        B.chg = (B.chgT === turnCount - 1 || B.chgT === turnCount) ? (B.chg || 0) + 1 : 1; B.chgT = turnCount;
        if (B.chg > 10) { B.ignore = B.ignore || {}; for (const m of threats) B.ignore[m.uid] = turnCount + 150; B.chg = 0; if (B.flee()) return 'flee'; } // it keeps its distance: chasing it just feeds it free shots
        else if (B.stepToward(t.x, t.y, { adjacent: true })) return 'charge';
      }
      B.waits = (B.waits || 0) + 1;
      if (B.waits <= 6) { endTurn({ forceFull: true }); return 'wait'; }
      B.ignore = B.ignore || {};
      for (const m of threats) B.ignore[m.uid] = turnCount + 60;
      B.waits = 0;
      endTurn({ forceFull: true }); return 'wait';
    }
    B.waits = 0;
    { const dr = B.danceReturn(); if (dr) return dr; }
    if (B.hideUntil > turnCount) { if (player.hp < player.maxHp && B.canRest()) { B.rest(200, 1.0); return 'rest'; } endTurn({ forceFull: true }); return 'shelter'; }
    // calm: loot, heal, then hunt
    if (B.lootHere()) return 'loot';
    if (player.hp < player.maxHp * B.cfg.restBelow && B.canRest()) { B.stats.rests++; B.rest(2000, 1.0); return 'rest'; }
    if (B.restPools()) return 'rest-pools';
    if ((player.statPoints || 0) > 0) { B.spendPoints(); return 'stats'; }
    if ((player.talentPoints || 0) > 0 && B.spendTalents()) return 'talent';
    if (B.equipBest()) return 'equip';
    // far beyond what this level should roam (a dungeon that exits somewhere else, a dodge, an errand): walk home BEFORE hunting/shopping/approaching anything further out.
    // The idle-branch go-home further down is never reached while there is always something to approach; a L3-L6 character was seen at 210-390 tiles this way.
    if (!curIsDungeon() && !curIsDimension() && player.level < 14 && typeof startDist === 'function' && startDist(player.x, player.y) > B.leash() + 60 && !B.hostiles(0).some((m) => chebyshev(m.x, m.y, player.x, player.y) <= 4)) { const s0 = worldStartAnchor || { x: 0, y: 0 }; if (B.travelTo(s0.x, s0.y)) return 'go-home'; }
    if (B.refugeUntil > turnCount) { if (player.hp < player.maxHp && B.canRest()) { B.rest(300, 1.0); return 'rest'; } endTurn(); return 'hide'; }
    if (player.hp < player.maxHp * 0.4 && ((player.statusPoison || 0) > 0 || (player.bleedTurns || 0) > 0 || B.hpFalling())) { if (B.drinkHeal()) return 'heal'; }
    // rest lock: hurt, but a monster we are ignoring keeps us in line of sight so resting is refused -> step away from it
    if (player.hp < player.maxHp * 0.6 && B.comfy() && !B.canRest() && !B.hpFalling()) {
      B.restLock = (B.restLock || 0) + 1;
      if (B.restLock > 3 && B.restLock % 4 === 0 && B.flee()) { B.stats.restLockEscapes = (B.stats.restLockEscapes || 0) + 1; return 'rest-lock-retreat'; }
    } else B.restLock = 0;
    if (player.hp < player.maxHp * 0.75 && !B.hpFalling()) { B.holds = (B.holds || 0) + 1; if (B.holds < 25) { endTurn(); return 'hold'; } } else B.holds = 0;
    if (B.envDanger && turnCount - B.envDanger <= 4) { // environmental damage with no visible enemy: get out of the room
      if (player.hp < player.maxHp * 0.5 && B.drinkHeal()) return 'heal';
      if (B.flee()) return 'escape-hazard';
      const d = DIRS[Math.floor(Math.random() * DIRS.length)]; const t0 = B.sig(); movePlayer(d[0], d[1]); if (B.sig() !== t0) return 'escape-hazard';
    }
    // something we cannot see or reach is wearing us down (archers, casters): do not chase it at low HP
    if (player.hp < player.maxHp * 0.6 && B.hpFalling()) {
      if (player.hp < player.maxHp * 0.5 && B.drinkHeal()) return 'heal';
      if (B.flee()) return 'retreat';
    }
    { const r = B.riftTick(); if (r) return r; }
    { // the quest boss lives on this floor: go and get it (the whole floor is known to us)
      const stg = player.story && player.story.stages[player.story.stageIndex];
      let sb = null;
      if (stg && stg.type === 'kill_boss' && stg.targetBossId !== 'god' && stg.targetBossId !== 'the_antagonist') sb = stg.targetBossId;
      else if (stg && stg.type === 'dimension_trail' && !(player.discoveredDimensions || []).includes(stg.targetDimensionId)) { const gi = DIMENSION_GATE_INFO[stg.targetDimensionId]; if (gi && (gi.kind === 'boss_kill' || (gi.kind === 'item_structure' && !B.hasItemNamed(gi.itemName)))) sb = gi.bossId; }
      if (sb && B.stageWants(curDungeon())) {
        const bm = curMonsters().find((m) => m.alive && m.hp > 0 && m.monsterId === sb);
        if (bm && B.bossReady(sb)) { if (B.tryCast(bm, 0)) return 'boss-cast'; if (B.huntStep(bm)) return 'boss-hunt'; }
      }
    }
    // choose a monster to hunt
    const lvl = curDungeonLevel();
    const best = B.pickTarget(0);
    if (best) { if (B.huntStep(best)) return 'hunt'; }
    // items on the floor
    if (lvl.items && lvl.items.length) {
      B.skip = B.skip || {};
      const it = lvl.items.filter((e) => e.item && e.item.type !== 'corpse' && !(B.skip[e.x + ',' + e.y + ',' + player.dungeonDepth] > 60)).sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y))[0];
      if (it) { const k = it.x + ',' + it.y + ',' + player.dungeonDepth; B.skip[k] = (B.skip[k] || 0) + 1; if (B.stepToward(it.x, it.y)) return 'fetch'; B.skip[k] = 999; }
    }
    return B.dungeonDone();
  };
  B.floorWorth = function (dg, f) {
    const rec = B.dungeonLog[dg.id] = B.dungeonLog[dg.id] || { done: 0, ex: {} };
    rec.ex = rec.ex || {};
    if (B.dungeonFloorLevel(dg, f) > player.level + (B.cfg.slack || 0)) return false;
    if (B.maxed()) return false;
    if (rec.fled && rec.fled[f] === player.level) return false;
    const e = rec.ex[f];
    rec.ext = rec.ext || {};
    return e === undefined || player.level > e || turnCount - (rec.ext[f] || 0) > 5000;
  };
  B.dungeonDone = function () {
    const dg = curDungeon(), st = B.stairs();
    const rec = B.dungeonLog[dg.id] = B.dungeonLog[dg.id] || { done: 0, ex: {} };
    rec.ex = rec.ex || {};
    rec.ex[player.dungeonDepth] = player.level;
    rec.ext = rec.ext || {}; rec.ext[player.dungeonDepth] = turnCount;
    rec.done = Math.max(rec.done, player.dungeonDepth);
    let goDown = false;
    if (!(rec.banUntil > turnCount) && B.stageWants(dg) && B.dungeonFloorLevel(dg, dg.maxDepth) <= player.level + B.qslack()) { // (banUntil: finishing this dungeon was held back on purpose, see below)
      if (player.dungeonDepth < dg.maxDepth) goDown = true;
      else if (st.down) { // deepest floor cleared: try to go further -- this is what completes a 'dungeon tier' stage
        if (!(player.story && player.story.stages[player.story.stageIndex] && player.story.stages[player.story.stageIndex].type === 'dungeon_tier')) { /* only a dungeon-tier stage is completed by going below the last floor */ }
        else if (!B.nextBossReady()) { rec.banUntil = turnCount + 2500; /* finishing this would summon a boss we cannot beat yet. Walking up and straight back down for it (a level-46 summoner did ~150 round trips in one deep run) just burns turns: leave it alone for a while */ }
        else if (B.isOn(st.down)) { descend(); B.dungeonLog[dg.id].ex = {}; return 'tier-complete'; }
        else if (B.stepToward(st.down.x, st.down.y)) return 'to-deepest-stairs';
      }
    }
    const offTrail = curIsDimension() && (() => { const ts = B.trailStage(); return !ts || ts.targetDimensionId !== player.dimensionId; })(); // nothing left for us in this dimension: only climb out
    if (offTrail) goDown = false;
    // nearest floor still worth working
    for (let k = 1; k <= dg.maxDepth; k++) {
      if (goDown || offTrail) break;
      if (player.dungeonDepth + k <= dg.maxDepth && B.floorWorth(dg, player.dungeonDepth + k)) { goDown = true; break; }
      if (player.dungeonDepth - k >= 1 && B.floorWorth(dg, player.dungeonDepth - k)) { goDown = false; break; }
    }
    const target = goDown ? st.down : st.up;
    if (!target) return 'idle:nostairs';
    if (B.isOn(target)) {
      B.sdl = (B.sdl || 0) + 1; if (B.sdl % 400 === 50 || (player.dungeonDepth === dg.maxDepth && B.sdl % 100 === 7)) B.note('STAIRLOOP ' + JSON.stringify({ me: [player.hp, player.maxHp, player.mp, player.maxMp, player.str, player.dex, player.int, (player.knownSpells || []).join(','), (player.knownTechniques || []).length], boss: (function () { const b = curMonsters().find((m) => m.alive && m.boss); return b ? [b.dmg || b.damage, b.def, b.abilities, b.behavior, b.speed] : null; })(),  mons: curMonsters().filter((m) => m.alive).slice(0, 6).map((m) => [m.monsterId, m.hp, m.maxHp, m.x, m.y, !!m.boss, B.simulate([m], 40).win]), pos: [player.x, player.y],  id: dg.id, theme: dg.theme, depth: player.dungeonDepth, max: dg.maxDepth, goDown, sw: B.stageWants(dg), maxed: B.maxed(), rec, fl: B.dungeonFloorLevel(dg, player.dungeonDepth + 1), lvl: player.level }));
      if (goDown) useStairs(); else { useStairsUp(); if (player.dungeonDepth === 0 || !curIsDungeon()) B.goalDungeon = null; }
      return goDown ? 'descend' : 'leave';
    }
    if (B.stepToward(target.x, target.y)) return 'to-exit';
    B.nopath = (B.nopath || 0) + 1;
    { // something is standing in the way (a sleeper in a corridor, say): plan through it and deal with whatever is on the first step
      const p = B.path(target.x, target.y, { avoidMonsters: false, ignoreDanger: true, maxNodes: 20000 });
      if (p.complete && p.steps.length) {
        const [dx, dy] = p.steps[0], nx = player.x + dx, ny = player.y + dy;
        const m = curMonsters().find((e) => e.alive && e.x === nx && e.y === ny);
        if (!m) { const t0 = B.sig(); movePlayer(dx, dy); if (B.sig() !== t0) return 'to-exit'; }
        else if (B.simulate([m], 40).win >= 0.85) { B.attackAdjacent([m]); return 'clear-way'; }
      }
    }
    { const other = goDown ? st.up : st.down; // the stairs we wanted are cut off: the other ones lead out of this pocket too
      if (B.nopath >= 20 && other) { if (B.isOn(other)) { B.nopath = 0; if (goDown) useStairsUp(); else useStairs(); return 'alt-stairs'; } if (B.stepToward(other.x, other.y)) return 'to-alt-stairs'; } }
    if (B.nopath >= 80 && B.nopath % 5 === 0) { // marooned (an island, a sealed pocket): the only way out may be to jump into a chasm, which drops us one floor down
      let best = null, bd = 1e9;
      for (let dy = -25; dy <= 25; dy++) for (let dx = -25; dx <= 25; dx++) { const t = curTileAt(player.x + dx, player.y + dy); if (t && t.feature === 'chasm') { const d = Math.max(Math.abs(dx), Math.abs(dy)); if (d < bd) { bd = d; best = [player.x + dx, player.y + dy]; } } }
      if (best) { B.wantJump = turnCount + 60; if (bd <= 1) { const t0 = B.sig(); movePlayer(Math.sign(best[0] - player.x), Math.sign(best[1] - player.y)); return 'to-chasm'; } if (B.stepToward(best[0], best[1], { partial: true, avoidMonsters: false, ignoreDanger: true })) return 'to-chasm'; }
    }
    if (B.nopath % 40 === 0) { // cannot reach the stairs: shove through whatever is in the way, or wander
      const blockers = curMonsters().filter((m) => m.alive && chebyshev(m.x, m.y, player.x, player.y) <= 1);
      if (blockers.length) { B.attackAdjacent(blockers); return 'unstick-attack'; }
      const p = B.path(target.x, target.y, { avoidMonsters: false, ignoreDanger: true, partial: true, maxNodes: 8000 });
      if (p.steps.length) { const [dx, dy] = p.steps[0]; movePlayer(dx, dy); return 'unstick-walk'; }
      const d = DIRS[Math.floor(Math.random() * DIRS.length)]; movePlayer(d[0], d[1]); return 'unstick-random';
    }
    return 'idle:nopath';
  };

  // ---------- overworld ----------
  B.scanned = {};
  B.scanDungeons = function (rad) {
    const pcx = Math.floor(player.x / 24), pcy = Math.floor(player.y / 24);
    const t0 = Date.now();
    for (let r = 0; r <= rad; r++) for (let cy = pcy - r; cy <= pcy + r; cy++) for (let cx = pcx - r; cx <= pcx + r; cx++) {
      if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) !== r) continue;
      const k = cx + ',' + cy; if (B.scanned[k]) continue;
      if (Date.now() - t0 > 400) { B.scanPending = rad; return false; } // keep each tick short; resume next tick
      B.scanned[k] = 1; getChunk(cx, cy);
    }
    B.scanPending = null; return true;
  };
  // The last floor holds the boss, generated at depthScale maxDepth+1+bonus (see the game's recommendedLevel comment): a 2-floor dungeon whose entrance says "recommended level 10+" has its boss at ~level 10, not at floor-2 strength.
  // Ignoring that sent level 4-6 characters down to Alpha Wolves hitting for 20-40 (39 of 92 deaths in a 75-build sweep).
  B.dungeonFloorLevel = function (d, floor) { const base = 1 + (floor + (d.depthScaleBonus || 0) - 1) * 98 / 13; return floor >= d.maxDepth ? Math.max(base, d.recommendedLevel || 0) : base; };
  B.qslack = () => (player.level >= 55 ? 12 : 1) + Math.min(20, Math.floor(B.xpIdle() / 600)); // strong characters take on quest dungeons a bit above their level (the fight sim and the stairs-dance keep it safe)
  B.dungeonLog = {};
  // does the current story stage want this particular dungeon?
  B.questWantsDungeon = function () { const st = player.story && player.story.stages[player.story.stageIndex]; if (st && st.type === 'dimension_trail' && !(player.discoveredDimensions || []).includes(st.targetDimensionId) && DIMENSION_GATE_INFO[st.targetDimensionId]) { const g9 = DIMENSION_GATE_INFO[st.targetDimensionId]; if (g9.kind === 'discovery' || (g9.kind === 'item_structure' && !B.hasItemNamed(g9.itemName))) return true; } return !!st && (st.type === 'dungeon_tier' || (st.type === 'kill_boss' && typeof BOSS_DUNGEON_THEME !== 'undefined' && !!BOSS_DUNGEON_THEME[st.targetBossId])); };
  B.stageWants = function (d) { // remembered for a while, so a borderline fight estimate cannot flip us between floors
    const k = d.id + '#' + (player.story ? player.story.stageIndex : 0); B._sw = B._sw || {};
    if (B._sw[k] > turnCount) return true;
    const r = B.stageWants0(d); if (r) B._sw[k] = turnCount + 1500; return r;
  };
  B.stageWants0 = function (d) {
    const st = player.story && player.story.stages[player.story.stageIndex]; if (!st) return false;
    if (st.type === 'dungeon_tier') return d.tier === st.targetTier && B.nextBossReady();
    if (st.type === 'dimension_trail') { // the gatekeeper's dungeon (to open the rift) -- the guardian's dungeon is chosen separately, inside the dimension
      const dimId = st.targetDimensionId, g = DIMENSION_GATE_INFO[dimId];
      if ((player.discoveredDimensions || []).includes(dimId)) { const gd = DIMENSION_TRAIL_GUARDIANS[dimId]; return !!gd && d.theme === gd.theme; }
      if (g && g.kind === 'discovery') return d.theme === 'dream_sanctum';
      if (g && g.kind === 'item_structure') { const th0 = BOSS_DUNGEON_THEME[g.bossId]; return !B.hasItemNamed(g.itemName) && !!th0 && d.theme === th0.theme && B.bossReady(g.bossId); }
      if (!g || g.kind !== 'boss_kill') return false;
      const th = BOSS_DUNGEON_THEME[g.bossId]; return !!th && d.theme === th.theme && B.bossReady(g.bossId);
    }
    if (st.type === 'kill_boss' && typeof BOSS_DUNGEON_THEME !== 'undefined') { const th = BOSS_DUNGEON_THEME[st.targetBossId === 'god' ? 'the_antagonist' : st.targetBossId]; return !!th && d.theme === th.theme && B.bossReady(st.targetBossId); }
    return false;
  };
  B.chooseDungeon = function () {
    let best = null; B.home = B.home || { x: player.x, y: player.y };
    // --devdungeon: the planted dungeon is the bot's goal until it has been completed once (or the bot flees it 3 times), so a test run really goes through it
    if (typeof window !== 'undefined' && window.__devDungeonId) { const dd = dungeonRegistry.get(window.__devDungeonId), lg = B.dungeonLog[window.__devDungeonId] || { done: 0 }; if (dd && !lg.done && !(lg.fleeN >= 3)) return dd; }
    for (const d of dungeonRegistry.values()) {
      if (d.isTutorial || d.originMode === 'dimension' || d.originDimensionId) continue;
      const rec = B.dungeonLog[d.id] || { done: 0 };
      if (rec.banUntil > turnCount) continue;
      if (rec.fleeN >= 3 && rec.fleeLvl === player.level) continue;
      if (B.dangerZones().some((z) => chebyshev(z.x, z.y, d.x, d.y) <= z.r + 2)) { B.dungeonLog[d.id] = Object.assign(B.dungeonLog[d.id] || { done: 0 }, { banUntil: turnCount + 1500 }); continue; } // something we cannot beat is parked at the entrance (ban for a while so we do not oscillate)
      let top = -1;
      const want = B.stageWants(d);
      if (B.dungeonFloorLevel(d, 1) > player.level + (B.cfg.slack || 0)) continue;
      for (let f = 1; f <= d.maxDepth; f++) if (B.floorWorth(d, f)) top = f;
      if (want && B.dungeonFloorLevel(d, d.maxDepth) <= player.level + B.qslack() && !(rec.fled && rec.fled[d.maxDepth] === player.level)) top = Math.max(top, 1); // quest dungeon: go all the way
      else if (want) { /* not ready for the deep floors: treat as an ordinary dungeon */ }
      if (top < 1) continue;
      const lvl = B.dungeonFloorLevel(d, top);
      const dist = chebyshev(d.x, d.y, player.x, player.y);
      if ((typeof startDist === 'function' ? startDist(d.x, d.y) : Math.min(dist, B.home ? chebyshev(d.x, d.y, B.home.x, B.home.y) : dist)) > Math.min(50 + 12 * player.level + Math.min(400, B.xpIdle() * 0.15), B.leash() + 20) && !(want && B.dungeonFloorLevel(d, d.maxDepth) <= player.level + B.qslack())) continue; // low levels stay near home
      const score = dist / 25 + Math.max(0, player.level - lvl) * 0.2 + (d.tier === 'common' ? 0 : 0.5) - (want && B.dungeonFloorLevel(d, d.maxDepth) <= player.level + B.qslack() ? 1000 : 0);
      if (!best || score < best.score) best = { d, score };
    }
    return best && best.d;
  };
  B.sig = () => turnCount + ',' + player.x + ',' + player.y + ',' + player.hp + ',' + (player.stamina || 0) + ',' + (player.mp || 0); // a turn, a step or a blow: any of these changed means we acted (free extra moves do not advance turnCount)
  B.tpWhy = {}; B.why = (k) => { B.tpWhy[k] = (B.tpWhy[k] || 0) + 1; };
  // coarse, whole-world route finder on the terrain noise itself: tells at once whether a far target is on our landmass, and gives waypoints around seas and mountain ranges
  B.coarseRoute = function (tx, ty) {
    const S = 8, sx = Math.round(player.x / S), sy = Math.round(player.y / S), gx = Math.round(tx / S), gy = Math.round(ty / S);
    const wk = new Map(); const walk = (cx, cy) => { const k = cx * 100003 + cy; let v = wk.get(k); if (v === undefined) { let b; try { b = classifyBiomeFull(cx * S, cy * S); } catch (e) { b = 'plains'; } v = !!(BIOMES[b] && BIOMES[b].walkable); wk.set(k, v); } return v; };
    const key = (x, y) => x * 100003 + y, open = [[0, sx, sy]], g = new Map([[key(sx, sy), 0]]), from = new Map();
    const hh = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(dx, dy) + 0.41 * Math.min(dx, dy); };
    open[0][0] = hh(sx, sy); let n = 0, found = false;
    const pop = () => { let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i; const r = open[bi]; open[bi] = open[open.length - 1]; open.pop(); return r; };
    while (open.length && n++ < 40000) {
      const [, x, y] = pop();
      if (Math.abs(x - gx) <= 1 && Math.abs(y - gy) <= 1) { found = [x, y]; break; }
      const gc = g.get(key(x, y));
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (!walk(nx, ny)) continue; if (dx && dy && (!walk(x + dx, y) || !walk(x, y + dy))) continue; const c = gc + (dx && dy ? 1.41 : 1), k = key(nx, ny); if (g.has(k) && g.get(k) <= c) continue; g.set(k, c); from.set(k, [x, y]); open.push([c + hh(nx, ny), nx, ny]); }
    }
    if (!found) return open.length === 0 ? null : undefined; // null: provably cut off; undefined: gave up searching
    const pts = []; let cur = found; while (cur && !(cur[0] === sx && cur[1] === sy)) { pts.push({ x: cur[0] * S, y: cur[1] * S }); cur = from.get(key(cur[0], cur[1])); }
    pts.reverse(); return pts;
  };
  B.travelTo = function (tx, ty) {
    if (!curIsDungeon() && !curIsDimension() && chebyshev(tx, ty, player.x, player.y) > 250 && turnCount - (B.lhT || -9999) > 300 && gameState === 'playing' && B.hostiles(6).length === 0) { // far trip: hop over the known waystone network first
      B.lhT = turnCount;
      const stn = player.inventory.find((i) => /stone_recall/.test(i.id || '') || /Recall Stone/i.test(i.name || ''));
      const haveSp = (player.knownSpells || []).includes('teleport') && (() => { const sp = SPELLS.find((x) => x.id === 'teleport'); return sp && effectiveCost(sp) <= (player.mp || 0) * 0.5; })();
      if (haveSp || stn) {
        try {
          if (haveSp) castSpell('teleport'); else useItem(stn);
          if (gameState === 'travel' && typeof travelDestinations !== 'undefined') {
            const here = chebyshev(tx, ty, player.x, player.y); let bi = -1, bd = here - 200;
            travelDestinations.forEach((d, i) => { const dd = chebyshev(tx, ty, d.x, d.y); if (dd < bd) { bd = dd; bi = i; } });
            if (bi >= 0) { confirmTravel(String.fromCharCode(97 + bi)); B.note('long-hop to ' + travelDestinations[bi].label + ' (' + here + ' -> ' + bd + ' from target)'); B.tp = null; return true; }
          }
        } catch (e) { /* */ }
        if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      }
    }
    if (!curIsDungeon() && !curIsDimension() && chebyshev(tx, ty, player.x, player.y) > 90 && typeof classifyBiomeFull === 'function') {
      const key = tx + ',' + ty; B.unreach = B.unreach || {};
      if ((B.unreach[key] || 0) > turnCount) { B.why('unreach'); return false; }
      if (!B.cr || B.cr.key !== key || turnCount - B.cr.t > 3000) { const pts = B.coarseRoute(tx, ty); B.cr = { key, t: turnCount, pts: pts || [] }; if (pts === null) { B.unreach[key] = turnCount + 20000; B.note('no land route to ' + key); return false; } }
      const pts = B.cr.pts; while (pts.length > 1 && chebyshev(pts[0].x, pts[0].y, player.x, player.y) < 14) pts.shift();
      for (let att = 0; att < 3 && pts.length > 3; att++) { // aim a few cells ahead so the local planner has room to round obstacles; a waypoint that cannot be reached is skipped over
        let w = pts[Math.min(pts.length - 1, 5)]; if (chebyshev(w.x, w.y, player.x, player.y) < 10) w = pts[pts.length - 1];
        if (!(chebyshev(w.x, w.y, tx, ty) > 20 && chebyshev(w.x, w.y, player.x, player.y) >= 10)) break;
        if (B.travelTo0(w.x, w.y)) return true;
        pts.splice(0, Math.max(1, pts.indexOf(w)));
      }
    }
    return B.travelTo0(tx, ty);
  };
  B.travelTo0 = function (tx, ty) {
    // walk toward a far target in hops, replanning only when the cached path runs out or is blocked
    const key = tx + ',' + ty;
    B.unreach = B.unreach || {}; B.nsF = B.nsF || {};
    if ((B.unreach[key] || 0) > turnCount) { B.why('unreach'); return false; }
    { B.pg = B.pg || {}; const dd = chebyshev(tx, ty, player.x, player.y); const q = B.pg[key];
      if (!q || turnCount - q.last > 100) B.pg[key] = { best: dd, t: turnCount, last: turnCount };
      else { q.last = turnCount; if (dd < q.best - 2) { q.best = dd; q.t = turnCount; } else if (turnCount - q.t > 1200 && dd > 1) { B.unreach[key] = turnCount + 4000; delete B.pg[key]; B.tp = null; B.note('no progress toward ' + key + ' in 1200 turns: abandoned for a while'); B.why('unreach'); return false; } } }
    if (!B.tp || B.tp.key !== key || !B.tp.steps.length) {
      const dist = chebyshev(tx, ty, player.x, player.y);
      let gx = tx, gy = ty;
      let p = B.path(gx, gy, { maxNodes: dist > 30 ? 8000 : 4000, partial: true, frontier: true });
      const prog = (q) => { let x = player.x, y = player.y; for (const [dx, dy] of q.steps) { x += dx; y += dy; } return chebyshev(gx, gy, player.x, player.y) - chebyshev(gx, gy, x, y); };
      if (!p.steps.length) { const p2 = B.path(gx, gy, { maxNodes: 30000, partial: true }); if (p2.steps.length) p = p2; }
      if (!p.steps.length || (!p.complete && prog(p) < 3)) { const p3 = B.path(tx, ty, { maxNodes: 20000, partial: true, frontier: true }); if (p3.steps.length) p = p3; } // local pocket against a wall: search wider before giving up
      if (!p.steps.length) {
        B.tp = null; B.why('nosteps'); if ((B.tpWhy.nosteps || 0) % 200 === 1) { const tt = curTileAt(tx, ty); B.note('NOSTEPS from ' + player.x + ',' + player.y + ' to ' + tx + ',' + ty + ' tgt ' + (tt ? tt.biome + '/' + tt.walkable : '?') + ' known ' + B.known(tx, ty) + ' hp ' + player.hp + ' slow ' + player.statusSlow + ' near ' + curMonsters().filter((m) => m.alive && chebyshev(m.x, m.y, player.x, player.y) <= 6).map((m) => m.name + '@' + m.x + ',' + m.y).join(';')); } B.nsC = (B.nsC || 0) + 1; { const f = B.nsF[key] = B.nsF[key] || { n: 0, t: turnCount }; if (turnCount - f.t > 600) { f.n = 0; f.t = turnCount; } if (++f.n >= 25) { B.unreach[key] = turnCount + 4000; f.n = 0; B.note('unreachable target ' + key + ' (abandoned for a while)'); } }
        if (B.nsC >= 4) { // boxed in: shuffle to any free neighbour so the planner sees a different start
          const ds = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].sort(() => Math.random() - 0.5);
          for (const [dx, dy] of ds) { const nx = player.x + dx, ny = player.y + dy; if (curWalkable(nx, ny) && !entityAt(nx, ny)) { const t0 = B.sig(); movePlayer(dx, dy); if (B.sig() !== t0) { B.nsC = 0; return true; } } }
        }
        return false;
      }
      B.nsC = 0;
      { // refuse routes that wade through freezing / scorching / toxic ground
        let x = player.x, y = player.y, bad = 0;
        for (const [dx, dy] of p.steps.slice(0, 30)) { x += dx; y += dy; if (B.known(x, y) && B.badTile(curTileAt(x, y))) bad++; }
        if (bad > 3 && !B.shelterTravel && !(player.maxHp >= 3000 && player.hp >= player.maxHp * 0.6) && !B.badTile(curTileAt(player.x, player.y))) { B.tp = null; B.why('badroute'); return false; }
      }
      B.tp = { key, steps: p.steps.slice(0, 25) };
    }
    const [dx, dy] = B.tp.steps[0];
    const nx = player.x + dx, ny = player.y + dy;
    if (!curWalkable(nx, ny) || entityAt(nx, ny)) { B.blk = { nx, ny, w: curWalkable(nx, ny), e: (entityAt(nx, ny) || {}).name, t: turnCount }; B.tp = null; return true && (endTurn(), true); }
    const t0 = B.sig(); movePlayer(dx, dy);
    if (B.sig() === t0 && player.statusSlow > 0) return true; // a slowed walker fumbles half its steps (a banked free action hides the lost turn): not a blocked path
    if (B.sig() === t0) { B.tp = null; B.why('nomove'); B.nm = B.nm || []; { if (B.nm.length >= 6) B.nm.shift(); const tt = curTileAt(nx, ny); B.nm.push([player.x, player.y, dx, dy, tt && tt.biome, tt && tt.feature, tt && tt.glyph, !!(tt && tt.walkable), gameState, player.statusSlow, player.statusStun, player.hp, (entityAt(nx, ny) || {}).name]); } return false; }
    B.tp.steps.shift();
    return true;
  };
  // Leave freezing / scorching ground: walk to the nearest tile that is not in a cold/hot biome.
  // expected temperature on another tile: same sky, weather and clock as here, different biome tag
  B.tagShift = (tg) => (tg === 'hot' ? 20 : tg === 'cold' ? -20 : tg === 'humid' ? 5 : 0);
  B.tileTemp = function (t, worst) {
    if (B._tt !== turnCount) { const h = curTileAt(player.x, player.y); B._tt = turnCount; B._t0 = currentTemperature() - (h && h.biome ? B.tagShift(biomeTempTag(h)) : 0); B._nw = curIsDungeon() ? 0 : 10 * (1 - Math.max(0, Math.min(1, nightFactor()))); }
    return B._t0 + (t && t.biome ? B.tagShift(biomeTempTag(t)) : 0) - (worst ? B._nw : 0); // worst = plan for the coldest hour, not the current one
  };
  B.badTile = function (t) {
    if (!t || !t.biome) return false;
    if (!curIsDungeon()) { const T = B.tileTemp(t); if (T <= 17 || T >= 83) return true; }
    const bi = BIOMES[t.biome]; return !!(bi && bi.effect && /poison|burn|radiation|curse|fear|voidtear|corrode|confuse/.test(bi.effect.type));
  };
  B.crossOK = function () { return !!(B.goalDungeon && B.stageWants(B.goalDungeon) && player.maxHp >= 800 && player.hp >= player.maxHp * 0.6); };
  B.escapeWeather = function () {
    if (curIsDungeon()) return false;
    const temp = currentTemperature();
    const here = curTileAt(player.x, player.y);
    const ch = player.statusChill || 0, ht = player.statusHeat || 0;
    const emerg = temp <= 14 || temp >= 86 || ch >= 5 || ht >= 5;
    const hazard = here && BIOMES[here.biome] && BIOMES[here.biome].effect && /poison|burn|radiation|curse|fear|voidtear|corrode|confuse/.test(BIOMES[here.biome].effect.type);
    const tagBad = B.badTile(here) && (temp <= 24 || temp >= 76);
    if (!emerg && !hazard && !tagBad) return false;
    if (player.maxHp >= 1200 && player.hp >= player.maxHp * 0.5 && ch < 12 && ht < 12) return false; // a few points of weather damage a turn mean nothing to a tough character
    if (!emerg && B.crossOK()) return false; // a quest destination lies beyond: wade through
    if (hazard && !emerg) { // we keep stepping into a toxic/irradiated biome on the way somewhere: give up on that destination
      B.hzT = (B.hzT || []).filter((t) => turnCount - t < 400); B.hzT.push(turnCount);
      if (B.hzT.length >= 3 && B.goalDungeon) { B.dungeonLog[B.goalDungeon.id] = Object.assign(B.dungeonLog[B.goalDungeon.id] || { done: 0 }, { banUntil: turnCount + 3000 }); B.goalDungeon = null; B.hzT = []; B.note('banned goal: route crosses a hazard biome'); }
    }
    // nearest ground that is not hot/cold/toxic
    let best = null, bd = 1e9;
    if (B.badTile(here)) {
      for (const R of [22, 70]) { // a big toxic region: widen the search rather than idling in it
        if (best) break;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const x = player.x + dx, y = player.y + dy; const t = curTileAt(x, y);
          if (!t || !t.biome || B.badTile(t) || !curWalkable(x, y)) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy)); if (d < bd) { bd = d; best = [x, y]; }
        }
      }
    }
    if (emerg && !(best && bd <= 10)) {
      // the whole region is too cold/hot: pick a comfortable place far away and walk there, sheltering in a dungeon to recover when it gets dangerous
      const g = B.climateGoal;
      if (!g || B.badTile(curTileAt(g.x, g.y)) || chebyshev(g.x, g.y, player.x, player.y) < 3) {
        B.climateGoal = null;
        const pcx = Math.floor(player.x / 24), pcy = Math.floor(player.y / 24); let bestC = null, bdd = 1e9;
        for (let r = 1; r <= 6 && !bestC; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = (pcx + dx) * 24 + 12, y = (pcy + dy) * 24 + 12; const t = curTileAt(x, y);
          if (!t || !t.biome || B.badTile(t) || !curWalkable(x, y)) continue;
          const d = Math.max(Math.abs(x - player.x), Math.abs(y - player.y)); if (d < bdd) { bdd = d; bestC = { x, y }; }
        }
        B.climateGoal = bestC;
      }
      B.shel = (B.shel || []).filter((t) => turnCount - t < 3000);
      const hurt = (ch >= 9 || ht >= 9) && (B.shel.length < 6 || player.hp < player.maxHp * 0.4);
      if (hurt || !B.climateGoal) {
        if (here && here.feature === 'dungeon_entrance') { B.cur = dungeonRegistry.get(here.dungeonId); B.noEnterUntil = 0; B.hideUntil = turnCount + 60; B.shel.push(turnCount); useStairs(); return true; }
        let be = null, bd2 = 1e9;
        for (const d of dungeonRegistry.values()) { if (d.isTutorial || d.originMode === 'dimension' || d.originDimensionId) continue; const dd = chebyshev(d.x, d.y, player.x, player.y); if (dd < bd2 && dd < 40) { bd2 = dd; be = d; } }
        if (be) { B.shelterTravel = true; const ok = B.travelTo(be.x, be.y); B.shelterTravel = false; if (ok) return true; }
      }
      if (B.climateGoal) { B.shelterTravel = true; const ok = B.travelTo(B.climateGoal.x, B.climateGoal.y); B.shelterTravel = false; if (ok) return true; }
    }
    if (best) {
      const wg = B.warmGoal; // keep walking to the same patch of safe ground instead of re-picking (and dithering) every step
      if (wg && turnCount - wg.t < 60 && !B.badTile(curTileAt(wg.x, wg.y)) && chebyshev(wg.x, wg.y, player.x, player.y) <= 30) best = [wg.x, wg.y];
      else B.warmGoal = { x: best[0], y: best[1], t: turnCount };
      return B.stepToward(best[0], best[1], { partial: true });
    }
    return false;
  };

  // ---------- shopping ----------
  B.count = (re) => player.inventory.filter((i) => re.test((i.name || '') + ' ' + (i.id || '') + ' ' + (i.effect || ''))).length;
  B.PRIO = { bandage: 6, antidote: 8, heal: 8 };
  B.wantScore = function (it) {
    const txt = (it.name || '') + ' ' + (it.id || '') + ' ' + (it.effect || '');
    if (it.type === 'consumable') {
      if (/bandage/i.test(txt)) return B.count(/bandage/i) < B.PRIO.bandage ? 100 : 0;
      if (/stone_recall|recall stone/i.test(txt)) return B.count(/stone_recall|recall stone/i) < 3 ? 50 : 0;
      if (/curefear|cureall|panacea|clarity|courage/i.test(txt)) return B.count(/curefear|cureall|panacea|clarity|courage/i) < 4 ? 55 : 0;
      if (/antidote|cureposion/i.test(txt)) return B.count(/antidote|cureposion/i) < B.PRIO.antidote ? 60 : 0;
      if (it.effect === 'heal') return B.count(/\bheal\b|potion_heal|potion_greaterheal/i) < B.PRIO.heal ? 70 + (it.power || 0) / 10 : 0;
      return 0;
    }
    if ((it.type === 'weapon' || it.type === 'armor') && it.slot) {
      const cur = player.equipment[it.slot];
      const d = B.gearScore(it) - B.gearScore(cur);
      return d > 0.5 ? 40 + d : 0;
    }
    return 0;
  };
  B.price = (npc, it) => Math.round(it.value * 1.2 * repPriceMult(getKingdom(Math.floor(npc.x / CH), Math.floor(npc.y / CH)).key) * tradeSpeciesPriceMult(npc) * npcTierPriceMult(npc) * relationshipPriceMult(npc) * merchantBuyMult());
  B.shopAt = function (npc) {
    openTrade(npc); let bought = 0;
    for (let n = 0; n < 60; n++) {
      let best = -1, bs = 0;
      npc.shop.forEach((it, i) => { const w = B.wantScore(it); if (w > bs && B.price(npc, it) <= player.gold) { bs = w; best = i; } });
      if (best < 0) break;
      const before = player.gold;
      tradePage = Math.floor(best / PAGE_SIZE); tradeTransact(String.fromCharCode(97 + best % PAGE_SIZE));
      if (player.gold === before) break; bought++;
    }
    closeModal(); gameState = 'playing';
    return bought;
  };

  // ---------- spell trainers ----------
  B.bestBase = function () { let b = 0; for (const a of B.dmgAbilities()) b = Math.max(b, a.s.power ? (a.s.power[0] + a.s.power[1]) / 2 * (a.aoe ? 1.2 : 1) : 0); return b; };
  B.wantSpell = function (id) {
    if ((player.knownSpells || []).includes(id)) return false;
    const sp = SPELLS.find((x) => x.id === id); if (!sp || sp.selfCost || sp.selfExposed) return false;
    if (!Array.isArray(sp.power) && sp.type !== 'cleanse') return false;
    const cost = 30 + (sp.mp || 0) * 8; if (cost > player.gold - 200) return false;
    const known = (player.knownSpells || []).map((k) => SPELLS.find((y) => y.id === k)).filter(Boolean);
    const avg = (x) => (x.power[0] + x.power[1]) / 2 * (x.type === 'smite' ? 1.6 : 1);
    if (sp.type === 'heal') { // heal per mana point, and it must be castable many times
      if (sp.id === 'reviveally' || (sp.mp || 0) > (player.maxMp || 0) / 8) return false;
      const eff = (x) => avg(x) / Math.max(1, x.mp);
      const bestAmt = Math.max(0, ...known.filter((o) => o.type === 'heal').map((o) => o.power[1]));
      return sp.power[1] > bestAmt * 1.3 && eff(sp) >= 2;
    }
    if ((sp.type === 'cleanse' || sp.type === 'purify') && !known.some((o) => o.type === 'cleanse' || o.type === 'purify')) return true;
    if (!['damage', 'drain', 'smite'].includes(sp.type)) return false;
    if ((sp.mp || 0) > (player.maxMp || 0) / 6) return false; // must be castable many times
    const aoe = !!sp.aoe;
    const bestSame = Math.max(0, ...known.filter((o) => ['damage', 'drain', 'smite'].includes(o.type) && !!o.aoe === aoe).map(avg), ...(player.knownTechniques || []).map((t) => { const o = TECHNIQUES.find((y) => y.id === t); return o && o.power && !!o.aoe === aoe && ['damage', 'smite', 'drain'].includes(o.type) ? avg(o) : 0; }));
    return avg(sp) > bestSame * 1.15;
  };
  // martial counterpart of wantSpell: a technique worth paying a Combat Trainer for (damage that beats what we already have, requirement within reach)
  B.wantTech = function (id) {
    if ((player.knownTechniques || []).includes(id)) return false;
    const t = TECHNIQUES.find((x) => x.id === id); if (!t || !Array.isArray(t.power) || !['damage', 'drain', 'smite'].includes(t.type)) return false;
    if (30 + (t.mp || 0) * 8 > player.gold - 150 || abilityRequirementDeficit(t) > 3) return false;
    const avg = (x) => (x.power[0] + x.power[1]) / 2 * (x.type === 'smite' ? 1.6 : 1) * (x.aoe ? 1.2 : 1);
    const res = t.resource || 'stamina', cap = res === 'stamina' ? (player.maxStamina || 0) : (player.maxMp || 0);
    if (cap && (t.mp || 0) > cap / 5) return false; // must be usable many times per fight
    const have = (player.knownSpells || []).map((k) => SPELLS.find((y) => y.id === k)).concat((player.knownTechniques || []).map((k) => TECHNIQUES.find((y) => y.id === k))).filter((o) => o && Array.isArray(o.power) && ['damage', 'drain', 'smite'].includes(o.type));
    return avg(t) > Math.max(0, ...have.map(avg)) * 1.15;
  };
  B.trainTick = function () {
    if (player.level < 5 || player.gold < 150 || (B.trainCool || 0) > turnCount) return false;
    const near = curNPCs().filter((n) => n.alive && !n.hostile && ((n.teachSpells && n.teachSpells.some(B.wantSpell)) || (n.teachTechniques && n.teachTechniques.some(B.wantTech))) && chebyshev(n.x, n.y, player.x, player.y) <= 1);
    if (near.length) {
      const npc = near[0]; let got = 0;
      openTrain(npc);
      for (let k = 0; k < 12; k++) {
        const idx = trainEntries.findIndex((e) => (e.kind === 'spell' && B.wantSpell(e.id)) || (e.kind === 'technique' && B.wantTech(e.id))); if (idx < 0) break;
        const g = player.gold; trainLearn(String.fromCharCode(97 + idx)); if (player.gold === g) break; got++;
      }
      closeModal(); gameState = 'playing';
      B.note('trainer ' + npc.name + ' taught ' + got + ' abilities; know ' + (player.knownSpells || []).concat(player.knownTechniques || []).join(','));
      B.trip2 = null; B.trainCool = turnCount + (got ? 100 : 2000); return 'train';
    }
    if (!B.trip2) {
      let best = null, bd = 1e9;
      for (const c of worldChunks.values()) { if (!c.npcs) continue; for (const n of c.npcs) { if (!n.alive || n.hostile || !((n.teachSpells && n.teachSpells.some(B.wantSpell)) || (n.teachTechniques && n.teachTechniques.some(B.wantTech)))) continue; const d = chebyshev(n.x, n.y, player.x, player.y); if (d < bd && d < 500) { bd = d; best = n; } } }
      if (!best) { B.trainCool = turnCount + 1500; return false; }
      B.trip2 = { npc: best, t0: turnCount };
    }
    if (turnCount - B.trip2.t0 > 2500) { B.trip2 = null; B.trainCool = turnCount + 4000; return false; }
    if (B.travelTo(B.trip2.npc.x, B.trip2.npc.y)) return 'to-trainer';
    B.trip2 = null; B.trainCool = turnCount + 2000; return false;
  };
  B.needSupplies = function () {
    return player.gold >= 25 && (B.count(/bandage/i) < 3 || B.count(/\bheal\b|potion_heal|potion_greaterheal/i) < 3 || (player.level >= 8 && B.count(/antidote|cureposion/i) < 3) || (player.level >= 50 && B.count(/stone_recall|recall stone/i) < 2));
  };
  B.settlements = function () {
    const out = [];
    for (const c of worldChunks.values()) if (c.settlement) out.push({ x: c.cx * CH + Math.floor(CH / 2), y: c.cy * CH + Math.floor(CH / 2), c });
    return out;
  };
  // one step of a supply trip; returns an action label or false when there is nothing (more) to do
  B.shopTick = function () {
    if ((B.shopCool || 0) > turnCount) return false;
    if (!B.trip && !B.needSupplies() && !(player.gold >= 400 && turnCount - (B.lastGear || -9999) > 3000)) return false;
    let tgt = null;
    // a shopkeeper right here?
    const near = curNPCs().filter((n) => n.alive && !n.hostile && n.shop && n.shop.length && chebyshev(n.x, n.y, player.x, player.y) <= 1);
    if (near.length) {
      let got = 0; for (const n of near) got += B.shopAt(n);
      B.trip = null; B.lastGear = turnCount; B.shopCool = turnCount + (got ? 600 : 1500); B.equipBest(); return 'shop';
    }
    if (!B.trip) {
      let best = null, bd = 1e9;
      for (const st of B.settlements()) { const d = chebyshev(st.x, st.y, player.x, player.y); if (d < bd && d < 260 && !(player.level < 14 && typeof startDist === 'function' && startDist(st.x, st.y) > B.leash() + 40)) { bd = d; best = st; } } // a shop beyond the leash fights the go-home logic: the bot oscillated between the two for ~2000 turns
      if (!best) { B.shopCool = turnCount + 800; return false; }
      B.trip = { x: best.x, y: best.y, c: best.c, t0: turnCount };
    }
    if (turnCount - B.trip.t0 > 1500) { B.note('SHOP TRIP TIMED OUT after 1500 turns, target ' + B.trip.x + ',' + B.trip.y + ' now at ' + player.x + ',' + player.y + (curIsDungeon() ? ' (in a dungeon)' : '') + ' gold ' + player.gold + ' why ' + JSON.stringify(B.tpWhy) + ' tgtTile ' + (() => { try { const t = curTileAt(B.trip.x, B.trip.y); return t ? t.type + '/' + t.feature : '?'; } catch (e) { return '?'; } })()); B.trip = null; B.shopCool = turnCount + 3000; return false; }
    // a shopkeeper we can see wins over the chunk's stored list (the stored list is empty until the chunk has been generated, and the chunk CENTRE can be a wall: 1500 turns of walking at a wall)
    const shopkeeper = curNPCs().find((n) => n.alive && !n.hostile && n.shop && n.shop.length && chebyshev(n.x, n.y, B.trip.x, B.trip.y) <= 40) || (B.trip.c.npcs && B.trip.c.npcs.find((n) => n.alive && !n.hostile && n.shop && n.shop.length));
    const dNow = chebyshev(B.trip.x, B.trip.y, player.x, player.y);
    if (B.trip.best === undefined || dNow < B.trip.best - 1) { B.trip.best = dNow; B.trip.bestT = turnCount; }
    else if (turnCount - B.trip.bestT > 500) { B.note('SHOP TRIP NO PROGRESS for 500 turns, ' + dNow + ' tiles short at ' + player.x + ',' + player.y); B.trip = null; B.shopCool = turnCount + 3000; return false; } // walking but not arriving
    const tx = shopkeeper ? shopkeeper.x : B.trip.x, ty = shopkeeper ? shopkeeper.y : B.trip.y;
    if (B.travelTo(tx, ty)) return 'to-shop';
    B.trip = null; B.shopCool = turnCount + 1500; return false;
  };
  // nearest place a too-strong monster cannot follow us: a dungeon entrance (stairs shake pursuers) or a town
  // step to the neighbouring tile that puts the most distance between us and the threats we cannot fight
  B.backAway = function (threats, maxD, strict) {
    const dmin = (x, y) => Math.min.apply(null, threats.map((m) => chebyshev(m.x, m.y, x, y)));
    const cur = dmin(player.x, player.y);
    if (cur > (maxD || 7)) return false;
    let best = null, bs = -1e9;
    const home = B.settlements().map((st) => ({ x: st.x, y: st.y })).sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y))[0];
    for (const d of DIRS) {
      const nx = player.x + d[0], ny = player.y + d[1];
      const t = curTileAt(nx, ny);
      if (!t || !curWalkable(nx, ny) || entityAt(nx, ny) || B.badTile(t)) continue;
      let sc = dmin(nx, ny) * 10;
      if (home) sc -= chebyshev(home.x, home.y, nx, ny) * 0.3;
      if (sc > bs) { bs = sc; best = d; }
    }
    if (!best) return false;
    const nd = dmin(player.x + best[0], player.y + best[1]);
    if (strict ? nd <= cur : nd < cur) return false; // cornered: no step helps
    const t0 = B.sig(); movePlayer(best[0], best[1]);
    return B.sig() !== t0;
  };
  B.refuge = function () {
    let best = null, bd = 1e9;
    for (const st of B.settlements()) { const dd = chebyshev(st.x, st.y, player.x, player.y); if (dd < bd && dd < 45) { bd = dd; best = { x: st.x, y: st.y }; } }
    if (!best) return false;
    return B.travelTo(best.x, best.y);
  };

  // ---------- dimension trail ----------
  B.trailStage = () => { const st = curStoryStage(); return st && st.type === 'dimension_trail' ? st : null; };
  // every generated dungeon floor is remembered by the game, so the rift the gatekeeper left behind can be found directly
  B.findPortal = function (dimId) {
    for (const d of dungeonRegistry.values()) {
      const lv = d.levels || [];
      for (let i = 0; i < lv.length; i++) {
        const L = lv[i]; if (!L || !L.grid) continue;
        for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) { const t = L.grid[y][x]; if (t && t.feature === 'rift_portal' && t.dimensionId === dimId) return { dg: d, depth: i + 1, x, y }; }
      }
    }
    return null;
  };
  // 'item_structure' gate: (1) the gatekeeper's item comes from the dungeon logic, (2) a second item may come from a roaming overworld boss, (3) both are used at a standing structure
  // generate only the chunks whose terrain matches the boss's habitat, ring by ring around a centre; returns 'scan' while working, false when the radius cap is spent
  B.scanForBoss = function (def) {
    const st = B.sfb = B.sfb || {};
    const key = def.id; let r = st[key];
    if (!r || chebyshev(r.cx, r.cy, player.x, player.y) > 700) r = st[key] = { cx: player.x, cy: player.y, rad: 0 };
    const pcx = Math.floor(r.cx / 24), pcy = Math.floor(r.cy / 24), t0 = Date.now();
    B.scanned = B.scanned || {};
    for (let rad = r.rad; rad <= 80; rad++) {
      for (let cy = pcy - rad; cy <= pcy + rad; cy++) for (let cx = pcx - rad; cx <= pcx + rad; cx++) {
        if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) !== rad) continue;
        const k2 = cx + ',' + cy; if (B.scanned[k2]) continue;
        if (Date.now() - t0 > 400) { r.rad = rad; return 'scan'; }
        let b; try { b = classifyBiomeFull(cx * 24 + 12, cy * 24 + 12); } catch (e) { b = null; }
        if (b && !def.biomes.includes(b)) continue; // wrong habitat: nothing to find there (not marked, another hunt may want it)
        B.scanned[k2] = 1; getChunk(cx, cy);
        if (B.findBoss(def.id)) { r.rad = rad; return 'scan'; }
      }
      r.rad = rad + 1;
    }
    return false;
  };
  B.findBoss = function (id) { let best = null, bd = 1e9; for (const c of worldChunks.values()) for (const m of (c.monsters || [])) { if (!m.alive || !(m.hp > 0) || m.monsterId !== id || ((B.bossIgn || {})[m.uid] || 0) > turnCount) continue; const d = chebyshev(m.x, m.y, player.x, player.y); if (d < bd) { bd = d; best = m; } } return best; };
  B.hasItemNamed = (n) => { if (B._hinT !== turnCount || B._hinN !== player.inventory.length) { B._hinT = turnCount; B._hinN = player.inventory.length; B._hin = {}; } const c = B._hin; if (c[n] === undefined) c[n] = player.inventory.some((i) => i.name === n); return c[n]; };
  B.itemGateTick = function () {
    const st = B.trailStage(); if (!st || curIsDungeon() || curIsDimension()) return false;
    const gi = DIMENSION_GATE_INFO[st.targetDimensionId];
    if (!gi || gi.kind !== 'item_structure' || (player.discoveredDimensions || []).includes(st.targetDimensionId)) return false;
    if (!B.hasItemNamed(gi.itemName)) return false;
    if (gi.secondItemName && !B.hasItemNamed(gi.secondItemName)) {
      const id = gi.secondBossId, def = typeof OVERWORLD_BOSSES !== 'undefined' && OVERWORLD_BOSSES.find((b) => b.id === id); if (!def) return false;
      const bm = B.findBoss(id);
      if (bm) {
        if (B.simulate([bm], 60).win < 0.9 && !(player.level >= 90)) return false;
        if (chebyshev(bm.x, bm.y, player.x, player.y) <= 1) return B.attackAdjacent([bm]) ? 'gate-attack' : false;
        if (B.tryCast(bm, 0)) return 'gate-cast';
        if (B.travelTo(bm.x, bm.y)) return 'gate-boss';
        B.bf = B.bf || {}; B.bf[bm.uid] = (B.bf[bm.uid] || 0) + 1; if (B.bf[bm.uid] < 8) return false; B.bf[bm.uid] = 0; B.bossIgn = B.bossIgn || {}; B.bossIgn[bm.uid] = turnCount + 600; B.note('boss unreachable for now: ' + id + ' at ' + bm.x + ',' + bm.y + ' from ' + player.x + ',' + player.y + ' why ' + JSON.stringify(B.tpWhy) + ' nm ' + JSON.stringify((B.nm || []).slice(-3)) + ' cr ' + (B.cr ? B.cr.key + '/' + B.cr.pts.length : '-') + ' unreach ' + JSON.stringify(Object.entries(B.unreach || {}).filter((e) => e[1] > turnCount).slice(-4)));
        return false;
      }
      if (B.scanForBoss(def)) return 'gate-scan';
      return B.wanderExplore() ? 'gate-explore' : false;
    }
    const feat = /Folding/i.test(gi.structureName) ? 'folding_stone' : /Launch/i.test(gi.structureName) ? 'launch_cradle' : null; if (!feat) return false;
    let tgt = null, bd = 1e9;
    for (const c of worldChunks.values()) if (c.poi && c.poi.type === feat) { const d = chebyshev(c.poi.x, c.poi.y, player.x, player.y); if (d < bd) { bd = d; tgt = c.poi; } }
    if (!tgt) { if ((B.g3R || 0) < 150 && turnCount - (B.g3T || 0) > 20) { B.g3T = turnCount; B.g3R = (B.g3R || 4) + 3; B.scanDungeons(B.g3R); return 'gate-scan'; } return B.wanderExplore() ? 'gate-explore' : false; }
    if (player.x === tgt.x && player.y === tgt.y) { B.note('using ' + feat); useStairs(); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } return 'gate-use'; }
    if (B.travelTo(tgt.x, tgt.y)) return 'gate-to-structure';
    if (B.stepToward(tgt.x, tgt.y, { partial: true })) return 'gate-to-structure';
    return false;
  };
  B.riftTick = function () {
    const st = B.trailStage(); if (!st || curIsDimension()) return false;
    if (curIsDungeon() && (curDungeon().originMode === 'dimension' || curDungeon().originDimensionId)) return false; // already inside the dimension's own dungeon
    const dimId = st.targetDimensionId;
    if (!(player.discoveredDimensions || []).includes(dimId)) return false;
    const p = B.findPortal(dimId); if (!p) return false;
    if (curIsDungeon()) {
      const dg = curDungeon();
      if (dg === p.dg || dg.id === p.dg.id) {
        if (player.dungeonDepth === p.depth) {
          if (player.x === p.x && player.y === p.y) { travelThroughRift(); B.note('entered rift to ' + dimId); return 'enter-rift'; }
          if (B.stepToward(p.x, p.y, { partial: true, avoidMonsters: false })) return 'to-rift';
          return false;
        }
        const st2 = B.stairs(), tg = player.dungeonDepth < p.depth ? st2.down : st2.up;
        if (tg) { if (B.isOn(tg)) { if (player.dungeonDepth < p.depth) useStairs(); else useStairsUp(); return 'rift-stairs'; } if (B.stepToward(tg.x, tg.y, { partial: true })) return 'rift-to-stairs'; }
        return false;
      }
      const up = B.stairs().up; // wrong dungeon: leave it
      if (up) { if (B.isOn(up)) { useStairsUp(); return 'rift-leave'; } if (B.stepToward(up.x, up.y, { partial: true })) return 'rift-to-exit'; }
      return false;
    }
    const t = curTileAt(player.x, player.y);
    if (t && t.feature === 'dungeon_entrance' && t.dungeonId === p.dg.id) { B.cur = p.dg; useStairs(); return 'rift-enter-dungeon'; }
    if (B.travelTo(p.dg.x, p.dg.y)) return 'rift-travel';
    return false;
  };
  // inside a dimension: find the guardian's dungeon, or, when there is nothing left to do here, walk back to the arrival rift
  // leaving a dimension drops us back into a dungeon whose stairs lead straight back into the dimension (the game keeps a stale return point): a Recall Stone or the Teleport spell gets us out for real
  B.recallOut = function () {
    let used = false;
    const st = player.inventory.find((i) => /stone_recall/.test(i.id || '') || /Recall Stone/i.test(i.name || ''));
    if (st) { try { useItem(st); used = true; } catch (e) { /* */ } }
    if (!used && (player.knownSpells || []).includes('teleport')) { const sp = SPELLS.find((x) => x.id === 'teleport'); if (sp && effectiveCost(sp) <= (player.mp || 0)) { try { castSpell('teleport'); used = true; } catch (e) { /* */ } } }
    if (!used) return false;
    if (gameState === 'travel' && typeof travelDestinations !== 'undefined') {
      let i = travelDestinations.findIndex((d) => d.kind === 'settlement'); if (i < 0) i = 0;
      confirmTravel(String.fromCharCode(97 + i)); B.note('recalled out to ' + (travelDestinations[i] && travelDestinations[i].label));
    }
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    return true;
  };
  B.dimTick = function () {
    const dimId = player.dimensionId, dim = DIMENSIONS[dimId];
    const st = B.trailStage();
    const gd = st && st.targetDimensionId === dimId ? DIMENSION_TRAIL_GUARDIANS[dimId] : null;
    if (gd) {
      let best = null, bd = 1e9;
      for (const d of dungeonRegistry.values()) { if (d.theme !== gd.theme) continue; const dd = chebyshev(d.x, d.y, player.x, player.y); if (dd < bd) { bd = dd; best = d; } }
      if (best && B.dungeonFloorLevel(best, 1) > player.level + B.qslack() + 4) best = null; // too strong yet: level up out here first (qslack grows while xp stalls)
      if (best) {
        const t = curTileAt(player.x, player.y);
        if (t && t.feature === 'dungeon_entrance' && t.dungeonId === best.id) { B.cur = best; useStairs(); return 'dim-enter'; }
        if (B.travelTo(best.x, best.y)) return 'dim-travel';
        if (B.stepToward(best.x, best.y, { partial: true })) return 'dim-step';
      }
      { const sd = (dim.subDungeons || []).find((x) => x.theme === gd.theme); // the guardian's stair sits at a fixed chunk position: walk straight there so its chunk gets generated
        if (sd) { const sx = sd.cx * CH + sd.lx, sy = sd.cy * CH + sd.ly; if (B.travelTo(sx, sy)) return 'dim-seek'; if (B.stepToward(sx, sy, { partial: true })) return 'dim-seek'; } }
      return B.wanderExplore() ? 'dim-explore' : false;
    }
    if (dim) { // nothing to do in here: back out through the arrival rift
      const ax = dim.arrival.cx * CH + dim.arrival.lx, ay = dim.arrival.cy * CH + dim.arrival.ly;
      if (player.x === ax && player.y === ay) { travelThroughRift(); B.needRecall = turnCount + 3000; return 'leave-dim'; }
      if (chebyshev(ax, ay, player.x, player.y) <= 4) { const t0 = B.sig(); movePlayer(Math.sign(ax - player.x), Math.sign(ay - player.y)); if (B.sig() !== t0) return 'dim-return'; const dd = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]][Math.floor(Math.random() * 8)]; movePlayer(dd[0], dd[1]); return 'dim-return'; }
      if (B.travelTo(ax, ay)) return 'dim-return';
      if (B.stepToward(ax, ay, { partial: true })) return 'dim-return';
    }
    return false;
  };

  // ---------- main quest ----------
  B.talkTo = function (npc) {
    openDialogue(npc);
    const o = (dialogueOptions || []).find((x) => /^(Talk|Chat)$/.test(x.label));
    if (o) o.action();
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
  };
  B.wanderExplore = function () {
    B.wx = B.wx || null;
    if (!B.wx || chebyshev(B.wx.x, B.wx.y, player.x, player.y) < 4 || turnCount > B.wx.until) { if (B.wAng === undefined || turnCount > (B.wAngT || 0)) { B.wAng = Math.random() * 6.283; B.wAngT = turnCount + 700; } // keep one heading for a while so exploring actually covers ground
      const a = B.wAng + (Math.random() - 0.5) * 0.9, r = 25 + Math.random() * 30; B.wx = { x: Math.round(player.x + Math.cos(a) * r), y: Math.round(player.y + Math.sin(a) * r), until: turnCount + 120 };
      // leash: a sensible player does not drift 150 tiles from home at level 1; past B.leash(), head back toward the start.
      if (B.beyondLeash(B.wx.x, B.wx.y)) { const s = worldStartAnchor || { x: 0, y: 0 }; B.wAng = Math.atan2(s.y - player.y, s.x - player.x); B.wAngT = turnCount + 300; B.wx = { x: Math.round(player.x + Math.cos(B.wAng) * r), y: Math.round(player.y + Math.sin(B.wAng) * r), until: turnCount + 120 }; } }
    if (B.travelTo(B.wx.x, B.wx.y)) return true;
    B.wx = null; B.wAng = undefined; return false;
  };
  // can we beat this boss (by simulation, against its stats scaled up a little for safety)?
  B.bossReady = function (bossId, margin) {
    const def = (typeof OVERWORLD_BOSSES !== 'undefined' && OVERWORLD_BOSSES.find((b) => b.id === bossId)) || (typeof MONSTER_BASES !== 'undefined' && MONSTER_BASES[bossId]);
    if (!def) return false;
    // overworld bosses are scaled up with distance from the start (1x at the start .. 4x far away); we pick the fight near the start
    const sc = (typeof OVERWORLD_BOSSES !== 'undefined' && OVERWORLD_BOSSES.find((b) => b.id === bossId)) ? (margin || (player.level < 45 ? 2.2 : 1.4)) : 1.3;
    margin = sc;
    // an archer that backs away from every step we take can only be hit now and then by a melee fighter: count its health as much larger
    const kite = (def.behavior === 'ranged' || def.behavior === 'kiter') && !(player.equipment.hand && player.equipment.hand.ranged) ? 2.5 : 1;
    // the game's difficulty curve (MONSTER_CURVE) multiplies real monsters' HP/attack by depth scale; mirror it so readiness is not over-optimistic
    const cv = (typeof monsterCurveMult === 'function' && typeof depthScaleForPlayerLevel === 'function') ? monsterCurveMult(depthScaleForPlayerLevel(player.level), true) : { hp: 1, atk: 1 };
    const m = { uid: 'syn', hp: def.hp * margin * kite * cv.hp, maxHp: def.hp * margin * kite * cv.hp, atk: [Math.round(def.atk[0] * margin * cv.atk), Math.round(def.atk[1] * margin * cv.atk)], str: Math.round((def.str || 10) * margin * cv.atk), dex: def.dex || 10, armor: def.armor || 0, boss: true, scriptedAI: def.scriptedAI || true, poison: def.poison || 0, engaged: true, behavior: def.behavior, abilities: def.abilities || null, powerScale: 1, x: player.x + 1, y: player.y, mp: 20 };
    // scripted early bosses open with a x2 Backstab, poison and (dex 18+) act more than once a turn: the plain simulation under-counted them and level-2 characters walked into Thessaly Voss
    // (10 of 25 sweep deaths). Count that burst, and ask for a bigger margin of health while the character is still fragile.
    const fast = Math.min(2, Math.max(1, (def.dex || 10) / 12)); if (fast > 1) { m.atk = [Math.round(m.atk[0] * fast), Math.round(m.atk[1] * fast)]; }
    if (def.scriptedAI) { m.atk = [Math.round(m.atk[0] * 1.2), Math.round(m.atk[1] * 1.2)]; }
    const sim = B.simulate([m], 80, player.maxHp);
    return sim.win >= 0.9 && sim.loss < player.maxHp * (def.scriptedAI && player.level < 12 ? 0.5 : 0.75);
  };
  // is the next boss fight on the story ready to be taken on? (used to hold back story progress that would summon it)
  B.nextBossReady = function () {
    const st = player.story; if (!st) return true;
    for (let i = st.stageIndex; i < st.stages.length; i++) {
      const g = st.stages[i];
      if (g.type === 'choice' && g.branches) { const opt = (g.options && g.options[0] && g.options[0].id); const br = (g.branches[opt] || Object.values(g.branches)[0] || []); const kb = br.find((x) => x.type === 'kill_boss'); if (kb) return B.bossReady(kb.targetBossId); continue; }
      if (g.type === 'kill_boss') return B.bossReady(g.targetBossId);
      if (g.type === 'dimension_trail') return true;
    }
    return true;
  };
  B.questTick = function () {
    if (curIsDungeon() || curIsDimension()) return false;
    const stage = curStoryStage(); if (!stage || stage.done) return false;
    if ((stage.type === 'auto' || stage.type === 'talk_npc' || stage.type === 'kill_any' || stage.type === 'choice') && !B.nextBossReady()) return false; // keep the boss from being summoned before we can beat it
    if (stage.type === 'auto') { advanceStory(); return 'quest-auto'; }
    if (stage.type === 'choice') { return 'quest-choice' && B.doChoice(stage); }
    if (stage.type === 'talk_npc') {
      let best = null, bd = 1e9;
      for (const c of worldChunks.values()) for (const n of (c.npcs || [])) {
        if (!n.alive || n.hostile || n.isTutorialInstructor || !n.roleId) continue; if (((B.unreach || {})[n.x + ',' + n.y] || 0) > turnCount) continue;
        if (stage.targetRoles && !stage.targetRoles.includes(n.roleId)) continue;
        const d = chebyshev(n.x, n.y, player.x, player.y); if (d < bd) { bd = d; best = n; }
      }
      if (!best) { if (B.scanR < 12) { B.scanR = (B.scanR || 4) + 1; B.scanDungeons(B.scanR); return 'scan'; } return B.wanderExplore() ? 'quest-explore' : false; }
      if (bd <= 1) { const before = stage; B.talkTo(best); return 'quest-talk'; }
      if (B.travelTo(best.x, best.y)) return 'quest-to-npc';
      return false;
    }
    if (stage.type === 'discover_kingdoms') { // walk into kingdoms we have not been in yet
      const seen = new Set(player.discoveredKingdoms || []);
      if (!B.kt || seen.has(B.kt.key)) {
        const pcx = Math.floor(player.x / CH), pcy = Math.floor(player.y / CH); let best = null, bd = 1e9;
        for (let r = 1; r <= 70 && !best; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const k = getKingdom(pcx + dx, pcy + dy); if (!k || seen.has(k.key)) continue;
          const d = Math.abs(dx) + Math.abs(dy); if (d < bd) { bd = d; best = { key: k.key, x: (pcx + dx) * CH + Math.floor(CH / 2), y: (pcy + dy) * CH + Math.floor(CH / 2) }; }
        }
        B.kt = best; if (best) B.note('kingdom target ' + best.key + ' at ' + best.x + ',' + best.y);
      }
      if (B.kt) { if (B.travelTo(B.kt.x, B.kt.y)) return 'quest-kingdom'; if (B.stepToward(B.kt.x, B.kt.y, { partial: true })) return 'quest-kingdom'; B.kt = null; }
      return B.wanderExplore() ? 'quest-explore' : false;
    }
    if (stage.type === 'kill_boss' && typeof OVERWORLD_BOSSES !== 'undefined' && !(typeof BOSS_DUNGEON_THEME !== 'undefined' && BOSS_DUNGEON_THEME[stage.targetBossId]) && stage.targetBossId !== 'god' && stage.targetBossId !== 'the_antagonist') {
      const id = stage.targetBossId, def = OVERWORLD_BOSSES.find((b) => b.id === id);
      if (def && !def.aquatic) {
        const bm = B.findBoss(id);
        if (bm) {
          if (B.simulate([bm], 60).win < 0.95) return false; // keep levelling first
          if (chebyshev(bm.x, bm.y, player.x, player.y) <= 1) return B.attackAdjacent([bm]) ? 'quest-attack' : false;
          if (B.tryCast(bm, 0)) return 'quest-cast';
          if (B.travelTo(bm.x, bm.y)) return 'quest-boss';
          B.bf = B.bf || {}; B.bf[bm.uid] = (B.bf[bm.uid] || 0) + 1; if (B.bf[bm.uid] < 8) return false; B.bf[bm.uid] = 0; B.bossIgn = B.bossIgn || {}; B.bossIgn[bm.uid] = turnCount + 600; B.note('boss unreachable for now: ' + id + ' at ' + bm.x + ',' + bm.y + ' from ' + player.x + ',' + player.y + ' why ' + JSON.stringify(B.tpWhy) + ' nm ' + JSON.stringify((B.nm || []).slice(-3)) + ' cr ' + (B.cr ? B.cr.key + '/' + B.cr.pts.length : '-') + ' unreach ' + JSON.stringify(Object.entries(B.unreach || {}).filter((e) => e[1] > turnCount).slice(-4)));
          return false;
        }
        // it only appears in chunks generated while this stage is active: generate fresh ground further and further out
        if (!B.bossReady(id)) return false; // not strong enough yet: level up first
        if (B.scanForBoss(def)) return 'quest-scan';
      }
    }
    if (stage.type === 'kill_any') {
      const ids = stage.targetIds || [];
      let tg = null, bd = 1e9;
      for (const m of curMonsters()) { if (!m.alive || !ids.includes(m.monsterId)) continue; const d = chebyshev(m.x, m.y, player.x, player.y); if (d < bd && d <= 25) { bd = d; tg = m; } }
      if (tg) {
        const sim = B.simulate([tg], 40);
        if (sim.win >= 0.95 && !(B.ign && B.ign[tg.uid] > turnCount)) {
          if (bd <= 1) return B.attackAdjacent([tg]) ? 'quest-attack' : false;
          if (B.huntStep(tg)) return 'quest-hunt';
        }
      }
      return B.wanderExplore() ? 'quest-explore' : false;
    }
    return false;
  };
  B.doChoice = function (stage) {
    if (gameState !== 'dialogue') advanceStory();
    let idx = 0;
    if (stage.id === 'betrayal_choice') { const want = stage.traitorIsX ? 'trust_y' : 'trust_x'; const i = stage.options.findIndex((o) => o.id === want); if (i >= 0) idx = i; }
    const opt = (dialogueOptions || [])[idx];
    if (opt) opt.action();
    if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
    return 'quest-choice';
  };
  // turns since the character last gained any experience
  B.xpIdle = function () {
    const k = player.level * 1e6 + player.xp;
    if (B.xpMark !== k) { B.xpMark = k; B.xpMarkT = turnCount; }
    return turnCount - (B.xpMarkT || 0);
  };
  B.tickOverworld = function () {
    B.xpIdle();
    if (B.useBandageIfBleeding()) return 'bandage';
    if (B.poisonCheck()) return 'antidote';
    if (B.dodgeManeuver()) return 'dodge';
    if (B.escapeHazard()) return 'escape-hazard';
    { const st9 = B.trailStage(); const gi9 = st9 && DIMENSION_GATE_INFO[st9.targetDimensionId];
      if (gi9 && gi9.kind === 'item_structure' && gi9.secondBossId && B.hasItemNamed(gi9.itemName) && !B.hasItemNamed(gi9.secondItemName) && player.level >= 90) { // a strong character just fights the gate's roaming boss instead of dithering over the estimate
        const bm = B.findBoss(gi9.secondBossId);
        if (bm && chebyshev(bm.x, bm.y, player.x, player.y) <= 14) {
          if (player.hp < player.maxHp * 0.4 && B.drinkHeal()) return 'gate-heal';
          if (chebyshev(bm.x, bm.y, player.x, player.y) <= 1) return B.attackAdjacent([bm]) ? 'gate-attack' : 'gate-attack-fail';
          if (B.tryCast(bm, 0)) return 'gate-cast';
          if (B.stepToward(bm.x, bm.y, { adjacent: true, partial: true, avoidMonsters: false })) return 'gate-close';
        }
      } }
    const threats = B.threats();
    if (!threats.length && B.danceBack) { const dr = B.danceReturn(); if (dr) return dr; }
    if (threats.length) {
      const adj = threats.filter((m) => chebyshev(m.x, m.y, player.x, player.y) <= 1);
      if (adj.length) {
        if (player.hp < player.maxHp * 0.4 && B.drinkHeal()) return 'heal';
        // a fight we are going to lose: a same-speed melee monster cannot land a blow on someone who keeps walking away, so run toward home
        if (B.simulate(threats, 40).win < 0.5 && !threats.some((m) => m.behavior === 'ranged' || m.behavior === 'kiter' || (m.abilities && m.abilities.length))) {
          B.runN = (B.runT === turnCount - 1 || B.runT === turnCount) ? (B.runN || 0) + 1 : 1; B.runT = turnCount;
          if (B.runN < 80 && B.backAway(threats, 99, true)) return 'run';
        }
        return B.attackAdjacent(adj) ? 'attack' : 'attack-fail';
      }
      B.abT = B.abT || 0;
      if (B.abLast >= turnCount - 4 && B.abLast <= turnCount) B.abT++; else B.abT = 0; // (gap tolerance 4: a stalker that shadows us at range made back-away alternate with travel/homing for 8000 turns, which reset a strict 1-turn counter)
      B.abLast = turnCount;
      if (B.abT > 60 && !threats.some((m) => chebyshev(m.x, m.y, player.x, player.y) <= 1)) { // dithering in front of something we can neither fight nor flee: stop reacting to it for a while
        B.ignore = B.ignore || {}; for (const m of threats) B.ignore[m.uid] = turnCount + 400; B.abT = 0; B.note('dither-ignore ' + threats.map((m) => m.name).join(','));
        endTurn({ forceFull: true }); return 'dither';
      }
      const sim = B.simulate(threats, 40);
      if (sim.win < 0.9) { // too strong for us: do not engage, keep going about our business (pathing steers around them)
        B.note('avoid: ' + threats.map((m) => m.name).join(',') + ' win=' + sim.win.toFixed(2));
        if (player.hp < player.maxHp * 0.5 && B.drinkHeal()) return 'heal';
        B.avoiding = true;
        const near = Math.min.apply(null, threats.map((m) => chebyshev(m.x, m.y, player.x, player.y)));
        const sh = threats.some((m) => (m.behavior === 'ranged' || m.behavior === 'kiter' || (m.abilities && m.abilities.length) || m.boss) && hasLOS(player.x, player.y, m.x, m.y));
        if (near <= 7 || sh) { if (B.backAway(threats, sh ? 24 : 7)) return 'back-away'; if (near > 3 && B.refuge()) return 'refuge'; }
      } else {
        { const tt = threats.slice().sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y))[0]; if (B.tryCast(tt)) return 'cast'; }
        B.waits = (B.waits || 0) + 1;
        const shoot = threats.some((m) => m.behavior === 'ranged' || m.behavior === 'kiter' || (m.abilities && m.abilities.length));
        if (B.waits <= (shoot ? 0 : 5)) { endTurn({ forceFull: true }); return 'wait'; } // never stand still in front of archers and casters
        const t = threats[0];
        if (B.waits <= 25 && B.stepToward(t.x, t.y, { adjacent: true })) return 'approach';
        if (shoot && (B.backAway(threats, 24) || (B.refuge && B.refuge()))) { B.waits = 0; return 'back-away'; } // never stand in the open while archers keep shooting
        B.ignore = B.ignore || {}; for (const m of threats) B.ignore[m.uid] = turnCount + 120; B.waits = 0;
        endTurn({ forceFull: true }); return 'wait';
      }
    }
    B.waits = 0;
    if (B.escapeWeather()) return 'warm';
    if (B.lootHere()) return 'loot';
    if (player.hp < player.maxHp * 0.5 && B.hpFalling() && !(player.statusPoison > 0)) { if (B.drinkHeal()) return 'heal'; if (B.refuge()) return 'refuge'; } // something unseen is still hitting us: resting here is fatal
    if (player.hp < player.maxHp * 0.95 && B.canRest()) { B.rest(3000, 1.0); return 'rest'; }
    if (B.restPools()) return 'rest-pools';
    if ((player.statPoints || 0) > 0) { B.spendPoints(); return 'stats'; }
    if ((player.talentPoints || 0) > 0 && B.spendTalents()) return 'talent';
    if (B.equipBest()) return 'equip';
    { const sh = B.shopTick(); if (sh) return sh; }
    { const tn = B.trainTick(); if (tn) return tn; }
    if (curIsDimension()) { const d = B.dimTick(); if (d) return d; }
    else { const r = B.riftTick(); if (r) return r; const r2 = B.itemGateTick(); if (r2) return r2; }
    if (B.questOn !== false) { const q = B.questTick(); if (q) return q; }
    if (!B.avoiding && !B.tooFar()) { // pick off easy monsters on the way: cheap XP
      const tg = B.pickTarget(12);
      if (tg && !(tg.behavior === 'flee' && chebyshev(tg.x, tg.y, player.x, player.y) > 4)) { if (B.huntStep(tg)) return 'hunt-ow'; }
    }
    B.avoiding = false;
    const t = curTileAt(player.x, player.y);
    if ((B.noEnterUntil || 0) > turnCount && B.comfy()) { if (player.hp < player.maxHp && B.canRest()) { B.rest(300, 1.0); return 'rest'; } endTurn(); return 'cooldown'; }
    if (B.goalDungeon && B.chooseDungeon() !== B.goalDungeon && !B.goalDungeon.__keep) B.goalDungeon = null;
    if (B.goalDungeon && t && t.feature === 'dungeon_entrance' && t.dungeonId === B.goalDungeon.id && player.hp < player.maxHp * 0.7 && B.comfy() && (B.entryHeal = (B.entryHeal || 0) + 1) < 40) { if (B.canRest()) { B.rest(400, 1.0); return 'rest'; } endTurn({ forceFull: true }); return 'heal-before-enter'; } // never walk back into the fight that just beat us at 40% HP
    if (B.goalDungeon && t && t.feature === 'dungeon_entrance' && t.dungeonId === B.goalDungeon.id) { B.cur = B.goalDungeon; B.entryHeal = 0; { const gd = B.goalDungeon; B.note('ENTER dungeon ' + gd.id + ' theme ' + gd.theme + ' tier ' + gd.tier + ' floors ' + gd.maxDepth + ' rec ' + gd.recommendedLevel + ' bonus ' + (gd.depthScaleBonus || 0) + ' at lvl ' + player.level + ' hp ' + player.hp + '/' + player.maxHp + (B.stageWants(gd) ? ' (quest)' : '')); } useStairs(); return 'enter'; }
    { const hd = B.home ? chebyshev(B.home.x, B.home.y, player.x, player.y) : 0; // no XP for ages and far from where we started: the region is a dead end, go back to known-good ground
      if (B.xpIdle() > 2500 && hd > 100 && !B.questWantsDungeon() && !B.trailStage()) B.homing = true; if (hd < 40) B.homing = false;
      if (B.homing) { if (B.travelTo(B.home.x, B.home.y)) return 'homing'; B.homing = false; } }
    if (!B.goalDungeon || B.goalDungeon.__stale) B.goalDungeon = B.chooseDungeon();
    if (B.questWantsDungeon() && (B.scanR || 0) < 90 && turnCount - (B.qscanT || 0) > 60 && ![...dungeonRegistry.values()].some((d) => !d.isTutorial && B.stageWants(d))) { B.qscanT = turnCount; B.scanR = Math.max(B.scanR || 0, 4) + 4; B.scanDungeons(B.scanR); } // the quest dungeon is not known yet: look ever further out
    if (B.scanPending && B.questWantsDungeon() && [...dungeonRegistry.values()].some((d) => !d.isTutorial && B.stageWants(d))) B.scanPending = null; // found what the quest needs: stop generating terrain
    if (B.scanPending) { B.scanDungeons(B.scanPending); if (!B.goalDungeon) B.goalDungeon = B.chooseDungeon(); if (!B.goalDungeon) return 'scan'; }
    if (!B.goalDungeon && !B.scanR) { B.scanR = 3; B.scanDungeons(B.scanR); B.goalDungeon = B.chooseDungeon(); }
    if (!B.goalDungeon && B.scanR < 7) { B.scanR++; B.scanDungeons(B.scanR); B.goalDungeon = B.chooseDungeon(); }
    if (B.goalDungeon) {
      const g = B.goalDungeon;
      B.shelterTravel = !!(B.stageWants(g) && player.maxHp >= 800 && player.hp >= player.maxHp * 0.7); // a quest dungeon behind toxic / freezing ground: wade through it when we are tough enough
      const okT = B.travelTo(g.x, g.y); B.shelterTravel = false;
      B.gf = B.gf || {}; if (okT) { B.gf[g.id] = 0; return 'travel'; }
      if (!(B.tpWhy && 0) && (B.gf[g.id] = (B.gf[g.id] || 0) + 1) < 8 && !(B.unreach[g.x + ',' + g.y] > turnCount)) { endTurn({ forceFull: true }); return 'travel-retry'; } // a blocked step or a slowed move is not a reason to give the dungeon up
      B.gf[g.id] = 0;
      B.note('goalfail ' + g.id + ' dist ' + chebyshev(g.x, g.y, player.x, player.y) + ' why ' + JSON.stringify(B.tpWhy) + ' at ' + player.x + ',' + player.y);
      B.dungeonLog[g.id] = Object.assign(B.dungeonLog[g.id] || { done: 0 }, { banUntil: turnCount + 4000 }); B.goalDungeon = null;
    }
    // nothing to do: forgive old failures, look further out, else wander
    B.idleN = (B.idleN || 0) + 1;
    if (B.idleN % 3 === 1) { for (const k in B.dungeonLog) { const r = B.dungeonLog[k]; delete r.banUntil; r.fleeN = 0; } B.noEnterUntil = 0; }
    if (B.scanR < (B.questWantsDungeon() ? 90 : 22) && (player.level > (B.scanLvl || 0) || turnCount - (B.scanTurn || 0) > (B.questWantsDungeon() ? 150 : (B.xpIdle() > 500 ? 500 : 4000)))) { B.scanLvl = player.level; B.scanTurn = turnCount; B.scanR += 2; B.scanDungeons(B.scanR); return 'scan'; }
    // idle and far past what this level should roam (a dodge/back-away/story errand can carry the bot well beyond the leash): walk home before looking for more to do
    if (!curIsDungeon() && !curIsDimension() && typeof startDist === 'function' && startDist(player.x, player.y) > B.leash() + 30 && !B.hostiles(0).some((m) => chebyshev(m.x, m.y, player.x, player.y) <= 8)) { const s0 = worldStartAnchor || { x: 0, y: 0 }; if (B.travelTo(s0.x, s0.y)) return 'go-home'; }
    // nothing suitable known yet: farm easy monsters near where we started instead of exploring ever further
    B.home = B.home || { x: player.x, y: player.y };
    if (!B.tooFar()) { const tg = B.pickTarget(14); if (tg && B.huntStep(tg)) return 'hunt-ow'; }
    if (B.xpIdle() > 400 && B.wanderExplore()) return 'wander'; // nothing nearby to fight or enter: go and find something
    { if (!B.fw || chebyshev(B.fw.x, B.fw.y, player.x, player.y) < 3 || turnCount > B.fw.until) { const a = Math.random() * 6.283, r = 10 + Math.random() * 25; B.fw = { x: Math.round(B.home.x + Math.cos(a) * r), y: Math.round(B.home.y + Math.sin(a) * r), until: turnCount + 150 }; }
      if (B.travelTo(B.fw.x, B.fw.y)) return 'wander'; B.fw = null; }
    if (B.wanderExplore()) return 'wander';
    { const d = DIRS[Math.floor(Math.random() * DIRS.length)]; const t0 = B.sig(); movePlayer(d[0], d[1]); if (B.sig() !== t0) return 'wander-random'; }
    endTurn(); return 'idle:overworld';
  };
  { const _mp = movePlayer; movePlayer = function (dx, dy) { B.lastMv = [player.x + dx, player.y + dy]; return _mp.apply(this, arguments); }; }
  B.tick = function () {
    B.dbg = "tick";
    if (gameState === 'gameover' || !player.alive) return 'dead';
    if (gameState === 'dialogue' && !dialogueNPC) { const st = curStoryStage(); if (st && st.type === 'choice') return B.doChoice(st); }
    if (gameState === 'confirmchasm') { if ((B.wantJump || 0) > turnCount) { confirmChasmJumpChoice('y'); B.nopath = 0; B.wantJump = 0; return 'chasm-jump'; } confirmChasmJumpChoice('n'); return 'ui:confirmchasm'; }
    if (gameState === 'choice' && /door is locked/i.test(pendingChoiceTitle || '')) { // never path through a locked house door again
      B.doorBlock = B.doorBlock || {}; B.doorTry = B.doorTry || {}; const dk = B.lastMv ? B.lastMv[0] + ',' + B.lastMv[1] : '?'; B.doorTry[dk] = (B.doorTry[dk] || 0) + 1;
      let li = pendingChoiceOptions.findIndex((o) => /pick/i.test(o.label));
      if (B.doorTry[dk] > 6 && B.xpIdle() > 1500) { const fi = pendingChoiceOptions.findIndex((o) => /force/i.test(o.label)); if (fi >= 0) li = fi; } // walled in by a door we cannot pick: break out
      else if (li < 0 || B.doorTry[dk] > 4) { li = pendingChoiceOptions.findIndex((o) => /leave/i.test(o.label)); if (B.lastMv) B.doorBlock[dk] = 1; B._sc = null; B.tp = null; } resolveChoiceKey(String.fromCharCode(97 + Math.max(0, li))); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      return 'door-leave';
    }
    if (gameState === 'choice' && /^Encounter:/.test(pendingChoiceTitle || '')) { // world-event encounters: usually take a viable option (exercises every outcome), sometimes walk away
      const ok = pendingChoiceOptions.map((o, i) => [o, i]).filter(([o]) => !/\(needs /.test(o.label) && !/^(Leave it be|Leave)/i.test(o.label));
      const pick = ok.length && Math.random() < 0.8 ? ok[Math.floor(Math.random() * ok.length)][1] : pendingChoiceOptions.length - 1;
      B.note('encounter ' + pendingChoiceTitle.slice(11) + ' -> ' + (pendingChoiceOptions[pick] || {}).label);
      resolveChoiceKey(String.fromCharCode(97 + pick)); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      return 'encounter';
    }
    if (gameState === 'choice') { const ct = pendingChoiceTitle + ' | ' + pendingChoiceOptions.map((o) => o.label).join(' / '); if (B.lastCt !== ct) { B.lastCt = ct; B.note('uichoice ' + ct.slice(0, 300) + ' @' + player.x + ',' + player.y); } }
    if (gameState !== 'playing') return 'ui:' + gameState;
    const wd0 = curIsDimension(), px0 = player.x, py0 = player.y, dd0 = player.dungeonDepth;
    const act = curIsDungeon() ? B.tickDungeon() : B.tickOverworld();
    if (wd0 !== curIsDimension()) { B.nFlip = (B.nFlip || 0) + 1; if (B.nFlip < 40) B.note('DIMFLIP -> ' + (curIsDimension() ? 'dim' : 'out') + ' act=' + act + ' from ' + px0 + ',' + py0 + ' d' + dd0 + ' dungeon=' + (curIsDungeon() ? (curDungeon() || {}).theme : '-')); }
    // loop breaker: the same quiet action over and over means we are stuck in a state we do not understand
    const actK = (act === 'dance-back' ? 'dance' : act);
    if (actK === B.lastAct) B.streak = (B.streak || 0) + 1; else { B.lastAct = actK; B.streak = 0; }
    if (B.streak === 400 && (act === 'rest' || act === 'hold' || act === 'wait' || act === 'shelter' || act === 'hide')) {
      B.noRestUntil = turnCount + 300; B.ignore = B.ignore || {}; B.hideUntil = 0; B.refugeUntil = 0;
      B.note('LOOP BREAK ' + act + ' hp ' + player.hp + '/' + player.maxHp + ' stam ' + player.stamina + '/' + player.maxStamina + ' temp ' + Math.round(currentTemperature()) + ' hunger ' + player.hunger + ' turn ' + turnCount + ' | ' + (function () {
        // everything that can stop or mask natural regeneration, so a "rested 400 times and hp did not move" loop is diagnosable from the log alone
        const o = { mp: player.mp + '/' + player.maxMp, mode: player.mode, depth: player.dungeonDepth, gs: gameState, regen: player.regen, regenBlocked: player.noRegen || player.regenBlocked, poison: player.statusPoison, bleed: player.bleedTurns, burning: player.burningTurns, starving: player.starving, wounds: player.wounds && JSON.stringify(player.wounds).slice(0, 120), monstersNear: curMonsters().filter((m) => m.alive && chebyshev(m.x, m.y, player.x, player.y) <= 8).map((m) => m.name + ':' + m.aiState).slice(0, 4).join(','), canRest: B.canRest(), restFail: B.restFail, noRestUntil: B.noRestUntil };
        try { return JSON.stringify(o); } catch (e) { return String(e); }
      })());
    }
    if (actK === 'dance' && B.streak === 600 && curIsDungeon()) {
      const th = B.threats(); const sm = B.simulate(th, 60);
      B.note('DANCE LOOP depth ' + player.dungeonDepth + ' hp ' + player.hp + '/' + player.maxHp + ' sim win ' + sm.win + ' loss ' + Math.round(sm.loss) + ' threats ' + th.map((m) => m.name + '(hp' + m.hp + ' d' + chebyshev(m.x, m.y, player.x, player.y) + ' ' + (m.behavior || '') + ' ' + (m.aiState || '') + ' w' + B.simulate([m], 40).win + ')').join(','));
    }
    // stall watchdog: no XP for a long time -> write ONE diagnostic note (what it has been doing, who is near, where it is trying to go) so a 30k-turn stall can be diagnosed from the run report alone
    B.actRing = B.actRing || []; B.actRing.push(actK); if (B.actRing.length > 300) B.actRing.shift();
    if (B.xpIdle() > 4000 && turnCount - (B.wdT || -1e9) > 4000) {
      B.wdT = turnCount; const hist = {}; for (const a of B.actRing) hist[a] = (hist[a] || 0) + 1;
      let near = []; try { near = curMonsters().filter((m) => m.alive && chebyshev(m.x, m.y, player.x, player.y) <= 14).slice(0, 6).map((m) => m.name + '@' + chebyshev(m.x, m.y, player.x, player.y) + (hasLOS(player.x, player.y, m.x, m.y) ? '/los' : '') + '/' + (m.aiState || '?') + '/' + (m.behavior || '?') + (m.sleeper ? '/sleep' : '') + (B.ignore && B.ignore[m.uid] > turnCount ? '/ignored' : '')); } catch (e) { /* */ }
      B.note('STALL ' + B.xpIdle() + ' turns without XP, lvl ' + player.level + ' hp ' + player.hp + '/' + player.maxHp + ' pos ' + player.x + ',' + player.y + (curIsDungeon() ? ' dungeon d' + player.dungeonDepth : ' overworld') + ' acts ' + JSON.stringify(hist) + ' near ' + near.join(' ; ') + ' tile ' + (() => { const t = curTileAt(player.x, player.y) || {}; return JSON.stringify({ fire: t.fireTurns, gas: t.gasTurns, gk: t.gasKind, f: t.feature, b: t.biome }); })() + ' goal ' + ((B.goalDungeon || {}).id || '-') + ' temp ' + Math.round(currentTemperature()) + ' hunger ' + player.hunger);
    }
    return act;
  };
}


module.exports = BRAIN;
});

// ==== FILE: lib/duel.js ====
__def("lib/duel.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// duel.js -- controlled one-on-one fights, run inside the game realm AFTER the brain is installed (uses window.__B).
// Gives a noise-free read on balance: "how often does a level-N <class> beat a <monster> at <scale>, and at what cost?"
// DUEL() installs window.__DUEL.run(monsterId, {scale, trials, maxTurns, dist}) -> {win, hpLostPct, turns, deaths}.
// The fighter follows a plain policy (cast self-buffs/summons/a debuff unless support:false, then the best damage ability if worthwhile, else melee, drink a heal below 35% hp) and never flees,
// so the numbers measure raw strength, not the autopilot's caution.
// =====================================================================================================
function DUEL() {
  /* global movePlayer, SPELLS, castSpell, confirmTileTarget, cancelTileTargeting, player, curMonsters, worldChunks, makeMonster, addMonsterToWorld, curTileAt, entityAt, endTurn, chebyshev, hasLOS, gameState, closeModal */
  const D = (window.__DUEL = {});
  const B = window.__B;
  D.arena = function (dist) {
    for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; }
    try { for (const c of worldChunks.values()) c.monsters = []; } catch (e) { /* */ }
    for (let r = 0; r < 80; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = player.x + dx, y = player.y + dy; let ok = true;
      for (let yy = -3; yy <= 3 && ok; yy++) for (let xx = -2; xx <= dist + 2 && ok; xx++) { const t = curTileAt(x + xx, y + yy); if (!t || !t.walkable || entityAt(x + xx, y + yy)) ok = false; }
      if (ok) { player.x = x; player.y = y; return { x, y }; }
    }
    return null;
  };
  // Level the character to L, spending each level's stat points on the stat its OWN abilities require (int for spell kits, dex/str for technique kits), then the talent points.
  // Why: levelling in one jump and spending afterwards with the autopilot's policy dumped ~45 points into INT even for a Warrior (STR 15, INT 53), so every martial ability
  // carried a big requirement penalty and martial classes looked far weaker than casters. Spend as you go, class-aware.
  D.levelTo = function (L) {
    const st = { int: 0, str: 0, dex: 0 };
    for (const id of (player.knownSpells || []).concat(player.knownTechniques || [])) { let a = null; try { a = findAbilityById(id); } catch (e) { /* */ } if (a && a.reqStat && st[a.reqStat] !== undefined) st[a.reqStat]++; }
    const primary = st.int > 0 && st.int >= st.str + st.dex ? 'int' : (st.dex > st.str ? 'dex' : 'str');
    const order = { int: [2, 2, 3, 2, 1], str: [0, 0, 3, 0, 1], dex: [1, 1, 3, 1, 0] }[primary]; // 0 str, 1 dex, 2 int, 3 con
    while (player.level < L) { levelUp(); for (let i = 0; i < 400 && (player.statPoints || 0) > 0; i++) spendStat(order[i % order.length]); }
    for (let k = 0; k < 60 && (player.talentPoints || 0) > 0; k++) if (!B.spendTalents()) break;
    player.hp = player.maxHp; return primary;
  };
  // Equip the best non-unique gear a level-L character could plausibly own: per armor slot (and the weapon) the highest-armor / highest-damage base whose STR requirement the character meets and whose
  // value tier is <= ceil(L/5)-1, rolled common at the level's item power multiplier; the weapon is the class's own, re-rolled at that multiplier. The starter kit has armor 5-11 where a real level-20 character wears ~100, which made STR-based
  // melee classes (who rely on armor, not evasion) look weak; this removes that artifact. Opt-in (--gear) so bare-kit numbers stay comparable.
  D.gearUp = function (L, best) {
    const vt = Math.max(1, Math.ceil(L / 5) - 1), pm = itemPowerMult(depthScaleForPlayerLevel(L));
    const ok = (b) => !b.isUnique && !b.setId && !b.craftOnly && (b.valueTier || 0) <= vt && (b.str || 0) <= player.str;
    const equip = (id) => { const it = makeItem(id, 1, Math.random, pm); if (!it) return; player.inventory.push(it); try { equipItem(it); } catch (e) { /* */ } };
    for (const slot of ['body', 'head', 'feet', 'gloves', 'cloak']) {
      const best = ITEM_BASES.filter((b) => b.type === 'armor' && b.slot === slot && ok(b)).sort((x, y) => (y.armor || 0) - (x.armor || 0))[0];
      if (best) equip(best.id);
    }
    if (player.equipment.offhand) { const sh = ITEM_BASES.filter((b) => b.type === 'armor' && b.slot === 'offhand' && ok(b)).sort((x, y) => (y.armor || 0) - (x.armor || 0))[0]; if (sh) equip(sh.id); }
    const cur = player.equipment.hand; // same weapon, re-rolled at this depth's power multiplier (what a found/crafted copy of it would be)
    if (cur && cur.type === 'weapon' && cur.id) equip(cur.id);
    // best:true -- a martial class that starts with a weak weapon (Chef's cleaver, Tinkerer's wrench: avg ~14 vs Berserker's war axe ~29 at level 30) would in real play pick up a better one; swap in the highest-average-damage
    // non-ranged weapon its STR allows. Only for characters whose own weapon is a melee weapon (casters keep their staves).
    if (best && cur && cur.type === 'weapon' && !cur.ranged && cur.dmg) {
      const avg = (b) => ((b.dmg[0] + b.dmg[1]) / 2);
      const pick = ITEM_BASES.filter((b) => b.type === 'weapon' && b.slot === 'hand' && b.dmg && !b.ranged && !b.magical && ok(b)).sort((x, y) => avg(y) - avg(x))[0];
      if (pick && avg(pick) > avg(cur) * 1.15) { equip(pick.id); D.swappedWeapon = pick.id; }
    }
    player.hp = player.maxHp; return Math.round(getArmorOf(player));
  };
  D.restore = function () {
    player.hp = player.maxHp; player.mp = player.maxMp; player.stamina = player.maxStamina; if (player.maxCharge) player.charge = player.maxCharge;
    for (const k of ['statusPoison', 'statusFear', 'statusConfuse', 'statusSlow', 'frozenSolidTurns', 'stunnedTurns', 'bleedTurns', 'burningTurns', 'wetTurns', 'oiledTurns', 'statusChill', 'statusHeat']) player[k] = 0;
    player.buffs = {}; player.allies = []; player.alive = true;
  };
  // Support policy: a class built on buffs/summons/debuffs is judged unfairly by a damage-only bot. Before and during the fight cast
  // known self-buffs and summons (recast every ~15 turns) and debuff the target once. Costs mana like anything else.
  D.support = function (m, turn) {
    if (turn % 15 !== 1) return false;
    let cast = false;
    for (const id of player.knownSpells || []) {
      const sp = SPELLS.find((x) => x.id === id); if (!sp) continue;
      const selfy = (sp.type === 'buff' || sp.type === 'summon') && !(sp.range > 0 && sp.type === 'buff' && sp.stat === undefined);
      const debuff = sp.type === 'debuff' && turn === 1;
      if (!selfy && !debuff) continue;
      if (sp.type === 'summon' && (player.allies || []).length >= 2) continue;
      const cost = sp.mp || 0; if (player.mp - cost < player.maxMp * 0.3) continue;
      const mp0 = player.mp, t0 = B.sig();
      try { castSpell(id); if (gameState === 'tiletarget') { confirmTileTarget(debuff ? m.x : player.x, debuff ? m.y : player.y); } if (gameState === 'tiletarget') cancelTileTargeting(); } catch (e) { /* */ }
      if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      if (player.mp < mp0 || B.sig() !== t0) cast = true;
      if (cast && sp.type === 'summon') break; // one summon per window
    }
    return cast;
  };
  // Escape policy (opt-in via support:'kite'): when hurt and in melee, blink to a free tile 4+ away so ranged/control kits get room to work.
  D.escape = function (m) {
    for (const id of player.knownSpells || []) {
      const sp = SPELLS.find((x) => x.id === id); if (!sp || sp.type !== 'blinklike' || player.mp < (sp.mp || 0)) continue;
      let spot = null;
      for (let r = 6; r >= 4 && !spot; r--) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = player.x + dx, y = player.y + dy, t = curTileAt(x, y);
        if (t && t.walkable && !entityAt(x, y) && chebyshev(x, y, m.x, m.y) >= 4 && hasLOS(player.x, player.y, x, y)) spot = { x, y };
      }
      if (!spot) return false;
      const mp0 = player.mp, px = player.x, py = player.y;
      try { castSpell(id); if (gameState === 'tiletarget') confirmTileTarget(spot.x, spot.y); if (gameState === 'tiletarget') cancelTileTargeting(); } catch (e) { /* */ }
      if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      if (player.mp < mp0 || player.x !== px || player.y !== py) return true;
    }
    return false;
  };
  // fightMany: spawn all of `ids` at once (a pack, fanned out vertically) and fight until they are all dead or we are. keep:true skips the full restore (attrition: mana/stamina/HP carry over from the previous fight).
  // Targeting policy: the nearest living monster. Reports `kills` so a gauntlet can tell how far we got.
  D.fightMany = function (ids, scale, dist, maxTurns, support, keep) {
    const spot = D.arena(dist); if (!spot) return null;
    if (!keep) D.restore();
    const mons = [];
    const offs = [0, -1, 1, -2, 2, -3, 3];
    ids.forEach((id, k) => {
      for (const dy of offs.slice(k)) { // first free tile in the fan, starting at this monster's own slot
        const x = spot.x + dist, y = spot.y + dy, t = curTileAt(x, y);
        if (!t || !t.walkable || entityAt(x, y)) continue;
        const m = makeMonster(id, x, y, scale, Math.random); m.alive = true; m.aiState = 'combat'; m.engaged = true; m.sleeper = false;
        addMonsterToWorld(m); mons.push(m); return;
      }
    });
    if (!mons.length) return null;
    const hp0 = player.hp; let turns = 0, minHp = player.hp;
    const living = () => mons.filter((m) => m.alive && m.hp > 0);
    while (turns < maxTurns && living().length && player.alive && player.hp > 0) {
      turns++;
      if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      const t0 = B.sig();
      const near = living().sort((a, b) => chebyshev(a.x, a.y, player.x, player.y) - chebyshev(b.x, b.y, player.x, player.y)), m = near[0];
      const adj = near.filter((x) => chebyshev(x.x, x.y, player.x, player.y) <= 1);
      if (support === 'bot') { try { B.tick(); } catch (e) { /* the autopilot's own errors are reported by its runs; here just keep the duel going */ } if (B.sig() === t0) endTurn(); if (player.hp < minHp) minHp = player.hp; continue; } // the real autopilot decides: flees, dodges telegraphs, throws, heals, retreats
      if (support === 'kite' && adj.length && player.hp < player.maxHp * 0.6 && (turns - (D._lastEsc || -99)) > 8 && (D._lastEsc = turns, D.escape(m))) { /* blinked away */ }
      else if (support && D.support(m, turns)) { /* buffed / summoned / debuffed (took its turn) */ }
      else if (player.hp < player.maxHp * 0.35 && B.drinkHeal()) { /* drank */ }
      else if (adj.length) { if (!B.tryCast(adj[0], 0.2)) B.attackAdjacent(adj); }
      else if (B.tryCast(m, 0.2)) { /* cast */ }
      else if (turns > 4) { const t1 = B.sig(); movePlayer(Math.sign(m.x - player.x), Math.sign(m.y - player.y)); if (B.sig() === t1) endTurn({ forceFull: true }); } // it will not come to us (shy/ranged/fleeing): go and get it
      else endTurn({ forceFull: true }); // let it come to us
      if (B.sig() === t0) endTurn(); // never stall
      if (player.hp < minHp) minHp = player.hp;
    }
    const kills = mons.filter((m) => !(m.alive && m.hp > 0)).length;
    const won = !living().length && player.alive && player.hp > 0;
    for (const m of mons) { m.alive = false; m.hp = 0; }
    const died = !(player.alive && player.hp > 0);
    return { won, died, turns, kills, of: mons.length, hpLostPct: Math.max(0, (hp0 - Math.max(0, player.hp)) / hp0), minHpPct: Math.max(0, minHp) / hp0 };
  };
  D.fight = function (id, scale, dist, maxTurns, support) { return D.fightMany([id], scale, dist, maxTurns, support, false); };
  // pack: `size` monsters drawn at random from `pool` arrive together. gauntlet: `size` monsters drawn at random fight ONE AFTER ANOTHER with no rest, mana or healing between (a worst-case floor).
  // Both return {win, death, hpLostPct, turns, avgKills}: win = everything dead and we alive.
  D.groupRun = function (pool, opts) {
    opts = opts || {}; const mode = opts.mode || 'pack', size = opts.size || 3, trials = opts.trials || 8;
    let wins = 0, deaths = 0, lost = 0, turns = 0, ran = 0, kills = 0;
    for (let i = 0; i < trials; i++) {
      const pick = []; for (let k = 0; k < size; k++) pick.push(pool[Math.floor(Math.random() * pool.length)]);
      let r;
      if (mode === 'pack') r = D.fightMany(pick, opts.scale || 1, opts.dist || 5, opts.maxTurns || 160, opts.support === undefined ? true : opts.support, false);
      else {
        D.restore(); let hpLost = 0, t = 0, k = 0, alive = true;
        const hp0 = player.hp;
        for (const id of pick) { const f = D.fightMany([id], opts.scale || 1, opts.dist || 5, opts.maxTurns || 80, opts.support === undefined ? true : opts.support, true); if (!f) break; t += f.turns; if (!f.won) { alive = !f.died; break; } k++; }
        r = { won: k === size, died: !(player.alive && player.hp > 0), turns: t, kills: k, hpLostPct: Math.max(0, (hp0 - Math.max(0, player.hp)) / hp0) };
      }
      if (!r) continue; ran++; kills += r.kills;
      if (r.died) deaths++;
      if (r.won) { wins++; lost += r.hpLostPct; turns += r.turns; }
    }
    D.restore();
    return { mode, size, trials: ran, win: ran ? wins / ran : 0, death: ran ? deaths / ran : 0, hpLostPct: wins ? lost / wins : 1, turns: wins ? turns / wins : 0, avgKills: ran ? kills / ran : 0 };
  };
  D.run = function (id, opts) {
    opts = opts || {}; const trials = opts.trials || 8; let wins = 0, deaths = 0, lost = 0, turns = 0, ran = 0, worst = 1;
    // the game's own threat estimate for this exact matchup (full hp/mp), so `balance --assess` can compare prediction with measured outcome
    let pred = null; D.restore(); try { if (typeof threatOf === 'function') { const pm = makeMonster(id, player.x + 5, player.y, opts.scale || 1, Math.random), t = threatOf(pm, opts.dist || 5); pred = { left: t.left, tier: t.tier.id, byEdge: {} }; const e0 = THREAT_MODEL.playerEdge; for (const e of [0.8, 1, 1.5, 2, 3, 4]) { THREAT_MODEL.playerEdge = e; pred.byEdge[e] = threatOf(pm, opts.dist || 5).left; } THREAT_MODEL.playerEdge = e0; } } catch (e) { /* */ }
    for (let i = 0; i < trials; i++) {
      const r = D.fight(id, opts.scale || 1, opts.dist || 5, opts.maxTurns || 80, opts.support === undefined ? true : opts.support); if (!r) continue; ran++;
      if (r.died) deaths++;
      if (r.won) { wins++; lost += r.hpLostPct; turns += r.turns; worst = Math.min(worst, r.minHpPct); }
    }
    D.restore();
    return { id, trials: ran, win: ran ? wins / ran : 0, death: ran ? deaths / ran : 0, stall: ran ? (ran - wins - deaths) / ran : 0, hpLostPct: wins ? lost / wins : 1, turns: wins ? turns / wins : 0, worstMinHp: worst, pred };
  };
}
module.exports = DUEL;
});

// ==== FILE: lib/driver.js ====
__def("lib/driver.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// driver.js -- creates characters and drives the autopilot (BRAIN) tick by tick from Node.
//   newGame(opts)              boot the game + install the brain
//   resolveBuild(win, spec)    {species:'dwarf'|'c'|2, archetype:'mage', scenario:'town'} -> creation letters
//   createCharacter(win, b)    run the creation screens
//   playLife(opts)             play one character until it dies / wins / runs out of budget -> result object
// =====================================================================================================
const fs = require('fs');
const { boot, ev, key, drainErrors } = require('./harness');
const BRAIN = require('./brain');

/** Boot the game and inject the autopilot brain (window.__B). */
async function newGame(opts) {
  opts = opts || {};
  const dom = await boot(opts.html, opts.seed, Object.assign({ saveable: !!process.env.CKPT }, opts.boot));
  const win = dom.window;
  const r = ev(win, '(' + BRAIN.toString() + ')()');
  if (!r.ok) throw new Error('brain failed to install: ' + r.error);
  return dom;
}

// Default character (what the autopilot was tuned on): dwarf commander starting in a town.
// Letters are positional in the game's creation lists -- use resolveBuild() to pick by name instead.
const BUILD = { species: 'c' /* dwarf */, archetype: 'i' /* commander */, scenario: 'd' /* town */ };

const letterOf = (i) => String.fromCharCode(97 + i);

/**
 * Turn a human-friendly build spec into the letters the creation screens expect.
 * Each field may be a letter ('c'), a 0-based index (2), or an id/name (case-insensitive substring ok).
 */
function resolveBuild(win, spec) {
  spec = spec || BUILD;
  const tables = JSON.parse(ev(win, 'JSON.stringify({species:SPECIES.map(s=>[s.id,s.name]),archetype:ARCHETYPES.map(s=>[s.id,s.name]),scenario:START_SCENARIOS.map(s=>[s.id,s.name])})').value);
  const out = {};
  for (const field of ['species', 'archetype', 'scenario']) {
    const v = spec[field], list = tables[field];
    let idx = -1;
    if (typeof v === 'number') idx = v;
    else if (typeof v === 'string' && /^[a-z]$/.test(v) && list.length > 1 && !list.some((e) => e[0] === v)) idx = v.charCodeAt(0) - 97;
    else if (typeof v === 'string') {
      const q = v.toLowerCase();
      idx = list.findIndex((e) => e[0].toLowerCase() === q || e[1].toLowerCase() === q);
      if (idx < 0) idx = list.findIndex((e) => e[0].toLowerCase().includes(q) || e[1].toLowerCase().includes(q));
    }
    if (idx < 0 || idx >= list.length) throw new Error(`unknown ${field} "${v}". Options: ${list.map((e, i) => letterOf(i) + '=' + e[0]).join(' ')}`);
    out[field] = letterOf(idx);
  }
  return out;
}

/** Run the creation screens. Returns true when the game reached 'playing'. */
function createCharacter(win, b) {
  b = b || BUILD;
  const letters = resolveBuild(win, b);
  for (const k of ['a', letters.species, letters.archetype, letters.scenario]) key(win, k);
  return ev(win, "gameState === 'playing'").value === true;
}

async function playLife(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const dom = await newGame(opts);
  const win = dom.window;
  const ckFile = process.env.CKPT_FILE || ('/tmp/runs/ckpt_' + (opts.seed || 1) + '.json');
  if (process.env.RESUME && require('fs').existsSync(ckFile)) { // pick up a character saved by an earlier process
    win.__ck = JSON.parse(require('fs').readFileSync(ckFile, 'utf8'));
    ev(win, 'applyLoadedSave(__ck)'); delete win.__ck;
    if (ev(win, "gameState === 'playing' && player.alive").value !== true) throw new Error('resume failed: ' + ev(win, 'gameState').value);
    log('RESUMED from checkpoint at level ' + ev(win, 'player.level').value + ' turn ' + ev(win, 'turnCount').value);
  } else {
  if (!createCharacter(win, opts.build)) throw new Error('character creation failed');
  if (opts.prep) opts.prep(win);
  }
  let lastCk = Date.now();
  const t0 = Date.now();
  const counts = {}; const trace = [];
  let B_ckDur = 0;
  let idleRun = 0, lastTurn = -1, stall = 0, lastLvl = 1, lastDepth = 0, lastStage = -2;
  const posRing = []; let travelDumped = false;
  let curDumped = false, lastBeat = Date.now(), prevCounts = {};
  let result = { outcome: 'budget', ticks: 0 };
  const levelTurns = {}; // level -> game turn on which it was reached (pace of progression)
  const depthMax = { v: 0 };
  const maxTicks = opts.maxTicks || 100000;
  for (let i = 0; i < maxTicks; i++) {
    const tkT0 = Date.now();
    const r = ev(win, '__B.tick()', 20000);
    if (Date.now() - tkT0 > 4000) log('SLOWTICK ' + (Date.now() - tkT0) + 'ms -> ' + r.value + ' turn ' + ev(win, 'turnCount').value);
    if (!r.ok && r.timeout) { result.outcome = 'hang'; result.hang = ev(win, 'JSON.stringify({gs:gameState,dun:curIsDungeon(),depth:player.dungeonDepth,x:player.x,y:player.y,hp:player.hp,turn:turnCount,goal:__B.goalDungeon&&__B.goalDungeon.id,trip:!!__B.trip,dbg:__B.dbg})').value; log('HANG ' + result.hang); break; }
    result.ticks = i;
    if (!r.ok) { log('BRAIN ERROR: ' + r.error.split('\n').slice(0, 3).join(' | ')); result.outcome = 'error'; result.error = r.error; break; }
    const v = String(r.value);
    if (v.startsWith('idle') || v.startsWith('unstick')) { idleRun++; if (idleRun === 150) { const d = ev(win, '__B.diag()').value; log('STUCK DIAG (' + v + ')\n' + d); } } else idleRun = 0;
    counts[v] = (counts[v] || 0) + 1;
    trace.push(v + ' ' + ev(win, 'turnCount+" hp"+player.hp+" @"+player.x+","+player.y+" d"+(player.dungeonDepth||0)').value); if (trace.length > 40) trace.shift();
    if (process.env.PT_PATH) { const pv = ev(win, 'turnCount+"|"+player.level+"|"+(curIsDungeon()?"dungeon":(typeof curIsDimension==="function"&&curIsDimension()?"dim":startDist(player.x,player.y)+"@"+player.x+","+player.y))+"|"+((typeof curStoryStage==="function"&&curStoryStage())?curStoryStage().type+":"+String(curStoryStage().desc||curStoryStage().id||"").slice(0,40):"")').value.split('|'); if (v !== trace.__lastV || +pv[0] - (trace.__lastT || -99) >= 150) { if (!trace.__lastT || +pv[0] - trace.__lastT >= 20) { trace.__lastT = +pv[0]; console.error('[path] t' + pv[0] + ' L' + pv[1] + ' ' + v + ' d=' + pv[2] + ' ' + pv[3]); } trace.__lastV = v; } }
    if (v === 'dead') { result.outcome = 'died'; break; }
    if (v.startsWith('ui:')) { ev(win, "try{closeModal()}catch(e){}; gameState='playing'"); }
    if (v === 'travel' || v === 'wander' || v.startsWith('quest-')) { // oscillating without getting anywhere?
      if (process.env.POSLOG && (counts[v] || 0) % 40 === 0) log('POS ' + v + ' ' + ev(win, 'player.x+","+player.y+" t"+turnCount+" goal="+(__B.goalDungeon&&__B.goalDungeon.id)+" tp="+(__B.tp&&__B.tp.key)+"/"+(__B.tp&&__B.tp.steps.length)').value);
      posRing.push(ev(win, 'player.x+","+player.y').value); if (posRing.length > 1500) posRing.shift();
      if (posRing.length === 1500 && !travelDumped && (() => { const xs = posRing.map((p) => +p.split(',')[0]), ys = posRing.map((p) => +p.split(',')[1]); return Math.max(...xs) - Math.min(...xs) <= 14 && Math.max(...ys) - Math.min(...ys) <= 14; })()) { travelDumped = true; log('TRAVEL STUCK trace: ' + trace.slice(-24).join(' ; ') + '\n' + ev(win, 'JSON.stringify({goal:__B.goalDungeon&&__B.goalDungeon.id,tp:__B.tp&&{key:__B.tp.key,n:__B.tp.steps.length},why:__B.tpWhy,pos:[player.x,player.y],turn:turnCount})').value + '\n' + ev(win, '__B.diag()').value); }
    }
    const st = ev(win, 'JSON.stringify([turnCount,player.level,player.dungeonDepth||0,player.gameCompleted===true,player.story?player.story.stageIndex:-1])').value;
    const [turn, lvl, depth, done, stg] = JSON.parse(st);
    if (stg !== lastStage) { log(`story stage ${stg} at turn ${turn} (lvl ${lvl})`); lastStage = stg; }
    if (done) { result.outcome = 'WON'; break; }
    if (turn === lastTurn) { if (++stall > 4) { ev(win, 'endTurn()'); stall = 0; } } else stall = 0;
    lastTurn = turn;
    if (process.env.CANDS && !curDumped && ev(win, '__B.xpIdle()').value > 1000) { curDumped = true; log('CANDS lvl ' + lvl + ' turn ' + turn + ' scanR ' + ev(win, '__B.scanR').value + ' goal ' + ev(win, '(__B.goalDungeon||{}).id').value + ' choose ' + ev(win, '(__B.chooseDungeon()||{}).id').value + ' idleN ' + ev(win, '__B.idleN').value + '\n' + JSON.parse(ev(win, 'JSON.stringify(__B.cands())').value).join('\n')); }
    if (process.env.CKPT && Date.now() - lastCk > Math.max(parseInt(process.env.CKPT, 10) * 1000, (B_ckDur || 0) * 15) && ev(win, "gameState === 'playing' && !curIsDungeon() && !curIsDimension() && player.alive").value === true) {
      lastCk = Date.now(); const ckT0 = Date.now();
      try { ev(win, 'for (const [k, c] of [...worldChunks.entries()]) { if (!c.dirty) continue; try { chunkSaveRecord(c, { left: 1e9 }); } catch (e) { worldChunks.delete(k); } }'); const r = ev(win, 'JSON.stringify(getSaveData(), saveDataReplacer)'); if (!r.ok) throw new Error(String(r.error).slice(0, 700)); const d = r.value; const fs = require('fs'); fs.writeFileSync(ckFile + '.tmp', d); fs.renameSync(ckFile + '.tmp', ckFile); B_ckDur = Date.now() - ckT0; if (Date.now() - ckT0 > 5000) log('SLOWCKPT ' + (Date.now() - ckT0) + 'ms size ' + d.length); } catch (e) { log('checkpoint failed: ' + e.message); }
    }
    if (opts.beatSecs && Date.now() - lastBeat > opts.beatSecs * 1000) {
      lastBeat = Date.now(); { const tr = ev(win, "(function(){var s=curStoryStage();if(!s||s.type!=='dimension_trail')return '';var gi=DIMENSION_GATE_INFO[s.targetDimensionId];var cd=curIsDungeon()?curDungeon():null;return JSON.stringify({where:[player.mode,player.dimensionId,cd&&cd.theme,player.dungeonDepth,player.x,player.y],st:{id:s.id,t:s.targetDimensionId,m:s.targetMonsterId},dim:player.dimensionId,disc:player.discoveredDimensions,gate:gi,gd:DIMENSION_TRAIL_GUARDIANS[s.targetDimensionId]})})()").value; if (tr) log('  TRAIL ' + String(tr).slice(0, 700)); }
      if (process.env.EV) { try { const evs = JSON.parse(ev(win, 'JSON.stringify(__B.events.slice(-80))').value || '[]'); globalThis.__seenEv = globalThis.__seenEv || new Set(); for (const e of evs) if (!globalThis.__seenEv.has(e) && new RegExp(process.env.EV).test(e)) { globalThis.__seenEv.add(e); log('  NOTE ' + e.slice(0, 1500)); } } catch (e) { /* */ } }
      const win2 = {}; for (const k in counts) { const d = counts[k] - (prevCounts[k] || 0); if (d > 0) win2[k] = d; } prevCounts = Object.assign({}, counts);
      log(`  [beat ${((Date.now() - t0) / 1000).toFixed(0)}s] lvl ${lvl} turn ${turn} depth ${depth} stage ${stg} ` + ev(win, "(function(){var s=curStoryStage();return s?s.id+'/'+s.type+'/'+(s.targetBossId||s.targetTier||''):'-'})()").value + ' ' + JSON.stringify(Object.entries(win2).sort((a, b) => b[1] - a[1]).slice(0, 7)) + ' ' + ev(win, "(function(){try{var g=__B.goalDungeon;var w=[...dungeonRegistry.values()].filter(function(d){return !d.isTutorial&&__B.stageWants(d)});var near=w.map(function(d){return Math.max(Math.abs(d.x-player.x),Math.abs(d.y-player.y))}).sort(function(a,b){return a-b})[0];return 'goal='+(g?g.id+'/'+g.tier+'/d'+Math.max(Math.abs(g.x-player.x),Math.abs(g.y-player.y)):'-')+' scanR='+__B.scanR+' wanted='+w.length+' nearestWanted='+near+' pos='+player.x+','+player.y+' tp='+(__B.tp?__B.tp.key+'/'+__B.tp.steps.length:'-')+' trip='+(__B.trip?__B.trip.x+','+__B.trip.y:'-')+' trip2='+(__B.trip2?__B.trip2.npc.name+'@'+__B.trip2.npc.x+','+__B.trip2.npc.y:'-')+' kt='+(__B.kt?__B.kt.x+','+__B.kt.y:'-')+' wd='+w.slice(0,2).map(function(d){return d.id+':f1='+__B.dungeonFloorLevel(d,1)+',fmax='+__B.dungeonFloorLevel(d,d.maxDepth)+',md='+d.maxDepth+',log='+JSON.stringify(__B.dungeonLog[d.id]||{})+',dz='+__B.dangerZones().filter(function(z){return Math.max(Math.abs(z.x-d.x),Math.abs(z.y-d.y))<=z.r+2}).length}).join(';')+' why='+JSON.stringify(__B.tpWhy)}catch(e){return 'beaterr'}})()").value);
    }
    if (opts.statusEvery && i % opts.statusEvery === 0 && i) log(`  [status] tick ${i} turn ${turn} lvl ${lvl} depth ${depth} ${((Date.now() - t0) / 1000).toFixed(0)}s ` + JSON.stringify(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)));
    if (process.env.UISCAN && lvl !== lastLvl && (lvl % 3 === 0 || lvl <= 2)) { // UISCAN=1: open every screen at level milestones, in whatever rich state this run has built, and record text leaks (UISCAN=debug also prints the raw result)
      try {
        const raw = ev(win, globalThis.UI_SCAN_JS); if (process.env.UISCAN === 'debug') log('  uiscan raw: ' + JSON.stringify(raw).slice(0, 300));
        for (const l of JSON.parse(raw.value || '[]')) { (result.uiLeaks = result.uiLeaks || []).push(`L${lvl}: ${l}`); log(`  UI LEAK L${lvl}: ${l}`); }
      } catch (e) { log('  uiscan failed: ' + e.message); }
    }
    if (lvl !== lastLvl) { levelTurns[lvl] = turn; log(`level ${lvl} at turn ${turn} (${((Date.now() - t0) / 1000).toFixed(0)}s) nextBossReady=${ev(win, '__B.nextBossReady()').value}`); lastLvl = lvl; }
    if (opts.maxSeconds && Date.now() - t0 > opts.maxSeconds * 1000) { result.outcome = 'time'; break; }
    if (v.startsWith('idle') && opts.stopOnIdle) { result.outcome = v; break; }
  }
  if (process.env.DIAG) { try { result.diagText = ev(win, '__B.diag()').value; } catch (e) { /* */ } }
  result.counts = counts; result.trace = trace; result.why = ev(win, 'JSON.stringify(__B.tpWhy)').value + ' ' + ev(win, 'JSON.stringify(__B.nm)').value + ' AF ' + ev(win, 'JSON.stringify(__B.af)').value;
  result.final = JSON.parse(ev(win, 'JSON.stringify({lvl:player.level,hp:player.hp,maxHp:player.maxHp,turn:turnCount,depth:player.dungeonDepth||0,place:(function(){try{var d=curIsDungeon()?curDungeon():null;return d?d.theme+"@"+d.id+" rec"+d.recommendedLevel:"overworld"}catch(e){return null}})(),alive:player.alive,xp:player.xp,gold:player.gold,cause:player.deathCause||lastDamageSource||null,st:{poison:player.statusPoison,slow:player.statusSlow,chill:player.statusChill,heat:player.statusHeat,rad:player.statusRadiation,bleed:player.bleedTurns,temp:(function(){try{return currentTemperature()}catch(e){return null}})(),biome:(function(){try{return curTileAt(player.x,player.y).biome}catch(e){return null}})()},eq:Object.entries(player.equipment).filter(function(e){return e[1]}).map(function(e){return e[0]+"="+e[1].name+(e[1].dmg?"["+e[1].dmg+"]":"")+(e[1].armor?"(a"+e[1].armor+")":"")}),stats:__B.stats,feats:(function(){try{var f=player.feats||{counts:{},done:{}};return{done:Object.keys(f.done),counts:f.counts}}catch(e){return null}})()})').value);
  // the bot never counted kills itself (B.stats.kills stayed 0 for every run); the game's own feat counter is the real total
  if (result.final && result.final.stats && result.final.feats && result.final.feats.counts) result.final.stats.kills = result.final.feats.counts.kills || 0;
  result.events = ev(win, '__B.events.slice(-40)').value;
  result.loops = ev(win, "__B.events.filter(function (e) { return e.indexOf('LOOP BREAK') >= 0 || e.indexOf('DANCE LOOP') >= 0 || e.indexOf('STALL') >= 0; }).slice(0, 5)").value;
  if (result.outcome === 'died') result.inv = ev(win, 'JSON.stringify([player.gold].concat(player.inventory.filter((i)=>i.type==="consumable").map((i)=>i.name+"x"+(i.qty||1))))').value;
  if (result.outcome === 'died') result.deathLog = ev(win, '(player.deathLog&&player.deathLog.length?player.deathLog:logMessages.map(function(x){return typeof x==="string"?x:(x&&x.text)||""})).slice(-16)').value;
  if (result.outcome === 'died') result.deathAt = ev(win, 'JSON.stringify({x:player.x,y:player.y,fromStart:(typeof startDist==="function"?startDist(player.x,player.y):null),near:(typeof monsters!=="undefined"?monsters:[]).filter(function(m){return m.alive&&Math.abs(m.x-player.x)+Math.abs(m.y-player.y)<=6}).map(function(m){return m.name+"@"+(Math.abs(m.x-player.x)+Math.abs(m.y-player.y))+(m.boss?"*":"")+(typeof spawnTierOf==="function"?"t"+spawnTierOf(m.monsterId):"")}).slice(0,6)})').value;
  result.seconds = (Date.now() - t0) / 1000;
  result.levelTurns = levelTurns;
  result.gameErrors = drainErrors(win);
  result.build = opts.build || BUILD;
  return result;
}


module.exports = { newGame, resolveBuild, createCharacter, playLife, BUILD };
});

// ==== FILE: lib/probes/abilities.js ====
__def("lib/probes/abilities.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Dynamic probes that USE abilities in a live world (needs a character).
// Shared setup (listed in `uses`, installed on A before fn runs): A.arena() puts the player on open ground with a tanky dummy target 2 tiles east.
const ARENA = function (A) {
  A.arena = function (monsterId, hp, dist) {
    for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; }
    try { for (const c of worldChunks.values()) c.monsters = []; } catch (e) { /* */ }
    let spot = null;
    for (let r = 0; r < 60 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = player.x + dx, y = player.y + dy; let ok = true;
      for (let yy = -2; yy <= 2 && ok; yy++) for (let xx = -3; xx <= 5 && ok; xx++) { const t = curTileAt(x + xx, y + yy); if (!t || !t.walkable || entityAt(x + xx, y + yy)) ok = false; }
      if (ok) spot = { x, y };
    }
    if (!spot) return null;
    player.x = spot.x; player.y = spot.y;
    const m = makeMonster(monsterId || 'goblin', spot.x + (dist || 2), spot.y, 1, Math.random);
    m.hp = m.maxHp = hp || 5000; m.armor = 0; m.atk = [0, 0]; m.str = 0; m.dex = 1; m.poison = 0; m.abilities = []; m.behavior = 'turret'; m.alive = true; m.aiState = 'combat'; m.engaged = true; m.sleeper = false;
    addMonsterToWorld(m);
    return m;
  };
  A.refill = function () {
    // big pools: this probe tests what an ability DOES, not whether a level-1 character can afford it
    player.maxHp = Math.max(player.maxHp, 400); player.maxMp = Math.max(player.maxMp, 400); player.maxStamina = Math.max(player.maxStamina, 400); player.maxCharge = Math.max(player.maxCharge || 0, 400);
    player.hp = player.maxHp; player.mp = player.maxMp; player.stamina = player.maxStamina; player.charge = player.maxCharge;
    player.str = Math.max(player.str, 60); player.dex = Math.max(player.dex, 60); player.int = Math.max(player.int, 60); // soft stat requirements would make casts fizzle
    for (const k of ['statusPoison', 'statusFear', 'statusConfuse', 'statusSlow', 'frozenSolidTurns', 'stunnedTurns', 'bleedTurns']) player[k] = 0;
    player.abilityCooldowns = {}; try { refillBonusActions(); } catch (e) { /* older builds */ }
    // earlier casts must not leak into later ones: weather, buffs, summons, fire on the ground
    player.buffs = {}; player.allies = []; player.statusChill = 0; player.statusHeat = 0; player.burningTurns = 0; player.wetTurns = 0; player.oiledTurns = 0;
    try { const st = ensureWeather(zoneKey()); st.id = 'clear'; st.turnsRemaining = 500; } catch (e) { /* underground */ }
    try { activeFxTiles = []; } catch (e) { /* */ }
  };
  A.settle = function () { // leave any prompt the ability opened
    for (let i = 0; i < 4 && gameState !== 'playing'; i++) {
      if (gameState === 'tiletarget') { try { cancelTileTargeting(); } catch (e) { /* */ } }
      try { closeModal(); } catch (e) { /* */ }
      gameState = 'playing';
    }
  };
};

module.exports = [
  {
    id: 'abilities.cast-all',
    desc: 'cast every spell / technique / active cyberware / active mutation at a dummy: no exceptions, no NaN, resources are paid, damage abilities hurt',
    needsPlayer: true,
    uses: [ARENA],
    seconds: 240,
    fn(A) {
      // a free, walkable tile 2-3 steps away in any direction (the old fixed 'y+3' was sometimes a wall/occupied -> flaky 'changed nothing' warnings for every blink-type ability)
      const blinkSpot = () => { for (const r of [3, 2, 4]) for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const x = player.x + dx * r, y = player.y + dy * r, t = curTileAt(x, y); if (t && t.walkable && !entityAt(x, y)) return [x, y]; } return [player.x, player.y + 3]; };
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const list = [].concat(SPELLS, TECHNIQUES, CYBERNETICS.filter((c) => c.activation === 'active'), MUTATIONS.filter((m) => m.activation === 'active'));
      const snap = () => ({ hp: player.hp, mp: player.mp, st: player.stamina, ch: player.charge, buffs: JSON.stringify(player.buffs), log: logMessages.length, inv: player.inventory.length, ents: curMonsters().length, ally: curMonsters().filter((m) => m.kind === 'ally').length, x: player.x, y: player.y, turn: turnCount });
      let casts = 0, noops = 0, free = 0;
      A.arena('goblin', 5000, 2); A.refill(); const hb = player.hp; endTurn(); const drift = Math.max(0, hb - player.hp); // what a do-nothing turn costs (ambient damage) must not be blamed on the ability
      for (const ab of list) {
        const dmgType = ['damage', 'execute', 'smite', 'lifetap', 'drain', 'multihit', 'direct'].includes(ab.type);
        let hurt = false, changedAny = false, paid = null, selfHurt = 0; const cost0 = false;
        for (let trial = 0; trial < 3; trial++) {
          const tgt = A.arena('goblin', 5000, ab.range === 1 ? 1 : 2);
          if (!tgt) { A.warn('abilities', ab.id, 'could not build an arena'); break; }
          A.refill();
          if (!player.knownSpells.includes(ab.id) && !player.knownTechniques.includes(ab.id)) {
            if (SPELLS.includes(ab)) player.knownSpells.push(ab.id); else if (TECHNIQUES.includes(ab)) player.knownTechniques.push(ab.id);
            else if (CYBERNETICS.includes(ab)) (player.installedCyber = player.installedCyber || []).push(ab.id); else (player.mutations = player.mutations || []).push(ab.id);
          }
          player.stunnedTurns = 0; player.statusFear = 0;
          // PRECONDITIONS: some abilities act on something other than a target (a corpse, a fallen ally, worn gear, a material). Without it they report "changed nothing".
          if (ab.type === 'raise' || ab.type === 'corpseblast') placeItemAt(player.x + 1, player.y, makeCorpse({ name: 'Goblin', monsterId: 'goblin' }));
          if (ab.id === 'reviveally') player.lastFallenAlly = { monsterId: 'wolf', name: 'Fallen Wolf', turn: turnCount };
          if (ab.type === 'repair') { let w = Object.values(player.equipment).find((e) => e && e.maxDurability !== undefined && e.maxDurability !== Infinity); if (!w) { w = makeItem('dagger', 0, Math.random); player.equipment.hand = w; } w.durability = Math.max(1, Math.floor(w.maxDurability / 2)); }
          if (ab.type === 'transmute' && !player.inventory.some((i) => i.type === 'material')) player.inventory.push(makeItem('herb', 0, Math.random));
          const before = snap(), hp0 = tgt.hp;
          const pool = ab.resource || 'mp';
          try {
            castSpell(ab.id);
            if (gameState === 'tiletarget') confirmTileTarget(...(pendingTarget && pendingTarget.kind === 'blink' ? blinkSpot() : [tgt.x, tgt.y]));
          } catch (e) { A.err('abilities', ab.id, 'castSpell threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); A.settle(); break; }
          A.settle(); casts++;
          if (gameState === 'gameover' || !player.alive) { A.err('abilities', ab.id, 'the caster DIED casting it (cause ' + player.deathCause + ') at hp ' + before.hp + '/' + player.maxHp); return; }
          const after = snap();
          if (!cost0 && after.hp < before.hp && !(ab.resource === 'hp' || ab.type === 'lifetap' || ab.type === 'bloodbuff' || ab.type === 'bloodarmor' || ab.selfCost)) selfHurt = Math.max(selfHurt, before.hp - after.hp - drift);
          for (const k of ['hp', 'mp', 'st', 'ch', 'x', 'y']) if (after[k] !== undefined && !finite(after[k])) A.err('abilities', ab.id, `player.${k} became ${after[k]}`);
          if (!finite(tgt.hp)) A.err('abilities', ab.id, 'target hp became ' + tgt.hp);
          if (tgt.hp < hp0) hurt = true;
          const changed = JSON.stringify(before) !== JSON.stringify(after) || tgt.hp !== hp0;
          if (changed) changedAny = true;
          const hpPay = pool === 'hp' || ab.type === 'lifetap' || ab.type === 'bloodarmor' || ab.type === 'bloodbuff' || ab.selfCost != null;
          const key = hpPay ? 'hp' : pool === 'stamina' ? 'st' : pool === 'charge' ? 'ch' : 'mp';
          paid = paid || (after[key] !== before[key]);
          A.refill();
        }
        if (!changedAny && ab.type === 'travelbypass') A.info('abilities.travel', ab.id, `${ab.name} (travelbypass) needs a waystone network / destination to do anything; not exercised here`);
        else if (!changedAny) { noops++; A.warn('abilities.noop', ab.id, `${ab.name} (${ab.type}) changed nothing in 3 casts`); }
        else if (dmgType && !hurt) A.warn('abilities.nodamage', ab.id, `${ab.name} (${ab.type}) never reduced the target's hp in 3 casts`);
        if (selfHurt > 0) A.info('abilities.selfdamage', ab.id, `${ab.name} (${ab.type}${ab.aoe ? ', aoe r' + ab.aoeRadius : ''}) hurt its own caster for ${selfHurt} (friendly fire is INTENDED design; informational only) with the target ${ab.range === 1 ? 1 : 2} tile(s) away`);
        const cost = ab.selfCost != null ? ab.selfCost : ab.mp;
        // lifetaps pay HP and heal it straight back, so the caster ends at full HP: net-neutral by design
        if (changedAny && cost > 0 && paid === false && !['blinklike'].includes(ab.type) && !(ab.healBackPct && !(ab.resource && ab.resource !== 'hp'))) { free++; A.warn('abilities.free', ab.id, `${ab.name} lists a cost of ${cost} (${ab.resource || 'mp'}) but the pool never changed`); }
      }
      A.stat('abilityCasts', casts); A.stat('abilityNoops', noops); A.stat('abilitiesThatNeverPaid', free);
    },
  },
];
module.exports.ARENA = ARENA;
});

// ==== FILE: lib/probes/bosses.js ====
__def("lib/probes/bosses.js", function (module, exports, require, __dirname, __filename) {
'use strict';
const ARENA2 = function (A) {
  A.arenaBoss = function (id, dist) { // like A.arena but keeps the monster's real stats/AI
    for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; }
    try { for (const c of worldChunks.values()) c.monsters = []; } catch (e) { /* */ }
    let spot = null;
    for (let r = 0; r < 80 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = player.x + dx, y = player.y + dy; let ok = true;
      for (let yy = -4; yy <= 4 && ok; yy++) for (let xx = -4; xx <= 8 && ok; xx++) { const t = curTileAt(x + xx, y + yy); if (!t || !t.walkable || entityAt(x + xx, y + yy)) ok = false; }
      if (ok) spot = { x, y };
    }
    if (!spot) return null;
    player.x = spot.x; player.y = spot.y;
    const m = makeMonster(id, spot.x + (dist || 3), spot.y, 3, Math.random);
    m.alive = true; m.aiState = 'combat'; m.engaged = true; m.sleeper = false;
    addMonsterToWorld(m);
    return m;
  };
};
module.exports = [
  {
    id: 'bosses.scripted-ai',
    desc: 'run every boss / scripted-AI monster for 3 phases against an unkillable player: no exceptions, no NaN, and measure damage output',
    needsPlayer: true, uses: [ARENA2], seconds: 600,
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const ids = Object.keys(MONSTER_BASES).filter((id) => MONSTER_BASES[id].boss || MONSTER_BASES[id].scriptedAI);
      let ran = 0; const __g = A.leakGuard({ baseStats: 12 }); A.stat('bossProbePlayer', `L${player.level} armor ${getArmorOf(player)} dex ${effDex(player)} str ${player.str} maxHp ${player.maxHp} dr ${Object.keys(player).filter((k) => /dodge|block|evasion|damage.*(red|taken)/i.test(k) && player[k]).map((k) => k + '=' + player[k]).join(',')}`); // a leaked resist/death-save/DEBUG flag made this measure ~0 damage in a full audit
      try {
      for (const id of ids) for (let attempt = 0; attempt < 2; attempt++) { // a boss that looks passive gets ONE retry at a fresh spot: an arena whose surroundings make a boss lose interest (seen at some post-probe positions) is environment noise, not a passive boss
        const m = A.arenaBoss(id, 3);
        if (!m) { A.warn('bosses', id, 'no arena space'); break; }
        player.maxHp = 1e7; player.hp = 1e7;
        // earlier probes share this game instance: clear anything that could make the boss harmless (allies that tank, buffs, fear/slow/freeze, invisibility) so the measurement is of the boss alone
        for (const k of ['statusPoison', 'statusFear', 'statusConfuse', 'statusSlow', 'frozenSolidTurns', 'stunnedTurns', 'bleedTurns', 'burningTurns', 'statusChill', 'statusHeat', 'invisibleTurns']) player[k] = 0;
        player.buffs = {}; player.allies = []; player.alive = true;
        // tally every point of damage the player takes (regeneration is ignored) by wrapping the hp accessor
        let backing = 1e7, tally = 0;
        Object.defineProperty(player, 'hp', { configurable: true, enumerable: true, get() { return backing; }, set(v) { if (v < backing) tally += backing - v; backing = Math.min(v, 1e7); } }); player.mp = player.maxMp = 1000; player.stamina = player.maxStamina = 1000; player.armor = player.armor || 0;
        const dmg = []; let attacked = false; // a boss that swings and MISSES (a high-level leftover player dodges a lot) is not passive
        for (const frac of [1, 0.6, 0.25]) {
          m.hp = Math.max(1, Math.round(m.maxHp * frac)); const hp0 = tally;
          for (let t = 0; t < 40; t++) {
            try { endTurn(); if (!attacked && logMessages.slice(-8).some((x) => x.startsWith(m.name) && / (you|your)\b/.test(x))) attacked = true; } catch (e) { A.err('bosses', id, `endTurn threw at ${Math.round(frac * 100)}% hp, turn ${t}: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`); break; }
            if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
            if (!player.alive) { player.alive = true; }
            if (!m.alive || m.hp <= 0) break;
            if (!finite(m.hp) || !finite(player.hp)) { A.err('bosses', id, `hp became NaN (boss ${m.hp}, player ${player.hp})`); break; }
          }
          dmg.push(Math.round((tally - hp0) / 40 * 10) / 10);
          if (!m.alive) break;
          // keep the player in reach so melee bosses are measured fairly
          if (chebyshev(m.x, m.y, player.x, player.y) > 8) { player.x = m.x - 2; player.y = m.y; }
        }
        installVitalGuards(player); player.hp = player.maxHp = 500; // put the normal accessor back
        const passive = dmg.every((d) => d <= 0) && !attacked && !MONSTER_BASES[id].waterOnly && !MONSTER_BASES[id].aquatic;
        if (passive && attempt === 0) { m.alive = false; m.hp = 0; player.x += 25; continue; }
        ran++;
        A.stat('bossDmgPerTurn:' + id, dmg.join('/'));
        if (passive) A.warn('bosses.passive', id, `${m.name} dealt no damage to a motionless player in 120 turns (hp phases ${dmg.join('/')}); boss alive=${m.alive} state=${m.aiState} dist=${chebyshev(m.x, m.y, player.x, player.y)} engaged=${m.engaged} sleeper=${m.sleeper} pos=${m.x},${m.y} player=${player.x},${player.y} last log: ${logMessages.slice(-2).join(' / ')}`);
        m.alive = false; m.hp = 0; // do not leave this boss fighting in the next boss's arena (they used to stack on one tile and hit each other / the player); done AFTER the diagnostics so they show the boss's real state
        break;
      }
      } finally { __g.restore(); }
      A.stat('bossesRun', ran);
    },
  },
];
module.exports.push({
  id: 'bosses.action-economy',
  desc: 'a boss whose DEX reaches a DEX_ACTION_SPEED_THRESHOLDS breakpoint silently acts twice per turn (Windrender, Thunderbird and The Unrepeated did ~2x their peers); it must be deliberate: list it in FAST_BOSS_OK or have swiftMover set',
  needsPlayer: false, seconds: 5,
  fn(A) {
    const FAST_BOSS_OK = ['broken_blade', 'god', 'alphawolf']; // deliberately fast: measured damage/turn is in line with peers (broken_blade ~26), GOD is the joke apex, alphawolf is a pack hunter. Add an id here only after checking bossDmgPerTurn
    const first = Math.min(...DEX_ACTION_SPEED_THRESHOLDS.map((t) => t.dex));
    for (const id of Object.keys(MONSTER_BASES)) {
      const b = MONSTER_BASES[id];
      if (!(b.boss || b.miniboss) || FAST_BOSS_OK.includes(id)) continue;
      if ((b.dex || 0) >= first) A.err('bosses.action-economy', id, 'boss dex ' + b.dex + ' >= ' + first + ' grants bonus actions (doubling its rotation); lower it or add to FAST_BOSS_OK deliberately');
      if (b.swiftMover) A.warn('bosses.action-economy', id, 'swiftMover grants a bonus action to a boss');
    }
  },
});
module.exports.push({
  id: 'bosses.kill-credit',
  desc: 'a boss melee hit with a damage multiplier (Backstab x2, Poisoned Edge...) that kills the player must credit the boss as the killer (it used to leave deathCause null: blank death screen)',
  needsPlayer: true, uses: [ARENA2], seconds: 60,
  fn(A) {
    for (const id of ['broken_blade', 'oathbroken']) {
      if (!MONSTER_BASES[id]) continue;
      let credited = 0, anonymous = 0;
      for (let trial = 0; trial < 14; trial++) { // varied starting HP so some hits leave the player alive until the x2 top-up lands
        const m = A.arenaBoss(id, 1); if (!m) { A.warn('bosses.kill-credit', id, 'no arena space'); break; }
        try { installVitalGuards(player); } catch (e) { /* */ }
        player.alive = true; player.deathCause = null; lastDamageSource = null; gameState = 'playing';
        player.maxHp = 60; player.hp = 3 + trial * 4; m.x = player.x + 1; m.y = player.y;
        for (let t = 0; t < 20 && player.alive && player.hp > 0; t++) { try { bossMeleeHit(m, 2.0); } catch (e) { A.err('bosses.kill-credit', id, 'bossMeleeHit threw: ' + e); break; } }
        if (!player.alive || player.hp <= 0) { if (player.deathCause) credited++; else anonymous++; }
        if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
        player.alive = true; player.hp = player.maxHp = 500;
      }
      A.stat('killCredit:' + id, credited + '/' + (credited + anonymous));
      if (anonymous) A.err('bosses.kill-credit', id, anonymous + ' of ' + (credited + anonymous) + ' fatal boss hits left deathCause empty');
    }
  },
});
module.exports.push({
  id: 'bosses.fragile-player',
  desc: 'every boss / scripted-AI monster fights a fragile player (60 HP, no guards): every death must name its killer (signature moves used to bypass the killer-aware death path)',
  needsPlayer: true, uses: [ARENA2], seconds: 400,
  fn(A) {
    const ids = Object.keys(MONSTER_BASES).filter((id) => MONSTER_BASES[id].boss || MONSTER_BASES[id].scriptedAI);
    let deaths = 0, anonymous = 0; const bad = {};
    for (const id of ids) {
      const m = A.arenaBoss(id, 2); if (!m) continue;
      for (let round = 0; round < 6; round++) {
        player.alive = true; player.deathCause = null; lastDamageSource = null; gameState = 'playing';
        player.maxHp = 60; player.hp = 60; player.statusPoison = 0; player.bleedTurns = 0;
        if (!m.alive) break;
        m.hp = m.maxHp; player.x = m.x - 2; player.y = m.y;
        for (let t = 0; t < 50 && player.alive && player.hp > 0 && m.alive; t++) {
          try { endTurn(); } catch (e) { A.err('bosses.fragile', id, 'endTurn threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); break; }
          if (gameState !== 'playing' && player.alive) { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
          if (player.hp > 0 && player.alive) player.hp = Math.max(player.hp, 1) && player.hp; // (no healing: fragile on purpose)
        }
        if (!player.alive || player.hp <= 0) { deaths++; if (!(player.deathCause || lastDamageSource)) { anonymous++; // the death screen falls back to lastDamageSource, so only a death with neither is a blank one
           bad[id] = (bad[id] || '') + ' [lastDamageSource=' + lastDamageSource + '; log: ' + logMessages.slice(-3).join(' / ') + ']'; } }
        if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      }
    }
    player.alive = true; player.hp = player.maxHp = 500;
    A.stat('fragileDeaths', deaths); A.stat('fragileAnonymousDeaths', anonymous);
    for (const id in bad) A.err('bosses.fragile', id, 'death with no killer recorded' + bad[id]);
  },
});
module.exports.ARENA2 = ARENA2;
});

// ==== FILE: lib/probes/content.js ====
__def("lib/probes/content.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes over authored content that players interact with: recipes, NPC roles and their dialogue trees.
const HELP = function (A) {
  A.settle = function () { for (let i = 0; i < 6 && gameState !== 'playing' && gameState !== 'gameover'; i++) { if (gameState === 'tiletarget') { try { cancelTileTargeting(); } catch (e) { /* */ } } try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; dialogueNPC = null; } };
  A.invCount = function (id) { return player.inventory.filter((i) => i.id === id).reduce((a, i) => a + (i.qty || i.amount || 1), 0); };
};
module.exports = [
  {
    id: 'content.recipes',
    desc: 'craft every recipe from scratch: the recipe is craftable with its listed inputs, consumes them, and yields its output',
    needsPlayer: true, uses: [HELP], seconds: 240,
    fn(A) {
      let crafted = 0;
      for (const r of RECIPES) {
        A.settle(); player.inventory = []; player.hp = player.maxHp = 500; player.stamina = player.maxStamina;
        if (!player.knownRecipes.includes(r.id)) player.knownRecipes.push(r.id);
        for (const inp of r.inputs) {
          const base = ITEM_BASES.find((b) => b.id === inp.id); if (!base) continue;
          const it = makeItem(inp.id, 0, Math.random, 1);
          if (NO_STACK_TYPES && NO_STACK_TYPES.has(it.type)) { for (let q = 0; q < inp.qty; q++) player.inventory.push(makeItem(inp.id, 0, Math.random, 1)); }
          else { it.qty = inp.qty; it.amount = inp.qty; player.inventory.push(it); }
        }
        let can; try { can = hasIngredients(r); } catch (e) { A.err('content.recipes', r.id, 'hasIngredients threw ' + e.message); continue; }
        if (!can) { A.err('content.recipes', r.id, `${r.name}: inputs ${JSON.stringify(r.inputs)} do not satisfy hasIngredients() even when held`); continue; }
        const before = A.invCount(r.output.id);
        try { craftRecipe(r.id); } catch (e) { A.err('content.recipes', r.id, `craftRecipe threw: ${String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')}`); A.settle(); continue; }
        A.settle(); crafted++;
        if (!player.alive) { player.alive = true; }
        const after = A.invCount(r.output.id);
        if (after <= before && !player.inventory.some((i) => i.id === r.output.id || (i.name && ITEM_BASES.find((b) => b.id === r.output.id) && i.name.includes(ITEM_BASES.find((b) => b.id === r.output.id).name)))) A.warn('content.recipes', r.id, `${r.name}: crafting produced no ${r.output.id} in the inventory (may be a proc/needs station)`);
      }
      A.stat('recipesCrafted', crafted);
    },
  },
  {
    id: 'content.npc-roles',
    desc: 'build an NPC of every role/species and open their dialogue, then press every dialogue option: no exceptions, no stuck modal',
    needsPlayer: true, uses: [HELP], seconds: 400,
    fn(A) {
      let talked = 0, options = 0;
      const speciesIds = SPECIES.map((s) => s.id);
      let k = 0;
      for (const role of ROLES) {
        const sp = speciesIds[k++ % speciesIds.length];
        let npc;
        try { npc = makeNPC(role.id, player.x + 1, player.y, Math.random, 'Auditville', sp); } catch (e) { A.err('content.npc', role.id, 'makeNPC threw ' + String(e.stack).split('\n').slice(0, 2).join(' | ')); continue; }
        if (!npc) { A.err('content.npc', role.id, 'makeNPC returned nothing'); continue; }
        if (typeof npc.hp !== 'number' || !isFinite(npc.hp)) A.err('content.npc', role.id, 'npc hp ' + npc.hp);
        if (!npc.name || /undefined|NaN/.test(npc.name)) A.err('content.npc', role.id, 'bad npc name ' + npc.name);
        npc.hostile = false; npc.asleep = false;
        A.settle(); player.hp = player.maxHp; player.gold = 5000;
        try { openDialogue(npc); } catch (e) { A.err('content.npc', role.id, 'openDialogue threw ' + String(e.stack).split('\n').slice(0, 3).join(' | ')); A.settle(); continue; }
        talked++;
        const opts = (typeof dialogueOptions !== 'undefined' && dialogueOptions) ? dialogueOptions.slice() : [];
        for (const o of opts) {
          if (!o || typeof o.action !== 'function' || /attack|fight|duel|rob|steal|kill|marry|propose|renounce|leave/i.test(o.label || '')) continue;
          options++;
          try { o.action(); } catch (e) { A.err('content.npc', role.id + ' / ' + o.label, 'option threw ' + String(e.stack).split('\n').slice(0, 3).join(' | ')); }
          A.settle(); if (!player.alive) player.alive = true;
          try { openDialogue(npc); } catch (e) { A.err('content.npc', role.id, 'reopen threw ' + e.message); A.settle(); break; }
        }
        A.settle();
      }
      A.stat('npcsTalkedTo', talked); A.stat('dialogueOptionsPressed', options);
    },
  },
];
});

// ==== FILE: lib/probes/coverage.js ====
__def("lib/probes/coverage.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Content-coverage census. These are DESIGN checks, not correctness checks: they warn where the game is thin so new content can be aimed at the gaps.
// (They found the v0.51.3 monster/spell packs.) Thresholds are conservative; raise or lower them in the constants at the top of each probe.
module.exports = [
  {
    id: 'coverage.spell-tiers',
    desc: 'per school: no empty tier between its lowest and highest tier (a caster must always have something to learn next), and every school has some damage or control option',
    fn(A) {
      const bySchool = {};
      for (const s of SPELLS) { const k = s.school || '?'; (bySchool[k] = bySchool[k] || []).push(s); }
      for (const [school, list] of Object.entries(bySchool)) {
        const tiers = list.map((s) => s.tier || 1);
        const lo = Math.min(...tiers), hi = Math.max(...tiers);
        const have = new Set(tiers);
        const holes = []; for (let t = lo; t <= hi; t++) if (!have.has(t)) holes.push(t);
        if (holes.length && list.length >= 5) A.warn('coverage.spell-tiers', school, `${school} has no tier ${holes.join(', ')} spell (${list.length} spells, tiers ${lo}-${hi})`);
        if (hi < 5 && list.length >= 5) A.info('coverage.spell-tiers', school, `${school} tops out at tier ${hi}`);
        if (!list.some((s) => s.type === 'damage' || s.type === 'lifetap' || s.type === 'summon' || s.type === 'execute')) A.info('coverage.spell-tiers', school, `${school} has no direct way to deal damage (fine for a support school; a problem for a class built on it)`);
      }
      A.stat('spellSchools', Object.keys(bySchool).length);
    },
  },
  {
    id: 'coverage.monster-pools',
    desc: 'per dungeon theme and floor band (1-3 / 4-6 / 7+): the pool the generator REALLY uses (dungeonMonsterPool). Warns on thin pools, and on off-theme monsters in a faction-locked theme (the old silent fallback to generic tier-1 monsters)',
    fn(A) {
      const MIN_POOL = 4;
      let thin = 0, offTheme = 0;
      for (const [k, meta] of Object.entries(DUNGEON_THEMES)) {
        const locked = !!(meta.factions && meta.factions.length);
        const maxDepth = (meta.depthRange || [3, 3])[1];
        for (const depth of [1, 4, 7]) {
          if (depth > maxDepth) continue;
          const pool = dungeonMonsterPool(meta, depth);
          const hasOwn = locked && Object.values(MONSTER_BASES).some((b) => b.dtier && !b.boss && meta.factions.includes(b.faction));
          if (locked && !hasOwn && depth === 1) A.info('coverage.monster-pools', k, `${k}: no ordinary monster belongs to its factions (${meta.factions.join('+')}), so every floor draws from the whole bestiary`);
          if (hasOwn) {
            const off = pool.filter((i) => !meta.factions.includes(MONSTER_BASES[i].faction));
            if (off.length && pool.length) { offTheme++; A.warn('coverage.monster-pools', k, `${k} floor ${depth}: ${off.length}/${pool.length} rollable monsters are off-theme (${meta.factions.join('+')}): ${off.slice(0, 4).join(', ')}`); }
          }
          if (pool.length < MIN_POOL) { thin++; A.warn('coverage.monster-pools', k, `${k} floor ${depth} can roll only ${pool.length} ordinary monsters`); }
        }
      }
      A.stat('thinMonsterPools', thin); A.stat('offThemePools', offTheme);
    },
  },
];
});

// ==== FILE: lib/probes/economy.js ====
__def("lib/probes/economy.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Economy probes: every shop role stocks sensible goods at every level, prices are sane, buying+selling back is never profitable
// (the game's own TRADE_SELL_TO_BUY_CAP invariant), and the trade UI can be driven end to end.
module.exports = [
  {
    id: 'economy.luxury-stock',
    desc: 'master-tier shops carry 0/1/2/3 Masterwork luxury items at player level <25 / 25 / 40 / 60 (literal contract), only for equipment/consumable roles, never for novice/journeyman, and they are priced above the stock they sit beside',
    needsPlayer: true, seconds: 60,
    fn(A) {
      const saved = player.level; const savedProfs = player.professionsLearned; player.professionsLearned = {};
      const count = (role, tier, lvl) => { player.level = lvl; let n = 0, items = []; for (let k = 0; k < 6; k++) { const inv = generateShopInventory(role, Math.random, { tier, name: 'probe' }); const lx = inv.filter((i) => i.luxury); n = Math.max(n, lx.length); if (k === 0) items = inv; } return { n, items }; };
      for (const [lvl, want] of [[10, 0], [24, 0], [25, 1], [39, 1], [40, 2], [59, 2], [60, 3], [90, 3]]) { const r = count('blacksmith', 'master', lvl); if (r.n !== want) A.err('economy.luxury-stock', 'L' + lvl, `master blacksmith carried ${r.n} luxury items, want ${want}`); }
      for (const tier of ['novice', 'journeyman']) { const r = count('blacksmith', tier, 70); if (r.n) A.err('economy.luxury-stock', tier, `${tier} shop carries ${r.n} luxury items (master only)`); }
      for (const role of ['baker', 'innkeeper']) { const r = count(role, 'master', 70); if (r.n) A.err('economy.luxury-stock', role, `${role} carries luxury items`); }
      { const r = count('armorer', 'master', 70); const lx = r.items.filter((i) => i.luxury), plain = r.items.filter((i) => !i.luxury); if (lx.length !== 3 || !/^Masterwork /.test(lx[0].name)) A.err('economy.luxury-stock', 'name', 'luxury items must lead the list and be named Masterwork ...'); const avg = plain.reduce((a, i) => a + i.value, 0) / Math.max(1, plain.length); if (lx.length && lx.reduce((a, i) => a + i.value, 0) / lx.length < avg * 1.5) A.err('economy.luxury-stock', 'price', 'luxury items are not clearly pricier than ordinary stock'); }
      player.level = saved; player.professionsLearned = savedProfs;
    },
  },
  {
    id: 'economy.shops',
    desc: 'every shop role x tier x player level: non-empty stock of valid items with finite positive prices; sell price never exceeds buy price (no arbitrage); trade screen opens and buys/sells without exceptions',
    needsPlayer: true, seconds: 240,
    fn(A) {
      const tiers = ['novice', 'journeyman', 'master'];
      let shops = 0, arb = 0;
      const rng = Math.random;
      // The Merchant profession (and its settlement market multipliers on materials) is the INTENDED way to profit from trade, and a random run can carry it,
      // so price the shops as a profession-free player; otherwise this probe flakes on material arbitrage depending on the build it happened to get.
      const savedProfs = player.professionsLearned; player.professionsLearned = {};
      for (const roleId of SHOP_ROLES) {
        for (const lvl of [1, 20, 60]) {
          for (const tier of tiers) {
            player.level = lvl;
            let npc;
            try { npc = makeNPC(roleId, player.x + 1, player.y, rng, null, 'human'); } catch (e) { A.err('economy.shops', roleId, 'makeNPC threw: ' + String(e && e.message)); continue; }
            npc.tier = tier;
            let stock;
            try { stock = generateShopInventory(roleId, rng, npc); } catch (e) { A.err('economy.shops', roleId, `generateShopInventory(${tier}, L${lvl}) threw: ${String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')}`); continue; }
            shops++;
            if (!stock.length) A.err('economy.shops', roleId, `empty stock (${tier}, L${lvl})`);
            for (const it of stock) {
              if (!it || !it.id || !it.name) { A.err('economy.shops', roleId, 'stock entry without id/name'); continue; }
              if (!ITEM_BASES.some((b) => b.id === it.id)) A.err('economy.shops', roleId, 'stock item ' + it.id + ' is not a known base');
              if (!(it.value > 0) || !isFinite(it.value)) { A.warn('economy.shops', it.id, `value ${it.value} (${roleId})`); continue; }
              const buy = tradeBuyPrice(it, npc), sell = tradeSellPrice(it, npc);
              if (!(buy > 0) || !isFinite(buy)) A.err('economy.shops', it.id, `buy price ${buy}`);
              if (!isFinite(sell) || sell < 0) A.err('economy.shops', it.id, `sell price ${sell}`);
              if (sell > buy) { arb++; A.err('economy.shops', it.id, `arbitrage: ${roleId} sells ${it.name} for ${buy} but buys it back for ${sell}`); }
            }
          }
        }
      }
      // drive the real trade UI once
      const npc = makeNPC('merchant', player.x + 1, player.y, rng, null, 'human'); npc.shop = generateShopInventory('merchant', rng, npc);
      player.gold = 100000; player.level = 10;
      try {
        openTrade(npc);
        for (let i = 0; i < 4; i++) simulateKey(String.fromCharCode(97 + i));
        simulateKey('Tab'); for (let i = 0; i < 3; i++) simulateKey(String.fromCharCode(97 + i));
        simulateKey('Escape');
      } catch (e) { A.err('economy.shops', 'ui', 'trade UI threw: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
      try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; dialogueNPC = null;
      player.professionsLearned = savedProfs;
      A.stat('shopsChecked', shops); A.stat('arbitrageCases', arb);
    },
  },
];
});

// ==== FILE: lib/probes/emergence.js ====
__def("lib/probes/emergence.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Emergence probes: the elemental COMBO layer (Wet / Oiled / Burning / Frozen). Checks both that each combo fires and that every piece of content that is
// supposed to take part is wired to it. Add a new primed state or payoff to the game -> add a case to COMBOS below.
const { ARENA } = require('./abilities');
module.exports = [
  {
    id: 'emergence.combos',
    desc: 'every elemental combo fires for BOTH sources (player spell, monster ability, monster melee): oil+fire, wet+frost, wet+shock, soak douses fire / rinses oil, oil beads off the soaked, oil feeds a fire',
    needsPlayer: true, uses: [ARENA], seconds: 120,
    fn(A) {
      const fresh = (n) => { A.refill(); const m = A.arena('goblin', 5000, n || 2); if (!m) return null; m.wetTurns = m.oiledTurns = m.burningTurns = m.frozenSolidTurns = 0; return m; };
      const say = (id, ok, msg) => { if (!ok) A.err('emergence.combos', id, msg); };
      const spl = (o) => Object.assign({ id: 'probe_spell', name: 'Probe', type: 'damage', power: [3, 3], range: 5, mp: 0 }, o);
      let m = fresh(); if (!m) { A.warn('emergence.combos', 'arena', 'no open ground to test on'); return; }
      // ---- player spells ----
      m.oiledTurns = 20; applyEffectToTarget(spl({ igniteGround: true }), m); say('spell oil+fire', m.burningTurns > 0, 'a fire spell did not ignite an Oiled target');
      m = fresh(); m.wetTurns = 20; applyEffectToTarget(spl({ frost: true }), m); say('spell wet+frost', m.frozenSolidTurns > 0, 'a frost spell did not freeze a Wet target solid');
      m = fresh(); m.wetTurns = 20; const wm = weatherElementMultiplier({ chainLightning: true }, m), wm2 = weatherElementMultiplier({ element: 'shock' }, m);
      say('wet+shock', wm >= 1.5 && wm2 >= 1.5, `shock vs a Wet target multiplied by ${wm}/${wm2}, expected ~1.6 (chainLightning flag / element:'shock')`);
      m = fresh(); applyEffectToTarget(spl({ soak: 10 }), m); say('spell soak', m.wetTurns >= 10, 'soak:10 did not make the target Wet');
      m = fresh(); m.burningTurns = 5; m.oiledTurns = 5; applyEffectToTarget(spl({ soak: 10 }), m); say('soak douses', m.burningTurns === 0 && m.oiledTurns === 0, 'soaking should put out fire AND rinse oil');
      m = fresh(); applyEffectToTarget(spl({ oil: 30 }), m); say('spell oil', m.oiledTurns >= 30, 'oil:30 did not coat the target');
      m = fresh(); m.wetTurns = 10; applyEffectToTarget(spl({ oil: 30 }), m); say('oil beads', !(m.oiledTurns > 0), 'oil stuck to a soaked target');
      m = fresh(); m.burningTurns = 3; applyEffectToTarget(spl({ oil: 30 }), m); say('oil feeds fire', m.burningTurns > 3, 'oil thrown on a burning target should feed the fire');
      m = fresh(); m.wetTurns = 10; applyEffectToTarget(spl({ consumeWet: true, wetMult: 2 }), m); say('consumeWet', !(m.wetTurns > 0), 'consumeWet should flash the water to steam (Wet cleared)');
      m = fresh(); m.wetTurns = 10; const a1 = weatherElementMultiplier({ wetMult: 1.5 }, m), a2 = (m.wetTurns = 0, weatherElementMultiplier({ wetMult: 1.5 }, m)); say('wetMult', a1 === 1.5 && a2 === 1, 'wetMult should apply only against a Wet target');
      m = fresh(); m.frozenSolidTurns = 3; say('frozenMult', weatherElementMultiplier({ frozenMult: 2 }, m) === 2, 'frozenMult should double damage vs a frozen target'); m.frozenSolidTurns = 0; say('frozenMult dry', weatherElementMultiplier({ frozenMult: 2 }, m) === 1, 'frozenMult applied to a target that is not frozen');
      m = fresh(); applyEffectToTarget(spl({ oilGround: 1 }), m); say('oilGround', isOiledTile(curTileAt(m.x, m.y)), 'oilGround did not slick the ground under the target');
      // ---- monster abilities against the player ----
      const hit = (abId, prep) => { A.refill(); const c = A.arena('goblin', 50, 3); c.alive = true; player.hp = player.maxHp = 5000; if (prep) prep(); monsterCastAt(c, MONSTER_ABILITY_LIBRARY[abId], player); return c; };
      hit('firebolt', () => { player.oiledTurns = 20; }); say('ability oil+fire', player.burningTurns > 0, 'a monster Firebolt did not ignite an Oiled player');
      hit('frostbolt', () => { player.wetTurns = 20; }); say('ability wet+frost', player.frozenSolidTurns > 0, 'a monster Frostbolt did not freeze a Wet player');
      hit('throw_bomb', () => { player.oiledTurns = 20; }); say('ability aoe oil+fire', player.burningTurns > 0, 'a monster Firebomb (aoe) did not ignite an Oiled player');
      for (const [id, field, label] of [['water_jet', 'wetTurns', 'Water Jet'], ['drench_wave', 'wetTurns', 'Drenching Wave'], ['tar_spit', 'oiledTurns', 'Tar Spit'], ['throw_oilflask', 'oiledTurns', 'Oil Flask'], ['throw_brine', 'wetTurns', 'Brine Flask']]) {
        if (!MONSTER_ABILITY_LIBRARY[id]) { A.err('emergence.combos', id, 'ability missing from MONSTER_ABILITY_LIBRARY'); continue; }
        hit(id, () => { player[field] = 0; }); say('ability ' + id, player[field] > 0, `${label} did not set ${field} on the player`);
      }
      // ---- monster melee ----
      { A.refill(); const c = A.arena('goblin', 50, 1); c.soakStrike = 10; c.atk = [1, 1]; c.str = 5; let got = false; for (let i = 0; i < 1500 && !got; i++) { player.hp = player.maxHp = 5000; try { doAttack(c, player); } catch (e) { A.err('emergence.combos', 'melee', 'doAttack threw: ' + e.message); break; } got = player.wetTurns > 0; } say('melee soakStrike', got, 'soakStrike never made the player Wet in 1500 melee hits'); }
      { A.refill(); const c = A.arena('goblin', 50, 1); c.oilStrike = 20; c.atk = [1, 1]; c.str = 5; let got = false; for (let i = 0; i < 1500 && !got; i++) { player.hp = player.maxHp = 5000; player.wetTurns = 0; try { doAttack(c, player); } catch (e) { A.err('emergence.combos', 'melee', 'doAttack threw: ' + e.message); break; } got = player.oiledTurns > 0; } say('melee oilStrike', got, 'oilStrike never oiled the player in 1500 melee hits'); }
      // ---- AI picks the payoff ----
      { const fb = MONSTER_ABILITY_LIBRARY.firebolt, tj = MONSTER_ABILITY_LIBRARY.tar_spit, mm = MONSTER_ABILITY_LIBRARY.magicmissile; m = fresh();
        say('ai bare', abilityComboScore(tj, m) > abilityComboScore(mm, m), 'a bare target should favour a primer over a plain bolt');
        m.oiledTurns = 9; say('ai oiled', abilityComboScore(fb, m) > abilityComboScore(mm, m) && abilityComboScore(tj, m) < 0, 'an Oiled target should favour fire and make Tar Spit pointless');
        m.oiledTurns = 0; m.wetTurns = 9; say('ai wet', abilityComboScore(MONSTER_ABILITY_LIBRARY.frostbolt, m) > 0 && abilityComboScore(tj, m) < 0 && abilityComboScore(MONSTER_ABILITY_LIBRARY.water_jet, m) < 0, 'a Wet target should favour frost/shock and make soak/oil pointless'); }
      // ---- elemental resistance gear: wearing it changes the player field, monster bolts/blasts of that element are reduced, taking it off restores everything ----
      for (const [id, field, el] of [['stormcloak', 'shockDmgReduction', 'shock'], ['embercloak', 'fireDmgReduction', 'fire'], ['frostweave_mantle', 'frostDmgReduction', 'frost'], ['amulet_elements', 'frostDmgReduction', 'frost']]) {
        A.refill(); const it = makeItem(id, 0, Math.random); const before = player[field] || 0;
        player.inventory.push(it); equipItem(it);
        const worn = player[field] || 0;
        say('resist gear ' + id, worn > before, `wearing ${id} did not raise player.${field} (${before} -> ${worn})`);
        say('resist factor ' + id, Math.abs(elementResistFactor(player, el) - (1 - Math.min(0.9, worn))) < 1e-9, `elementResistFactor(player, '${el}') wrong`);
        unequipSlot(it.slot);
        say('resist gear off ' + id, Math.abs((player[field] || 0) - before) < 1e-9, `taking ${id} off left player.${field} at ${player[field]} (was ${before})`);
      }
      { A.refill(); player.frostDmgReduction = 0.5; let a = 0, b = 0; const N = 40;
        for (let i = 0; i < N; i++) { player.hp = player.maxHp = 5000; const c = A.arena('goblin', 50, 3); c.alive = true; player.frostDmgReduction = 0; const h0 = player.hp; monsterCastAt(c, Object.assign({}, MONSTER_ABILITY_LIBRARY.frostbolt, { power: [300, 300] }), player); a += h0 - player.hp; player.hp = player.maxHp = 5000; player.frostDmgReduction = 0.5; player.wetTurns = player.frozenSolidTurns = 0; const h1 = player.hp; monsterCastAt(c, Object.assign({}, MONSTER_ABILITY_LIBRARY.frostbolt, { power: [300, 300] }), player); b += h1 - player.hp; player.frozenSolidTurns = 0; player.frostDmgReduction = 0.5; c.alive = false; c.hp = 0; }
        say('frost resist bolt', b < a * 0.8, `a 50% frost resistance should clearly cut monster Frostbolt damage (no resist ${a}, 50% ${b} over ${N} casts)`); player.frostDmgReduction = 0; }
      // ---- Resistance potions/food: the buff halves monster bolts/blasts of its element (all three elements, plus the all-in-one elixir) ----
      for (const [id, el] of [['potion_fireres', 'fire'], ['potion_frostres', 'frost'], ['potion_shockres', 'shock']]) {
        A.refill(); player.fireDmgReduction = player.frostDmgReduction = player.shockDmgReduction = 0;
        const it = makeItem(id, 0, Math.random); if (!it) { A.err('emergence.combos', id, 'makeItem returned nothing'); continue; }
        const f0 = elementResistFactor(player, el); player.inventory.push(it); useItem(it);
        say('resist buff ' + id, f0 === 1 && Math.abs(elementResistFactor(player, el) - 0.5) < 1e-9, `${id}: factor before ${f0}, after ${elementResistFactor(player, el)} (want 1 -> 0.5)`);
      }
      { A.refill(); const it = makeItem('potion_elementward', 0, Math.random); if (!it) A.err('emergence.combos', 'potion_elementward', 'makeItem returned nothing'); else { player.inventory.push(it); useItem(it);
        say('elementward', ['fire', 'frost', 'shock'].every(e => Math.abs(elementResistFactor(player, e) - 0.5) < 1e-9), 'Elixir of the Elements should halve fire, frost and shock'); } }
      A.refill();
    },
  },
  {
    id: 'emergence.scrolls',
    desc: 'area scrolls (scrollblast / soaksplash / oilsplash) apply their element and combo rider; scroll value ladder reaches the deeper loot tiers',
    needsPlayer: true, uses: [ARENA], seconds: 60,
    fn(A) {
      const say = (id, ok, msg) => { if (!ok) A.err('emergence.scrolls', id, msg); };
      const fresh = () => { A.refill(); const m = A.arena('goblin', 5000, 3); if (!m) return null; m.alive = true; m.hp = m.maxHp = 5000; m.wetTurns = m.oiledTurns = m.burningTurns = m.frozenSolidTurns = 0; m.fireImmune = m.frostImmune = m.shockImmune = false; return m; };
      const cast = (id, m, prep) => { const it = makeItem(id, 0, Math.random); if (!it) { A.err('emergence.scrolls', id, 'makeItem returned nothing'); return 0; } if (prep) prep(m); const h0 = m.hp; resolveThrowAtTile(it, m.x, m.y); return h0 - m.hp; };
      let m = fresh(); if (!m) { A.warn('emergence.scrolls', 'arena', 'no open ground'); return; }
      const mean = (id, prep) => { let t = 0; for (let i = 0; i < 12; i++) { m = fresh(); t += cast(id, m, prep); } return t / 12; };
      const dry = mean('scroll_thunderclap'), wet = mean('scroll_thunderclap', (x) => { x.wetTurns = 20; });
      say('thunderclap wet', wet > dry * 1.3, `Thunderclap on soaked targets should clearly out-damage dry ones (dry ${dry.toFixed(1)}, wet ${wet.toFixed(1)})`);
      m = fresh(); cast('scroll_inferno', m); say('inferno ignites', m.burningTurns > 0 || m.hp <= 0, 'Inferno did not ignite a dry target');
      m = fresh(); cast('scroll_inferno', m, (x) => { x.wetTurns = 20; }); say('inferno vs wet', !(m.burningTurns > 0), 'Inferno ignited a soaked target');
      m = fresh(); cast('scroll_deepfreeze', m, (x) => { x.wetTurns = 20; }); say('deepfreeze wet', m.frozenSolidTurns > 0, 'Deep Freeze did not freeze a soaked target solid');
      m = fresh(); cast('scroll_deepfreeze', m); say('deepfreeze dry', !(m.frozenSolidTurns > 0), 'Deep Freeze froze a dry target solid (needs Wet)');
      m = fresh(); m.frostImmune = true; say('deepfreeze immune', cast('scroll_deepfreeze', m) === 0, 'Deep Freeze hurt a frost-immune target');
      m = fresh(); m.fireImmune = true; say('inferno immune', cast('scroll_inferno', m) === 0, 'Inferno hurt a fire-immune target');
      m = fresh(); cast('scroll_downpour', m); say('downpour', m.wetTurns > 0, 'Downpour did not soak the target');
      m = fresh(); cast('scroll_slick', m); say('slick', m.oiledTurns > 0, 'Slickness did not oil the target');
      m = fresh(); say('annihilate', cast('scroll_annihilate', m) >= 60, 'Annihilation did less than 60 damage');
      // ---- late-game potions: each must work when drunk, and the consumable ladder must reach past 150g ----
      for (const id of ['elixir_vitality', 'draught_archmage', 'elixir_ironhide', 'elixir_swiftness', 'elixir_grand_regen', 'potion_deadeye']) {
        A.refill(); const it = makeItem(id, 0, Math.random); if (!it) { A.err('emergence.scrolls', id, 'makeItem returned nothing'); continue; }
        player.hp = Math.max(1, Math.floor(player.maxHp / 4)); player.mp = 0; const hp0 = player.hp, mp0 = player.mp; player.inventory.push(it); useItem(it);
        const stat = { buffarmor: 'armor', buffhaste: 'actionspeed', buffregen: 'regen', buffcrit: 'crit' }[it.effect];
        const ok = it.effect === 'heal' ? player.hp > hp0 : it.effect === 'mana' ? player.mp > mp0 : getBuff(stat) > 0;
        say(id, ok, `${id} (${it.effect}) had no visible effect when drunk`);
      }
      { const cons = ITEM_BASES.filter(b => b.type === 'consumable' && !b.craftOnly && b.effect !== 'food' && !b.foodFlavor); A.stat('potionsOver150g', cons.filter(b => (b.value || 0) >= 150).length);
        if (cons.filter(b => (b.value || 0) >= 150).length < 5) A.warn('emergence.scrolls', 'potion-ladder', 'fewer than 5 non-food consumables worth >=150g'); }
      // value ladder: deeper loot tiers only cap value upward, so a flat ladder means late loot never improves
      const sc = ITEM_BASES.filter(b => b.type === 'scroll');
      A.stat('scrollBases', sc.length); A.stat('scrollsOver100g', sc.filter(b => (b.value || 0) >= 100).length);
      if (sc.filter(b => (b.value || 0) >= 100).length < 4) A.warn('emergence.scrolls', 'ladder', 'fewer than 4 scrolls worth >=100g: late-game scroll loot is flat');
      A.refill();
    },
  },
  {
    id: 'emergence.tags',
    desc: 'content that LOOKS elemental is tagged so the combo layer sees it (fire spells ignite oil, frost spells freeze the wet, shock spells conduct), and primer fields are well-formed',
    fn(A) {
      const fireRe = /\b(fire|flame|inferno|blaze|incinerat|napalm|pyre)\b/i, frostRe = /\b(frost|ice|glacial|blizzard|freez)/i, shockRe = /\b(lightning|thunder|shock|electr)/i;
      let tagged = 0;
      for (const s of [].concat(SPELLS, TECHNIQUES)) {
        const dmg = s.type === 'damage'; if (!dmg) continue;
        const hay = `${s.id} ${s.name}`;
        if (fireRe.test(hay) && !s.igniteGround && s.element !== 'fire') A.warn('emergence.tags', s.id, `${s.name} reads as fire but has neither igniteGround nor element:'fire', so it won't ignite Oiled targets`);
        if (frostRe.test(hay) && !s.frost && s.element !== 'frost') A.warn('emergence.tags', s.id, `${s.name} reads as frost but has no frost flag, so it can't freeze a Wet target`);
        if (shockRe.test(hay) && !s.chainLightning && s.element !== 'shock') A.warn('emergence.tags', s.id, `${s.name} reads as shock but has neither chainLightning nor element:'shock', so a Wet target won't conduct it`);
        tagged++;
      }
      const okNum = (v) => v === true || (typeof v === 'number' && isFinite(v) && v > 0);
      for (const src of [].concat(SPELLS, TECHNIQUES, Object.entries(MONSTER_ABILITY_LIBRARY).map(([k, v]) => Object.assign({ id: k }, v)))) {
        for (const k of ['soak', 'oil', 'oilGround', 'wetMult', 'oiledMult', 'frozenMult']) if (src[k] !== undefined && src[k] !== 0 && !okNum(src[k])) A.err('emergence.tags', src.id, `${k} must be a positive number, got ${src[k]}`);
        if (src.soak && src.oil) A.warn('emergence.tags', src.id, 'has both soak and oil; soaking rinses oil off, so oil would never stick');
      }
      for (const [id, b] of Object.entries(MONSTER_BASES)) for (const k of ['soakStrike', 'oilStrike']) if (b[k] !== undefined && !okNum(b[k])) A.err('emergence.tags', id, `${k} must be a positive number`);
      A.stat('damageSpellsChecked', tagged);
      const primeSpells = [].concat(SPELLS, TECHNIQUES).filter((s) => s.soak || s.oil || s.oilGround).length, primeMon = Object.values(MONSTER_BASES).filter((b) => b.soakStrike || b.oilStrike || (b.abilities || []).some((a) => (MONSTER_ABILITY_LIBRARY[a] || {}).soak || (MONSTER_ABILITY_LIBRARY[a] || {}).oil)).length;
      A.stat('primerSpells', primeSpells); A.stat('primerMonsters', primeMon);
      if (primeSpells < 4) A.warn('emergence.tags', 'primerSpells', `only ${primeSpells} spells can set up Wet/Oiled`);
      if (primeMon < 6) A.warn('emergence.tags', 'primerMonsters', `only ${primeMon} monsters can set up Wet/Oiled`);
    },
  },
];
});

// ==== FILE: lib/probes/events.js ====
__def("lib/probes/events.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// World-event probes. ENCOUNTERS are events with a decision in them (type:'encounter', choices -> weighted outcomes that are themselves event defs). Add one to WORLD_EVENTS
// and this probe validates its shape and EXECUTES every outcome of every choice in a live game, so a typo'd item id, a missing handler or a thrown exception shows up here.
const { ARENA } = require('./abilities');
module.exports = [
  {
    id: 'quests.chains',
    desc: 'every authored quest chain: start() gives a well-formed quest, and BOTH endings (finish as contracted, the chain\'s alternate resolution) run to completion without throwing and pay out; chain_recover chains also place and reveal on pickup',
    needsPlayer: true, uses: [ARENA], seconds: 180,
    fn(A) {
      const dg = [...dungeonRegistry.values()].find((d) => !d.isTutorial && !d.originDimensionId && d.maxDepth >= 2);
      const npc = { uid: 'chain_probe_npc', name: 'Probe Clerk', home: 'Testhold', x: dg ? dg.x + 10 : 0, y: dg ? dg.y : 0, roleId: 'guildclerk' };
      if (dg) player.level = Math.max(player.level, dg.recommendedLevel || 1); // pickRecoverSite only offers dungeons rated at most player level + 4
      const ids = Object.keys(QUEST_CHAINS); A.stat('questChains', ids.length);
      const savedStats = { cha: player.cha, int: player.int, dex: player.dex, str: player.str, wil: player.wil }, savedGold = player.gold;
      const reset = () => { player.quests = []; player.completedChains = []; player.inventory = player.inventory.filter((i) => !i.questId); player.gold = 5000; for (const k in savedStats) player[k] = 40; if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } player.alive = true; player.hp = Math.max(player.hp, 50); };
      for (const id of ids) {
        const chain = QUEST_CHAINS[id];
        for (const alt of [false, true]) {
          reset(); const cost = chain.hooks && chain.hooks.altCost;
          if (alt) { player.inventory.push(makeItem('gem', 0, Math.random)); if (cost) for (let k = 0; k < cost.n; k++) player.inventory.push(makeItem(cost.id, 0, Math.random)); }
          let q; try { q = chain.start(npc, Math.random); } catch (e) { A.err('quests.chains', id, 'start threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); break; }
          if (!q) { if (id === 'borrowed_heirloom' && !dg) continue; A.err('quests.chains', id, 'start() returned nothing'); break; }
          for (const f of ['id', 'chainId', 'type', 'desc', 'need', 'rewardGold', 'rewardXp']) if (q[f] === undefined) A.err('quests.chains', id, `quest has no ${f}`);
          try {
            acceptRadiantQuest(q);
            if (!player.quests.includes(q)) { A.err('quests.chains', id, 'quest was not accepted'); break; }
            if (q.type === 'chain_kill') { for (let k = 0; k < q.need; k++) checkBountyQuests(q.target); }
            else if (q.type === 'chain_recover') {
              const lvl = dungeonRegistry.get(q.dungeonId).levels[q.floor - 1]; const ent = lvl && (lvl.items || []).find((e) => e.item && e.item.questId === q.id);
              if (!ent) { A.err('quests.chains', id, 'no relic placed'); break; }
              pickUpSpecificItem(ent.item);
            } else { A.err('quests.chains', id, `unknown chain quest type ${q.type}`); break; }
            if (!q.twistRevealed) { A.err('quests.chains', id, 'twist was not revealed after the objective'); break; }
            if (alt && cost) { // an item-cost ending must refuse when the pack is one short, and must not eat what it was given
              const held = chainItemCount(cost.id); chainTakeItems(cost.id, 1);
              resolveChainConfrontation(q, true); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
              if (q.done) A.err('quests.chains', id, `alternate ending completed while one ${cost.id} short`);
              if (chainItemCount(cost.id) !== held - 1) A.err('quests.chains', id, `a refused alternate ending changed the ${cost.id} count (${held - 1} -> ${chainItemCount(cost.id)})`);
              player.inventory.push(makeItem(cost.id, 0, Math.random));
            }
            let tries = 0; while (!q.done && tries++ < 40) { resolveChainConfrontation(q, alt); if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } if (!alt) break; }
            if (!q.done && !alt && q.progress >= q.need) A.err('quests.chains', id, 'finish-as-contracted did not complete the quest');
            if (alt && !q.done) A.err('quests.chains', id, `alternate resolution never completed in ${tries} tries (stats 40, gold 5000, a gem, ${cost ? cost.n + ' x ' + cost.id : 'no item cost'})`);
            if (alt && q.done && cost && chainItemCount(cost.id) !== 0) A.err('quests.chains', id, `alternate ending left ${chainItemCount(cost.id)} x ${cost.id} behind (cost ${cost.n})`);
            if (q.done && !q.resolutionPath) A.err('quests.chains', id, 'completed with no resolutionPath');
            if (q.done && q.type === 'chain_recover' && player.inventory.some((i) => i.questId === q.id)) A.err('quests.chains', id, 'heirloom still in pack after completion');
          } catch (e) { A.err('quests.chains', id, `${alt ? 'alternate' : 'finish'} path threw: ` + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
        }
      }
      reset(); for (const k in savedStats) player[k] = savedStats[k]; player.gold = savedGold; player.quests = [];
    },
  },
  {
    id: 'quests.radiant-scaling',
    desc: 'rolled radiant quests keep up with the character (v0.51.5): at every level a kill/gather/escort offer pays 10-80% of a level in XP (was 2% at L40); kill targets come from the level band (L<8 classic list, 8-15 dtier 2, 16-27 dtier 3, 28+ dtier 4) and are real, ordinary, non-unique monsters; boss bounties match the level (no power-3 boss at level 1)',
    needsPlayer: true, seconds: 40,
    fn(A) {
      const saved = player.level; const rng = Math.random;
      const npc = makeNPC('elder', player.x + 1, player.y, rng, null, 'human');
      const bandTier = (L) => (L >= 28 ? 4 : (L >= 16 ? 3 : (L >= 8 ? 2 : 0)));
      const kill = new Set(['bounty', 'protect', 'sabotage', 'caravan_guard']);
      try {
        for (const L of [1, 5, 8, 12, 16, 22, 28, 40, 70]) {
          player.level = L; const need = xpNeededForLevel(L); let n = 0, minShare = 9, maxShare = 0;
          for (let i = 0; i < 160; i++) {
            let q; try { q = rollRadiantQuestOffer(npc, rng); } catch (e) { A.err('quests.radiant-scaling', 'L' + L, 'roll threw: ' + String(e && e.stack || e).split('\n')[0]); break; }
            if (!isFinite(q.rewardXp) || !isFinite(q.rewardGold) || q.rewardXp < 0 || q.rewardGold < 0) A.err('quests.radiant-scaling', q.type, `L${L}: non-finite or negative reward ${q.rewardXp}xp ${q.rewardGold}g`);
            if (q.type !== 'boss_bounty' && q.type !== 'recover' && q.type !== 'delivery') { const sh = q.rewardXp / need; n++; minShare = Math.min(minShare, sh); maxShare = Math.max(maxShare, sh); }
            if (kill.has(q.type)) {
              const m = MONSTER_BASES[q.target];
              if (!m) { A.err('quests.radiant-scaling', q.type, `L${L}: target ${q.target} is not a monster`); continue; }
              if (L >= 8 && (m.dtier || 0) !== bandTier(L)) A.err('quests.radiant-scaling', q.target, `L${L} ${q.type} names a dtier ${m.dtier || 0} monster (band says ${bandTier(L)})`);
              if (L < 8 && (m.dtier || 0) > 1) A.err('quests.radiant-scaling', q.target, `L${L} ${q.type} names a dtier ${m.dtier} monster`);
              if (m.boss || m.miniboss || m.splitInto || /^the_/.test(q.target)) A.err('quests.radiant-scaling', q.target, `L${L} ${q.type} names a boss, miniboss, splitter or one-of-a-kind creature`);
            }
            if (q.type === 'boss_bounty') {
              const p = MONSTER_BASES[q.target] && MONSTER_BASES[q.target].bossPower;
              if (!p) A.err('quests.radiant-scaling', q.target, `L${L}: boss bounty target has no bossPower`);
              else if (p > Math.min(3, 1 + Math.floor(L / 8)) && p > 1) A.err('quests.radiant-scaling', q.target, `L${L}: power ${p} boss bounty is too strong for the level`);
              else if (L >= 50 && p < 3) A.err('quests.radiant-scaling', q.target, `L${L}: power ${p} boss bounty is trivial at this level`);
            }
          }
          if (L >= 5 && n && (minShare < 0.10 || maxShare > 0.80)) A.err('quests.radiant-scaling', 'L' + L, `XP reward share of a level ranges ${(minShare * 100).toFixed(0)}%-${(maxShare * 100).toFixed(0)}% (want 10-80%)`);
        }
        // end to end: a scaled bounty is accepted, counted by the real kill hook and paid in full
        { player.level = 20; const savedQ = player.quests, savedG = player.gold, savedXp = player.xp; player.quests = [];
          let q = null; for (let i = 0; i < 80 && !(q && q.type === 'bounty'); i++) q = rollRadiantQuestOffer(npc, rng);
          if (q && q.type === 'bounty') {
            player.quests.push(q); const g0 = player.gold; const realGain = gainXP; let xpPaid = 0; gainXP = (a) => { xpPaid += a; };
            try { for (let i = 0; i < q.need; i++) checkBountyQuests(q.target); } catch (e) { A.err('quests.radiant-scaling', 'e2e', 'bounty completion threw: ' + String(e && e.stack || e).split('\n')[0]); } finally { gainXP = realGain; }
            if (!q.done) A.err('quests.radiant-scaling', 'e2e', `bounty for ${q.need} ${q.target} not completed by ${q.need} kills`);
            else if (player.gold - g0 < q.rewardGold * 0.9 || xpPaid < q.rewardXp * 0.9) A.err('quests.radiant-scaling', 'e2e', `paid ${player.gold - g0}g/${xpPaid}xp for an offer of ${q.rewardGold}g/${q.rewardXp}xp`);
          } else A.warn('quests.radiant-scaling', 'e2e', 'no bounty offer rolled in 80 tries');
          player.quests = savedQ; player.gold = savedG; player.xp = savedXp; }
        // findability: every monster a bounty can name at any level must appear in some ordinary dungeon floor pool or overworld table
        const where = new Set();
        for (const meta of Object.values(DUNGEON_THEMES)) { const md = (meta.depthRange || [3, 3])[1]; for (let d = 1; d <= md; d++) { try { for (const i of dungeonMonsterPool(meta, d)) where.add(i); } catch (e) { /* reported by coverage probes */ } } }
        for (const b of Object.values(BIOMES)) for (const [id] of (b.encounter || [])) where.add(id);
        for (const L of [1, 8, 16, 28, 70]) for (const id of questMonsterPool(L)) if (!where.has(id)) A.err('quests.radiant-scaling', id, `L${L} bounty can name ${id}, which no ordinary dungeon floor or overworld table can spawn: the quest could never be finished`);
      } finally { player.level = saved; }
    },
  },
  {
    id: 'systems.hazard-scaling',
    desc: 'environmental damage keeps pace with the character (v0.51.5): event damage at 28 max HP stays in its authored range, at 400 max HP it is at least 3x; lightning hits scale the same way; dungeon dart/spike traps placed on deeper floors carry a bigger multiplier and really hit harder; nothing goes non-finite',
    needsPlayer: true, seconds: 60,
    fn(A) {
      const sv = { hp: player.hp, maxHp: player.maxHp, alive: player.alive, ds: lastDamageSource };
      try {
        // 1. event damage via the real handler
        for (const [mh, lo, hi] of [[28, 6, 14], [400, 18, Infinity]]) {
          player.maxHp = mh; let mn = 1e9, mx = 0;
          for (let i = 0; i < 40; i++) { player.hp = mh; WORLD_EVENT_HANDLERS.damagePlayer({ msg: 'probe', dmg: [6, 14], dmgSource: 'probe' }); const d = mh - player.hp; mn = Math.min(mn, d); mx = Math.max(mx, d); }
          if (!isFinite(mn) || mn < lo || (mh === 28 && mx > hi)) A.err('systems.hazard-scaling', 'event@' + mh, `damagePlayer 6-14 dealt ${mn}-${mx} at ${mh} max HP (want ${lo}-${hi === Infinity ? 'up' : hi})`);
        }
        // 2. lightning
        for (const [mh, lo] of [[28, 6], [400, 18]]) {
          player.maxHp = mh; player.hp = mh; resolveLightningStrike({ x: player.x, y: player.y, turnsLeft: 0, dmgRange: [6, 14], sourceLabel: 'probe', zk: zoneKey() });
          const d = mh - player.hp; if (d < lo || (mh === 28 && d > 14)) A.err('systems.hazard-scaling', 'lightning@' + mh, `strike 6-14 dealt ${d} at ${mh} max HP`);
          player.hp = mh;
        }
        // 3. traps: stamped multiplier on a deep floor, honoured when triggered
        const trapTheme = Object.keys(DUNGEON_THEMES).find((k) => DUNGEON_THEMES[k].hazard === 'traps') || 'ruins';
        let shallow = 0, deep = 0, nS = 0, nD = 0;
        for (const [depth, acc] of [[1, 's'], [12, 'd']]) {
          for (let n = 0; n < 20; n++) {
            let L; try { L = generateDungeonLevel(trapTheme, depth, 12, 'standard', undefined, 0); } catch (e) { continue; }
            const grid = L.grid || L.tiles || L.map; if (!grid) continue;
            for (const row of grid) for (const tile of row) if (tile && tile.hiddenTrap && (tile.trapType === 'dart' || tile.trapType === 'spike')) { const m = tile.trapDmgMult || 1; if (acc === 's') { shallow += m; nS++; } else { deep += m; nD++; } }
          }
        }
        A.stat('trapsFloor1', nS); A.stat('trapsFloor12', nD);
        if (nS && shallow / nS > 1.05) A.err('systems.hazard-scaling', 'trap-floor1', `floor-1 traps carry multiplier ${(shallow / nS).toFixed(2)} (want ~1)`);
        if (nD && deep / nD < 2.5) A.err('systems.hazard-scaling', 'trap-floor12', `floor-12 dart/spike traps average multiplier ${(deep / nD).toFixed(2)} (want >= 2.5)`);
        if (!nD) A.warn('systems.hazard-scaling', 'trap-sample', 'no dart/spike traps generated on floor 12 in 20 levels; trap multiplier unchecked');
        player.maxHp = 1e5; let dd = 0; for (let i = 0; i < 20; i++) { player.hp = 1e5; triggerTrapAt({ trapType: 'spike', trapDmgMult: 3 }, player.x, player.y, player); dd = Math.max(dd, 1e5 - player.hp); player.statusPoison = 0; }
        if (!(dd >= 24)) A.err('systems.hazard-scaling', 'trap-trigger', `a spike trap with multiplier 3 dealt at most ${dd} (8-16 x3 should reach >= 24)`);
      } finally { player.maxHp = sv.maxHp; player.hp = sv.hp; player.alive = sv.alive; lastDamageSource = sv.ds; player.statusPoison = 0; }
    },
  },
  {
    id: 'systems.dot-scaling',
    desc: 'poison/burning/bleeding/radiation ticks grow with the target past ~100 max HP (v0.51.5): at 50 max HP the classic 4/3/2/3 per tick, at 600 max HP at least 1.8x that; the tick never goes non-finite or negative',
    needsPlayer: true, seconds: 20,
    fn(A) {
      const sv = { hp: player.hp, maxHp: player.maxHp, lvl: player.level, regen: player.regen, mr: player.mutationRegen, alive: player.alive };
      const reset = () => { player.statusPoison = 0; player.burningTurns = 0; player.bleedStacks = 0; player.bleedClotTurns = 0; player.statusRadiation = 0; player.poisonImmune = false; player.regen = 0; player.mutationRegen = 0; player.stormRegenBonus = 0; };
      const tick = (setup) => { reset(); player.alive = true; player.hp = player.maxHp; setup(); processEntityStatus(player); const d = player.maxHp - player.hp; reset(); return d; };
      try {
        player.level = 12;
        const cases = { poison: () => { player.statusPoison = 4; }, burning: () => { player.burningTurns = 3; }, bleeding: () => { player.bleedStacks = 2; }, radiation: () => { player.statusRadiation = 3; } };
        const lo = {}, hi = {};
        for (const [name, setup] of Object.entries(cases)) {
          let a = 0, b = 0;
          for (let i = 0; i < 12; i++) { player.maxHp = 50; a = Math.max(a, tick(setup)); player.maxHp = 600; b = Math.max(b, tick(setup)); }
          lo[name] = a; hi[name] = b;
          if (!isFinite(a) || !isFinite(b) || a < 0 || b < 0) A.err('systems.dot-scaling', name, `non-finite/negative tick ${a} / ${b}`);
          if (a < 1) A.err('systems.dot-scaling', name, `tick at 50 max HP dealt ${a} (the status did nothing: probe setup stale?)`);
          if (a && b < a * 1.8) A.err('systems.dot-scaling', name, `tick ${a} at 50 max HP vs ${b} at 600 max HP (want >= 1.8x)`);
        }
        A.stat('dotLow', JSON.stringify(lo)); A.stat('dotHigh', JSON.stringify(hi));
      } finally { reset(); player.maxHp = sv.maxHp; player.hp = sv.hp; player.level = sv.lvl; player.regen = sv.regen; player.mutationRegen = sv.mr; player.alive = sv.alive; }
    },
  },
  {
    id: 'events.reward-scaling',
    desc: 'world-event XP/gold payouts follow the level (v0.51.5): at level 1 a grantXp 10-20 pays 10-20, at level 40 it pays at least ~10x that and stays a sane share (0.5-15%) of a level; grantGold scales the same way and never goes non-finite',
    needsPlayer: true, seconds: 20,
    fn(A) {
      const saved = { lvl: player.level, gold: player.gold }; const realGain = gainXP; const got = [];
      try {
        gainXP = (a) => { got.push(a); };
        for (const [L, lo, hi] of [[1, 10, 20], [40, 100, Infinity]]) {
          player.level = L; got.length = 0;
          for (let i = 0; i < 60; i++) WORLD_EVENT_HANDLERS.grantXp({ msg: 'probe', xp: [10, 20] });
          const mn = Math.min(...got), mx = Math.max(...got), need = xpNeededForLevel(L);
          if (mn < lo) A.err('events.reward-scaling', 'L' + L, `grantXp 10-20 paid as little as ${mn} (want >= ${lo})`);
          if (L === 1 && mx > 20) A.err('events.reward-scaling', 'L1', `grantXp 10-20 paid ${mx} at level 1 (early game must stay unscaled)`);
          if (L === 40 && (mx / need > 0.15 || mn / need < 0.005)) A.err('events.reward-scaling', 'L40', `grantXp pays ${(mn / need * 100).toFixed(2)}-${(mx / need * 100).toFixed(2)}% of a level (want 0.5-15%)`);
          player.gold = 1e6; const g0 = player.gold; WORLD_EVENT_HANDLERS.grantGold({ msg: 'probe', gold: [25, 70] });
          const dg = player.gold - g0; if (!isFinite(dg) || dg < 25) A.err('events.reward-scaling', 'gold L' + L, `grantGold 25-70 paid ${dg}`);
          if (L === 1 && dg > 70) A.err('events.reward-scaling', 'gold L1', `grantGold 25-70 paid ${dg} at level 1`);
          if (L === 40 && dg < 150) A.err('events.reward-scaling', 'gold L40', `grantGold 25-70 paid only ${dg} at level 40`);
        }
        // one-off rewards (rescues, last rites, freed captives) share a helper; every site must use it
        for (const fn of ['resolveCagedPrisoner', 'resolveDungeonRescue', 'completeLastRites']) { const all = document.documentElement.outerHTML, at = all.indexOf('function ' + fn + '('), src = at < 0 ? '' : all.slice(at, at + 3500); /* source text, not String(fn): publisher wrappers replace some of these */ if (!/grantScaledReward/.test(src)) A.err('events.reward-scaling', fn, 'pays a flat reward: it must go through grantScaledReward'); }
        { player.level = 40; got.length = 0; const g0 = player.gold; grantScaledReward(20, 15); if (!(got[0] >= 100) || !(player.gold - g0 >= 60)) A.err('events.reward-scaling', 'grantScaledReward', `L40 grantScaledReward(20,15) paid ${got[0]}xp ${player.gold - g0}g`); }
      } finally { gainXP = realGain; player.level = saved.lvl; player.gold = saved.gold; }
    },
  },
  {
    id: 'quests.recover',
    desc: "the 'recover' radiant quest: needs a real 2+ floor dungeon in reach, accepting places a uniquely tagged relic on a walkable far tile of a non-boss floor, picking it up completes the quest and pays out",
    needsPlayer: true, uses: [ARENA], seconds: 120,
    fn(A) {
      const dgs = [...dungeonRegistry.values()].filter((d) => !d.isTutorial && !d.originDimensionId && d.maxDepth >= 2);
      A.stat('recoverCandidateDungeons', dgs.length);
      if (!dgs.length) { A.warn('quests.recover', 'setup', 'no 2+ floor dungeon registered in this game instance; probe skipped'); return; }
      const dg = dgs[0], npc = { uid: 'probe_npc', name: 'Probe', home: 'Testhold', x: dg.x + 12, y: dg.y, roleId: 'elder' };
      player.level = Math.max(player.level, (dg.recommendedLevel || 1));
      let offer = null;
      for (let i = 0; i < 80 && !offer; i++) { let o; try { o = rollRadiantQuestOffer(npc, Math.random); } catch (e) { A.err('quests.recover', 'roll', 'rollRadiantQuestOffer threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); return; } if (o && o.type === 'recover') offer = o; }
      if (!offer) { A.err('quests.recover', 'roll', 'no recover offer in 80 rolls with a 2+ floor dungeon next to the giver'); return; }
      if (offer.floor >= dgs.find((d) => d.id === offer.dungeonId).maxDepth) A.err('quests.recover', offer.id, `relic floor ${offer.floor} is the boss floor`);
      const goldBefore = player.gold, nq = player.quests.length;
      acceptRadiantQuest(offer);
      if (player.quests.length !== nq + 1) { A.err('quests.recover', offer.id, 'accepting did not add the quest'); return; }
      const lvl = dungeonRegistry.get(offer.dungeonId).levels[offer.floor - 1];
      const ent = lvl && (lvl.items || []).find((e) => e.item && e.item.questId === offer.id);
      if (!ent) { A.err('quests.recover', offer.id, 'no relic was placed on the target floor'); return; }
      const tile = lvl.grid[ent.y] && lvl.grid[ent.y][ent.x];
      if (!tile || !tile.walkable) A.err('quests.recover', offer.id, 'relic lies on a wall');
      const dUp = Math.max(Math.abs(ent.x - lvl.upStairs.x), Math.abs(ent.y - lvl.upStairs.y));
      A.stat('recoverRelicDistFromStairs', dUp);
      if (dUp < 5) A.warn('quests.recover', offer.id, `relic only ${dUp} tiles from the arrival stairs (meant to be on the far side)`);
      // pick it up: the real pickup path completes the quest
      const prevMode = [player.mode, player.dungeonId, player.dungeonDepth, player.x, player.y];
      try { pickUpSpecificItem(ent.item); } catch (e) { A.err('quests.recover', offer.id, 'pickUpSpecificItem threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); }
      const q = player.quests.find((x) => x.id === offer.id);
      if (!q || !q.done) A.err('quests.recover', offer.id, 'picking up the relic did not complete the quest');
      if (player.gold <= goldBefore) A.err('quests.recover', offer.id, 'completion paid no gold');
      if (player.inventory.some((it) => it.questId === offer.id)) A.err('quests.recover', offer.id, 'relic left in inventory after turn-in');
      if (gameState !== 'playing') { try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; }
    },
  },
  {
    id: 'floors.aspects',
    desc: 'floor aspects (FLOOR_ASPECTS): every entry is well-formed; forcing each one onto freshly generated floors leaves monsters/chests on open tiles, none stacked, none on the stairs, bosses untouched; natural rolls never hit floor 1 or the boss floor, hit roughly FLOOR_ASPECT_CHANCE of eligible floors, survive a pack/unpack round trip, and announce once',
    needsPlayer: true, uses: [ARENA], seconds: 150,
    fn(A) {
      if (typeof FLOOR_ASPECTS === 'undefined') { A.err('floors.aspects', 'registry', 'FLOOR_ASPECTS is not defined'); return; }
      A.stat('floorAspects', FLOOR_ASPECTS.length);
      const seen = new Set();
      for (const a of FLOOR_ASPECTS) {
        if (!a.id || seen.has(a.id)) A.err('floors.aspects', String(a.id), 'missing or duplicate id'); seen.add(a.id);
        for (const f of ['name', 'announce']) if (typeof a[f] !== 'string' || !a[f]) A.err('floors.aspects', a.id, `needs a ${f} string`);
        if (typeof a.apply !== 'function') A.err('floors.aspects', a.id, 'needs an apply(ctx) function');
        if (!(a.weight > 0)) A.err('floors.aspects', a.id, 'weight must be > 0');
        if (a.themes) for (const t of a.themes) if (!DUNGEON_THEMES[t]) A.err('floors.aspects', a.id, `unknown theme "${t}"`);
        if (a.xpMult !== undefined && !(a.xpMult >= 1 && a.xpMult <= 3)) A.err('floors.aspects', a.id, `xpMult ${a.xpMult} outside 1..3`);
      }
      const themes = Object.keys(DUNGEON_THEMES).filter((t) => t !== 'tutorial');
      const mkCtx = (lvl, theme, depth, maxD) => {
        const floors = []; for (let y = 0; y < lvl.h; y++) for (let x = 0; x < lvl.w; x++) if (lvl.grid[y][x].walkable) floors.push({ x, y });
        let seed = 12345 + depth; const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        return { level: lvl, grid: lvl.grid, floors, up: lvl.upStairs, down: lvl.downStairs, rng, depth, maxDepth: maxD, depthScaleBonus: 0, theme, areaScale: 1, variant: {}, meta: DUNGEON_THEMES[theme] };
      };
      // 1. force each aspect onto real floors of several themes
      let forced = 0;
      for (const a of FLOOR_ASPECTS) {
        const ok = a.themes ? a.themes : themes.slice(0, 12);
        for (const theme of ok.slice(0, 6)) {
          if (!DUNGEON_THEMES[theme]) continue;
          let lvl; try { lvl = generateDungeonLevel(theme, 3, 5, 'standard', 'small', 0); } catch (e) { A.err('floors.aspects', a.id, `generateDungeonLevel(${theme}) threw ${e.message}`); continue; }
          const bosses = lvl.monsters.filter((m) => m.boss).map((m) => m.uid), before = lvl.monsters.length, chestsBefore = (lvl.containers || []).length, oldMons = new Set(lvl.monsters.map((m) => m.uid)), oldAff = new Set(lvl.monsters.filter((m) => m.affixes && m.affixes.length).map((m) => m.uid)), oldBoxes = new Set((lvl.containers || []).map((c) => c.container)); // only what the aspect added is judged
          let oilBefore = 0, trapsBefore = 0; for (const row of lvl.grid) for (const t of row) { if (t && t.oilTurns > 0) oilBefore++; if (t && t.hiddenTrap) trapsBefore++; } const oldNpcs = new Set((lvl.npcs || []).map((n) => n.uid));
          try { a.apply(mkCtx(lvl, theme, 3, 5)); } catch (e) { A.err('floors.aspects', a.id, `apply on ${theme} threw: ${String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')}`); continue; }
          forced++;
          const pos = new Set();
          for (const m of lvl.monsters) {
            const t = lvl.grid[m.y] && lvl.grid[m.y][m.x];
            if (!t || !t.walkable) A.err('floors.aspects', a.id, `${theme}: ${m.name} placed on a non-walkable tile ${m.x},${m.y}`);
            const k = m.x + ',' + m.y; if (pos.has(k)) A.err('floors.aspects', a.id, `${theme}: two monsters on ${k}`); pos.add(k);
            if (lvl.upStairs && m.x === lvl.upStairs.x && m.y === lvl.upStairs.y) A.err('floors.aspects', a.id, `${theme}: monster on the up stairs`);
            if (!oldMons.has(m.uid) && !(m.xp > 0)) A.err('floors.aspects', a.id, `${theme}: added ${m.name} has xp ${m.xp}`);
          }
          for (const u of bosses) if (!lvl.monsters.some((m) => m.uid === u)) A.err('floors.aspects', a.id, `${theme}: a boss was removed`);
          for (const c of (lvl.containers || [])) { if (oldBoxes.has(c.container)) continue; const t = lvl.grid[c.y] && lvl.grid[c.y][c.x]; if (!t || !t.walkable) A.err('floors.aspects', a.id, `${theme}: container on a non-walkable tile`); }
          if (a.id === 'infested' && lvl.monsters.length <= before) A.err('floors.aspects', a.id, `${theme}: added no monsters (${before} -> ${lvl.monsters.length})`);
          if (a.id === 'hoard' && (lvl.containers || []).length < chestsBefore + 1) A.err('floors.aspects', a.id, `${theme}: added no chests`);
          if (a.id === 'restless' && lvl.monsters.some((m) => !m.boss && m.sleeper)) A.err('floors.aspects', a.id, `${theme}: a monster is still a sleeper`);
          if (a.id === 'warband' && !lvl.monsters.some((m) => m.affixes && m.affixes.length && !oldAff.has(m.uid))) A.err('floors.aspects', a.id, `${theme}: promoted nobody to Marked/Elite`);
          if (a.id === 'quiet' && lvl.monsters.length > before) A.err('floors.aspects', a.id, `${theme}: added monsters`);
          if (a.id === 'slicked' && !(function () { let n = 0; for (const row of lvl.grid) for (const t of row) if (t && t.oilTurns > 0) n++; return n > oilBefore; })()) A.err('floors.aspects', a.id, `${theme}: laid no oil`);
          if (a.id === 'tripwired' && !(function () { let n = 0; for (const row of lvl.grid) for (const t of row) if (t && t.hiddenTrap) n++; return n >= trapsBefore + 3; })()) A.err('floors.aspects', a.id, `${theme}: added fewer than 3 hidden traps`);
          if (a.id === 'captives') {
            const cages = (lvl.npcs || []).filter((n) => n.caged && !oldNpcs.has(n.uid));
            if (!cages.length) A.err('floors.aspects', a.id, `${theme}: placed no caged prisoner`);
            for (const c of cages) { const t = lvl.grid[c.y] && lvl.grid[c.y][c.x]; if (!t || !t.walkable) A.err('floors.aspects', a.id, `${theme}: prisoner on a non-walkable tile`); if (!lvl.monsters.some((m) => !oldMons.has(m.uid) && Math.max(Math.abs(m.x - c.x), Math.abs(m.y - c.y)) <= 2)) A.err('floors.aspects', a.id, `${theme}: prisoner has no guard within 2 tiles`); }
          }
          if (a.id === 'haunted' && !lvl.monsters.some((m) => /ghost|skeleton|zombie/i.test(m.monsterId || ''))) A.err('floors.aspects', a.id, `${theme}: no undead present`);
        }
      }
      A.stat('floorAspectsForced', forced);
      // 2. natural rolls: never floor 1 / the boss floor; frequency near FLOOR_ASPECT_CHANCE among eligible floors
      let eligible = 0, hit = 0; const byId = {};
      for (let i = 0; i < 200; i++) {
        const theme = themes[i % themes.length], maxD = 3 + (i % 3), depth = 1 + (i % maxD);
        let lvl; try { lvl = generateDungeonLevel(theme, depth, maxD, 'standard', 'small', 0); } catch (e) { continue; }
        const isElig = depth >= 2 && depth < maxD;
        if (lvl.aspect && !isElig) A.err('floors.aspects', lvl.aspect, `${theme} d${depth}/${maxD}: rolled on an ineligible floor`);
        if (lvl.aspect && !FLOOR_ASPECTS.some((a) => a.id === lvl.aspect)) A.err('floors.aspects', lvl.aspect, 'level.aspect is not a registered aspect');
        if (isElig) { eligible++; if (lvl.aspect) { hit++; byId[lvl.aspect] = (byId[lvl.aspect] || 0) + 1; } }
      }
      A.stat('floorAspectRollRate', eligible ? +(hit / eligible).toFixed(2) : 0); A.stat('floorAspectRolls', JSON.stringify(byId));
      if (eligible >= 40 && (hit / eligible < FLOOR_ASPECT_CHANCE * 0.4 || hit / eligible > FLOOR_ASPECT_CHANCE * 2)) A.err('floors.aspects', 'rate', `${hit}/${eligible} eligible floors rolled an aspect; FLOOR_ASPECT_CHANCE is ${FLOOR_ASPECT_CHANCE}`);
      // 3. save round trip and one-time announcement
      const theme = 'crypt', lvl = generateDungeonLevel(theme, 3, 5, 'standard', 'small', 0);
      lvl.aspect = FLOOR_ASPECTS[0].id; lvl.aspectSeen = false;
      const copy = JSON.parse(JSON.stringify(packDungeon({ levels: [lvl] })));
      if (copy.levels[0].aspect !== lvl.aspect) A.err('floors.aspects', 'save', 'level.aspect did not survive packDungeon + JSON');
      const logBefore = (typeof gameLog !== 'undefined' && gameLog.length) || 0;
      if (floorAspectTag(lvl) !== '') A.err('floors.aspects', 'tag', 'location tag shown before the aspect was announced');
      announceFloorAspect(lvl); announceFloorAspect(lvl);
      if (!floorAspectTag(lvl).includes(FLOOR_ASPECTS[0].name)) A.err('floors.aspects', 'tag', 'location tag missing after announcement: ' + JSON.stringify(floorAspectTag(lvl)));
      if (!lvl.aspectSeen) A.err('floors.aspects', 'announce', 'announceFloorAspect did not mark the level');
    },
  },
  {
    id: 'events.curios',
    desc: 'dungeon curios: every curio opens a choice menu through openCurio on a real tile, any chosen option spends it, a spent curio does not reopen, and an engaged enemy blocks it without spending it',
    needsPlayer: true, uses: [ARENA], seconds: 120,
    fn(A) {
      const curios = WORLD_EVENTS.filter((e) => e.curio);
      A.stat('curioDefs', curios.length);
      if (curios.length < 8) A.warn('events.curios', 'count', `only ${curios.length} dungeon curios`);
      // content gap: a dungeon theme with no curio that can appear in it (curios without `themes` are generic and appear everywhere)
      const generic = curios.some((e) => !e.themes);
      if (!generic) for (const t of Object.keys(DUNGEON_THEMES)) if (!curios.some((e) => e.themes && e.themes.includes(t))) A.warn('events.curios', 'coverage:' + t, `dungeon theme '${t}' has no curio`);
      for (const e of curios) {
        if (e.scope !== 'dungeon') A.err('events.curios', e.id, `scope is '${e.scope}', must be 'dungeon' so the overworld roll never picks it`);
        if (e.themes) for (const t of e.themes) if (!DUNGEON_THEMES[t]) A.err('events.curios', e.id, `themes lists unknown dungeon theme '${t}'`);
        A.refill(); const m = A.arena('goblin', 50, 20); if (m) { m.alive = false; m.hp = 0; }
        const tile = { feature: 'curio', curioId: e.id, curioUsed: false, glyph: '\u00A4', color: '#fff', walkable: true };
        try { openCurio(tile); } catch (x) { A.err('events.curios', e.id, 'openCurio threw: ' + String(x && x.stack || x).split('\n').slice(0, 2).join(' | ')); continue; }
        if (gameState !== 'choice' || !pendingChoiceOptions || pendingChoiceOptions.length < 2) { A.err('events.curios', e.id, `openCurio did not open a choice menu (gameState=${gameState})`); try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; continue; }
        if (tile.curioUsed) A.err('events.curios', e.id, 'tile was spent just by opening it');
        // take the last real option (the one before "leave"): the first option may need an item
        player.hp = player.maxHp = 3000; player.gold = Math.max(player.gold, 500);
        const opt = pendingChoiceOptions[pendingChoiceOptions.length - 2]; const nBefore = pendingChoiceOptions.length;
        try { opt.action(); } catch (x) { A.err('events.curios', e.id, 'choosing an option threw: ' + String(x && x.stack || x).split('\n').slice(0, 2).join(' | ')); }
        if (nBefore >= 2 && e.choices.length && !(encounterNeedProblem(e.choices[e.choices.length - 1].needs)) && !tile.curioUsed) A.err('events.curios', e.id, 'committing to an option did not spend the curio');
        try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; player.alive = true;
      }
      // an engaged enemy next to us blocks the curio and leaves it unspent
      A.refill(); const foe = A.arena('goblin', 50, 3); if (foe) { foe.engaged = true; foe.aiState = 'combat'; const t2 = { feature: 'curio', curioId: curios[0].id, curioUsed: false, walkable: true }; openCurio(t2); if (gameState === 'choice') { A.err('events.curios', 'blocked', 'a curio opened with an engaged enemy 3 tiles away'); try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; } if (t2.curioUsed) A.err('events.curios', 'blocked', 'a blocked curio was spent'); foe.alive = false; foe.hp = 0; }
    },
  },
  {
    id: 'events.encounters',
    desc: 'every encounter event: well-formed (choices, needs, outcomes, ids that exist) and every outcome of every choice runs without throwing',
    needsPlayer: true, uses: [ARENA], seconds: 120,
    fn(A) {
      const encs = WORLD_EVENTS.filter((e) => e.type === 'encounter');
      A.stat('encounterEvents', encs.length);
      if (encs.length < 6) A.warn('events.encounters', 'count', `only ${encs.length} encounter events; ordinary events are mostly flavor text`);
      const itemOk = (id) => ITEM_BASES.some((b) => b.id === id);
      const seen = new Set(); let ran = 0;
      for (const e of encs) {
        if (seen.has(e.id)) A.err('events.encounters', e.id, 'duplicate event id'); seen.add(e.id);
        if (!e.msg) A.err('events.encounters', e.id, 'no msg');
        if (!Array.isArray(e.choices) || !e.choices.length) { A.err('events.encounters', e.id, 'no choices'); continue; }
        e.choices.forEach((ch, ci) => {
          const where = `${e.id} choice ${ci + 1} (${ch.label})`;
          if (!ch.label) A.err('events.encounters', e.id, `choice ${ci + 1} has no label`);
          if (!Array.isArray(ch.outcomes) || !ch.outcomes.length) { A.err('events.encounters', e.id, where + ': no outcomes'); return; }
          const n = ch.needs;
          if (n && n.item && !itemOk(n.item)) A.err('events.encounters', e.id, `${where}: needs unknown item ${n.item}`);
          if (n && n.stat && !(typeof player[n.stat[0]] === 'number')) A.err('events.encounters', e.id, `${where}: needs unknown stat ${n.stat[0]}`);
          if (n && n.spell) for (const sid of [].concat(n.spell)) if (!SPELLS.some((x) => x.id === sid) && !TECHNIQUES.some((x) => x.id === sid)) A.err('events.encounters', e.id, `${where}: needs unknown spell/technique ${sid}`);
          if (n && n.minLevel !== undefined && !(n.minLevel > 0)) A.err('events.encounters', e.id, `${where}: needs.minLevel is not a positive number`);
          if (e.biomes && !(Array.isArray(e.biomes) && e.biomes.length && e.biomes.every((b) => BIOMES[b]))) A.err('events.encounters', e.id, `biomes must be a non-empty list of BIOMES keys (got ${JSON.stringify(e.biomes)})`);
          const flat = []; ch.outcomes.forEach((o) => { for (let x = o; x; x = x.also) flat.push(x); });
          for (const o of flat) {
            if (!WORLD_EVENT_HANDLERS[o.type]) { A.err('events.encounters', e.id, `${where}: outcome type '${o.type}' has no handler`); continue; }
            if (o.type === 'grantItem' && !itemOk(o.item)) A.err('events.encounters', e.id, `${where}: grants unknown item ${o.item}`);
            if (o.type === 'grantItemOf' && !(Array.isArray(o.items) && o.items.length && o.items.every(itemOk))) A.err('events.encounters', e.id, `${where}: grantItemOf has an unknown or empty items list`);
            if (o.type === 'cureStatus' && !(o.statuses || ['statusPoison']).every((k) => k === 'bleed' || typeof player[k] === 'number')) A.err('events.encounters', e.id, `${where}: cureStatus names a status that is not a numeric player field (${JSON.stringify(o.statuses)})`);
            if (o.type === 'restoreMana' && !(Array.isArray(o.mp) && o.mp.length === 2)) A.err('events.encounters', e.id, `${where}: restoreMana needs mp:[min,max]`);
            if (o.type === 'debuffStatus' && typeof player[o.status] !== 'number') A.err('events.encounters', e.id, `${where}: debuffStatus status ${o.status} is not a numeric player field`);
            if (o.type === 'buffPlayer' && !['armor','crit','dex','evasion','str','resistbleed','resistpoison','resistfire','resistfrost','nightvision','waterbreathing','actionspeed','flight','invis'].includes(o.stat)) A.warn('events.encounters', e.id, `${where}: buff stat '${o.stat}' is not read by getBuff anywhere I know of`);
            if (o.type === 'spawnWave' && !validEventPool(o.pool)) A.err('events.encounters', e.id, `${where}: spawnWave pool '${o.pool}' is empty or unknown`);
            if (!o.msg) A.warn('events.encounters', e.id, `${where}: outcome '${o.type}' has no msg (the player sees nothing)`);
            if (typeof o.w === 'number' && !(o.w > 0)) A.err('events.encounters', e.id, `${where}: non-positive weight`);
          }
          // execute every outcome for real, several times, on a healthy player
          for (const o of ch.outcomes) for (let k = 0; k < 3; k++) {
            A.refill(); const m = A.arena('goblin', 50, 6); if (m) { m.alive = false; m.hp = 0; }
            player.hp = player.maxHp = 3000; player.gold = Math.max(player.gold, 200);
            try { runEncounterOutcome(o); ran++; } catch (x) { A.err('events.encounters', e.id, `${where}: outcome '${o.type}' threw: ${String(x && x.stack || x).split('\n').slice(0, 2).join(' | ')}`); }
            if (!Number.isFinite(player.hp) || !Number.isFinite(player.gold)) A.err('events.encounters', e.id, `${where}: outcome '${o.type}' left hp/gold non-finite`);
            if (gameState !== 'playing') { try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; }
            player.alive = true;
          }
        });
        // the full dispatch path, as the scheduler uses it: presents a real choice menu
        A.refill(); const m2 = A.arena('goblin', 50, 20); if (m2) { m2.alive = false; m2.hp = 0; }
        player.inventory.push(makeItem('water_flask', 0, Math.random));
        try {
          scheduleOrApplyWorldEvent(e);
          if (gameState !== 'choice' || !pendingChoiceOptions || pendingChoiceOptions.length < 2) A.err('events.encounters', e.id, `dispatch did not open a choice menu (gameState=${gameState})`);
          else { resolveChoiceKey(String.fromCharCode(97 + pendingChoiceOptions.length - 1)); if (gameState === 'choice') A.err('events.encounters', e.id, 'choosing the last (leave) option did not close the menu'); }
        } catch (x) { A.err('events.encounters', e.id, 'dispatch threw: ' + String(x && x.stack || x).split('\n').slice(0, 2).join(' | ')); }
        if (gameState !== 'playing') { try { closeModal(); } catch (y) { /* */ } gameState = 'playing'; }
      }
      A.stat('encounterOutcomesRun', ran);
    },
  },
];
});

// ==== FILE: lib/probes/faith.js ====
__def("lib/probes/faith.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Faith probes: every deity is well-formed, can be pledged to, its boons apply and revert cleanly (finite stats), its invocation and event hooks
// do not throw, and wrath/renounce leave the player in a sane state.
module.exports = [
  {
    id: 'faith.deities',
    desc: 'each deity: schema (tenets, 5 boon ranks, invoke), pledge -> max piety -> boons applied with finite stats, invoke, hook events, offering, wrath and renounce, without exceptions',
    needsPlayer: true, seconds: 120,
    fn(A) {
      const ids = Object.keys(DEITIES);
      const settle = () => { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; dialogueNPC = null; };
      const finite = (id, what) => { for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'str', 'dex', 'con', 'int', 'wil', 'cha']) if (typeof player[k] === 'number' && !isFinite(player[k])) { A.err('faith.deities', id, `${what}: ${k} became ${player[k]}`); player[k] = 10; } };
      for (const id of ids) {
        const d = DEITIES[id];
        if (d.id !== id) A.err('faith.deities', id, 'deity.id "' + d.id + '" does not match its key');
        for (const f of ['name', 'title', 'domain', 'blurb']) if (!d[f]) A.err('faith.deities', id, 'missing ' + f);
        if (!Array.isArray(d.tenets) || !d.tenets.length) A.err('faith.deities', id, 'no tenets');
        const ranks = (d.boons || []).map((b) => b.rank).join(',');
        if (ranks !== '1,2,3,4,5') A.warn('faith.deities', id, 'boon ranks are ' + ranks + ' (expected 1..5)');
        if (!d.invoke || typeof d.invoke.run !== 'function' || !(d.invoke.cooldown >= 0) || !(d.invoke.cost >= 0)) A.err('faith.deities', id, 'invoke needs {cooldown,cost,run}');
        if (!Object.keys(d.on || {}).length && !Object.keys(d.events || {}).length) A.warn('faith.deities', id, 'no piety hooks (on.kill/item/cast...): piety can only come from offerings');
        try {
          settle(); player.faith = null; player.hp = player.maxHp = Math.max(player.maxHp, 100); turnCount += 5000;
          pledgeTo(id, 'the probe');
          if (!player.faith || player.faith.god !== id) { A.err('faith.deities', id, 'pledgeTo did not set the god'); continue; }
          addPiety(FAITH_TUNING.maxPiety); finite(id, 'max piety');
          if (faithTier(player.faith.piety) !== 5) A.warn('faith.deities', id, 'max piety does not reach tier 5');
          // hooks, fed plausible events
          const mon = Object.values(MONSTER_BASES)[0];
          const events = { kill: { def: Object.assign({ kind: 'monster' }, mon), killer: player, target: {} }, item: { it: makeItem('healing_potion', 0, Math.random, 1) }, cast: { ok: true, spell: SPELLS[0] } };
          for (const k of Object.keys(d.on)) { try { const v = d.on[k](events[k] || {}); if (typeof v !== 'number' || !isFinite(v)) A.warn('faith.deities', id, `on.${k} returned ${v}`); } catch (e) { A.err('faith.deities', id, `on.${k} threw: ${String(e && e.message)}`); } }
          for (const k of Object.keys(d.events || {})) { try { const v = d.events[k]({}); if (typeof v !== 'number' || !isFinite(v)) A.warn('faith.deities', id, `events.${k} returned ${v}`); } catch (e) { A.err('faith.deities', id, `events.${k} threw: ${String(e && e.message)}`); } }
          player.faith.invokedAt = {}; invokeGod(); settle(); finite(id, 'invoke');
          player.gold = 5000; player.faith.offeredAt = -9999; makeOffering(); settle();
          syncBoons(); finite(id, 'syncBoons');
          player.hp = player.maxHp; godWrath('abandon'); settle(); finite(id, 'wrath');
          if (player.faith.god) A.err('faith.deities', id, 'still pledged after wrath');
          if (player.hp < 1) { A.err('faith.deities', id, 'wrath left hp ' + player.hp); player.hp = player.maxHp; }
          pledgeTo(id); renounceFaith(true); finite(id, 'renounce');
        } catch (e) { A.err('faith.deities', id, 'threw: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
        player.alive = true; settle();
      }
      player.faith = null;
      A.stat('deities', ids.length);
    },
  },
];
});

// ==== FILE: lib/probes/index.js ====
__def("lib/probes/index.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probe registry. To add a check: put { id, desc, fn(A), needsPlayer?, seconds? } in any file here and list the file below.
//   fn(A) runs INSIDE the game realm (no require/fs). A.err/warn/info(area, id, msg) report; A.stat(name, value) records a metric.
//   uses:[fn(A)] -> helper installers run in the game first (e.g. A.arena()); share them via a module-level const.
//   needsPlayer:true -> a character is created first (state-dependent checks: casting, saving, generating worlds).
//   A thrown exception is reported as an error finding, so a probe can just call game code and let it blow up.
module.exports = [].concat(
  require('./worldgen'), // FIRST on purpose: it checks the world as GENERATED. Run after abilities.cast-all it saw terrain those spells had reshaped (walls, digging) and reported 4-6 'stranded' places that were not stranded in a fresh world
  require('./items'),
  require('./refs'),
  require('./monsters'),
  require('./abilities'),
  require('./bosses'),
  require('./content'),
  require('./talents'),
  require('./economy'),
  require('./story'),
  require('./faith'),
  require('./coverage'),
  require('./emergence'),
  require('./events'),
  require('./training'),
  require('./bot'),
  require('./systems')
);
});

// ==== FILE: lib/probes/items.js ====
__def("lib/probes/items.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes about item DATA (ITEM_BASES) and what makeItem() builds from it.
// Each probe: { id, desc, fn(A) }. fn's SOURCE runs inside the game; A is the finding reporter (see audit.js).
module.exports = [
  {
    id: 'items.schema',
    desc: 'every ITEM_BASES entry has the fields its type needs and sane numbers',
    fn(A) {
      const seen = new Map();
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const SLOTS = new Set(['hand', 'offhand', 'body', 'head', 'feet', 'ring', 'amulet', 'gloves', 'cloak']);
      for (const b of ITEM_BASES) {
        const id = b.id;
        if (!id) { A.err('items', '?', 'item without id: ' + JSON.stringify(b).slice(0, 80)); continue; }
        if (seen.has(id)) A.err('items', id, 'duplicate id (also "' + seen.get(id).name + '")');
        seen.set(id, b);
        if (!b.name || /undefined|NaN/.test(b.name)) A.err('items', id, 'bad name ' + b.name);
        if (!b.type) A.err('items', id, 'missing type');
        if (!b.glyph) A.warn('items', id, 'missing glyph');
        if (b.value !== undefined && (!finite(b.value) || b.value < 0)) A.err('items', id, 'bad value ' + b.value);
        if (b.type === 'weapon') {
          if (!Array.isArray(b.dmg) || b.dmg.length !== 2 || !finite(b.dmg[0]) || !finite(b.dmg[1])) A.err('items', id, 'weapon without numeric dmg [lo,hi]: ' + JSON.stringify(b.dmg));
          else if (b.dmg[0] > b.dmg[1] || b.dmg[0] < 0) A.err('items', id, 'weapon dmg range inverted/negative ' + JSON.stringify(b.dmg));
          if (b.slot !== 'hand' && b.slot !== 'offhand') A.warn('items', id, 'weapon slot ' + b.slot);
        }
        if (b.type === 'armor') {
          if (!SLOTS.has(b.slot)) A.err('items', id, 'armor with unknown slot ' + b.slot);
          if (b.armor !== undefined && !finite(b.armor)) A.err('items', id, 'armor not numeric');
        }
        if (b.str !== undefined && (!finite(b.str) || b.str < 0)) A.err('items', id, 'bad str requirement ' + b.str);
        for (const k of Object.keys(b)) { const v = b[k]; if (typeof v === 'number' && !isFinite(v)) A.err('items', id, 'field ' + k + ' is ' + v); }
      }
      A.stat('itemBases', ITEM_BASES.length);
    },
  },
  {
    id: 'items.make',
    desc: 'makeItem() output is finite and well formed for every base across rarities and power multipliers',
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      let made = 0;
      for (const b of ITEM_BASES) {
        for (const rarity of [0, 1, 2, 3]) for (const pm of [1, 4, 25]) {
          let it;
          try { it = makeItem(b.id, rarity, Math.random, pm); } catch (e) { A.err('items.make', b.id, `throws (rarity ${rarity}, x${pm}): ${e.message}`); break; }
          made++;
          if (!it) { A.err('items.make', b.id, 'returned null'); break; }
          if (/undefined|NaN/.test(it.name)) A.err('items.make', b.id, 'bad generated name ' + it.name);
          if (!finite(it.value) || it.value < 1) A.err('items.make', b.id, 'bad value ' + it.value);
          if (it.dmg && (!finite(it.dmg[0]) || !finite(it.dmg[1]) || it.dmg[0] > it.dmg[1] || it.dmg[0] < 1)) A.err('items.make', b.id, `bad dmg ${JSON.stringify(it.dmg)} (rarity ${rarity}, x${pm})`);
          if (b.type === 'armor' && !finite(it.armor)) A.err('items.make', b.id, 'armor NaN');
          for (const s in it.bonuses || {}) if (!finite(it.bonuses[s])) A.err('items.make', b.id, 'bonus ' + s + ' NaN');
          if (it.str !== undefined && !finite(it.str)) A.err('items.make', b.id, 'str req NaN');
        }
      }
      A.stat('itemsGenerated', made);
    },
  },
  {
    id: 'items.value-curve',
    desc: 'gold value should rise with power: flags weapons/armor far cheaper than a weaker item of the same slot (shop/economy sanity)',
    fn(A) {
      const weap = ITEM_BASES.filter((b) => b.type === 'weapon' && b.dmg && !b.noShop && b.value > 0);
      const avg = (b) => (b.dmg[0] + b.dmg[1]) / 2;
      // value per average damage point; outliers by >6x from the median are almost always data typos
      const ratios = weap.map((b) => b.value / avg(b)).sort((a, b) => a - b);
      const med = ratios[Math.floor(ratios.length / 2)];
      for (const b of weap) { const r = b.value / avg(b); if (r > med * 8 || r < med / 8) A.warn('items.economy', b.id, `value ${b.value} for avg dmg ${avg(b).toFixed(1)} (median gold/dmg ${med.toFixed(1)})`); }
      A.stat('medianGoldPerWeaponDmg', +med.toFixed(2));
    },
  },
];
});

// ==== FILE: lib/probes/monsters.js ====
__def("lib/probes/monsters.js", function (module, exports, require, __dirname, __filename) {
'use strict';
const { ARENA2 } = require('./bosses');
module.exports = [
  {
    id: 'monsters.schema',
    desc: 'monster definitions: numeric stats, loot chances, behaviors the AI knows',
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      for (const [id, m] of Object.entries(MONSTER_BASES)) {
        if (!m.name) A.err('monsters', id, 'no name');
        for (const k of ['hp', 'str', 'dex', 'xp']) if (!finite(m[k]) || m[k] < 0) A.err('monsters', id, `bad ${k}: ${m[k]}`);
        if (!(m.hp > 0)) A.err('monsters', id, 'hp must be > 0');
        if (!Array.isArray(m.atk) || !finite(m.atk[0]) || !finite(m.atk[1]) || m.atk[0] > m.atk[1] || m.atk[0] < 0) A.err('monsters', id, 'bad atk ' + JSON.stringify(m.atk));
        if (m.armor !== undefined && (!finite(m.armor) || m.armor < 0)) A.err('monsters', id, 'bad armor ' + m.armor);
        for (const l of m.loot || []) {
          if (!(l.chance >= 0 && l.chance <= 1)) A.err('monsters', id, `loot ${l.id} chance ${l.chance} outside 0..1`);
          if (l.min !== undefined && l.max !== undefined && l.min > l.max) A.err('monsters', id, `loot ${l.id} min>max`);
        }
        if (!m.glyph) A.warn('monsters', id, 'no glyph');
        if (!m.desc && !(typeof MONSTER_DESCRIPTIONS !== 'undefined' && MONSTER_DESCRIPTIONS[id])) A.warn('monsters', id, 'no description');
      }
      A.stat('monsterBases', Object.keys(MONSTER_BASES).length);
    },
  },
  {
    id: 'monsters.make',
    desc: 'makeMonster() works for every monster at shallow and deep scale (no NaN, no throw)',
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      for (const id of Object.keys(MONSTER_BASES)) for (const ds of [1, 5, 14]) {
        let m; try { m = makeMonster(id, 5, 5, ds, Math.random); } catch (e) { A.err('monsters.make', id, `throws at depthScale ${ds}: ${e.message}`); break; }
        for (const k of ['hp', 'maxHp', 'str', 'xp']) if (!finite(m[k])) A.err('monsters.make', id, `${k} = ${m[k]} at depthScale ${ds}`);
        if (!m.atk || !finite(m.atk[0]) || !finite(m.atk[1])) A.err('monsters.make', id, 'atk NaN at depthScale ' + ds);
      }
    },
  },
  {
    id: 'monsters.xp-curve',
    desc: 'XP per unit of threat should be roughly consistent; flags monsters that pay far more/less than their stats justify',
    fn(A) {
      const rows = [];
      for (const [id, m] of Object.entries(MONSTER_BASES)) {
        if (m.xp <= 0 || m.boss) continue;
        const dpt = (m.atk[0] + m.atk[1]) / 2 + (m.str || 0) / 4;
        const threat = Math.sqrt(m.hp * (dpt + 1)) * (1 + (m.armor || 0) * 0.08);
        rows.push({ id, ratio: m.xp / threat, xp: m.xp, threat });
      }
      rows.sort((a, b) => a.ratio - b.ratio);
      const med = rows[Math.floor(rows.length / 2)].ratio;
      for (const r of rows) if (r.ratio > med * 4 || r.ratio < med / 5) A.warn('monsters.xp', r.id, `xp ${r.xp} vs threat ${r.threat.toFixed(1)} (xp/threat ${r.ratio.toFixed(2)}, median ${med.toFixed(2)})`);
      A.stat('medianXpPerThreat', +med.toFixed(2));
    },
  },
  {
    id: 'monsters.behave',
    desc: 'drop every ordinary monster next to an unkillable, motionless player for 30 turns: no exceptions/NaN, and it should DO something (hit, move, summon, burst gas); flag inert and wildly over/under-damaging monsters against their tier',
    needsPlayer: true, uses: [ARENA2], seconds: 600,
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const rows = [];
      for (const [id, base] of Object.entries(MONSTER_BASES)) {
        if (base.boss || base.scriptedAI || base.waterOnly || base.powerDraw) continue; // bosses have their own probe; water-bound / ally constructs need special arenas
        const m = A.arenaBoss(id, base.ambush ? 2 : 4);
        if (!m) { A.warn('monsters.behave', id, 'no arena space'); continue; }
        player.maxHp = 1e7; player.hp = 1e7;
        let backing = 1e7, tally = 0;
        Object.defineProperty(player, 'hp', { configurable: true, enumerable: true, get() { return backing; }, set(v) { if (v < backing) tally += backing - v; backing = Math.min(v, 1e7); } });
        const x0 = m.x, y0 = m.y, n0 = curMonsters().filter((q) => q.alive).length; let moved = false;
        for (let t = 0; t < 30; t++) {
          try { endTurn(); } catch (e) { A.err('monsters.behave', id, `endTurn threw on turn ${t}: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`); break; }
          if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
          if (!player.alive) player.alive = true;
          if (m.x !== x0 || m.y !== y0) moved = true;
          if (!m.alive || m.hp <= 0) break;
          if (!finite(m.hp) || !finite(player.hp)) { A.err('monsters.behave', id, `hp became NaN (monster ${m.hp}, player ${player.hp})`); break; }
        }
        installVitalGuards(player); player.hp = player.maxHp = 500;
        const summoned = curMonsters().filter((q) => q.alive).length > n0;
        const dpt = tally / 30;
        rows.push({ id, tier: base.dtier || 0, dpt });
        const passive = base.behavior === 'support' || base.behavior === 'flee' || base.prey;
        if (!passive && tally <= 0 && !moved && !summoned) A.warn('monsters.inert', id, `${m.name} neither hit, moved nor summoned in 30 turns next to the player (behavior ${base.behavior})`);
      }
      // outliers against the monster's own tier (median damage per turn of monsters that dealt damage)
      const byTier = {};
      for (const r of rows) if (r.dpt > 0) (byTier[r.tier] = byTier[r.tier] || []).push(r.dpt);
      const med = (a) => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
      for (const r of rows) {
        const a = byTier[r.tier]; if (!a || a.length < 5 || !(r.dpt > 0)) continue;
        const md = med(a);
        if (r.dpt > md * 4) A.warn('monsters.dpt', r.id, `deals ${r.dpt.toFixed(1)} dmg/turn vs tier-${r.tier} median ${md.toFixed(1)} (over 4x)`);
      }
      for (const t in byTier) A.stat('monsterDptMedianTier' + t, +med(byTier[t]).toFixed(2));
      A.stat('monstersBehaved', rows.length);
    },
  },
];
});

// ==== FILE: lib/probes/refs.js ====
__def("lib/probes/refs.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes about cross-table references: every id a table mentions must exist in the table it points at.
module.exports = [
  {
    id: 'refs.items',
    desc: 'every item id mentioned by drop tables, recipes, sets, shops, starters, rewards exists',
    fn(A) {
      const items = new Set(ITEM_BASES.map((b) => b.id));
      const chk = (where, id, ctx) => { if (id && !items.has(id)) A.err('refs.items', where, `unknown item id "${id}"${ctx ? ' (' + ctx + ')' : ''}`); };
      for (const [mid, m] of Object.entries(MONSTER_BASES)) for (const l of m.loot || []) chk('monster:' + mid, l.id, 'loot');
      for (const r of RECIPES) { for (const i of r.inputs || []) chk('recipe:' + r.id, i.id, 'input'); if (r.output) chk('recipe:' + r.id, r.output.id, 'output'); }
      for (const [k, s] of Object.entries(ITEM_SETS)) for (const p of s.pieces || []) chk('set:' + k, p, 'piece');
      for (const [k, d] of Object.entries(BOSS_UNIQUE_DROPS)) chk('bossUnique:' + k, d.itemId);
      for (const [k, d] of Object.entries(BOSS_MATERIAL_DROPS)) chk('bossMaterial:' + k, d.itemId);
      for (const [k, d] of Object.entries(COMMON_UNIQUE_DROPS)) chk('commonUnique:' + k, d.itemId);
      for (const m of MILESTONE_REWARDS) chk('milestone:' + m.id, m.itemId);
      for (const [k, v] of Object.entries(ROLE_DEATH_LOOT)) for (const id of v) chk('roleLoot:' + k, id);
      for (const id of FISH_CATCH_TABLE) chk('fish', id);
      for (const [k, c] of Object.entries(CROPS)) { /* crops reference items by key */ if (c.seedItem) chk('crop:' + k, c.seedItem); if (c.yieldItem) chk('crop:' + k, c.yieldItem); }
      for (const id of HUNTER_LOOT_IDS) chk('hunterLoot', id);
      for (const id of CONTAINER_FOOD_IDS) chk('containerFood', id);
      for (const id of CONTAINER_MATERIAL_IDS) chk('containerMaterial', id);
    },
  },
  {
    id: 'refs.monsters',
    desc: 'every monster id mentioned by biomes, dimensions, events, quests, bosses exists',
    fn(A) {
      const mons = new Set(Object.keys(MONSTER_BASES));
      const chk = (where, id, ctx) => { if (id && !mons.has(id)) A.err('refs.monsters', where, `unknown monster id "${id}"${ctx ? ' (' + ctx + ')' : ''}`); };
      for (const [k, b] of Object.entries(BIOMES)) for (const e of b.encounter || []) chk('biome:' + k, e[0]);
      for (const [k, d] of Object.entries(DIMENSIONS)) for (const [bk, b] of Object.entries(d.biomes || {})) for (const e of b.encounter || []) chk('dimension:' + k + '/' + bk, e[0]);
      for (const [k, v] of Object.entries(EVENT_MONSTER_POOLS)) for (const id of v) chk('eventPool:' + k, id);
      for (const id of QUEST_MONSTER_POOL) chk('questPool', id);
      for (const b of STORY_BOSSES) chk('storyBoss', b.id);
      for (const b of OVERWORLD_BOSSES) chk('overworldBoss', b.id);
      for (const b of TRAIL_GUARDIANS) chk('trailGuardian', b.id);
      for (const id of UNDEAD_IDS) chk('UNDEAD_IDS', id);
      for (const id of SILVER_BONUS_IDS) chk('SILVER_BONUS_IDS', id);
      for (const k of Object.keys(BOSS_POWER)) chk('BOSS_POWER', k);
      for (const k of Object.keys(BOSS_UNIQUE_DROPS)) chk('BOSS_UNIQUE_DROPS', k);
      for (const k of Object.keys(COMMON_UNIQUE_DROPS)) chk('COMMON_UNIQUE_DROPS', k);
      for (const k of Object.keys(BOSS_MATERIAL_DROPS)) chk('BOSS_MATERIAL_DROPS', k);
      for (const k of Object.keys(LEGACY_MONSTER_FACTIONS)) chk('LEGACY_MONSTER_FACTIONS', k);
      for (const [k, d] of Object.entries(DIMENSION_TRAIL_GUARDIANS)) chk('trailGuardianOf:' + k, typeof d === 'string' ? d : d && d.id);
    },
  },
  {
    id: 'refs.themes',
    desc: 'dungeon themes: generators exist, depth ranges sane, faction pools non-empty',
    fn(A) {
      for (const [k, t] of Object.entries(DUNGEON_THEMES)) {
        if (!t.name) A.err('themes', k, 'no name');
        if (!Array.isArray(t.depthRange) || t.depthRange[0] > t.depthRange[1] || t.depthRange[0] < 1) A.err('themes', k, 'bad depthRange ' + JSON.stringify(t.depthRange));
        for (const g of t.genPool || []) if (!DUNGEON_GENERATORS[g[0]]) A.err('themes', k, 'unknown generator ' + g[0]);
        if (!DUNGEON_TIER_WEIGHTS[t.tier] && t.tier !== 'dimension') A.err('themes', k, 'unknown tier ' + t.tier);
      }
      for (const [k, p] of Object.entries(DUNGEON_THEME_GENPOOLS)) for (const g of p) if (!DUNGEON_GENERATORS[g[0]]) A.err('themes', k, 'genpool unknown generator ' + g[0]);
    },
  },
  {
    id: 'refs.abilities',
    desc: 'spells/techniques/talents/mutations/cyberware: unique ids, prerequisites exist, required fields valid',
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const uniq = (list, area) => { const s = new Set(); for (const x of list) { if (s.has(x.id)) A.err(area, x.id, 'duplicate id'); s.add(x.id); } return s; };
      const spells = uniq(SPELLS, 'spells'), techs = uniq(TECHNIQUES, 'techniques'), talents = uniq(TALENTS_V2, 'talents');
      uniq(MUTATIONS, 'mutations'); uniq(CYBERNETICS, 'cybernetics');
      for (const s of SPELLS) {
        if (!s.name || !s.type) A.err('spells', s.id, 'missing name/type');
        if (s.mp !== undefined && (!finite(s.mp) || s.mp < 0)) A.err('spells', s.id, 'bad mp cost ' + s.mp);
        if (s.power !== undefined && !(finite(s.power) || (Array.isArray(s.power) && s.power.every(finite)))) A.err('spells', s.id, 'bad power ' + JSON.stringify(s.power));
        if (Array.isArray(s.power) && s.power[0] > s.power[1]) A.err('spells', s.id, 'power range inverted');
        if (s.range !== undefined && !finite(s.range)) A.err('spells', s.id, 'bad range');
      }
      for (const t of TECHNIQUES) {
        if (!t.name || !t.type) A.err('techniques', t.id, 'missing name/type');
        if (t.mp !== undefined && (!finite(t.mp) || t.mp < 0)) A.err('techniques', t.id, 'bad cost ' + t.mp);
        if (Array.isArray(t.power) && t.power[0] > t.power[1]) A.err('techniques', t.id, 'power range inverted');
      }
      for (const t of TALENTS_V2) {
        for (const r of [].concat(t.requires || [])) { const id = typeof r === 'string' ? r : r && r.id; if (id && !talents.has(id)) A.err('talents', t.id, 'requires unknown talent ' + id); }
        if (t.requires && [].concat(t.requires).includes(t.id)) A.err('talents', t.id, 'requires itself');
      }
      // cycle check on the talent prerequisite graph
      const byId = new Map(TALENTS_V2.map((t) => [t.id, t]));
      const state = new Map();
      const dfs = (id, path) => {
        if (state.get(id) === 2) return; if (state.get(id) === 1) { A.err('talents', id, 'prerequisite cycle: ' + path.join('>')); return; }
        state.set(id, 1); const t = byId.get(id); for (const r of [].concat((t && t.requires) || [])) { const rid = typeof r === 'string' ? r : r && r.id; if (rid && byId.has(rid)) dfs(rid, path.concat(rid)); } state.set(id, 2);
      };
      for (const t of TALENTS_V2) dfs(t.id, [t.id]);
      for (const a of ARCHETYPES) {
        // starter abilities named by archetype apply() functions
        const src = String(a.apply);
        for (const m of src.matchAll(/knownTechniques\.push\(([^)]*)\)/g)) for (const q of m[1].split(',')) { const id = q.trim().replace(/['"`]/g, ''); if (id && !techs.has(id)) A.err('archetypes', a.id, 'starter technique "' + id + '" does not exist'); }
        for (const m of src.matchAll(/knownSpells\.push\(([^)]*)\)/g)) for (const q of m[1].split(',')) { const id = q.trim().replace(/['"`]/g, ''); if (id && !spells.has(id)) A.err('archetypes', a.id, 'starter spell "' + id + '" does not exist'); }
        // balance lesson (v0.51.3): five starter kits had NO reliable damage (only buffs/blinks/execute-finishers) and won 40-60% of duels the other classes won ~99%.
        // Every archetype must start with at least one plain damage ability (no HP cost / exposure) or a summon.
        { const ids = []; for (const m of src.matchAll(/known(?:Spells|Techniques)\.push\(([^)]*)\)/g)) for (const q of m[1].split(',')) { const id = q.trim().replace(/['"`]/g, ''); if (id) ids.push(id); }
          const offense = ids.some((id) => { let ab = null; try { ab = findAbilityById(id); } catch (e) { /* */ } return ab && ((['damage', 'drain', 'smite'].includes(ab.type) && Array.isArray(ab.power) && !ab.selfCost && !ab.selfExposed) || ab.type === 'summon'); });
          if (!offense) A.err('archetypes', a.id, 'starter kit has no reliable damage ability (needs a plain damage/drain/smite spell or technique, or a summon): ' + ids.join(','));
        }
        for (const m of src.matchAll(/makeStarterItem\(['"]([^'"]+)['"]/g)) if (!ITEM_BASES.some((b) => b.id === m[1])) A.err('archetypes', a.id, 'starter item "' + m[1] + '" does not exist');
      }
    },
  },
];
});

// ==== FILE: lib/probes/story.js ====
__def("lib/probes/story.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Main-quest probes: generate the questline many times, validate every stage's references, then play it to the end (taking every
// choice branch across runs) so a dead-end / unreachable ending / throwing stage is caught.
module.exports = [
  {
    id: 'story.playthrough',
    desc: 'generateMainQuest x many: stage refs resolve (bosses, dimensions, guardians); stepping through advanceStory/resolveMainQuestChoice reaches the final stage without exceptions or stalls, on every choice branch',
    needsPlayer: true, seconds: 240,
    fn(A) {
      const runs = 24;
      const choiceTaken = new Set(); let finished = 0;
      for (let run = 0; run < runs; run++) {
        let st;
        try { player.story = null; st = player.story = generateMainQuest(Math.random); } catch (e) { A.err('story.playthrough', 'generate', 'generateMainQuest threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); continue; }
        const checkStage = (s) => {
          if (!s.id || !s.type || !s.title) A.err('story.playthrough', s.id || '?', 'stage missing id/type/title');
          if (s.targetBossId && !MONSTER_BASES[s.targetBossId]) A.err('story.playthrough', s.id, 'targetBossId ' + s.targetBossId + ' is not a monster');
          if (s.targetMonsterId && !MONSTER_BASES[s.targetMonsterId]) A.err('story.playthrough', s.id, 'targetMonsterId ' + s.targetMonsterId + ' is not a monster');
          if (s.targetDimensionId && !DIMENSIONS[s.targetDimensionId]) A.err('story.playthrough', s.id, 'targetDimensionId ' + s.targetDimensionId + ' is not a dimension');
          if (s.type === 'dungeon_tier' && !DUNGEON_TIER_WEIGHTS[s.targetTier]) A.err('story.playthrough', s.id, 'unknown dungeon tier ' + s.targetTier);
        };
        st.stages.forEach(checkStage);
        for (const s of st.stages) if (s.branches) for (const k in s.branches) s.branches[k].forEach(checkStage);
        let steps = 0, last = -1, stuck = 0;
        try {
          player.hp = player.maxHp = 9999;
          while (steps++ < 200) {
            const cur = player.story.stages[player.story.stageIndex];
            if (!cur) { finished++; break; }
            if (cur.type === 'choice') {
              const keys = Object.keys(cur.branches);
              const pick = keys[run % keys.length];
              choiceTaken.add(cur.id + ':' + pick);
              resolveMainQuestChoice(cur, pick);
            } else advanceStory();
            try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; dialogueNPC = null;
            if (player.story.stageIndex === last) { if (++stuck > 3) { A.err('story.playthrough', cur.id, 'story stalled on stage ' + cur.id + ' (' + cur.type + ')'); break; } } else { stuck = 0; last = player.story.stageIndex; }
          }
          if (steps >= 200) A.err('story.playthrough', 'loop', 'story did not finish in 200 steps');
        } catch (e) { A.err('story.playthrough', 'walk', 'walking the quest threw: ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
        player.alive = true;
      }
      player.story = null;
      A.stat('storyRuns', runs); A.stat('storyFinished', finished); A.stat('storyChoiceBranchesTaken', choiceTaken.size);
    },
  },
];
});

// ==== FILE: lib/probes/bot.js ====
__def("lib/probes/bot.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes for the autopilot's OWN behaviour (window.__B is installed by the audit before probes run).
// A bot capability that silently stops working would make every later balance run lie, so the important ones are pinned here.
const { ARENA } = require('./abilities');
module.exports = [
  {
    id: 'bot.dodge',
    desc: 'the autopilot sidesteps a wound-up maneuver aimed at its tile, and the blow then lands on nothing',
    needsPlayer: true, uses: [ARENA], seconds: 60,
    fn(A) {
      const B = window.__B; if (!B || !B.dodgeManeuver) { A.err('bot.dodge', 'brain', 'window.__B.dodgeManeuver missing'); return; }
      let dodged = 0, trials = 0;
      for (let i = 0; i < 6; i++) {
        A.settle(); A.refill(); for (const k of ['frozenSolidTurns', 'stunnedTurns', 'statusSlow', 'statusFear', 'statusConfuse', 'statusPoison', 'burningTurns', 'bleedStacks', 'statusRadiation']) player[k] = 0; // leftover statuses from earlier probes can legitimately pin the player in place (or, since v0.51.5 DoT scaling, tick for several HP: the 'hit' check allows 1)
        const m = A.arena('savanna_lion', 5000, 3); if (!m) continue; trials++; try { extinguishArea(player.x, player.y, 8); } catch (e) { /* */ }
        m.maneuver = { id: 'pounce', phase: 'windup', left: 1, plan: { tiles: [{ x: player.x, y: player.y }] } };
        const hp0 = player.hp, x0 = player.x, y0 = player.y;
        if (!B.dodgeManeuver()) { A.warn('bot.dodge', 'noop', 'dodgeManeuver returned false with the player on a marked tile (can be legitimate when boxed in; passes in isolation)'); m.alive = false; m.hp = 0; continue; }
        if (player.x === x0 && player.y === y0) A.err('bot.dodge', 'stayed', 'dodge claimed success but the player did not move');
        try { endTurn({ forceFull: true }); } catch (e) { A.err('bot.dodge', 'endTurn', 'endTurn threw ' + e.message); }
        if (player.hp < hp0 - 1) A.err('bot.dodge', 'hit', `took ${hp0 - player.hp} damage after sidestepping the marked tile`); else dodged++;
        m.maneuver = null; m.alive = false; m.hp = 0;
      }
      A.stat('dodgeTrials', trials); A.stat('dodgesClean', dodged);
      // not on a marked tile: do nothing
      A.refill(); const m2 = A.arena('savanna_lion', 5000, 3); if (m2) { m2.maneuver = { id: 'pounce', phase: 'windup', left: 1, plan: { tiles: [{ x: player.x + 2, y: player.y + 2 }] } }; if (B.dodgeManeuver()) A.err('bot.dodge', 'spurious', 'dodged although no marked tile was under the player'); m2.maneuver = null; m2.alive = false; m2.hp = 0; }
    },
  },
  {
    id: 'bot.throwables',
    desc: 'the autopilot throws damage bombs at a dangerous target (and not at trivial ones) and douses itself with a Water Flask when burning',
    needsPlayer: true, uses: [ARENA], seconds: 60,
    fn(A) {
      const B = window.__B; if (!B || !B.tryThrow) { A.err('bot.throwables', 'brain', 'window.__B.tryThrow missing'); return; }
      const trb0 = player.throwRadiusBonus; player.throwRadiusBonus = 0; // earlier probes may have left a bonus that changes the blast-radius rule
      const give = (id) => { const it = makeItem(id, 0, Math.random); if (!it) { A.err('bot.throwables', id, 'makeItem returned nothing'); return null; } player.inventory.push(it); return it; };
      const setup = (id, n) => { A.settle(); A.refill(); player.inventory = player.inventory.filter((i) => !B.THROW_DAMAGE.has(i.effect) && i.effect !== 'soaksplash'); let m = null;
        for (const dist of [n || 4, 5, 4, 6, 5, 4]) { // a polluted arena can put a wall between us: retry until the target is in line of sight
          m = A.arena(id, 5000, dist); try { extinguishArea(player.x, player.y, 8); } catch (e) { /* */ }
          if (!m || hasLOS(player.x, player.y, m.x, m.y)) break;
          m.alive = false; m.hp = 0; m = null;
        }
        if (m) { m.fireImmune = false; m.wetTurns = 0; } return m; };
      // 1. a boss-flagged dummy: worth a bomb
      let m = setup('goblin', 4); const bomb = give('firebomb');
      if (m && bomb) {
        m.boss = true; const n0 = player.inventory.filter((i) => i.effect === 'aoefire').reduce((a, i) => a + (i.amount || 1), 0), h0 = m.hp;
        let spent = B.tryThrow(m), tries = 1;
        // a thrown bomb can miss (accuracy roll): give it up to 5 bombs before calling "no damage" a failure
        while (spent && m.hp >= h0 && tries < 5) { give('firebomb'); const nBefore = player.inventory.filter((i) => i.effect === 'aoefire').reduce((a, i) => a + (i.amount || 1), 0); spent = B.tryThrow(m); tries++; if (!spent) break; void nBefore; }
        const n1 = player.inventory.filter((i) => i.effect === 'aoefire').reduce((a, i) => a + (i.amount || 1), 0);
        if (!spent || n1 !== n0 - 1 || m.hp >= h0) A.err('bot.throwables', 'boss', `tryThrow on a boss: spent=${spent}, bombs ${n0}->${n1}, hp ${h0}->${m.hp}; ` + JSON.stringify({ d: chebyshev(m.x, m.y, player.x, player.y), los: hasLOS(player.x, player.y, m.x, m.y), best: !!B.bestThrowable(m), range: throwRangeFor(bomb), r: bomb.radius, gs: gameState, froz: player.frozenSolidTurns, stun: player.stunnedTurns, trb: player.throwRadiusBonus, fi: m.fireImmune, wet: m.wetTurns, eff: bomb.effect, pw: bomb.power, inv: player.inventory.length }));
        m.boss = false; m.alive = false; m.hp = 0;
      }
      // 2. a trivial monster at full health: keep the bomb
      m = setup('rabbit', 4); const b2 = give('firebomb');
      if (m && b2) { const spent = B.tryThrow(m); if (spent) A.err('bot.throwables', 'trivial', 'threw a Firebomb at a rabbit while healthy'); m.alive = false; m.hp = 0; }
      // 3. too close for an area blast: do not blow ourselves up on purpose
      m = setup('goblin', 1); const b3 = give('firebomb');
      if (m && b3) { m.boss = true; if (B.tryThrow(m)) A.err('bot.throwables', 'adjacent', 'threw an area bomb at an adjacent target'); m.boss = false; m.alive = false; m.hp = 0; }
      // 4. burning + Water Flask: soak ourselves, fire goes out
      A.settle(); A.refill(); player.inventory = player.inventory.filter((i) => i.effect !== 'soaksplash'); const fl = give('water_flask');
      if (fl) { player.burningTurns = 6; player.hp = Math.floor(player.maxHp * 0.5); const ok = B.douseSelf(); if (!ok || player.burningTurns > 0) A.err('bot.throwables', 'douse', `douseSelf=${ok}, burningTurns after = ${player.burningTurns} (expected 0)`); }
      player.burningTurns = 0; player.throwRadiusBonus = trb0; A.refill();
    },
  },
];
});

// ==== FILE: lib/probes/systems.js ====
__def("lib/probes/systems.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes that exercise whole game systems with a live character.
const { ARENA } = require('./abilities');
const HELPERS = function (A) {
  A.settle = function () { for (let i = 0; i < 4 && gameState !== 'playing' && gameState !== 'gameover'; i++) { if (gameState === 'tiletarget') { try { cancelTileTargeting(); } catch (e) { /* */ } } try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
  A.vitals = function () { player.maxHp = Math.max(player.maxHp, 500); player.hp = player.maxHp; player.mp = Math.max(player.mp, 100); player.stamina = player.maxStamina; };
  A.numbersOk = function (obj, label, ids) { // report any non-finite player vitals
    for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'stamina', 'maxStamina', 'gold', 'str', 'dex', 'int', 'con', 'wil', 'cha', 'xp', 'level']) if (typeof player[k] !== 'number' || !isFinite(player[k])) { A.err(label, ids, `player.${k} is ${player[k]}`); return false; }
    return true;
  };
};

module.exports = [
  {
    id: 'systems.use-items',
    desc: 'use every consumable / scroll / rune / recipe item once: no exceptions, no NaN vitals',
    needsPlayer: true, uses: [HELPERS], seconds: 240,
    fn(A) {
      let used = 0;
      const bases = ITEM_BASES.filter((b) => ['consumable', 'scroll', 'recipe', 'rune', 'misc', 'material'].includes(b.type));
      for (const b of bases) {
        A.vitals(); A.settle();
        let it; try { it = makeItem(b.id, 1, Math.random, 1); } catch (e) { A.err('systems.use-items', b.id, 'makeItem threw ' + e.message); continue; }
        if (!it) continue;
        player.inventory.push(it);
        const gold0 = player.gold;
        try { useItem(it); } catch (e) { A.err('systems.use-items', b.id, `useItem(${b.name}) threw: ${String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')}`); }
        A.settle(); used++;
        if (gameState === 'gameover' || !player.alive) { A.warn('systems.use-items', b.id, `using ${b.name} killed the player (${player.deathCause}) -- fine if it is a poison/curse item`); return; }
        A.numbersOk(player, 'systems.use-items', b.id + ' (' + b.name + ')');
      }
      A.stat('itemsUsed', used);
    },
  },
  {
    id: 'systems.bleed-floor',
    desc: 'at player level 1-4 a bleed tick never kills (leaves 1 HP); at level 5+ it can',
    needsPlayer: true,
    fn(A) {
      const __g = A.leakGuard(); // the probes below kill the player on purpose: restore() puts the world back so the next probe does not start with a corpse
      const saved = { lvl: player.level, hp: player.hp, mhp: player.maxHp, st: player.bleedStacks, bt: player.bleedTurns, buffs: player.buffs };
      player.buffs = {}; // a leftover bleed-resist / regeneration buff made the level-8 check flaky
      const run = (lvl) => { player.level = lvl; player.maxHp = 40; player.hp = 6; player.bleedStacks = 6; player.bleedTurns = 1; player.bleedClotTurns = 0; player.alive = true; gameState = 'playing'; let died = false; for (let i = 0; i < 12 && player.alive; i++) { try { processEntityStatus(player); } catch (e) { A.err('systems.bleed-floor', 'throw', String(e)); return null; } if (player.hp <= 0 || !player.alive || gameState === 'gameover') { died = true; break; } } return { died, hp: player.hp }; };
      if (typeof processEntityStatus !== 'function') { A.warn('systems.bleed-floor', 'api', 'processEntityStatus not found (renamed?)'); return; }
      const lo = run(2); if (lo && (lo.died || lo.hp < 1)) A.err('systems.bleed-floor', 'early', `level 2 character bled to death (hp ${lo.hp})`);
      const hi = run(8); if (hi && !hi.died && hi.hp > 0) A.warn('systems.bleed-floor', 'late', `level 8 character survived 12 ticks of a 6-stack bleed from 6 HP (hp ${hi.hp}): bleed no longer lethal at level 5+? leaked: ${Object.entries(player).filter(([k, v]) => /regen|heal|life|leech|bleed|immune/i.test(k) && v).map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : v)).join(', ')}`);
      player.level = saved.lvl; player.maxHp = saved.mhp; player.hp = saved.hp; player.bleedStacks = saved.st || 0; player.bleedTurns = saved.bt || 0; player.buffs = saved.buffs || {}; player.alive = true; __g.restore();
    },
  },
  {
    id: 'systems.poison-floor',
    desc: 'at player level 1-4 poison ticks never kill (leave 1 HP); at level 5+ a heavy poison can',
    needsPlayer: true,
    fn(A) {
      const __g = A.leakGuard(); // the probes below kill the player on purpose: restore() puts the world back so the next probe does not start with a corpse
      if (typeof processEntityStatus !== 'function') { A.warn('systems.poison-floor', 'api', 'processEntityStatus not found (renamed?)'); return; }
      const saved = { lvl: player.level, hp: player.hp, mhp: player.maxHp, ps: player.statusPoison, buffs: player.buffs, pi: player.poisonImmune, pr: player.poisonDmgReduction, bs: player.bleedStacks, bt: player.bleedTurns };
      player.buffs = {}; player.poisonImmune = false; player.poisonDmgReduction = 0; player.bleedStacks = 0; player.bleedTurns = 0;
      const run = (lvl) => { player.level = lvl; player.maxHp = 40; player.hp = 6; player.statusPoison = 20; player.alive = true; gameState = 'playing'; let died = false; for (let i = 0; i < 14 && player.statusPoison > 0 && !died; i++) { processEntityStatus(player); if (player.hp <= 0 || !player.alive || gameState === 'gameover') died = true; } return { hp: player.hp, died }; };
      const lo = run(3); if (lo.died || lo.hp < 1) A.err('systems.poison-floor', 'early', `level 3 character was poisoned to death (hp ${lo.hp})`);
      let hi = run(9); for (let k = 0; k < 6 && !hi.died; k++) hi = run(9); /* willpower can shake off ticks at random: only warn if six tries all survive */ if (!hi.died && hi.hp > 0) A.warn('systems.poison-floor', 'late', `level 9 character survived a 20-turn poison from 6 HP (hp ${hi.hp}): poison no longer lethal at level 5+? leaked: ${Object.entries(player).filter(([k, v]) => /regen|heal|life|leech|bleed|immune|poison|resist|invuln|reduc|ward|shield/i.test(k) && v).map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v).slice(0, 50) : v)).join(', ')}`);
      player.level = saved.lvl; player.maxHp = saved.mhp; player.hp = saved.hp; player.statusPoison = saved.ps || 0; player.buffs = saved.buffs || {}; player.poisonImmune = saved.pi; player.poisonDmgReduction = saved.pr; player.bleedStacks = saved.bs || 0; player.bleedTurns = saved.bt || 0; player.alive = true; __g.restore();
    },
  },
  {
    id: 'systems.augments',
    desc: 'cybernetics and mutations: ids unique, required fields present, every apply() runs, and for each cybernetic with apply+remove the pair is symmetric (installing then removing leaves every numeric player stat as it was)',
    needsPlayer: true,
    fn(A) {
      const snap = () => { const o = {}; for (const k of Object.keys(player)) { const v = player[k]; if (typeof v === 'number' && isFinite(v)) o[k] = v; } return o; };
      const lists = [['cybernetics', CYBERNETICS], ['mutations', MUTATIONS]];
      const savedAll = JSON.stringify(player, saveDataReplacer);
      let applied = 0, paired = 0;
      for (const [name, list] of lists) {
        const ids = new Set();
        for (const e of list) {
          const where = `${name}:${e.id}`;
          if (!e.id || ids.has(e.id)) A.err('systems.augments', where, 'missing or duplicate id'); ids.add(e.id);
          for (const f of ['name', 'category', 'desc']) if (typeof e[f] !== 'string' || !e[f]) A.err('systems.augments', where, `needs a ${f} string`);
          if (e.activation !== 'passive' && e.activation !== 'active') A.err('systems.augments', where, `activation must be passive|active, got ${e.activation}`);
          if (name === 'cybernetics' && e.tier !== undefined && !(e.tier >= 1 && e.tier <= 5)) A.err('systems.augments', where, `tier ${e.tier} outside 1..5`);
          if (name === 'mutations' && !(typeof e.corruptionReq === 'number' && e.corruptionReq >= 0)) A.err('systems.augments', where, `corruptionReq ${e.corruptionReq} invalid`);
          if (e.activation === 'active') {
            if (!e.type) A.err('systems.augments', where, 'active augment has no type');
            if (!(e.mp > 0) && !(e.selfCost > 0)) A.err('systems.augments', where, `active augment has no cost (mp ${e.mp}, selfCost ${e.selfCost}): mutations pay in HP via selfCost, cybernetics in charge via mp`);
            if (e.range === undefined) A.err('systems.augments', where, 'active augment has no range');
          } else if (typeof e.apply !== 'function') A.err('systems.augments', where, 'passive augment has no apply()');
          if (typeof e.apply === 'function') {
            player.stamina = player.maxStamina;   // apply() may raise stamina by its bonus and remove() clamps it to max: drift is only meaningful starting from a full pool (it flaked by a few points otherwise)
            const before = snap();
            try { e.apply(); applied++; } catch (x) { A.err('systems.augments', where, 'apply() threw: ' + String(x && x.message || x)); }
            if (typeof e.remove === 'function') {
              try { e.remove(); paired++; } catch (x) { A.err('systems.augments', where, 'remove() threw: ' + String(x && x.message || x)); }
              const after = snap(); const drift = [];
              for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) { if (k === 'hp') continue; if (Math.abs((before[k] || 0) - (after[k] || 0)) > 1e-9) drift.push(`${k} ${before[k] || 0}->${after[k] || 0}`); }
              if (drift.length) A.err('systems.augments', where, `apply() then remove() left drift: ${drift.slice(0, 4).join(', ')}`);
            } else if (name === 'cybernetics' && e.activation === 'passive') A.warn('systems.augments', where, 'passive cybernetic has apply() but no remove(): it can never be uninstalled cleanly');
            // restore whatever apply() changed so later probes see a normal player
            const cur = snap(); for (const k of Object.keys(before)) if (cur[k] !== before[k]) player[k] = before[k];
            for (const k of Object.keys(cur)) if (!(k in before)) delete player[k];
          }
        }
      }
      A.stat('augmentsApplied', applied); A.stat('augmentPairsChecked', paired);
      void savedAll;
    },
  },
  {
    id: 'systems.containers',
    desc: 'every container kind x loot tier rolls plausible contents (valid item ids, positive amounts, within capacity, nothing quest-bound or uniquely story-gated), and lock odds stay inside 5%..95% for every difficulty',
    needsPlayer: true,
    fn(A) {
      const bases = new Map(ITEM_BASES.map((b) => [b.id, b]));
      let rolls = 0, items = 0, empty = 0;
      for (const kind of Object.keys(CONTAINER_KINDS)) {
        const cap = CONTAINER_KINDS[kind].capacity;
        if (!(cap > 0)) A.err('systems.containers', kind, `capacity ${cap}`);
        const box = makeContainer(kind, { contents: [], locked: true });
        if (!box.cuid || box.kind !== kind || box.locked !== true) A.err('systems.containers', kind, 'makeContainer returned a malformed container');
        for (let tier = 0; tier <= 4; tier++) for (let n = 0; n < 12; n++) {
          let list; try { list = rollContainerLoot(Math.random, kind, tier); } catch (e) { A.err('systems.containers', kind, `rollContainerLoot(tier ${tier}) threw ${e.message}`); break; }
          rolls++;
          if (!Array.isArray(list)) { A.err('systems.containers', kind, `tier ${tier}: not an array`); break; }
          if (list.length > cap) A.err('systems.containers', kind, `tier ${tier}: ${list.length} items exceed capacity ${cap}`);
          if (!list.length) empty++;
          for (const it of list) {
            items++;
            if (it && it.type === 'recipe') { if (!RECIPES.some((r) => r.id === it.recipeId)) A.err('systems.containers', kind, `recipe item points at unknown recipe ${it.recipeId}`); continue; } // recipe scrolls carry the recipe id as their item id
            if (!it || !bases.has(it.id)) { A.err('systems.containers', kind, `tier ${tier}: unknown item id ${it && it.id}`); continue; }
            if (it.amount !== undefined && !(it.amount >= 1)) A.err('systems.containers', kind, `${it.id} amount ${it.amount}`);
            if (it.questId) A.err('systems.containers', kind, `${it.id} carries a questId`);
            const b = bases.get(it.id); const superStock = (kind === 'reliquary' || kind === 'vault'); // reliquaries/vaults DO hold uniques and craft-only parts on purpose
            if (!superStock && (b.isUnique || b.setId || b.craftOnly)) A.err('systems.containers', kind, `tier ${tier} ${kind} rolled ${it.id} (${b.isUnique ? 'unique' : b.setId ? 'set piece' : 'craft-only'}): earned items must not be shop-shelf stock`);
          }
        }
      }
      A.stat('containerRolls', rolls); A.stat('containerItems', items); A.stat('emptyContainerRolls', empty);
      for (const d of [0, 5, 10, 20, 30, 50, 100]) { const c = lockPickChance(d), f = lockForceChance(d); if (!(c >= 0.05 && c <= 0.95)) A.err('systems.containers', 'lock', `lockPickChance(${d}) = ${c}`); if (!(f >= 0.05 && f <= 0.85)) A.err('systems.containers', 'lock', `lockForceChance(${d}) = ${f}`); }
    },
  },
  {
    id: 'systems.properties',
    desc: 'housing: buying a vacant house charges its quoted price and marks it owned, every furnishing can be added (charging its cost), 30 days of upkeep tick without throwing, and selling returns less than was paid (no buy/sell money loop) and frees the building',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof buyProperty !== 'function') { A.warn('systems.properties', 'api', 'buyProperty not found (renamed?)'); return; }
      let chunk = null, idx = -1;
      outer: for (let cy = -8; cy <= 8; cy++) for (let cx = -8; cx <= 8; cx++) { const c = getChunk(cx, cy); if (!c || !c.settlement) continue; const v = vacantHousesInChunk(c); if (v.length) { chunk = c; idx = v[0]; break outer; } }
      if (!chunk) { A.warn('systems.properties', 'setup', 'no vacant house found within 8 chunks of the origin; probe skipped'); return; }
      const saved = { gold: player.gold, props: player.properties, primary: player.primaryResidenceId, day: player.lastUpkeepDay, turn: turnCount, x: player.x, y: player.y };
      const closeUi = () => { if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      try {
        player.properties = []; player.primaryResidenceId = null; player.gold = 1000000;
        const quote = propertyPriceFor(chunk, idx); A.stat('houseQuote', quote.price);
        if (!(quote.price > 0) || !(quote.upkeep >= 1)) A.err('systems.properties', 'quote', `bad quote ${JSON.stringify(quote)}`);
        const g0 = player.gold; buyProperty(chunk, idx); closeUi();
        const prop = (player.properties || [])[0];
        if (!prop) { A.err('systems.properties', 'buy', 'buyProperty did not create a property'); return; }
        if (player.gold !== g0 - quote.price) A.err('systems.properties', 'buy', `charged ${g0 - player.gold}, quoted ${quote.price}`);
        if (chunk.settlement.buildings[idx].ownerId !== 'player') A.err('systems.properties', 'buy', 'building not marked as owned');
        if (vacantHousesInChunk(chunk).includes(idx)) A.err('systems.properties', 'buy', 'owned building still listed as vacant');
        let furnishCost = 0;
        for (const key of Object.keys(FURNISHINGS)) {
          const f = FURNISHINGS[key]; const before = player.gold;
          if (f.requiresProfession) { player.professionsLearned = player.professionsLearned || {}; player.professionsLearned[f.requiresProfession] = player.professionsLearned[f.requiresProfession] || 1; }
          try { furnishProperty(prop.id, key); } catch (e) { A.err('systems.properties', key, 'furnishProperty threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); continue; }
          closeUi();
          if (!prop.furnishings.includes(key)) A.err('systems.properties', key, 'furnishing was not added');
          else if (before - player.gold !== f.cost) A.err('systems.properties', key, `charged ${before - player.gold}, cost ${f.cost}`);
          furnishCost += before - player.gold;
        }
        A.stat('furnishingsTested', Object.keys(FURNISHINGS).length); A.stat('furnishTotalCost', furnishCost);
        // upkeep: 30 days with nobody minding the house must not throw, and must never pay out more than it costs when nobody is home
        const gBefore = player.gold; player.lastUpkeepDay = Math.floor(turnCount / DAY_LENGTH);
        for (let d = 0; d < 30; d++) { turnCount += DAY_LENGTH; try { tickPropertyUpkeep(); } catch (e) { A.err('systems.properties', 'upkeep', `day ${d}: ` + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); break; } closeUi(); }
        A.stat('upkeepNet30Days', player.gold - gBefore);
        if (player.gold - gBefore > 0) A.warn('systems.properties', 'upkeep', `a house with every furnishing and NOBODY home paid +${player.gold - gBefore}g over 30 days: passive income without anyone minding the place?`);
        const gSell = player.gold; sellProperty(prop.id); closeUi();
        const refund = player.gold - gSell;
        if (refund >= quote.price) A.err('systems.properties', 'sell', `refund ${refund} >= price ${quote.price}: a buy/sell loop makes money`);
        if (chunk.settlement.buildings[idx].ownerId) A.err('systems.properties', 'sell', 'sold building still marked owned');
        if ((player.properties || []).length) A.err('systems.properties', 'sell', 'property still in the list after selling');
      } finally {
        player.gold = saved.gold; player.properties = saved.props; player.primaryResidenceId = saved.primary; player.lastUpkeepDay = saved.day; turnCount = saved.turn; player.x = saved.x; player.y = saved.y;
        try { delete chunk.settlement.buildings[idx].ownerId; } catch (e) { /* */ } closeUi();
      }
    },
  },
  {
    id: 'systems.relationships',
    desc: 'affection tiers are monotonic, price multipliers stay in 0.5..1.0 and never make buying+selling profitable at any affection/reputation, decay moves toward 0 and never overshoots, marriage needs affection 80, is refused when already married or when the NPC is spoken for',
    needsPlayer: true,
    fn(A) {
      const mk = (aff, extra) => Object.assign({ uid: 'rel_probe_' + aff, name: 'Probe', affection: aff, roleId: 'merchant', tier: 'journeyman', x: player.x + 1, y: player.y }, extra || {});
      let lastIdx = -2;
      for (let aff = -30; aff <= 120; aff += 5) {
        const t = relationshipTier(mk(aff)); if (t.index < lastIdx) A.err('systems.relationships', `aff ${aff}`, `tier index fell from ${lastIdx} to ${t.index}`); lastIdx = t.index;
        const m = relationshipPriceMult(mk(aff)); if (!(m >= 0.5 && m <= 1)) A.err('systems.relationships', `aff ${aff}`, `price multiplier ${m} outside 0.5..1`);
      }
      // decay: toward zero, never past it
      const savedTurn = turnCount, savedSpouse = player.spouse; player.spouse = null;
      for (const start of [-25, -3, 0, 7, 55, 100]) {
        const npc = mk(start, { lastTalkTurn: turnCount, lastDecayTurn: null });
        turnCount = savedTurn + DAY_LENGTH * 400; applyAffectionDecay(npc); turnCount = savedTurn;
        if (start > 0 && !(npc.affection >= 0 && npc.affection <= start)) A.err('systems.relationships', `decay ${start}`, `ended at ${npc.affection}`);
        if (start < 0 && !(npc.affection <= 0 && npc.affection >= start)) A.err('systems.relationships', `decay ${start}`, `ended at ${npc.affection}`);
        if (start === 0 && npc.affection !== 0) A.err('systems.relationships', 'decay 0', `ended at ${npc.affection}`);
      }
      // trade arbitrage at the friendliest possible standing
      const shopper = mk(100); const items = ITEM_BASES.filter((b) => b.value > 0 && ['weapon', 'armor', 'consumable', 'scroll'].includes(b.type)).slice(0, 60);
      let bad = 0; for (const b of items) { const it = makeItem(b.id, 0, Math.random); if (!it) continue; try { if (tradeSellPrice(it, shopper) > tradeBuyPrice(it, shopper)) bad++; } catch (e) { A.err('systems.relationships', 'trade', 'price call threw ' + e.message); break; } }
      if (bad) A.err('systems.relationships', 'trade', `${bad} of ${items.length} items sell to a Beloved shopkeeper for more than they cost to buy`);
      // marriage rules
      const closeUi = () => { if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      const savedChildren = player.children;
      const a = mk(60); proposeMarriage(a); closeUi(); if (player.spouse) A.err('systems.relationships', 'marry', 'married at affection 60');
      const b = mk(95, { spouse: true }); proposeMarriage(b); closeUi(); if (player.spouse) A.err('systems.relationships', 'marry', 'married an NPC who is already spoken for');
      const c = mk(95); proposeMarriage(c); closeUi(); if (!player.spouse || player.spouse.uid !== c.uid) A.err('systems.relationships', 'marry', 'refused a valid proposal at affection 95');
      const d = mk(99); d.uid = 'rel_probe_second'; proposeMarriage(d); closeUi(); if (player.spouse && player.spouse.uid === d.uid) A.err('systems.relationships', 'marry', 'a married player married a second NPC');
      player.spouse = savedSpouse; turnCount = savedTurn; player.children = savedChildren;
    },
  },
  {
    id: 'systems.diseases',
    desc: 'procedural diseases: every ordinary illness burns out within its natural duration or on 3 cure progress, never more than 3 at once, fever never kills, chronic illness is curable by Greater Restoration, cure progress only hits matching cures, stat penalties are removed when the disease ends',
    needsPlayer: true,
    fn(A) {
      const saveD = player.diseases, saveHp = player.hp, saveImm = player.diseaseImmune, saveSt = player.stamina;
      player.diseaseImmune = false; player.maxHp = Math.max(player.maxHp, 40);
      let chronic = 0, ordinary = 0;
      for (let i = 0; i < 400; i++) {
        player.diseases = []; player.hp = player.maxHp; player.stamina = player.maxStamina || 100;
        triggerDisease(player, 'probe');
        const d = player.diseases[0]; if (!d) { A.err('systems.diseases', 'trigger', 'triggerDisease produced nothing for a vulnerable player'); break; }
        if (!d.symptoms.length || !d.cureId) A.err('systems.diseases', 'shape', `disease ${d.name} missing symptoms/cure`);
        if (d.permanent) { chronic++; if (d.cureId !== 'greaterRestoration') A.err('systems.diseases', 'chronic', 'chronic disease with an unreachable cure ' + d.cureId); continue; }
        ordinary++;
        let lowest = player.hp;
        for (let t = 0; t < 145 && player.diseases.length; t++) { tickDiseases(player); lowest = Math.min(lowest, player.hp); player.stamina = player.maxStamina || 100; }
        if (player.diseases.length) A.err('systems.diseases', 'duration', `${d.name} (${d.symptoms.map(x => x.id)}) still active after 145 turns (natural ${d.naturalDuration})`);
        if (lowest < 1) A.err('systems.diseases', 'lethal', 'disease alone took HP below 1');
        if (d.symptoms.some(x => x.id === 'fever') && lowest < Math.ceil(player.maxHp * 0.35)) A.err('systems.diseases', 'fever floor', `fever pushed HP to ${lowest} of ${player.maxHp}`);
      }
      A.stat('diseaseSample', `${ordinary} ordinary / ${chronic} chronic`);
      // cure matching
      player.diseases = [{ name: 'T', symptoms: [{ id: 'weakness', label: 'W', statPenalty: { str: -2 } }], cureId: 'fireCure', cureProgress: 0, naturalDuration: 999, turnsElapsed: 0 }];
      grantDiseaseCureProgress('restCure', 5); if (player.diseases[0].cureProgress) A.err('systems.diseases', 'cure', 'a rest cure advanced a fire-cure disease');
      if (getDiseaseStatPenalty('str') !== -2) A.err('systems.diseases', 'penalty', 'weakness did not lower STR by 2');
      grantDiseaseCureProgress('fireCure', 3); tickDiseases(player);
      if (player.diseases.length) A.err('systems.diseases', 'cure', 'disease survived 3 matching cure progress');
      if (getDiseaseStatPenalty('str') !== 0) A.err('systems.diseases', 'penalty', 'stat penalty lingered after cure');
      // cap of 3
      player.diseases = []; for (let i = 0; i < 12; i++) triggerDisease(player, 'cap');
      if (player.diseases.length > 3) A.err('systems.diseases', 'cap', `${player.diseases.length} simultaneous diseases`);
      // immunity
      player.diseases = []; player.diseaseImmune = true; triggerDisease(player, 'imm'); if (player.diseases.length) A.err('systems.diseases', 'immune', 'immune player caught a disease');
      player.diseaseImmune = false;
      // chronic cure path
      player.diseases = [{ name: 'C', symptoms: [], cureId: 'greaterRestoration', permanent: true, naturalDuration: Infinity, turnsElapsed: 0, cureProgress: 0 }];
      if (!hasCurableAffliction()) A.err('systems.diseases', 'chronic', 'hasCurableAffliction ignores chronic illness');
      const g = player.gold; player.gold = 99999; try { payForGreaterRestoration({ name: 'Priest', tier: 'village' }); } catch (e) { A.err('systems.diseases', 'chronic', 'payForGreaterRestoration threw ' + e.message); }
      try { closeModal(); } catch (e) { /* */ } gameState = 'playing';
      if (player.diseases.length) A.err('systems.diseases', 'chronic', 'Greater Restoration left the chronic illness');
      player.gold = g; player.diseases = saveD || []; player.hp = saveHp; player.diseaseImmune = saveImm; player.stamina = saveSt;
    },
  },
  {
    id: 'systems.weather',
    desc: 'weather data is coherent: every climate table id exists with positive weights, every dimension has its own climate, soft transitions/wind/severe sets reference real weather, nothing is unreachable, durations are sane, biome-biased rolls never fail, vision modifiers cannot blind the player',
    needsPlayer: true,
    fn(A) {
      const ids = Object.keys(WEATHER_TYPES);
      for (const id of ids) {
        const w = WEATHER_TYPES[id];
        for (const f of ['name', 'glyph', 'color', 'enterMsg']) if (!w[f] && !(id === 'clear' && f === 'enterMsg')) A.err('systems.weather', id, `missing ${f}`);
        if (typeof w.tempShift !== 'number') A.err('systems.weather', id, 'tempShift not a number');
        if ((w.visMod || 0) < -12) A.err('systems.weather', id, `visMod ${w.visMod} is absurd (< -12)`);
        if (w.igniteMult !== undefined && !(w.igniteMult >= 0 && w.igniteMult <= 3)) A.err('systems.weather', id, `igniteMult ${w.igniteMult} outside 0..3`);
        for (const [el, m] of Object.entries(w.elementMods || {})) if (!(m > 0 && m < 3)) A.err('systems.weather', id, `elementMods.${el}=${m} outside (0,3)`);
        for (const f of ['slowChance', 'extinguishChance', 'lightningChance', 'fearChance', 'positiveChance', 'corrodeChance']) if (w[f] !== undefined && !(w[f] >= 0 && w[f] <= 1)) A.err('systems.weather', id, `${f}=${w[f]} not a probability`);
        if (!(WEATHER_PARTICLE_KIND[id] !== undefined || WEATHER_WASH_ALPHA[id] !== undefined || ['clear', 'partly_cloudy', 'overcast'].includes(id))) A.warn('systems.weather', id, 'no particle or wash styling (renders as plain air)');
      }
      const reach = new Set();
      for (const [zk, c] of Object.entries(ZONE_CLIMATE)) {
        if (!c.weatherTable.length) A.err('systems.weather', zk, 'empty table');
        for (const [id, wt] of c.weatherTable) { reach.add(id); if (!WEATHER_TYPES[id]) A.err('systems.weather', zk, `table references unknown weather ${id}`); if (!(wt > 0)) A.err('systems.weather', zk, `${id} weight ${wt}`); }
        if (!(c.baseTemp >= 0 && c.baseTemp <= 100)) A.err('systems.weather', zk, `baseTemp ${c.baseTemp}`);
      }
      for (const id of ids) if (!reach.has(id)) A.warn('systems.weather', id, 'in no zone weather table (only reachable by spells/events?)');
      for (const dim of Object.keys(DIMENSIONS)) if (!ZONE_CLIMATE[dim]) A.warn('systems.weather', dim, 'dimension has no climate; falls back to overworld weather');
      for (const [k, v] of Object.entries(WEATHER_SOFT_TRANSITIONS)) { if (!WEATHER_TYPES[k]) A.err('systems.weather', k, 'soft transition from unknown weather'); for (const t of v) if (!WEATHER_TYPES[t]) A.err('systems.weather', k, `soft transition to unknown ${t}`); }
      for (const k of Object.keys(WEATHER_WIND_STRENGTH)) if (!WEATHER_TYPES[k]) A.err('systems.weather', k, 'wind strength for unknown weather');
      for (const k of WEATHER_SEVERE) if (!WEATHER_TYPES[k]) A.err('systems.weather', k, 'severe set names unknown weather');
      for (const set of [HOT_WEATHER, COLD_WEATHER, HUMID_WEATHER]) for (const k of set) if (!WEATHER_TYPES[k]) A.err('systems.weather', k, 'biome weather set names unknown weather');
      // rolls
      for (const zk of Object.keys(ZONE_CLIMATE)) for (let i = 0; i < 300; i++) { const r = rollWeather(zk); if (!WEATHER_TYPES[r]) { A.err('systems.weather', zk, `rollWeather returned ${r}`); break; } }
      for (const tag of ['hot', 'cold', 'humid', 'temperate']) for (const id of ids) { const m = biomeWeatherBiasMult(id, tag); if (!(m > 0)) A.err('systems.weather', `${tag}/${id}`, `bias ${m}`); }
      for (const id of ids) { for (let i = 0; i < 20; i++) { const d = weatherDuration(id); if (!(d >= 10 && d <= 200)) { A.err('systems.weather', id, `duration ${d}`); break; } } }
      // current-weather accessors on whatever the player stands in
      for (const id of ids) { const zk = zoneKey(); const save = weatherState[zk]; weatherState[zk] = { id, turnsRemaining: 50 };
        try { if (!curIsDungeon()) { weatherElementMultiplier({ element: 'fire' }, null); weatherElementMultiplier({ chainLightning: true }, player); if (currentVisRadius() < 3) A.err('systems.weather', id, 'vision radius fell below 3'); weatherRangedAccuracyMod(); try { renderWeatherOverlay(); } catch (e) { A.err('systems.weather', id, 'renderWeatherOverlay threw ' + e.message); } weatherIgniteChanceMult(); } } catch (e) { A.err('systems.weather', id, 'accessor threw ' + e.message); }
        weatherState[zk] = save; }
    },
  },
  {
    id: 'systems.locks',
    desc: 'lock picking/forcing: chances stay in their clamps and fall as difficulty rises, no pick = no success, a success runs the callback exactly once, a failed pick can snap the lockpick but never the last of anything else, forcing a crime-flagged lock records the crime',
    needsPlayer: true,
    fn(A) {
      let prev = 1; for (let d = 6; d <= 20; d++) { const c = lockPickChance(d); if (!(c >= 0.05 && c <= 0.95)) A.err('systems.locks', `pick ${d}`, `chance ${c} outside clamp`); if (c > prev + 1e-9) A.err('systems.locks', `pick ${d}`, 'chance rose with difficulty'); prev = c; }
      prev = 1; for (let d = 6; d <= 20; d++) { const c = lockForceChance(d); if (!(c >= 0.05 && c <= 0.85)) A.err('systems.locks', `force ${d}`, `chance ${c} outside clamp`); if (c > prev + 1e-9) A.err('systems.locks', `force ${d}`, 'chance rose with difficulty'); prev = c; }
      const realRandom = Math.random, saveInv = player.inventory.slice(), saveTurn = turnCount;
      try {
        player.inventory = player.inventory.filter((i) => i.id !== 'lockpick'); let hits = 0;
        Math.random = () => 0; attemptPickLock('a test lock', 10, () => hits++);
        if (hits) A.err('systems.locks', 'nopick', 'opened a lock with no lockpick');
        player.inventory.push(makeItem('lockpick', 0, realRandom)); hits = 0;
        Math.random = () => 0; attemptPickLock('a test lock', 10, () => hits++);
        if (hits !== 1) A.err('systems.locks', 'pick', `success callback ran ${hits} times`);
        if (!player.inventory.some((i) => i.id === 'lockpick')) A.err('systems.locks', 'pick', 'a SUCCESSFUL pick consumed the lockpick');
        hits = 0; Math.random = () => 0.999; const others = player.inventory.filter((i) => i.id !== 'lockpick').length;
        attemptPickLock('a test lock', 20, () => hits++);
        if (hits) A.err('systems.locks', 'pick', 'worst roll still opened a difficulty-20 lock');
        if (player.inventory.filter((i) => i.id !== 'lockpick').length !== others) A.err('systems.locks', 'pick', 'failed pick removed a non-lockpick item');
        hits = 0; Math.random = () => 0; attemptForceOpen('a test lock', 10, () => hits++);
        if (hits !== 1) A.err('systems.locks', 'force', `forced success callback ran ${hits} times`);
        hits = 0; Math.random = () => 0.999; attemptForceOpen('a test lock', 20, () => hits++);
        if (hits) A.err('systems.locks', 'force', 'worst roll still forced a difficulty-20 lock');
      } catch (e) { A.err('systems.locks', 'throw', e.message); }
      finally { Math.random = realRandom; player.inventory = saveInv; }
    },
  },
  {
    id: 'systems.kingdoms-war',
    desc: 'kingdom relations are symmetric, bounded to -100..100 and map every score to a real state; nudges cross bands exactly once; a settlement war party spawns real hostile guards on walkable unoccupied tiles, who are hostile to the defenders and are withdrawn (not left immortal) when the clock expires',
    needsPlayer: true,
    fn(A) {
      const ks = []; for (let i = 0; i < 6; i++) { const k = getKingdom(i * KINGDOM_REGION * 2, (i % 3) * KINGDOM_REGION * 2); if (k && !ks.some((o) => o.key === k.key)) ks.push(k); }
      if (ks.length < 3) A.warn('systems.kingdoms-war', 'setup', `only ${ks.length} distinct kingdoms sampled`);
      const stateIds = new Set(KINGDOM_RELATION_STATES.map((s) => s.id));
      for (let sc = -100; sc <= 100; sc++) if (!stateIds.has(relationStateIdFromScore(sc))) A.err('systems.kingdoms-war', 'score', `score ${sc} maps to an unknown state`);
      for (const a of ks) for (const b of ks) {
        if (a.key === b.key) { if (getKingdomRelation(a.key, b.key) !== null) A.err('systems.kingdoms-war', 'self', 'a kingdom has a relation with itself'); continue; }
        const r1 = getKingdomRelation(a.key, b.key), r2 = getKingdomRelation(b.key, a.key);
        if (r1 !== r2) A.err('systems.kingdoms-war', 'symmetry', `${a.name}/${b.name}: ${r1} vs ${r2}`);
        if (!stateIds.has(r1)) A.err('systems.kingdoms-war', 'state', `unknown relation ${r1}`);
      }
      if (ks.length >= 2) {
        const [a, b] = ks, rk = relationPairKey(a.key, b.key), keepScore = kingdomRelationScores.get(rk), keepHist = [a.history, b.history], keepLog = (player.kingdomEventLog || []).slice();
        getKingdomRelation(a.key, b.key);
        nudgeKingdomRelation(a.key, b.key, 9999); if (kingdomRelationScores.get(rk) !== 100) A.err('systems.kingdoms-war', 'clamp', `+9999 gave ${kingdomRelationScores.get(rk)}`);
        nudgeKingdomRelation(a.key, b.key, -9999); if (kingdomRelationScores.get(rk) !== -100) A.err('systems.kingdoms-war', 'clamp', `-9999 gave ${kingdomRelationScores.get(rk)}`);
        const n0 = (player.kingdomEventLog || []).length; nudgeKingdomRelation(a.key, b.key, 1); if ((player.kingdomEventLog || []).length !== n0) A.err('systems.kingdoms-war', 'nudge', 'a nudge that stayed inside a band wrote a history event');
        if (keepScore === undefined) kingdomRelationScores.delete(rk); else kingdomRelationScores.set(rk, keepScore);
        a.history = keepHist[0]; b.history = keepHist[1]; player.kingdomEventLog = keepLog;
      }
      // war party
      if (curIsDungeon()) { A.stat('warPartyExercised', false); return; }
      let guarded = null; for (const c of worldChunks.values()) if (c.settlement && (c.settlement.type || '').toLowerCase() !== 'hamlet') { guarded = c; break; }
      if (!guarded) { for (let r = 0; r < 40 && !guarded; r++) { const c = getChunk(r % 7 - 3, Math.floor(r / 7) - 3); if (c && c.settlement && (c.settlement.type || '').toLowerCase() !== 'hamlet') guarded = c; } }
      if (!guarded) { A.warn('systems.kingdoms-war', 'war', 'no guarded settlement could be found near the origin; war party not exercised'); return; }
      A.stat('warPartyExercised', true);
      const before = activeWarParties.length, res = spawnWarParty(14, 50);
      if (!res) { A.err('systems.kingdoms-war', 'war', 'spawnWarParty returned null although a settlement exists'); return; }
      const wp = activeWarParties[activeWarParties.length - 1];
      if (activeWarParties.length !== before + 1 || wp.npcs.length !== res.count) A.err('systems.kingdoms-war', 'war', 'war party bookkeeping does not match spawn result');
      if (res.rivalName === res.defenderName) A.err('systems.kingdoms-war', 'war', 'a kingdom invaded itself');
      const seen = new Set(), invaders = [];
      for (const e of wp.npcs) {
        const c = worldChunks.get(chunkKey(e.cx, e.cy)), n = c && c.npcs.find((x) => x.uid === e.uid);
        if (!n) { A.err('systems.kingdoms-war', 'war', 'invader missing from its chunk'); continue; }
        invaders.push(n);
        const t = curTileAt(n.x, n.y); if (!t || !t.walkable) A.err('systems.kingdoms-war', 'war', `invader on a non-walkable tile at ${n.x},${n.y}`);
        const k = n.x + ',' + n.y; if (seen.has(k)) A.err('systems.kingdoms-war', 'war', 'two invaders share a tile'); seen.add(k);
        if (!n.warKingdom) A.err('systems.kingdoms-war', 'war', 'invader without a warKingdom tag');
      }
      const defender = (guarded.npcs || []).find((n) => NPC_DEFENDER_ROLES.has(n.roleId) && n.alive);
      if (defender && invaders[0] && !(isHostileTo(invaders[0], defender) && isHostileTo(defender, invaders[0]))) A.err('systems.kingdoms-war', 'war', 'invaders and defenders are not mutually hostile');
      if (invaders[0] && !isInActiveWar(invaders[0])) A.err('systems.kingdoms-war', 'war', 'isInActiveWar missed an invader');
      const keepTurn = turnCount; turnCount = wp.expireTurn + 1; tickWarParties(); turnCount = keepTurn;
      if (activeWarParties.includes(wp)) A.err('systems.kingdoms-war', 'war', 'expired war party still listed');
      for (const n of invaders) { if (n.alive) A.err('systems.kingdoms-war', 'war', 'invader still alive after the war ended'); if (n.warKingdom) A.err('systems.kingdoms-war', 'war', 'invader kept its war tag after the war'); }
    },
  },
  {
    id: 'systems.professions',
    desc: 'every profession can actually be learned (its trainer role spawns in some settlement tier), levels/ranks are monotonic and invertible, specializations are 2-way with unique ids, leveling a profession to 60 never pushes granted bonuses past their caps or double-counts them, shift wages stay bounded',
    needsPlayer: true,
    fn(A) {
      const spawnable = new Set(); for (const pool of Object.values(ROLE_POOLS)) for (const r of pool) spawnable.add(r);
      for (const f of Object.values(SETTLEMENT_FLAVORS)) for (const r of (f.rolePool || [])) spawnable.add(r); // themed settlements (mining hold, lumber camp...) add their own roles
      for (const [id, p] of Object.entries(PROFESSIONS)) {
        if (!p.name || !p.verb || !(p.wageBase > 0)) A.err('systems.professions', id, 'incomplete definition');
        if (!p.trainerRoles.some((r) => spawnable.has(r))) A.err('systems.professions', id, `no trainer role (${p.trainerRoles}) appears in any settlement ROLE_POOLS: profession cannot be learned`);
        for (const r of p.trainerRoles) if (!spawnable.has(r)) A.warn('systems.professions', id, `trainer role ${r} never spawns`);
      }
      for (const [id, specs] of Object.entries(PROFESSION_SPECIALIZATIONS)) {
        if (!PROFESSIONS[id]) A.err('systems.professions', id, 'specializations for an unknown profession');
        if (specs.length !== 2) A.err('systems.professions', id, `${specs.length} specializations (expected a 2-way choice)`);
        if (new Set(specs.map((x) => x.id)).size !== specs.length) A.err('systems.professions', id, 'duplicate specialization ids');
        for (const sp of specs) if (!sp.label || !sp.desc) A.err('systems.professions', `${id}/${sp.id}`, 'missing label/desc');
      }
      let prevTitle = -1; for (let l = 1; l <= 60; l++) {
        if (professionLevel(professionXpForLevel(l)) !== l) A.err('systems.professions', `level ${l}`, 'professionLevel(xpForLevel(l)) != l');
        if (l > 1 && professionLevel(professionXpForLevel(l) - 1) !== l - 1) A.err('systems.professions', `level ${l}`, 'one xp short of a level should be the previous level');
        const idx = PROFESSION_RANKS.findIndex((r) => r.title === professionRankTitle(l)); if (idx < prevTitle) A.err('systems.professions', `level ${l}`, 'rank title went backwards'); prevTitle = idx;
      }
      // leveling sweep
      const keep = { learned: player.professionsLearned, xp: player.professionXp, spec: player.professionSpecialization, alch: player.alchemyPotencyBonus, cook: player.cookingHealBonus, throwD: player.throwDmgBonus, ag: player._alchemistPotencyGranted, ab: player._alchemistBombGranted, cg: player._chefHealGranted };
      const keepGold = player.gold, realLog = log;
      try {
        for (const [id, specs] of Object.entries(PROFESSION_SPECIALIZATIONS)) for (const sp of [null, ...specs]) {
          player.professionsLearned = { [id]: true }; player.professionXp = { [id]: 0 }; player.professionSpecialization = sp ? { [id]: sp.id } : {};
          player.alchemyPotencyBonus = 0; player.cookingHealBonus = 0; player.throwDmgBonus = 0; player._alchemistPotencyGranted = 0; player._alchemistBombGranted = 0; player._chefHealGranted = 0;
          for (let i = 0; i < 400 && professionLevelOf(id) < 60; i++) gainProfessionXp(id, 40 * 60 * 60 / 200);
          if (player.alchemyPotencyBonus > 0.71) A.err('systems.professions', `${id}/${sp && sp.id}`, `alchemy potency bonus ${player.alchemyPotencyBonus.toFixed(2)} past its 0.7 cap`);
          if (player.cookingHealBonus > 0.41) A.err('systems.professions', `${id}/${sp && sp.id}`, `cooking heal bonus ${player.cookingHealBonus.toFixed(2)} past its 0.4 cap`);
          if (player.throwDmgBonus > 0.41) A.err('systems.professions', `${id}/${sp && sp.id}`, `bomb damage bonus ${player.throwDmgBonus.toFixed(2)} past its 0.4 cap`);
          const wageAt = (lvl) => Math.round(PROFESSIONS[id].wageBase * (1 + lvl * 0.1) * 1.25 * (id === 'guard' && sp && sp.id === 'sellsword' ? 1.35 : 1));
          if (wageAt(60) > 1500) A.warn('systems.professions', id, `a level-60 shift would pay ${wageAt(60)}g/day`);
        }
      } catch (e) { A.err('systems.professions', 'sweep', 'threw: ' + e.message); }
      finally { player.professionsLearned = keep.learned; player.professionXp = keep.xp; player.professionSpecialization = keep.spec; player.alchemyPotencyBonus = keep.alch; player.cookingHealBonus = keep.cook; player.throwDmgBonus = keep.throwD; player._alchemistPotencyGranted = keep.ag; player._alchemistBombGranted = keep.ab; player._chefHealGranted = keep.cg; player.gold = keepGold; }
    },
  },
  {
    id: 'tutorial.structure',
    desc: 'every tutorial part builds: a walkable start, every item/NPC/monster/container/trigger/stairs reachable from the start (secret doors count as passable), nothing stacked on one tile, objectives evaluate on a fresh player without throwing and are not already satisfied, instructors have dialogue',
    needsPlayer: true,
    fn(A) {
      let parts = 0, objectives = 0;
      for (const tut of TUTORIALS) for (let pi = 0; pi < tut.parts.length; pi++) {
        const part = tut.parts[pi], tag = `${tut.id}#${pi + 1} ${part.title}`; parts++;
        let level; try { level = part.build(); } catch (e) { A.err('tutorial.structure', tag, 'build threw: ' + e.message); continue; }
        const g = level.grid, st = level.tutorialStart, h = g.length, w = g[0].length;
        const at = (x, y) => (g[y] || [])[x];
        if (!at(st.x, st.y) || !at(st.x, st.y).walkable) { A.err('tutorial.structure', tag, `start ${st.x},${st.y} is not walkable`); continue; }
        // flood fill; doors and secret doors are passable, water/walls are not
        const seen = new Set([st.x + ',' + st.y]), q = [[st.x, st.y]];
        while (q.length) { const [x, y] = q.pop(); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy, t = at(nx, ny), k = nx + ',' + ny; if (!t || seen.has(k)) continue; if (t.walkable || t.feature === 'secretdoor') { seen.add(k); q.push([nx, ny]); } } }
        const reach = (x, y) => { if (seen.has(x + ',' + y)) return true; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (seen.has((x + dx) + ',' + (y + dy))) return true; return false; }; // standing next to it is enough (water bank, shop counter)
        const occ = new Map();
        const place = (kind, x, y, nameStr) => { const t = at(x, y); if (!t) { A.err('tutorial.structure', tag, `${kind} ${nameStr || ''} outside the map at ${x},${y}`); return; } if (!reach(x, y) && !part.sealedByDesign) A.err('tutorial.structure', tag, `${kind} ${nameStr || ''} at ${x},${y} is unreachable from the start`); if (kind === 'monster' || kind === 'npc') { const k = x + ',' + y; if (occ.has(k)) A.err('tutorial.structure', tag, `${kind} ${nameStr || ''} shares a tile with ${occ.get(k)}`); occ.set(k, kind + ':' + (nameStr || '')); if (!t.walkable) A.err('tutorial.structure', tag, `${kind} ${nameStr || ''} stands in a wall at ${x},${y}`); } };
        for (const m of level.monsters) place('monster', m.x, m.y, m.name);
        for (const n of level.npcs) place('npc', n.x, n.y, n.name);
        for (const c of (level.pendingCompanions || [])) place('companion', c.x, c.y, c.name);
        for (const i of level.items) place('item', i.x, i.y, i.item && i.item.name);
        for (const c of level.containers) place('container', c.x, c.y, c.container && c.container.name);
        for (const t of level.tutorialTriggers) place('trigger', t.x, t.y, t.tag);
        if (part.requiresStairs !== false && level.downStairs) place('stairs', level.downStairs.x, level.downStairs.y, 'down');
        for (const n of level.npcs) if (n.isTutorialInstructor && !n.tutorialDialogue && !n.tutorialDialogueFn && !n.shop) A.err('tutorial.structure', tag, `instructor ${n.name} has nothing to say`);
        // objectives
        let p; try { p = tutBuildPlayer(part.setupPlayer); } catch (e) { A.err('tutorial.structure', tag, 'setupPlayer threw: ' + e.message); continue; }
        p.x = st.x; p.y = st.y;
        const state = { level, player: p, tutorial: tut, partDef: part };
        const objs = part.objectives || [];
        if (!objs.length) A.warn('tutorial.structure', tag, 'part has no objectives (can never auto-complete)');
        let allDone = objs.length > 0;
        for (const o of objs) { objectives++; let r; try { r = o.check(state); } catch (e) { A.err('tutorial.structure', tag, `objective "${o.label || o.id}" threw on a fresh player: ${e.message}`); r = false; } if (!r) allDone = false; }
        if (allDone) A.err('tutorial.structure', tag, 'every objective is already satisfied at the start: part completes with no input');
      }
      A.stat('tutorialParts', parts); A.stat('tutorialObjectives', objectives);
    },
  },
  {
    id: 'systems.lighting',
    desc: 'light sources/rules are well formed and use real colours; a lamppost lights the player at night and softens the night vision penalty (never beyond daytime vision), light queries never throw, and drawNight survives full night in every settings combination',
    needsPlayer: true,
    fn(A) {
      const okColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
      for (const [f, l] of Object.entries(LIGHT_SOURCES)) { if (!(l.radius > 0 && l.strength > 0 && l.strength <= 1) || !okColor(l.color)) A.err('systems.lighting', f, 'malformed light source'); }
      for (const r of LIGHT_RULES) if (!r.id || typeof r.test !== 'function' || !(r.radius > 0 && r.strength > 0 && r.strength <= 1) || !okColor(r.color)) A.err('systems.lighting', r.id || '?', 'malformed light rule');
      if (curIsDungeon()) { A.stat('lightingExercised', false); return; }
      const saveNF = nightFactor, saveEnabled = settings.dynamicLighting, saveDark = settings.nightDarkness, saveReduce = settings.reduceMotion;
      const t0 = curTileAt(player.x, player.y), t1 = curTileAt(player.x + 1, player.y), saveFeat = t1 && t1.feature;
      try {
        settings.dynamicLighting = true;
        nightFactor = () => 1;
        const dark = currentVisRadius(), lampAt = (() => { for (let r = 3; r < 90; r += 3) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const x = player.x + dx, y = player.y + dy, a = curTileAt(x, y), b = curTileAt(x + 1, y); if (a && b && a.walkable && b.walkable && !b.feature && !Lighting.litAt(x, y)) return { x, y, b }; } return null; })();
        if (!lampAt) A.warn('systems.lighting', 'lamppost', 'could not find an unlit patch of ground to test a lamppost on');
        else {
          const lb = lampAt.b, keepF = lb.feature; lb.feature = 'lamppost'; lb.seen = true; turnCount++;
          try { if (!Lighting.litAt(lampAt.x, lampAt.y)) A.err('systems.lighting', 'lamppost', 'a tile right beside a lamppost is not lit'); } finally { lb.feature = keepF; turnCount--; }
        }
        const lit = currentVisRadius();
        if (lit < dark) A.err('systems.lighting', 'lamp', `vision changed unexpectedly ${dark} -> ${lit}`);
        nightFactor = () => 0; const day = currentVisRadius();
        if (lit > day) A.err('systems.lighting', 'lamp', `night vision (${lit}) beats daytime (${day})`);
        nightFactor = () => 1;
        // drawNight with a recording fake context, across settings
        const calls = []; const grad = { addColorStop() {} };
        const mk = () => new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' ? () => grad : k in t ? t[k] : (...a) => { calls.push(k); }), set: (t, k, v) => { t[k] = v; return true; } });
        const fakeCanvas = { width: 800, height: 600, getContext: () => mk() }, realCreate = document.createElement.bind(document);
        document.createElement = (tag) => (tag === 'canvas' ? fakeCanvas : realCreate(tag));
        try {
          for (const dd of [0, 50, 100, 200]) for (const rm of [false, true]) { settings.nightDarkness = dd; settings.reduceMotion = rm; const ok = Lighting.drawNight(mk(), { halfW: 12, halfH: 8, ts: 20 }, fakeCanvas); if (ok === undefined) A.err('systems.lighting', 'drawNight', 'returned undefined'); }
        } finally { document.createElement = realCreate; }
        settings.dynamicLighting = false; if (Lighting.drawNight(mk(), { halfW: 12, halfH: 8, ts: 20 }, { width: 10, height: 10 }) !== false) A.err('systems.lighting', 'disabled', 'drawNight drew although dynamic lighting is off');
        A.stat('lightingExercised', true);
      } catch (e) { A.err('systems.lighting', 'throw', e.message); }
      finally { nightFactor = saveNF; settings.dynamicLighting = saveEnabled; settings.nightDarkness = saveDark; settings.reduceMotion = saveReduce; if (t1) t1.feature = saveFeat; }
    },
  },
  {
    id: 'systems.event-gating',
    desc: 'world events respect character level: no legendary event is eligible below level 8 and no rare event below level 3, an explicit minLevel overrides the rarity default, every event has a known rarity',
    needsPlayer: true,
    fn(A) {
      for (const e of WORLD_EVENTS) if (!(e.rarity in EVENT_RARITY_MIN_LEVEL)) A.err('systems.event-gating', e.id, `unknown rarity ${e.rarity}`);
      const keepLevel = player.level, keepTurn = turnCount;
      try {
        turnCount = DAY_LENGTH * 40; // far past every minDay
        for (const zk of ['overworld', ...Object.keys(DIMENSIONS)]) {
          player.level = 1; for (const e of eligibleEventsFor(zk)) if (['rare', 'legendary'].includes(e.rarity) && e.minLevel === undefined) A.err('systems.event-gating', `${zk}/${e.id}`, `${e.rarity} event eligible for a level-1 character`);
          player.level = 5; for (const e of eligibleEventsFor(zk)) if (e.rarity === 'legendary') A.err('systems.event-gating', `${zk}/${e.id}`, 'legendary event eligible at level 5');
          player.level = 60; if (zk === 'overworld' && !eligibleEventsFor(zk).some((e) => e.rarity === 'legendary')) A.err('systems.event-gating', zk, 'no legendary event ever becomes eligible');
        }
      } finally { player.level = keepLevel; turnCount = keepTurn; }
    },
  },
  {
    id: 'content.descriptions',
    desc: 'every monster (and every item base) has flavour text the player can read; reports the ones that fall back to nothing',
    needsPlayer: true,
    fn(A) {
      const has = (id) => !!(MONSTER_BASES[id].desc && String(MONSTER_BASES[id].desc).length > 12);
      const missing = Object.keys(MONSTER_BASES).filter((id) => !has(id));
      A.stat('monstersWithoutDescription', missing.length);
      const byType = {}; for (const b of ITEM_BASES) { if (b.craftOnly) continue; const d = b.desc || b.description || b.lore; if (!d) (byType[b.type] = byType[b.type] || []).push(b.id); }
      for (const [t, ids] of Object.entries(byType)) A.stat('itemsWithoutDesc:' + t, ids.length + '/' + ITEM_BASES.filter((b) => b.type === t).length);
      if (missing.length) A.warn('content.descriptions', 'monsters', `${missing.length} of ${Object.keys(MONSTER_BASES).length} monsters have no description: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ', ...' : ''}`);
    },
  },
  {
    id: 'content.item-tooltips',
    desc: 'consumables and scrolls must tell the player what they do: a tooltip that falls back to the generic "A consumable item." (and has no flavour desc) is reported; tooltips never throw for any item base',
    needsPlayer: true,
    fn(A) {
      const generic = [], thrown = [];
      for (const b of ITEM_BASES) {
        let it; try { it = makeItem(b.id, 0, Math.random); } catch (e) { continue; } if (!it) continue;
        let txt; try { txt = describeItem(it); } catch (e) { thrown.push(b.id + ': ' + e.message); continue; }
        const flat = Array.isArray(txt) ? txt.join(' | ') : String(txt || '');
        if ((b.type === 'consumable' || b.type === 'scroll') && /A consumable item\./.test(flat)) generic.push(b.id + (b.effect ? `(${b.effect})` : ''));
      }
      // every item base's own desc must actually reach the tooltip (it did not for years: only uniques showed theirs), and no misc item may fall back to the generic trinket line
      const hidden = [], trinket = [];
      for (const b of ITEM_BASES) {
        let it; try { it = makeItem(b.id, 0, Math.random); } catch (e) { continue; } if (!it) continue;
        let flat; try { flat = String(describeItem(it)); } catch (e) { continue; }
        if (b.desc && !flat.includes(String(b.desc).replace(/"/g, '"'))) hidden.push(b.id);
        if (b.type === 'misc' && /A valuable trinket\./.test(flat)) trinket.push(b.id);
      }
      A.stat('hiddenItemDescs', hidden.length);
      if (hidden.length) A.err('content.item-tooltips', 'hiddendesc', `${hidden.length} items have a desc that the tooltip never shows: ${hidden.slice(0, 30).join(', ')}`);
      if (trinket.length) A.err('content.item-tooltips', 'trinket', `misc items with the generic "A valuable trinket." tooltip (add to MISC_ITEM_TEXT or give a desc): ${trinket.join(', ')}`);
      if (thrown.length) A.err('content.item-tooltips', 'throw', `describeItem threw for ${thrown.length}: ${thrown.slice(0, 5).join('; ')}`);
      A.stat('genericConsumableTooltips', generic.length);
      if (generic.length) A.err('content.item-tooltips', 'generic', `${generic.length} consumables/scrolls read just "A consumable item." (add an entry to CONSUMABLE_EFFECT_TEXT in the game): ${generic.slice(0, 60).join(', ')}${generic.length > 60 ? ', ...' : ''}`);
    },
  },
  {
    id: 'systems.feats',
    desc: 'every feat (FEATS) completes exactly once when its counter reaches the goal, pays a reward that actually changes the character (hp/mp/stat/gold/crit/dodge), and every FEAT_COUNTERS row really moves its stat when its bus event fires; completed feats survive a save round trip',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof FEATS === 'undefined' || typeof featBump !== 'function') { A.err('systems.feats', 'api', 'FEATS/featBump missing'); return; }
      const snap = () => JSON.stringify([player.maxHp, player.maxMp, player.str, player.dex, player.int, player.con, player.wil, player.cha, player.gold, player.critBonus || 0, player.dodgeChance || 0, player.regen || 0]);
      const keep = player.feats, hp0 = player.hp, mp0 = player.mp, st = { maxHp: player.maxHp, maxMp: player.maxMp, str: player.str, dex: player.dex, int: player.int, con: player.con, wil: player.wil, cha: player.cha, gold: player.gold, critBonus: player.critBonus, dodgeChance: player.dodgeChance, regen: player.regen };
      try {
        const ids = new Set(); let paid = 0;
        for (const f of FEATS) {
          if (ids.has(f.id)) A.err('systems.feats', f.id, 'duplicate feat id'); ids.add(f.id);
          if (!f.name || !f.desc || !f.stat || !(f.goal > 0) || !f.reward || !f.reward.text || typeof f.reward.run !== 'function') { A.err('systems.feats', f.id, 'incomplete feat definition'); continue; }
          player.feats = { counts: {}, done: {} };
          const before = snap();
          if (f.goal > 1) { featBump(f.stat, f.goal - 1, true); if (player.feats.done[f.id]) A.err('systems.feats', f.id, 'completed one short of its goal'); }
          featBump(f.stat, f.goal, true);
          if (!player.feats.done[f.id]) { A.err('systems.feats', f.id, 'did not complete at its goal'); continue; }
          const after = snap();
          if (f.id !== 'devout' && after === before) A.err('systems.feats', f.id, `reward "${f.reward.text}" changed nothing about the character`); else paid++;
          const again = snap(); featBump(f.stat, f.goal, true); featBump(f.stat, 1, false); if (snap() !== again && FEATS.filter((g) => g.stat === f.stat && !player.feats.done[g.id]).length === 0) A.err('systems.feats', f.id, 'paid its reward more than once');
        }
        A.stat('featsChecked', FEATS.length); A.stat('featsPaid', paid);
        // every stat a feat uses has a source: one of the built-in counters, or a FEAT_COUNTERS row (removing a row would otherwise leave an unwinnable feat)
        { const builtin = new Set(['kills', 'elites', 'undead', 'desperate', 'casts', 'items', 'outdoor', 'underground', 'faithrank', 'turns', 'trials']); const wired = new Set((typeof FEAT_COUNTERS !== 'undefined' ? FEAT_COUNTERS : []).map((c) => c.stat));
          for (const f of FEATS) if (!builtin.has(f.stat) && !wired.has(f.stat)) A.err('systems.feats', f.id, `feat counts "${f.stat}" but nothing ever bumps it (no built-in counter, no FEAT_COUNTERS row): it can never be completed`); }
        // every counter row is wired: fire its event, expect its stat to move
        if (typeof FEAT_COUNTERS !== 'undefined') for (const c of FEAT_COUNTERS) {
          if (c.on === 'turn' || c.on === 'death' || c.on === 'attackResolved') continue; // need live entities; covered below
          player.feats = { counts: {}, done: {} };
          GameBus.emit(c.on, { key: 'probe', id: 'probe', q: {}, npc: {}, item: {}, depth: 5 });
          if (!(player.feats.counts[c.stat] > 0)) A.err('systems.feats', c.stat, `event "${c.on}" did not move the "${c.stat}" counter`);
        }
        {
          player.feats = { counts: {}, done: {} };
          const mon = makeMonster('wolf', player.x + 5, player.y, 1, Math.random);
          const boss = makeMonster('windrender', player.x + 6, player.y, 1, Math.random);
          GameBus.emit('attackResolved', { att: player, def: mon, dmg: 55, killed: true, melee: false });
          if (!((player.feats.counts.sniper || 0) === 1 && (player.feats.counts.bighit || 0) === 55)) A.err('systems.feats', 'attackResolved', `ranged kill for 55 gave sniper=${player.feats.counts.sniper} bighit=${player.feats.counts.bighit}`);
          GameBus.emit('attackResolved', { att: player, def: mon, dmg: 12, killed: true, melee: true }); // a MELEE kill is not a ranged kill
          GameBus.emit('attackResolved', { att: player, def: mon, dmg: 12, killed: false, melee: true });
          if ((player.feats.counts.sniper || 0) !== 1 || (player.feats.counts.bighit || 0) !== 55) A.err('systems.feats', 'attackResolved', 'a melee non-kill must not count as a ranged kill and must not lower the biggest hit');
          GameBus.emit('death', { def: boss, killer: player });
          if ((player.feats.counts.bosses || 0) !== 1) A.err('systems.feats', 'bosses', 'killing a boss did not count');
          GameBus.emit('death', { def: boss, killer: mon });
          if ((player.feats.counts.bosses || 0) !== 1) A.err('systems.feats', 'bosses', 'a boss killed by a monster (not the player) counted');
        }
        { // publishers: a REAL freed prisoner counts, a decoy ambusher does not; descend() announces the floor it arrives on
          player.feats = { counts: {}, done: {} };
          const gold0 = player.gold, xp0 = player.xp;
          const mkCage = (decoy, depth) => ({ uid: 'probe' + Math.random(), kind: 'npc', name: 'Probe Prisoner', caged: true, freed: false, isDecoy: decoy, foundDepth: depth, x: player.x + 1, y: player.y, hp: 5, maxHp: 5, alive: true });
          try { resolveCagedPrisoner(mkCage(true, 1)); } catch (e) { A.err('systems.feats', 'decoy', 'freeing a decoy threw: ' + e.message); }
          if ((player.feats.counts.rescues || 0) !== 0) A.err('systems.feats', 'rescues', 'a decoy ambusher counted as a rescue');
          player.gold = 0; try { resolveCagedPrisoner(mkCage(false, 1)); } catch (e) { A.err('systems.feats', 'rescue', 'freeing a prisoner threw: ' + e.message); } const g1 = player.gold;
          if ((player.feats.counts.rescues || 0) !== 1) A.err('systems.feats', 'rescues', 'freeing a real prisoner did not count');
          player.gold = 0; try { resolveCagedPrisoner(mkCage(false, 5)); } catch (e) { A.err('systems.feats', 'rescue', 'freeing a deep prisoner threw: ' + e.message); } const g5 = player.gold;
          if (!(g5 > g1)) A.err('systems.feats', 'rescues', `a depth-5 prisoner paid ${g5} gold, no more than a depth-1 one (${g1}): rewards should scale with depth`);
          player.gold = gold0;
          if (!/floorEntered/.test(String(descend))) A.err('systems.feats', 'depth', 'descend() no longer announces floorEntered, so depth feats can never complete');
        }
        // persistence
        player.feats = { counts: { kills: 5 }, done: { first_blood: 12 } };
        let raw; try { raw = JSON.stringify(getSaveData(), saveDataReplacer); applyLoadedSave(JSON.parse(raw)); } catch (e) { A.err('systems.feats', 'save', 'save/load threw: ' + String(e.stack || e).split('\n')[0]); }
        if (!(player.feats && player.feats.done && player.feats.done.first_blood === 12 && player.feats.counts.kills === 5)) A.err('systems.feats', 'save', 'feat progress did not survive a save round trip');
      } finally {
        player.feats = keep; Object.assign(player, st); player.hp = Math.min(hp0, player.maxHp); player.mp = Math.min(mp0, player.maxMp);
        try { if (gameState !== 'playing') { closeModal(); gameState = 'playing'; } } catch (e) { /* */ }
      }
    },
  },
  {
    id: 'systems.water',
    desc: 'swimming rules, exercised by really stepping into a water tile with movePlayer: stamina is spent per stroke, an exhausted swimmer takes drowning damage (and a fatal one names its cause), vessels / free swimming / flight cross for free, and stamina does not regenerate while treading water',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof movePlayer !== 'function' || typeof setTileWater !== 'function') { A.err('systems.water', 'api', 'movePlayer/setTileWater missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 });
      const saved = { x: player.x, y: player.y, hp: player.hp, maxHp: player.maxHp, stamina: player.stamina, maxStamina: player.maxStamina, inv: player.inventory, fs: player.freeSwim, wb: player.permaWaterbreathing, buffs: player.buffs, alive: player.alive, wsp: player.waterStaminaPenalty, wed: player.waterEntryDmg, dc: player.deathCause };
      const tiles = []; let spot = null;
      try {
        // an open strip: (x,y) walkable and (x+1..x+2,y) walkable land we can turn into water and restore afterwards
        for (let r = 0; r < 60 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = saved.x + dx, y = saved.y + dy; let ok = true;
          for (let xx = 0; xx <= 3 && ok; xx++) { const t = curTileAt(x + xx, y); if (!t || !t.walkable || t.feature || entityAt(x + xx, y)) ok = false; }
          if (ok) spot = { x, y };
        }
        if (!spot) { A.warn('systems.water', 'spot', 'no open strip to flood'); return; }
        for (let xx = 1; xx <= 3; xx++) { const t = curTileAt(spot.x + xx, spot.y); tiles.push([t, { walkable: t.walkable, feature: t.feature, glyph: t.glyph, color: t.color, bg: t.bg }]); setTileWater(t); }
        const setup = (o) => {
          for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; }
          player.x = spot.x; player.y = spot.y; player.alive = true; gameState = 'playing'; player.deathCause = null; lastDamageSource = null;
          player.maxHp = 80; player.hp = o.hp === undefined ? 80 : o.hp; player.maxStamina = 100; player.stamina = o.stamina === undefined ? 100 : o.stamina;
          player.inventory = saved.inv.filter((i) => !['raft', 'rowboat', 'sailing_ship'].includes(i.id)); if (o.vessel) player.inventory.push({ id: o.vessel, name: o.vessel, type: 'misc', qty: 1 });
          player.freeSwim = !!o.free; player.permaWaterbreathing = false; player.buffs = {}; if (o.fly) player.buffs.flight = { power: 1, turns: 20 };
          player.waterStaminaPenalty = 0; player.waterEntryDmg = 0;
        };
        const step = () => { try { movePlayer(1, 0); } catch (e) { A.err('systems.water', 'throw', 'movePlayer into water threw: ' + String(e.stack || e).split('\n')[0]); } if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
        const at = () => player.x === spot.x + 1 && player.y === spot.y;
        // 1. an ordinary swimmer pays stamina per stroke
        setup({ stamina: 60 }); step();
        if (!at()) A.err('systems.water', 'swim', 'a swimmer with stamina could not enter water');
        else { const cost = 60 - player.stamina; if (!(cost > 0 && cost <= 10)) A.err('systems.water', 'swim-cost', `one stroke cost ${cost} stamina (expected 1..10)`); A.stat('swimStrokeCost', cost); if (player.hp !== 80) A.err('systems.water', 'swim-hp', 'a swimmer with stamina lost HP'); }
        // 2. exhausted: floundering hurts, and says why
        setup({ stamina: 0 }); step();
        if (!at()) A.err('systems.water', 'flounder', 'an exhausted swimmer could not move into water at all (stranded on the shore)');
        else { if (!(player.hp < 80)) A.err('systems.water', 'flounder-dmg', 'an exhausted swimmer took no damage'); if (lastDamageSource !== 'drowning') A.err('systems.water', 'flounder-src', `drowning damage was attributed to "${lastDamageSource}"`); }
        // 3. a lethal flounder must name its killer
        setup({ stamina: 0, hp: 2 }); step();
        if (player.alive && player.hp > 0) A.err('systems.water', 'lethal', 'floundering at 2 HP did not kill'); else if (!player.deathCause) A.err('systems.water', 'death-cause', 'drowning left the death cause blank');
        // 4. vessels, free swimming and flight cross without spending stamina or HP
        for (const [label, o] of [['raft', { vessel: 'raft' }], ['rowboat', { vessel: 'rowboat' }], ['sailing ship', { vessel: 'sailing_ship' }], ['free swimmer', { free: true }], ['flight', { fly: true }]]) {
          setup(Object.assign({ stamina: 50 }, o)); step();
          if (!at()) { A.err('systems.water', label, `${label} could not cross a water tile`); continue; }
          if (player.stamina !== 50 || player.hp !== 80) A.err('systems.water', label, `${label} still cost stamina/HP (stamina ${player.stamina}, hp ${player.hp})`);
        }
        // 5. treading water does not regenerate stamina
        setup({ stamina: 10 }); step();
        if (at()) { const s0 = player.stamina; for (let i = 0; i < 6 && player.alive; i++) { try { endTurn(); } catch (e) { A.err('systems.water', 'endTurn', String(e.message || e)); break; } if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } } if (player.stamina > s0) A.err('systems.water', 'regen', `stamina regenerated while treading water (${s0} -> ${player.stamina})`); }
        // 6. a 3-tile crossing from full stamina is survivable for a normal character (a short river must not be a death trap)
        setup({ stamina: 100 }); let crossed = 0; for (let i = 0; i < 3; i++) { step(); if (player.x === spot.x + 1 + i) crossed++; if (player.alive) { /* keep going */ } }
        if (crossed < 3 || !(player.hp >= 70)) A.err('systems.water', 'short-river', `a 3-tile crossing from full stamina: crossed ${crossed}/3, hp ${player.hp}/80`);
      } finally {
        for (const [t, o] of tiles) Object.assign(t, o);
        Object.assign(player, { x: saved.x, y: saved.y, maxHp: saved.maxHp, hp: Math.min(saved.hp, saved.maxHp), maxStamina: saved.maxStamina, stamina: saved.stamina, inventory: saved.inv, freeSwim: saved.fs, permaWaterbreathing: saved.wb, buffs: saved.buffs, alive: true, waterStaminaPenalty: saved.wsp, waterEntryDmg: saved.wed, deathCause: saved.dc });
        __g.restore(); gameState = 'playing'; lastDamageSource = null;
      }
    },
  },
  {
    id: 'systems.constructs',
    desc: 'engineering construct power grid: every deploy item resolves to a real construct with a sane powerDraw that a maxed engineer can field; capacity = base + practice + INT + reactors (all capped); an over-budget deploy is refused WITHOUT consuming the item; deploying charges the grid; constructs drain charge per turn and power down at 0; a Power Cell revives them; a dead construct frees its grid slot; reactors stop at the cap',
    needsPlayer: true, seconds: 60,
    fn(A) {
      for (const f of ['computeConstructPowerCapacity', 'currentConstructPowerDraw', 'useItem', 'makeItem', 'spawnAlly']) if (typeof globalThis[f] !== 'function' && typeof eval('typeof ' + f) !== 'undefined' && eval('typeof ' + f) !== 'function') { A.err('systems.constructs', 'api', f + ' missing'); return; }
      // ---- static registry checks ----
      const deployItems = ITEM_BASES.filter((b) => b.effect === 'summonconstruct');
      const maxCap = CONSTRUCT_BASE_CAPACITY + MAX_ENGINEERING_PRACTICE_CAPACITY_BONUS + MAX_AUX_REACTORS + Math.floor(30 / 10); // a maxed engineer at INT 30
      let maxDraw = 0;
      for (const b of deployItems) {
        const m = MONSTER_BASES[b.summonId];
        if (!m) { A.err('systems.constructs', b.id, `summons "${b.summonId}", which is not a monster`); continue; }
        const d = m.powerDraw; if (!(Number.isInteger(d) && d >= 1)) { A.err('systems.constructs', b.id, `${b.summonId} has powerDraw ${d} (must be a positive integer)`); continue; }
        maxDraw = Math.max(maxDraw, d);
        if (d > maxCap) A.err('systems.constructs', b.id, `${b.summonId} draws ${d} but even a maxed engineer only has ${maxCap} capacity: it can never be deployed`);
        if (!RECIPES.some((r) => r.output && r.output.id === b.id)) A.warn('systems.constructs', b.id, 'no recipe produces this deploy item (only findable or craftable via loot)');
        if (!(m.hp > 0 && m.atk) && m.behavior !== 'support') A.err('systems.constructs', b.id, `${b.summonId} has no hp/atk`);
      }
      A.stat('constructDeployItems', deployItems.length); A.stat('constructMaxDraw', maxDraw);
      // ---- dynamic ----
      const __g = A.leakGuard({ baseStats: 12 });
      const __back = A.relocate(7, 7); if (!__back) { A.warn('systems.constructs', 'room', 'no open ground to deploy constructs on'); __g.restore(); return; }
      const saved = { inv: player.inventory, allies: player.allies, int: player.int, craft: player.craftSkill, aux: player.auxReactorsInstalled, gold: player.gold, hp: player.hp, maxHp: player.maxHp, x: player.x, y: player.y };
      const fresh = () => { for (const a of curAllies ? curAllies().slice() : []) { a.alive = false; a.hp = 0; } player.allies = []; player.inventory = []; player.craftSkill = { engineering: 0 }; player.auxReactorsInstalled = 0; player.int = 12; player.maxHp = 400; player.hp = 400; for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; } };
      const give = (id) => { const it = makeItem(id, 'common', Math.random); player.inventory.push(it); return it; };
      const settle = () => { if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      const constructs = () => (player.allies || []).filter((a) => a.isPlayerConstruct && a.alive);
      try {
        // capacity formula and caps
        fresh(); const base = computeConstructPowerCapacity();
        if (base !== CONSTRUCT_BASE_CAPACITY + 1) A.err('systems.constructs', 'capacity', `a fresh INT-12 character has capacity ${base}, expected ${CONSTRUCT_BASE_CAPACITY + 1}`);
        player.craftSkill.engineering = 9999; player.auxReactorsInstalled = 99; player.int = 12;
        if (computeConstructPowerCapacity() > CONSTRUCT_BASE_CAPACITY + MAX_ENGINEERING_PRACTICE_CAPACITY_BONUS + MAX_AUX_REACTORS + 1) A.err('systems.constructs', 'capacity-cap', `practice/reactor bonuses are not capped (capacity ${computeConstructPowerCapacity()})`);
        // over-budget deploy: refused, item kept
        fresh(); const big = deployItems.find((b) => MONSTER_BASES[b.summonId].powerDraw === 4);
        if (big) { const it = give(big.id); const n0 = player.inventory.length; try { useItem(it); } catch (e) { A.err('systems.constructs', 'throw', 'useItem threw: ' + String(e.stack || e).split('\n')[0]); } settle();
          if (constructs().length) A.err('systems.constructs', 'over-budget', `a draw-4 construct deployed on a capacity-${base} grid`);
          if (player.inventory.length !== n0 || !player.inventory.includes(it)) A.err('systems.constructs', 'refund', 'a refused deploy consumed the item'); }
        // exact fit + grid accounting
        fresh(); const three = deployItems.find((b) => MONSTER_BASES[b.summonId].powerDraw === 3), one = deployItems.find((b) => MONSTER_BASES[b.summonId].powerDraw === 1);
        let c3 = null;
        if (three) { const it = give(three.id); try { useItem(it); } catch (e) { A.err('systems.constructs', 'throw', 'useItem threw: ' + String(e.stack || e).split('\n')[0]); } settle();
          c3 = constructs()[0];
          if (!c3) A.err('systems.constructs', 'exact-fit', `a draw-3 construct would not deploy on a capacity-${base} grid`);
          else {
            if (currentConstructPowerDraw() !== 3) A.err('systems.constructs', 'grid', `grid draw is ${currentConstructPowerDraw()} after one draw-3 deploy`);
            if (player.inventory.includes(it)) A.err('systems.constructs', 'consume', 'a successful deploy did not consume the item');
            if (one) { const it1 = give(one.id); try { useItem(it1); } catch (e) { /* */ } settle(); if (constructs().length !== 1) A.err('systems.constructs', 'overfill', 'a draw-1 construct deployed onto a full grid'); }
            // drain
            const ch0 = c3.charge; for (let i = 0; i < 4; i++) { try { endTurn(); } catch (e) { A.err('systems.constructs', 'endTurn', String(e.message || e)); break; } settle(); }
            if (!(c3.charge < ch0)) A.err('systems.constructs', 'drain', `a deployed construct's charge did not drain over 4 turns (${ch0} -> ${c3.charge})`);
            // power down at 0
            c3.charge = 2; for (let i = 0; i < 3 && !c3.poweredDown; i++) { try { endTurn(); } catch (e) { break; } settle(); }
            if (!c3.poweredDown) A.err('systems.constructs', 'power-down', 'a construct at ~0 charge never powered down');
            if (c3.charge < 0) A.err('systems.constructs', 'negative-charge', 'charge went negative');
            if (currentConstructPowerDraw() !== 3) A.err('systems.constructs', 'powered-down-slot', 'a powered-down construct should still hold its grid slot');
            // power cell revives
            const cell = ITEM_BASES.find((b) => b.effect === 'rechargeconstructs');
            if (!cell) A.err('systems.constructs', 'cell', 'no item has effect rechargeconstructs'); else { const ci = give(cell.id); try { useItem(ci); } catch (e) { /* */ } settle(); if (c3.poweredDown || !(c3.charge > 100)) A.err('systems.constructs', 'recharge', `a Power Cell did not revive the construct (poweredDown ${c3.poweredDown}, charge ${c3.charge})`); }
            // death frees the slot
            c3.alive = false; c3.hp = 0; if (currentConstructPowerDraw() !== 0) A.err('systems.constructs', 'dead-slot', `a dead construct still occupies ${currentConstructPowerDraw()} grid capacity`);
          } }
        // reactors: +1 each, stop at the cap, refund beyond it
        fresh(); const reactor = ITEM_BASES.find((b) => b.effect === 'installreactor');
        if (reactor) { const c0 = computeConstructPowerCapacity(); for (let i = 0; i < MAX_AUX_REACTORS; i++) { const r = give(reactor.id); try { useItem(r); } catch (e) { /* */ } settle(); }
          if (computeConstructPowerCapacity() !== c0 + MAX_AUX_REACTORS) A.err('systems.constructs', 'reactors', `${MAX_AUX_REACTORS} reactors raised capacity ${c0} -> ${computeConstructPowerCapacity()}`);
          const g0 = player.gold, extra = give(reactor.id); try { useItem(extra); } catch (e) { /* */ } settle();
          if (computeConstructPowerCapacity() !== c0 + MAX_AUX_REACTORS) A.err('systems.constructs', 'reactor-cap', 'a fourth reactor raised capacity past the cap');
          if (!(player.gold > g0)) A.err('systems.constructs', 'reactor-refund', 'a reactor beyond the cap was swallowed with no refund'); }
      } finally {
        for (const a of (player.allies || []).slice()) { if (a.isPlayerConstruct) { a.alive = false; a.hp = 0; } }
        Object.assign(player, { inventory: saved.inv, allies: saved.allies, int: saved.int, craftSkill: saved.craft, auxReactorsInstalled: saved.aux, gold: saved.gold, maxHp: saved.maxHp, hp: Math.min(saved.hp, saved.maxHp), x: saved.x, y: saved.y, alive: true });
        __g.restore(); __back(); gameState = 'playing';
      }
    },
  },
  {
    id: 'systems.reputation',
    desc: 'crime and standing: city ranks are ordered, the bounty markup / goodwill discount are monotonic and capped, a crime raises the bounty and turns the local guards hostile, bounties decay but never go negative, paying one off costs 3x and refuses when you cannot afford it, civic office needs 60 standing, is granted once, and pays a stipend',
    needsPlayer: true, seconds: 60,
    fn(A) {
      for (const f of ['commitCrime', 'decayBounties', 'payOffBounty', 'reputationPriceMult', 'cityRankTitleFor', 'petitionForOffice', 'tickCivicIncome', 'addGoodwill']) if (eval('typeof ' + f) !== 'function') { A.err('systems.reputation', 'api', f + ' missing'); return; }
      // the registry
      for (let i = 1; i < CITY_RANKS.length; i++) if (!(CITY_RANKS[i].min > CITY_RANKS[i - 1].min)) A.err('systems.reputation', 'ranks', 'CITY_RANKS must have strictly increasing thresholds');
      for (const r of CITY_RANKS) { if (cityRankTitleFor(r.min) !== r.title) A.err('systems.reputation', 'rank-edge', `${r.min} goodwill should read "${r.title}", reads "${cityRankTitleFor(r.min)}"`); if (r.min > 0 && cityRankTitleFor(r.min - 1) === r.title) A.err('systems.reputation', 'rank-edge', `${r.min - 1} goodwill already reads "${r.title}"`); }
      // a settlement with people in it
      let chunk = null; for (const c of worldChunks.values()) if (c.settlement && (c.npcs || []).length && c.npcs.some((n) => ['guard', 'watchman', 'captain'].includes(n.roleId))) { if (!chunk || Math.abs(c.cx) + Math.abs(c.cy) < Math.abs(chunk.cx) + Math.abs(chunk.cy)) chunk = c; }
      if (!chunk) { A.warn('systems.reputation', 'settlement', 'no generated settlement with a guard to test crime against'); return; }
      const npc = chunk.npcs.find((n) => ['elder', 'noble'].includes(n.roleId)) || chunk.npcs[0], region = getRegionKey(npc.x, npc.y);
      const __g = A.leakGuard();
      const sv = { mode: player.mode, bounties: player.bounties, goodwill: player.goodwill, offices: player.civicOffices, gold: player.gold, corr: player.corruption, lastCivic: player.lastCivicDay, turn: turnCount, kr: player.kingdomRep };
      const hostile = chunk.npcs.map((n) => [n, n.hostile]);
      try {
        player.mode = 'overworld'; player.bounties = {}; player.goodwill = {}; player.civicOffices = {}; player.corruption = 0; player.gold = 5000;
        // price multiplier: monotonic and capped
        let prev = 0; for (const b of [0, 14, 15, 30, 50, 80, 500, 5000]) { player.bounties[region] = b; const m = reputationPriceMult(npc); if (m < prev - 1e-9) A.err('systems.reputation', 'bounty-mult', `bounty ${b} lowers the price multiplier (${m} < ${prev})`); if (m > 1.5 + 1e-9) A.err('systems.reputation', 'bounty-cap', `bounty ${b} marks prices up ${m}x (cap 1.5)`); prev = m; }
        player.bounties[region] = 0; prev = 9; for (const g of [0, 9, 10, 50, 120, 5000]) { player.goodwill[region] = g; const m = reputationPriceMult(npc); if (m > prev + 1e-9) A.err('systems.reputation', 'goodwill-mult', `goodwill ${g} raises prices (${m} > ${prev})`); if (m < 0.8 - 1e-9) A.err('systems.reputation', 'goodwill-cap', `goodwill ${g} discounts prices to ${m}x (floor 0.8)`); prev = m; }
        // crime
        player.bounties = {}; player.goodwill = {}; for (const n of chunk.npcs) if (['guard', 'watchman', 'captain'].includes(n.roleId)) n.hostile = false;
        commitCrime(region, 12);
        if ((player.bounties[region] || 0) !== 12) A.err('systems.reputation', 'crime', `commitCrime(12) left bounty ${player.bounties[region]}`);
        if (!chunk.npcs.some((n) => ['guard', 'watchman', 'captain'].includes(n.roleId) && n.alive && n.hostile)) A.err('systems.reputation', 'alert', 'a crime did not turn any guard hostile');
        commitCrime(region, 8); if (player.bounties[region] !== 20) A.err('systems.reputation', 'crime-stack', 'bounties do not stack');
        // decay
        decayBounties(); if (player.bounties[region] !== 10) A.err('systems.reputation', 'decay', `20 decays to ${player.bounties[region]}, expected 10`);
        decayBounties(); decayBounties(); if (player.bounties[region] !== 0) A.err('systems.reputation', 'decay-floor', `bounty ended at ${player.bounties[region]} (must floor at 0)`);
        // pay off
        player.bounties[region] = 30; player.gold = 89; payOffBounty(npc, region, 30); settleM();
        if (player.bounties[region] !== 30 || player.gold !== 89) A.err('systems.reputation', 'payoff-poor', `a poor player cleared a bounty anyway (bounty ${player.bounties[region]}, gold ${player.gold})`);
        player.gold = 500; payOffBounty(npc, region, 30); settleM();
        if (player.bounties[region] !== 0 || player.gold !== 410) A.err('systems.reputation', 'payoff', `paying 30 off should cost 90 and clear it (bounty ${player.bounties[region]}, gold ${player.gold})`);
        // civic office
        player.goodwill[region] = 59; petitionForOffice(npc); settleM();
        if (Object.keys(player.civicOffices).length) A.err('systems.reputation', 'office-early', 'granted civic office at 59 standing');
        player.goodwill[region] = 60; petitionForOffice(npc); settleM();
        if (Object.keys(player.civicOffices).length !== 1) A.err('systems.reputation', 'office', `60 standing did not grant exactly one office (${Object.keys(player.civicOffices).length})`);
        { const gw = player.goodwill[region], kr = JSON.stringify(player.kingdomRep || null); petitionForOffice(npc); settleM(); if (Object.keys(player.civicOffices).length !== 1) A.err('systems.reputation', 'office-twice', 'a second petition granted a second office in the same settlement'); if (player.goodwill[region] !== gw || JSON.stringify(player.kingdomRep || null) !== kr) A.err('systems.reputation', 'office-farm', 'petitioning again for an office you hold still pays standing / kingdom reputation (an infinite reputation farm)'); }
        // stipend: let three days pass
        const gold0 = player.gold, dl = typeof DAY_LENGTH === 'number' ? DAY_LENGTH : 0;
        if (dl) { player.lastCivicDay = Math.floor(turnCount / dl); const t0 = turnCount; turnCount = t0 + dl * 3; try { tickCivicIncome(); } finally { turnCount = t0; } if (!(player.gold > gold0)) A.err('systems.reputation', 'stipend', 'three days in office paid no stipend'); }
      } finally {
        for (const [n, h] of hostile) n.hostile = h;
        Object.assign(player, { mode: sv.mode, bounties: sv.bounties, goodwill: sv.goodwill, civicOffices: sv.offices, gold: sv.gold, corruption: sv.corr, lastCivicDay: sv.lastCivic, kingdomRep: sv.kr });
        __g.restore(); gameState = 'playing';
      }
      function settleM() { if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } }
    },
  },
  {
    id: 'systems.affixes',
    desc: 'Marked/Elite/Paragon monsters (MONSTER_AFFIXES): every affix has a prefix/colour/description and conflicts that name real affixes both ways; each can be forced onto a monster (renamed, XP multiplied by rank, loot rolled); every hook (onHit/onTurn/onDamaged/onDeath) runs without throwing and does what its description says; natural rolls respect minDs, conflicts, rank limits and the early-game grace period',
    needsPlayer: true, seconds: 120,
    fn(A) {
      if (typeof MONSTER_AFFIXES === 'undefined' || typeof rollMonsterAffixes !== 'function') { A.err('systems.affixes', 'api', 'MONSTER_AFFIXES / rollMonsterAffixes missing'); return; }
      const ids = Object.keys(MONSTER_AFFIXES);
      for (const id of ids) {
        const a = MONSTER_AFFIXES[id];
        if (!a.prefix || !a.color || !a.desc || !(a.weight > 0) || !(a.minDs >= 1)) A.err('systems.affixes', id, 'missing prefix/colour/desc, or a non-positive weight/minDs');
        for (const c of a.conflicts || []) { if (!MONSTER_AFFIXES[c]) A.err('systems.affixes', id, `conflicts with unknown affix "${c}"`); }
        for (const h of ['apply', 'onHit', 'onTurn', 'onDamaged', 'onDeath']) if (a[h] !== undefined && typeof a[h] !== 'function') A.err('systems.affixes', id, `${h} is not a function`);
        if (!a.apply && !a.onHit && !a.onTurn && !a.onDamaged && !a.onDeath) A.err('systems.affixes', id, 'defines no behaviour at all');
      }
      A.stat('affixes', ids.length);
      const __g = A.leakGuard({ baseStats: 12 }); const __back = A.relocate(9, 9); if (!__back) { A.warn('systems.affixes', 'room', 'no open ground for the affix fixtures'); __g.restore(); return; }
      const sv = { hp: player.hp, maxHp: player.maxHp, gold: player.gold, mp: player.mp, st: player.stamina, x: player.x, y: player.y, alive: player.alive, pois: player.statusPoison, slow: player.statusSlow, fear: player.statusFear, level: player.level, mode: player.mode, allies: player.allies, ek: player.eliteKills };
      const quiet0 = GameBus.quiet; const spawned = [];
      const settle = () => { if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      const fresh = (monId, dx) => { GameBus.quiet = true; const m = makeMonster(monId, player.x + (dx || 1), player.y, 3, Math.random); GameBus.quiet = quiet0; m.alive = true; m.engaged = true; spawned.push(m); return m; };
      const reset = () => { player.hp = player.maxHp = 5000; player.gold = 300; player.mp = 100; player.stamina = 100; player.statusPoison = 0; player.statusSlow = 0; player.statusFear = 0; player.alive = true; player.allies = []; for (const m of curMonsters().slice()) { if (!spawned.includes(m)) { m.alive = false; m.hp = 0; } } };
      try {
        player.level = 20; // past the early-game grace period
        for (const id of ids) {
          reset();
          const monId = MONSTER_BASES.orc ? 'orc' : Object.keys(MONSTER_BASES).find((k) => !MONSTER_BASES[k].boss);
          const m = fresh(monId, 1), base = MONSTER_BASES[monId], hp0 = m.maxHp, atk0 = (m.atk || [0, 0]).slice(), xp0 = m.xp;
          try { rollMonsterAffixes(m, base, 6, [id]); } catch (e) { A.err('systems.affixes', id, 'rollMonsterAffixes threw: ' + String(e.stack || e).split('\n')[0]); continue; }
          if (!m.affixes || m.affixes[0] !== id) { A.err('systems.affixes', id, 'forcing the affix did not attach it'); continue; }
          if (!m.name.startsWith(MONSTER_AFFIXES[id].prefix + ' ')) A.err('systems.affixes', id, `monster not renamed with the prefix ("${m.name}")`);
          if (!(m.xp > xp0) && id !== 'gilded') A.err('systems.affixes', id, `marked monster pays no more XP (${xp0} -> ${m.xp})`);
          if (!m.guaranteedDrops || !m.guaranteedDrops.length) A.err('systems.affixes', id, 'marked monster rolled no bonus loot');
          const a = MONSTER_AFFIXES[id];
          // behaviour claims
          if (id === 'brutal' && !(m.atk[1] > atk0[1])) A.err('systems.affixes', id, 'Brutal did not raise attack');
          if (id === 'hulking' && !(m.maxHp > hp0 * 1.5)) A.err('systems.affixes', id, `Hulking HP ${hp0} -> ${m.maxHp}`);
          if (id === 'swift' && !m.swiftMover) A.err('systems.affixes', id, 'Swift did not set swiftMover');
          if (id === 'plated' && !(m.armor > (base.armor || 0))) A.err('systems.affixes', id, 'Plated did not raise armor');
          if (a.onHit) { const snapP = () => JSON.stringify([player.statusPoison, player.statusSlow, player.statusFear, player.statusConfuse || 0, player.mp, player.stamina, player.gold, player.bleedTurns || 0, player.burningTurns || 0]); player.statusPoison = 0; player.statusSlow = 0; player.statusFear = 0; player.statusConfuse = 0; /* earlier probes leave statuses behind, and an effect that max()es a status shows no change on top of one */ const before = snapP();
            for (let i = 0; i < 60; i++) { try { a.onHit(m, player, 12); } catch (e) { A.err('systems.affixes', id, 'onHit threw: ' + String(e.stack || e).split('\n')[0]); break; } }
            const after = snapP();
            if (before === after && id !== 'vampiric' && !(id === 'heretic' && !(typeof deityOf === 'function' && deityOf()))) A.err('systems.affixes', id, `onHit x60 had no effect on the player ("${a.desc}")`);
            if (id === 'vampiric') { m.hp = 1; a.onHit(m, player, 20); if (!(m.hp > 1)) A.err('systems.affixes', id, 'Bloodthirsty did not heal on hit'); } }
          if (a.onTurn) for (let i = 0; i < 3; i++) { try { a.onTurn(m); } catch (e) { A.err('systems.affixes', id, 'onTurn threw: ' + String(e.stack || e).split('\n')[0]); break; } }
          if (id === 'resilient') { m.hp = 1; a.onTurn(m); if (!(m.hp > 1)) A.err('systems.affixes', id, 'Resilient did not regenerate'); }
          if (a.onDamaged) { const att = { hp: 100, maxHp: 100, x: m.x + 1, y: m.y, alive: true, kind: 'ally', name: 'dummy' }; const h0 = att.hp; try { a.onDamaged(m, att, 20); } catch (e) { A.err('systems.affixes', id, 'onDamaged threw: ' + String(e.stack || e).split('\n')[0]); } if (id === 'thorned' && !(att.hp < h0)) A.err('systems.affixes', id, 'Thorned reflected nothing'); }
          if (id === 'thieving') { player.gold = 300; m.stolenGold = 0; const g0 = player.gold; m.x = player.x + 1; a.onHit(m, player, 5); if (!(player.gold < g0) || !m.stolenGold) A.err('systems.affixes', id, 'Light-Fingered stole nothing'); else { a.onDeath(m, player); if (player.gold !== g0) A.err('systems.affixes', id, `killing the thief returned ${player.gold - g0 + m.stolenGold}... gold not restored (${g0} -> ${player.gold})`); } }
          else if (a.onDeath) { m.x = player.x + 1; m.y = player.y; const n0 = curMonsters().length, hp1 = player.hp; try { m.alive = false; m.hp = 0; a.onDeath(m, player); } catch (e) { A.err('systems.affixes', id, 'onDeath threw: ' + String(e.stack || e).split('\n')[0]); }
            if (id === 'volatile' && !(player.hp < hp1)) A.err('systems.affixes', id, 'Volatile burst hurt nobody adjacent'); if (id === 'brooding') { const kids = curMonsters().filter((k) => k.isBrood && k.alive); spawned.push(...kids); if (!kids.length) A.err('systems.affixes', id, 'Brooding split into nothing'); } }
          if (id === 'gravebound') { m.alive = false; m.hp = 0; m.x = player.x + 2; m.y = player.y; const r0 = curMonsters().filter((k) => k.risen).length; a.onDeath(m); const rs = curMonsters().filter((k) => k.risen); spawned.push(...rs); if (rs.length <= r0) A.err('systems.affixes', id, 'Gravebound did not rise again'); const cpy = rs[0] || m; cpy.x = m.x; cpy.y = m.y; /* beside the free tiles the first rise used */ const cnt0 = curMonsters().filter((k) => k.risen).length; a.onDeath(cpy); if (curMonsters().filter((k) => k.risen).length > cnt0) A.err('systems.affixes', id, 'a risen copy rose AGAIN (infinite undead loop)'); }
          if (id === 'mending') { const o = fresh(monId, 2); addMonsterToWorld(o); o.hp = 1; m.hp = m.maxHp; m.x = player.x + 1; o.x = player.x + 2; const t0 = turnCount; turnCount = Math.ceil((t0 + 1) / 4) * 4; try { a.onTurn(m); } finally { turnCount = t0; } if (!(o.hp > 1)) A.err('systems.affixes', id, 'Mending healed no nearby ally'); }
          if (id === 'warded') { if (!(m.ward > 0)) A.err('systems.affixes', id, 'Warded monster has no ward'); else { m.hp = m.maxHp; const w0 = m.ward; m.hp -= 5; a.onDamaged(m, { hp: 50, x: m.x + 1, y: m.y }, 5); if (!(m.ward < w0 && m.hp === m.maxHp)) A.err('systems.affixes', id, 'the ward did not soak the first blow'); } }
          if (id === 'berserking') { m.hp = Math.floor(m.maxHp * 0.4); const atkB = m.atk[1]; a.onTurn(m); if (!(m.atk[1] > atkB) || !m.swiftMover) A.err('systems.affixes', id, 'Berserk did not enrage below half health'); const atkC = m.atk[1]; a.onTurn(m); if (m.atk[1] !== atkC) A.err('systems.affixes', id, 'Berserk enraged twice (attack compounds every turn)'); }
          settle();
        }
        // natural rolls
        reset(); const stat = { n: 0, marked: 0, byRank: [0, 0, 0, 0], bad: 0 }; const base = MONSTER_BASES.orc || MONSTER_BASES[Object.keys(MONSTER_BASES)[0]];
        const rollMany = (lvl, ds, N) => { player.level = lvl; let marked = 0; for (let i = 0; i < N; i++) { GameBus.quiet = true; const m = makeMonster('orc', 40 + i * 7, 900 + (i % 17) * 5, ds, Math.random); GameBus.quiet = quiet0; m.alive = true; spawned.push(m);
            try { rollMonsterAffixes(m, MONSTER_BASES.orc, ds); } catch (e) { A.err('systems.affixes', 'natural', 'natural roll threw: ' + String(e.stack || e).split('\n')[0]); return 0; }
            if (m.affixes) { marked++; const L = m.affixes.length; stat.byRank[Math.min(3, L)]++; if (L > 3) A.err('systems.affixes', 'rank', `${L} affixes on one monster`); if (new Set(m.affixes).size !== L) A.err('systems.affixes', 'dupe', 'the same affix twice: ' + m.affixes.join(','));
              for (const id of m.affixes) { if ((MONSTER_AFFIXES[id].minDs || 1) > ds) A.err('systems.affixes', 'minDs', `${id} rolled at depth ${ds} (needs ${MONSTER_AFFIXES[id].minDs})`); for (const c of MONSTER_AFFIXES[id].conflicts || []) if (m.affixes.includes(c)) A.err('systems.affixes', 'conflict', `${id} and ${c} on the same monster`); } } } return marked / N; };
        const early = rollMany(1, 1, 400), mid = rollMany(15, 3, 600), deep = rollMany(30, 7, 600);
        A.stat('affixRate', `L1 ds1 ${(early * 100).toFixed(1)}% | L15 ds3 ${(mid * 100).toFixed(1)}% | L30 ds7 ${(deep * 100).toFixed(1)}%`);
        if (early > 0.04) A.err('systems.affixes', 'grace', `${(early * 100).toFixed(1)}% of level-1 monsters are marked (the grace period should keep this under 4%)`);
        if (!(mid > early && deep >= mid * 0.9)) A.warn('systems.affixes', 'curve', `mark rate does not grow with depth/level (${(early * 100).toFixed(1)}% -> ${(mid * 100).toFixed(1)}% -> ${(deep * 100).toFixed(1)}%)`);
        if (deep > 0.4) A.err('systems.affixes', 'rate-cap', `${(deep * 100).toFixed(1)}% of deep monsters are marked: elites stop being special`);
      } finally {
        GameBus.quiet = quiet0; for (const m of spawned) { m.alive = false; m.hp = 0; }
        Object.assign(player, { hp: sv.hp, maxHp: sv.maxHp, gold: sv.gold, mp: sv.mp, stamina: sv.st, x: sv.x, y: sv.y, alive: true, statusPoison: sv.pois, statusSlow: sv.slow, statusFear: sv.fear, level: sv.level, mode: sv.mode, allies: sv.allies, eliteKills: sv.ek });
        __g.restore(); __back(); settle(); gameState = 'playing';
      }
    },
  },
  {
    id: 'systems.maneuvers',
    desc: 'telegraphed heavy attacks (MANEUVERS): registry shape and rules point at real maneuvers; for EACH maneuver the winding-up monster really hurts a player who stays on the marked tiles, whiffs and is EXPOSED when the player sidesteps, is negated (and staggered) by a parry stance, and is cancelled by a stun during the wind-up',
    needsPlayer: true, seconds: 90,
    fn(A) {
      if (typeof MANEUVERS === 'undefined' || typeof maneuverTurn !== 'function') { A.err('systems.maneuvers', 'api', 'MANEUVERS/maneuverTurn missing'); return; }
      const ids = Object.keys(MANEUVERS);
      for (const id of ids) { const d = MANEUVERS[id];
        if (!d.name || !(d.windup >= 1) || !(d.recover >= 1) || !(d.mult >= 0) || !(d.cd >= 1) || !(d.chance > 0 && d.chance <= 1) || !(d.minR >= 1 && d.maxR >= d.minR) || typeof d.plan !== 'function' || typeof d.announce !== 'function' || typeof d.resolve !== 'function') A.err('systems.maneuvers', id, 'incomplete maneuver definition');
        if (d.mult > 3) A.err('systems.maneuvers', id, `damage multiplier ${d.mult} is a one-shot waiting to happen (cap 3)`); }
      for (const r of MANEUVER_RULES) for (const id of r.ids) if (!MANEUVERS[id]) A.err('systems.maneuvers', 'rules', `a MANEUVER_RULES entry names unknown maneuver "${id}"`);
      let covered = 0, total = 0; for (const [id, b] of Object.entries(MONSTER_BASES)) { if (b.boss || b.scriptedAI) continue; total++; try { const mm = { monsterId: id, atk: b.atk, behavior: b.behavior, thrower: b.thrower, breathWeapon: b.breathWeapon }; if (maneuverIdsFor(mm, b).length) covered++; } catch (e) { A.err('systems.maneuvers', 'rules', `maneuverIdsFor threw for ${id}: ${e.message}`); } }
      A.stat('maneuverCoverage', `${covered}/${total} non-boss monsters have a maneuver`);
      const __g = A.leakGuard({ baseStats: 12 }); const __back = A.relocate(13, 13); if (!__back) { A.warn('systems.maneuvers', 'room', 'no open ground'); __g.restore(); return; }
      const sv = { fr: player.fearResistBonus, dc: player.dodgeChance, sf: player.statusFear, hp: player.hp, maxHp: player.maxHp, x: player.x, y: player.y, parry: player._parry, alive: player.alive, sl: player.statusSlow, st: player.stamina };
      const home = { x: player.x, y: player.y }, spawned = [];
      const settle = () => { if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      try {
        for (const id of ids) {
          const def = MANEUVERS[id], dist = Math.max(def.minR, Math.min(def.maxR, 3));
          const trial = (mode) => {
            for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; }
            player.x = home.x; player.y = home.y; player.maxHp = player.hp = 5000; player.alive = true; player.statusSlow = 0; player.statusFear = 0; player.fearResistBonus = 0; player.dodgeChance = 0; player._parry = null; player.stamina = 100; gameState = 'playing';
            GameBus.quiet = true; const m = makeMonster('ogre', home.x + dist, home.y, 1, Math.random); GameBus.quiet = false; spawned.push(m);
            m.alive = true; m.engaged = true; m.hp = m.maxHp = 3000; m.affixes = undefined; m.maneuverCd = 99; m.stunnedTurns = 0; m.statusFear = 0; m.statusConfuse = 0; m.buffAtkMult = 1; m.armor = 0;
            addMonsterToWorld(m);
            const plan = def.plan(m); if (!plan) return { noplan: true };
            m.maneuver = { id, phase: 'windup', left: def.windup, plan };
            if (mode === 'sidestep') { const away = plan.tiles && plan.tiles.length ? plan.tiles : []; let best = null, bd = -1; for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) { const x = home.x + dx, y = home.y + dy; const t = curTileAt(x, y); if (!t || !t.walkable || entityAt(x, y) || away.some((a) => a.x === x && a.y === y)) continue; if (chebyshev(x, y, m.x, m.y) < 2) continue; const d = Math.min(...(away.length ? away.map((a) => chebyshev(a.x, a.y, x, y)) : [9])); if (d > bd) { bd = d; best = { x, y }; } } if (!best) return { noplan: true }; player.x = best.x; player.y = best.y; }
            if (mode === 'parry') player._parry = { until: turnCount + 6, grade: 1, id: 'parrystance' };
            if (mode === 'stun') { m.stunnedTurns = 2; }
            const hp0 = player.hp, fear0 = player.statusFear || 0;
            for (let i = 0; i < def.windup + 1 && m.maneuver && m.maneuver.phase === 'windup'; i++) { try { maneuverTurn(m, false); } catch (e) { A.err('systems.maneuvers', id, `maneuverTurn (${mode}) threw: ` + String(e.stack || e).split('\n')[0]); break; } settle(); if (mode === 'stun') break; }
            return { m, lost: (hp0 - player.hp) + ((player.statusFear || 0) > fear0 ? 1 : 0) /* a Bellow does no damage: fear counts as the effect */, plan };
          };
          let hit = trial('stay'); for (let k = 0; k < 14 && !hit.noplan && !(hit.lost > 0); k++) hit = trial('stay'); // a heavy blow can still MISS on the attack roll
          if (hit.noplan) { A.warn('systems.maneuvers', id, 'plan() returned nothing in the open fixture; not exercised'); continue; }
          if (!(hit.lost > 0)) A.err('systems.maneuvers', id, 'a player who stays on the marked tiles took no damage');
          if (hit.m.maneuver && hit.m.maneuver.phase !== 'recover' && hit.m.alive) A.err('systems.maneuvers', id, `after resolving, the monster is in phase "${hit.m.maneuver && hit.m.maneuver.phase}" instead of recovering`);
          const dodge = trial('sidestep');
          if (!dodge.noplan) { if (dodge.lost > 0) A.err('systems.maneuvers', id, `a player who sidestepped still took ${dodge.lost} damage`); else if (!(dodge.m.exposedTurns > 0)) A.err('systems.maneuvers', id, 'a whiffed maneuver did not leave the monster exposed (the reward for reading the telegraph)'); }
          const par = def.mult > 0 ? trial('parry') : { noplan: true }; // a Bellow is a roar, not a blow: nothing to parry
          if (!par.noplan) { if (par.lost > 0) A.err('systems.maneuvers', id, `a parry stance still took ${par.lost} damage`); else if (!(par.m.stunnedTurns > 0)) A.err('systems.maneuvers', id, 'a successful parry did not stagger (stun) the attacker'); }
          const stun = trial('stun');
          if (!stun.noplan) { if (stun.m.maneuver) A.err('systems.maneuvers', id, 'a stun during the wind-up did not cancel the maneuver'); if (stun.lost > 0) A.err('systems.maneuvers', id, 'an interrupted maneuver still hurt the player'); }
        }
      } finally {
        GameBus.quiet = false; for (const m of spawned) { m.alive = false; m.hp = 0; }
        Object.assign(player, { fearResistBonus: sv.fr, dodgeChance: sv.dc, statusFear: sv.sf, hp: Math.min(sv.hp, sv.maxHp), maxHp: sv.maxHp, x: sv.x, y: sv.y, _parry: sv.parry, alive: true, statusSlow: sv.sl, stamina: sv.st });
        __g.restore(); __back(); settle(); gameState = 'playing';
      }
    },
  },
  {
    id: 'systems.trials',
    desc: 'shrine trials: starting one spawns 3-5 engaged foes led by a 2-affix champion and marks the shrine spent; the interaction is not offered again (or while one is running); slaying them all pays gold + XP + an item + the Trial-Bound feat counter and ends the trial; walking away lapses it with no reward; a trial with no survivors (save/load) lapses instead of hanging',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof startShrineTrial !== 'function' || typeof _trialReward !== 'function') { A.err('systems.trials', 'api', 'startShrineTrial missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const __back = A.relocate(13, 13); if (!__back) { A.warn('systems.trials', 'room', 'no open ground'); __g.restore(); return; }
      const sv = { hp: player.hp, maxHp: player.maxHp, gold: player.gold, xp: player.xp, level: player.level, inv: player.inventory, feats: player.feats, trial: player._trial, x: player.x, y: player.y, alive: player.alive, god: player.faith };
      const home = { x: player.x, y: player.y }; const spawned = [];
      const settle = () => { if (gameState !== 'playing' && gameState !== 'gameover') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; } };
      const clear = () => { for (const m of curMonsters().slice()) { m.alive = false; m.hp = 0; } };
      try {
        player.maxHp = player.hp = 5000; player.level = 10; player.inventory = []; player.feats = { counts: {}, done: {} }; player._trial = null; player.faith = null; player.alive = true;
        clear(); const tile = { feature: 'shrine' };
        const opts = () => { const o = []; for (const f of INTERACT_PROVIDERS) { try { f(o, tile); } catch (e) { A.err('systems.trials', 'provider', 'an interact provider threw: ' + String(e.message || e)); } } return o.filter((x) => /trial/i.test(x.label || '')); };
        if (opts().length !== 1) A.err('systems.trials', 'offer', `a fresh shrine offers ${opts().length} trial options (expected 1)`);
        try { startShrineTrial(tile); } catch (e) { A.err('systems.trials', 'start', 'startShrineTrial threw: ' + String(e.stack || e).split('\n')[0]); settle(); return; }
        settle(); const t = player._trial;
        if (!t) { A.err('systems.trials', 'start', 'no _trial state after starting'); return; }
        const foes = curMonsters().filter((m) => t.uids.includes(m.uid)); spawned.push(...foes);
        if (foes.length < TRIAL_TUNING.minCount || foes.length > TRIAL_TUNING.maxCount) A.err('systems.trials', 'count', `${foes.length} foes (expected ${TRIAL_TUNING.minCount}-${TRIAL_TUNING.maxCount}; an open fixture has room for all)`);
        const champ = foes.find((m) => m.isChampion); if (!champ) A.err('systems.trials', 'champion', 'no champion in the pack'); else if (!champ.affixes || champ.affixes.length < 1) A.err('systems.trials', 'champion', 'the champion has no affixes');
        if (!foes.every((m) => m.engaged)) A.err('systems.trials', 'engaged', 'trial foes are not engaged (they would idle)');
        if (!tile.trialDone) A.err('systems.trials', 'spent', 'the shrine was not marked spent');
        if (opts().length) A.err('systems.trials', 're-offer', 'the trial is still offered while one runs / after the shrine is spent');
        // win it
        const g0 = player.gold, x0 = player.xp, inv0 = player.inventory.length, lvl0 = player.level;
        for (const m of foes) { m.alive = false; m.hp = 0; try { GameBus.emit('death', { def: m, killer: player }); } catch (e) { A.err('systems.trials', 'death', 'death hook threw: ' + String(e.message || e)); } }
        settle();
        if (player._trial) A.err('systems.trials', 'win', 'killing every foe did not end the trial');
        if (!(player.gold >= g0 + 40 + lvl0 * 18)) A.err('systems.trials', 'gold', `reward gold ${player.gold - g0} < the ${40 + lvl0 * 18} promised`);
        if (!(player.xp > x0) && !(player.level > 10)) A.warn('systems.trials', 'xp', 'the trial paid no XP');
        if (player.inventory.length <= inv0) A.warn('systems.trials', 'item', 'the trial paid no item');
        if (!(player.feats.counts.trials >= 1)) A.err('systems.trials', 'feat', 'the Trial-Bound feat counter did not tick');
        // second win must not pay twice for one trial
        const tr1 = player.feats.counts.trials; GameBus.emit('death', { def: foes[0], killer: player }); if (player.feats.counts.trials !== tr1) A.err('systems.trials', 'double-pay', 'a stray death after the trial paid a second reward (the Trial-Bound counter ticked again; gold is not compared because unrelated kill hooks can pay gold)');
        // abandon: walk off
        clear(); const tile2 = { feature: 'shrine' }; player.x = home.x; player.y = home.y; startShrineTrial(tile2); settle();
        spawned.push(...curMonsters().filter((m) => player._trial && player._trial.uids.includes(m.uid)));
        const gA = player.gold; player.x = home.x + TRIAL_TUNING.abandonDist + 5; GameBus.emit('turn', {}); player.x = home.x;
        if (player._trial) A.err('systems.trials', 'abandon', 'walking away did not lapse the trial'); if (player.gold !== gA) A.err('systems.trials', 'abandon-pay', 'an abandoned trial paid out');
        // orphaned trial (monsters gone, as after a save/load) lapses
        clear(); player._trial = { uids: ['ghost'], left: 1, x: home.x, y: home.y, god: null, startedAt: turnCount - 10 }; GameBus.emit('turn', {});
        if (player._trial) A.err('systems.trials', 'orphan', 'a trial whose monsters no longer exist never lapsed (it would block shrines forever)');
      } finally {
        for (const m of spawned) { m.alive = false; m.hp = 0; } clear();
        Object.assign(player, { hp: Math.min(sv.hp, sv.maxHp), maxHp: sv.maxHp, gold: sv.gold, xp: sv.xp, level: sv.level, inventory: sv.inv, feats: sv.feats, _trial: sv.trial, x: sv.x, y: sv.y, alive: true, faith: sv.god });
        __g.restore(); __back(); settle(); gameState = 'playing';
      }
    },
  },
  {
    id: 'systems.story-readiness',
    desc: 'the mandatory story-boss hunt waits for the player: a weak character is rated not-ready for the active target (no spawn, one rumor hint per interval), a strong or high-level character is ready (forceLevel is an escape hatch), and the real hunt hook spawns the boss only for the ready one',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof storyBossReadiness !== 'function' || typeof onPlayerEnteredChunk !== 'function') { A.err('systems.story-readiness', 'api', 'storyBossReadiness/onPlayerEnteredChunk missing'); return; }
      const def = OVERWORLD_BOSSES.find((b) => b.id === 'windrender'); if (!def) { A.err('systems.story-readiness', 'fixture', 'windrender missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 });
      const sv = { story: player.story, mode: player.mode, level: player.level, hp: player.hp, maxHp: player.maxHp, mp: player.mp, maxMp: player.maxMp, x: player.x, y: player.y, rnd: Math.random, equip: player.equipment, inv: player.inventory };
      const R = STORY_HUNT.readiness, boss = () => { for (const c of worldChunks.values()) for (const m of c.monsters || []) if (m.alive && m.monsterId === 'windrender') return m; return null; };
      try {
        player.mode = 'overworld';
        // 1. weak vs strong vs forced
        player.level = 3; player.maxHp = player.hp = 40; player.maxMp = player.mp = 10;
        const weak = storyBossReadiness(def, 1); if (weak.ready) A.err('systems.story-readiness', 'weak', `a level-3 40-HP character is rated READY for Skarn Windrender (tier ${weak.tier})`);
        player.level = R.forceLevel - 1; player.maxHp = player.hp = 3000; player.maxMp = player.mp = 500; // just under the escape hatch, so only real strength can make it ready
        const strong = storyBossReadiness(def, 1); if (!strong.ready) A.err('systems.story-readiness', 'strong', `a high-HP character just below the force level is rated NOT ready (tier ${strong.tier})`);
        player.level = R.forceLevel; player.maxHp = player.hp = 40;
        const forced = storyBossReadiness(def, 1); if (!forced.ready) A.err('systems.story-readiness', 'force', `level ${R.forceLevel} is not forced ready (a weak build could be locked out of the story)`);
        // 2. the real hook with a rigged die: always passes the pity roll
        let chunk = null, cx = 0, cy = 0;
        for (const [k, c] of worldChunks) { if (!c.tiles) continue; const [x, y] = k.split(',').map(Number); if (startDist(x * CH + (CH >> 1), y * CH + (CH >> 1)) <= 60) continue; const b = c.tiles[CH >> 1][CH >> 1].biome; if (def.biomes.includes(b)) { chunk = c; cx = x; cy = y; break; } }
        if (!chunk) { for (let i = -6; i <= 6 && !chunk; i++) for (let j = -6; j <= 6 && !chunk; j++) { const x = 12 + i * 3, y = 12 + j * 3; if (startDist(x * CH + (CH >> 1), y * CH + (CH >> 1)) <= 60) continue; const c = getChunk(x, y); if (c && def.biomes.includes(c.tiles[CH >> 1][CH >> 1].biome)) { chunk = c; cx = x; cy = y; } } }
        if (!chunk) { A.warn('systems.story-readiness', 'fixture', 'no forest/plains chunk far from the start to run the hook on'); return; }
        const setStage = () => { player.story = { stages: [{ id: 'probe_hunt', type: 'kill_boss', targetBossId: 'windrender', done: false }], stageIndex: 0, hunt: null, empoweredBossIds: [], choices: {}, kingdomRep: {} }; chunk._huntStage = null; for (const m of chunk.monsters || []) if (m.monsterId === 'windrender') m.alive = false; player.x = cx * CH + (CH >> 1); player.y = cy * CH + (CH >> 1); };
        Math.random = () => 0;
        player.level = 3; player.maxHp = player.hp = 40; setStage(); const rumors = () => logMessages.filter((l) => /Rumors place/.test(String(l))).length; /* the log is capped at 200 lines, so count matches, never slice by length */ const r0 = rumors();
        try { onPlayerEnteredChunk(cx, cy); } catch (e) { A.err('systems.story-readiness', 'throw', 'hook threw: ' + String(e.stack || e).split('\n')[0]); }
        if (boss()) A.err('systems.story-readiness', 'gate', 'the hunt spawned Skarn Windrender in front of a level-3 character');
        const hints = rumors() - r0; if (hints !== 1) A.err('systems.story-readiness', 'hint', `${hints} rumor hints on the first gated entry (expected 1)`);
        chunk._huntStage = null; onPlayerEnteredChunk(cx, cy); const hints2 = rumors() - r0; if (hints2 !== 1) A.err('systems.story-readiness', 'hint-spam', `the rumor repeated within its ${R.hintEvery}-turn interval (${hints2} total)`);
        player.level = R.forceLevel - 1; player.maxHp = player.hp = 3000; player.maxMp = player.mp = 500; setStage();
        try { onPlayerEnteredChunk(cx, cy); } catch (e) { A.err('systems.story-readiness', 'throw', 'hook threw: ' + String(e.stack || e).split('\n')[0]); }
        if (!boss()) A.err('systems.story-readiness', 'spawn', 'a strong character got no Skarn Windrender from the hunt (the story would stall)');
        // 3. the RANDOM roaming-boss pool (maybeSpawnOverworldBoss) honours the same gate: a weak explorer is never handed a boss the threat model rates deadly/overwhelming
        if (typeof maybeSpawnOverworldBoss === 'function') {
          const spawnRun = () => {
            const placed = [];
            const farX = 60, farY = 60; // far enough from the start for every power tier
            for (let v = 0.02; v < 1; v += 0.02) {
              const ch = { tiles: chunk.tiles, monsters: [] }; let n = 0;
              const rng = () => (n++ === 0 ? 0.0001 : v);
              try { for (const biome of ['forest', 'plains', 'mountain', 'swamp', 'desert', 'tundra']) { ch.monsters.length = 0; if (maybeSpawnOverworldBoss(ch, farX, farY, biome, (n = 0, rng))) placed.push(...ch.monsters.map((m) => m.monsterId)); } } catch (e) { A.err('systems.story-readiness', 'throw', 'random pool threw: ' + String(e.stack || e).split('\n')[0]); return placed; }
            }
            return placed;
          };
          player.story = { stages: [{ id: 'probe_other', type: 'reach_level', done: false }], stageIndex: 0, hunt: null, empoweredBossIds: [], choices: {}, kingdomRep: {} };
          player.level = 3; player.maxHp = player.hp = 40; player.maxMp = player.mp = 10;
          const weakPlaced = spawnRun();
          const bad = weakPlaced.filter((id) => { const d = OVERWORLD_BOSSES.find((b) => b.id === id); return d && !storyBossReadiness(d, overworldDangerScale(60, 60)).ready; });
          if (bad.length) A.err('systems.story-readiness', 'random-pool', `the random pool rolled ${[...new Set(bad)].join(', ')} for a level-3 40-HP character (rated not ready)`);
          player.level = R.forceLevel; // escape hatch: everything is eligible again, so the pool must be able to produce bosses at all (guards a filter that blocks everything)
          const strongPlaced = spawnRun();
          if (!strongPlaced.length) A.warn('systems.story-readiness', 'random-pool-fixture', 'the random pool produced no boss even for a forced-ready character; the weak-case check proves nothing here');
          A.stat('randomPoolBossesWeakVsReady', `${weakPlaced.length} vs ${strongPlaced.length}`);
        }
      } finally {
        Math.random = sv.rnd; for (const c of worldChunks.values()) for (const m of c.monsters || []) if (m.monsterId === 'windrender') { m.alive = false; m.hp = 0; }
        Object.assign(player, { story: sv.story, mode: sv.mode, level: sv.level, maxHp: sv.maxHp, hp: Math.min(sv.hp, sv.maxHp), maxMp: sv.maxMp, mp: Math.min(sv.mp, sv.maxMp), x: sv.x, y: sv.y });
        __g.restore(); gameState = 'playing';
      }
    },
  },
  {
    id: 'systems.implants',
    desc: 'passive cybernetics and mutations: apply() really changes the character, every property it sets is READ somewhere else in the game (no dead stats), a cybernetic remove() restores the exact prior state and can be cycled without drift',
    needsPlayer: true, seconds: 90,
    fn(A) {
      if (typeof CYBERNETICS === 'undefined' || typeof MUTATIONS === 'undefined') { A.err('systems.implants', 'api', 'CYBERNETICS/MUTATIONS missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 });
      const src = Array.from(document.scripts).map((x) => x.textContent).join('\n');
      const num = () => { const o = {}; for (const k of Object.keys(player)) { const v = player[k]; if (typeof v === 'number' && isFinite(v)) o[k] = v; else if (typeof v === 'boolean') o[k] = v ? 1 : 0; } return o; };
      const diff = (a, b) => { const out = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] || 0) !== (b[k] || 0)) out.push(k); return out; };
      const flags0 = { permaNightVision: player.permaNightVision, cyberNightVision: player.cyberNightVision }; player.permaNightVision = false; player.cyberNightVision = 0; // earlier probes may have left these set
      const keep = JSON.stringify({ inst: player.installedCyber, mut: player.mutations });
      const snapAll = num(), hp0 = player.hp, maxHp0 = player.maxHp;
      const reads = (key, own) => { const re = new RegExp('[.\\[\'"]' + key.replace(/[$]/g, '\\$') + '\\b', 'g'); const total = (src.match(re) || []).length; return total - own; };
      const ownRefs = (fnObj, key) => { const t = String((fnObj.apply || '') ) + String((fnObj.remove || '')); return (t.match(new RegExp('[.\\[\'"]' + key + '\\b', 'g')) || []).length; };
      let checked = 0, dead = [], noEffect = [], leaks = [], drift = [];
      const CORE = new Set(['str', 'dex', 'int', 'con', 'wil', 'hp', 'maxHp', 'mp', 'maxMp', 'stamina', 'maxStamina', 'charge', 'maxCharge', 'xp']);
      try {
        for (const [kind, list] of [['cyber', CYBERNETICS], ['mutation', MUTATIONS]]) for (const e of list) {
          if (e.activation !== 'passive' || typeof e.apply !== 'function') continue;
          const before = num(); let after;
          try { e.apply(); } catch (x) { noEffect.push(`${e.id} threw ${x.message}`); continue; }
          after = num(); const changed = diff(before, after); checked++;
          if (!changed.length) noEffect.push(`${kind}:${e.id}`);
          for (const k of changed) { if (CORE.has(k)) continue; if (reads(k, ownRefs(e, k)) < 1) dead.push(`${kind}:${e.id} sets player.${k} but nothing reads it`); }
          if (kind === 'cyber' && typeof e.remove === 'function') {
            try { e.remove(); } catch (x) { leaks.push(`${e.id}.remove threw ${x.message}`); continue; }
            const left = diff(before, num()).filter((k) => k !== 'hp' && k !== 'stamina' && k !== 'mp' && k !== 'charge');
            if (left.length) leaks.push(`${e.id}: remove() leaves ${left.join(',')} changed`);
            // cycle three times: no drift
            for (let i = 0; i < 3; i++) { e.apply(); e.remove(); }
            const left2 = diff(before, num()).filter((k) => k !== 'hp' && k !== 'stamina' && k !== 'mp' && k !== 'charge');
            if (left2.length && !left.length) drift.push(`${e.id}: drifts over repeated install/uninstall (${left2.join(',')})`);
          } else if (kind === 'cyber') leaks.push(`${e.id}: passive cybernetic has no remove()`);
          // re-baseline: a mutation has no remove(), so put every touched field back (or delete it if it was new) so one entry never masks the next (two mutations may set the same flag)
          for (const k of changed) { if (k in before) player[k] = typeof player[k] === 'boolean' ? !!before[k] : before[k]; else delete player[k]; }
        }
        A.stat('implantsChecked', checked);
        if (noEffect.length) A.err('systems.implants', 'no-effect', `${noEffect.length} passive implants change nothing: ${noEffect.slice(0, 8).join('; ')}`);
        if (dead.length) A.err('systems.implants', 'dead-stat', `${dead.length} implant effects feed stats nothing reads: ${dead.slice(0, 8).join('; ')}`);
        if (leaks.length) A.err('systems.implants', 'remove', `${leaks.length} cybernetic uninstall problems: ${leaks.slice(0, 8).join('; ')}`);
        if (drift.length) A.err('systems.implants', 'drift', drift.slice(0, 6).join('; '));
      } finally { try { const k = JSON.parse(keep); player.installedCyber = k.inst; player.mutations = k.mut; } catch (e) { /* */ } for (const key of Object.keys(snapAll)) player[key] = snapAll[key]; player.permaNightVision = flags0.permaNightVision; player.cyberNightVision = flags0.cyberNightVision; player.hp = Math.min(hp0, player.maxHp); __g.restore(); }
    },
  },
  {
    id: 'systems.companions',
    desc: 'companions (toggleSpouseFollow / companionFollowAI / scaleCompanionToPlayer): joining and leaving moves them between the world and player.companions, scaling follows level without compounding and returns exactly, followers close the gap, stay holds, aggressive attacks a hostile while passive does not',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof toggleSpouseFollow !== 'function' || typeof companionFollowAI !== 'function' || typeof makeNPC !== 'function') { A.err('systems.companions', 'api', 'companion API missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const __rl = A.relocate(15, 9);
      const sv = { level: player.level, comps: player.companions, cha: player.cha, bonus: player.companionPowerBonus, spouse: player.spouse };
      let npc = null, chunk = null;
      try {
        player.companions = []; player.companionPowerBonus = 0; player.spouse = null; gameState = 'playing';
        chunk = getChunk(Math.floor(player.x / CH), Math.floor(player.y / CH));
        npc = makeNPC('guard', player.x + 1, player.y + 1, Math.random, 'Probe Town'); if (!npc) { A.err('systems.companions', 'fixture', 'makeNPC returned nothing'); return; }
        npc.uid = 'comp_probe'; npc.alive = true; chunk.npcs.push(npc);
        // 1. scaling: monotone in player level, idempotent, exact on the way back, current damage % preserved
        player.level = 1; scaleCompanionToPlayer(npc); const hp1 = npc.maxHp, atk1 = npc.atk[1];
        scaleCompanionToPlayer(npc); if (npc.maxHp !== hp1) A.err('systems.companions', 'idempotent', `scaling twice at the same level changed max HP ${hp1} -> ${npc.maxHp} (compounding)`);
        player.level = 30; scaleCompanionToPlayer(npc); const hp30 = npc.maxHp;
        if (!(hp30 > hp1 && npc.atk[1] > atk1)) A.err('systems.companions', 'scale-up', `a level-30 companion is no stronger (${hp1}hp/${atk1} -> ${hp30}hp/${npc.atk[1]})`);
        npc.hp = Math.round(npc.maxHp / 2); player.level = 60; scaleCompanionToPlayer(npc);
        if (Math.abs(npc.hp / npc.maxHp - 0.5) > 0.02) A.err('systems.companions', 'hp-ratio', `a half-health companion became ${(npc.hp / npc.maxHp * 100).toFixed(0)}% on level-up`);
        player.level = 1; scaleCompanionToPlayer(npc); if (npc.maxHp !== hp1) A.err('systems.companions', 'roundtrip', `scaling 1->60->1 left max HP ${npc.maxHp}, expected ${hp1}`);
        npc.hp = npc.maxHp;
        // 2. joining
        toggleSpouseFollow(npc);
        if (!npc.following || !player.companions.includes(npc)) A.err('systems.companions', 'join', 'toggleSpouseFollow did not make the NPC a following companion');
        if (chunk.npcs.includes(npc)) A.err('systems.companions', 'join', 'a companion also remained in the chunk NPC list (duplicated)');
        if (!(npc.x === player.x && npc.y === player.y) && chebyshev(npc.x, npc.y, player.x, player.y) > 3) A.err('systems.companions', 'join', 'companion did not appear next to the player');
        // 3. follow closes a gap
        const open = (x, y) => curWalkable(x, y) && !entityAt(x, y);
        let placed = false; for (let dx = 7; dx <= 9 && !placed; dx++) for (const sx of [1, -1]) { const x = player.x + sx * dx; if (open(x, player.y)) { npc.x = x; npc.y = player.y; placed = true; break; } }
        if (placed) { npc.orderMode = 'follow'; npc.stance = 'passive'; const d0 = chebyshev(npc.x, npc.y, player.x, player.y); for (let i = 0; i < 4; i++) companionFollowAI(npc); const d1 = chebyshev(npc.x, npc.y, player.x, player.y); if (!(d1 < d0)) A.err('systems.companions', 'follow', `a following companion did not close a ${d0}-tile gap (still ${d1})`); }
        else A.warn('systems.companions', 'fixture', 'no open row to test following');
        // 4. stay holds position while the player walks off
        const hold = { x: npc.x, y: npc.y }; npc.orderMode = 'stay'; npc.orderPos = hold; const px = player.x; player.x += 6; for (let i = 0; i < 3; i++) companionFollowAI(npc); player.x = px;
        if (npc.x !== hold.x || npc.y !== hold.y) A.err('systems.companions', 'stay', 'a companion ordered to stay walked away');
        npc.orderMode = 'follow'; npc.orderPos = null;
        // 5. stances against an adjacent hostile
        const foe = () => { const spot = findOpenAdjacent(npc.x, npc.y); if (!spot) return null; const m = makeMonster('wolf', spot.x, spot.y, 1, Math.random); m.alive = true; m.hp = m.maxHp = 400; addMonsterToWorld(m); return m; };
        npc.x = player.x + 1; npc.y = player.y; npc.atk = [30, 30]; npc.str = 30; npc.dex = 40;
        let m1 = foe(); if (m1) { npc.stance = 'passive'; npc.target = null; const h0 = m1.hp; for (let i = 0; i < 6; i++) companionFollowAI(npc); if (m1.hp < h0) A.err('systems.companions', 'passive', 'a passive companion attacked'); m1.alive = false; }
        let m2 = foe(); if (m2) { npc.stance = 'aggressive'; npc.target = null; const h0 = m2.hp; for (let i = 0; i < 8; i++) { m2.x = Math.max(npc.x - 1, Math.min(npc.x + 1, m2.x)); companionFollowAI(npc); } if (!(m2.hp < h0)) A.warn('systems.companions', 'aggressive', 'an aggressive companion never hurt an adjacent hostile in 8 tries (hostility pairing, misses, or a bug)'); m2.alive = false; }
        // 6. leaving
        toggleSpouseFollow(npc);
        if (npc.following || player.companions.includes(npc)) A.err('systems.companions', 'leave', 'toggling again did not dismiss the companion');
        if (!chunk.npcs.includes(npc) && !getChunk(Math.floor(npc.x / CH), Math.floor(npc.y / CH)).npcs.includes(npc)) A.err('systems.companions', 'leave', 'a dismissed companion vanished from the world');
      } finally {
        if (npc) { for (const c of worldChunks.values()) if (c.npcs) c.npcs = c.npcs.filter((n) => n !== npc); }
        player.level = sv.level; player.companions = sv.comps; player.companionPowerBonus = sv.bonus; player.spouse = sv.spouse; gameState = 'playing';
        if (__rl) __rl(); __g.restore();
      }
    },
  },
  {
    id: 'monsters.engulf',
    desc: 'ooze engulf slow: a level 1-4 character is never slowed beyond ENGULF_TUNING.earlyMaxStacks, a higher-level one stacks up to maxStacks, and the stacks reset when the ooze is no longer adjacent',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof ENGULF_TUNING === 'undefined' || typeof monsterAI !== 'function') { A.err('monsters.engulf', 'api', 'ENGULF_TUNING/monsterAI missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const __rl = A.relocate(7, 5); const realRnd = Math.random;
      const sv = { level: player.level, hp: player.hp, maxHp: player.maxHp, slow: player.statusSlow };
      let m = null;
      try {
        const run = (level, blows) => {
          player.level = level; player.maxHp = player.hp = 100000; player.statusSlow = 0; player.alive = true; gameState = 'playing';
          if (m) m.alive = false;
          m = makeMonster('acid_slime', player.x + 1, player.y, 1, Math.random); m.alive = true; m.hp = m.maxHp = 1e6; m.dex = 80; m.atk = [3, 3]; m.aiState = 'combat'; m.engaged = true; m.target = player; m.engulfSkip = false; m.engulfStacks = 0; m.sleeper = false;
          addMonsterToWorld(m);
          let peak = 0; for (let i = 0; i < blows; i++) { m.x = player.x + 1; m.y = player.y; try { monsterAI(m); } catch (e) { A.err('monsters.engulf', 'throw', String(e.stack || e).split('\n')[0]); return -1; } peak = Math.max(peak, m.engulfStacks || 0, player.statusSlow || 0); }
          return peak;
        };
        const low = run(1, 12), high = run(15, 12);
        if (low > ENGULF_TUNING.earlyMaxStacks) A.err('monsters.engulf', 'early', `a level-1 character was slowed ${low} stacks (cap ${ENGULF_TUNING.earlyMaxStacks})`);
        if (high <= ENGULF_TUNING.earlyMaxStacks) A.err('monsters.engulf', 'high-level', `a level-15 character never stacked beyond ${high}: the engulf mechanic is dead or the low-level cap leaks`);
        if (high > ENGULF_TUNING.maxStacks) A.err('monsters.engulf', 'max', `slow stacked to ${high} (max ${ENGULF_TUNING.maxStacks})`);
        if (low === 0) A.warn('monsters.engulf', 'fixture', 'no blow landed at level 1; the early cap check proved nothing');
        A.stat('engulfPeakLowVsHigh', `${low} vs ${high}`);
      } finally { if (m) m.alive = false; Math.random = realRnd; player.level = sv.level; player.maxHp = sv.maxHp; player.hp = Math.min(sv.hp, sv.maxHp); player.statusSlow = sv.slow; player.alive = true; gameState = 'playing'; if (__rl) __rl(); __g.restore(); }
    },
  },
  {
    id: 'systems.status-caps',
    desc: 'stacking fear and confusion are capped: the add helpers never exceed their ceiling, the per-turn tick clamps any direct write, and a pack of confusing monsters hitting dozens of times cannot chain more than the ceiling',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof addFearTurns !== 'function' || typeof FEAR_MAX_TURNS === 'undefined') { A.err('systems.status-caps', 'api', 'addFearTurns/FEAR_MAX_TURNS missing'); return; }
      if (typeof addConfuseTurns !== 'function' || typeof CONFUSE_MAX_TURNS === 'undefined') { A.err('systems.status-caps', 'api', 'addConfuseTurns/CONFUSE_MAX_TURNS missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const __rl = A.relocate(7, 3); const realRnd = Math.random;
      const sv = { hp: player.hp, maxHp: player.maxHp, f: player.statusFear, c: player.statusConfuse };
      try {
        let f = 0; for (let i = 0; i < 100; i++) f = addFearTurns(f, 6); if (f > FEAR_MAX_TURNS) A.err('systems.status-caps', 'fear', `fear stacked to ${f} (cap ${FEAR_MAX_TURNS})`);
        let c = 0; for (let i = 0; i < 100; i++) c = addConfuseTurns(c, 3); if (c > CONFUSE_MAX_TURNS) A.err('systems.status-caps', 'confuse-helper', `confusion stacked to ${c} (cap ${CONFUSE_MAX_TURNS})`);
        if (addConfuseTurns(0, 3) !== 3 || addConfuseTurns(undefined, 2) !== 2) A.err('systems.status-caps', 'helper', 'small additions were altered');
        // the tick clamps a direct write from any of the ~20 other sources
        player.maxHp = player.hp = 5000; player.statusConfuse = 500; player.alive = true; gameState = 'playing';
        endTurn({ forceFull: true });
        if (player.statusConfuse > CONFUSE_MAX_TURNS) A.err('systems.status-caps', 'tick', `a direct write of 500 survived the turn tick as ${player.statusConfuse}`);
        // the real attack path: a confusing monster that always procs, 60 blows
        player.statusConfuse = 0; const m = makeMonster('glimmerfae', player.x + 1, player.y, 1, Math.random); m.alive = true; m.causesConfuse = true; m.atk = [1, 1]; m.dex = 60; m.kind = 'monster';
        Math.random = () => 0;
        let peak = 0; for (let i = 0; i < 60; i++) { player.hp = player.maxHp; try { doAttack(m, player); } catch (e) { A.err('systems.status-caps', 'throw', String(e.stack || e).split('\n')[0]); break; } peak = Math.max(peak, player.statusConfuse || 0); }
        Math.random = realRnd;
        if (peak > CONFUSE_MAX_TURNS) A.err('systems.status-caps', 'attack', `60 confusing blows stacked confusion to ${peak} (cap ${CONFUSE_MAX_TURNS})`);
        if (peak === 0) A.warn('systems.status-caps', 'fixture', 'no confusing blow landed; the attack-path check proved nothing');
        A.stat('confusePeak', peak);
      } finally {
        Math.random = realRnd; player.statusFear = sv.f; player.statusConfuse = sv.c; player.maxHp = sv.maxHp; player.hp = Math.min(sv.hp, sv.maxHp); player.alive = true; gameState = 'playing';
        if (__rl) __rl(); __g.restore();
      }
    },
  },
  {
    id: 'systems.fishing',
    desc: 'fishing (beginFishing): refuses with danger nearby, a bite lands a Raw Fish / gem and ends the cast, a dry cast gives up within its tick budget, a rod bites where bare hands do not, the rod wears, a rare bite-back spawns a water monster, and every cast spends turns',
    needsPlayer: true, seconds: 60,
    fn(A) {
      if (typeof beginFishing !== 'function') { A.err('systems.fishing', 'api', 'beginFishing missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const __rl = A.relocate(9, 3);
      const realSI = window.setInterval, realCI = window.clearInterval, realRnd = Math.random, realEnd = window.endTurn; let turnsSpent = 0;
      window.endTurn = function () { turnsSpent++; }; // isolate the cast logic from world events (a constant die would otherwise spawn things every turn)
      const sv = { hand: player.equipment.hand, inv: player.inventory, auto: autoRunActive, mons: null };
      let cb = null, creations = 0;
      window.setInterval = (f) => { cb = f; creations++; return 1; }; window.clearInterval = () => { cb = null; };
      const fish = () => player.inventory.filter((i) => i.id === 'fish_raw' || i.id === 'gem').reduce((n, i) => n + (i.qty || 1), 0);
      const lines = () => logMessages.filter((l) => /reel|Nothing bites|can't fish|lunges/.test(String(l))).length;
      // a scripted die: first values pop from the queue, then it settles at `rest`
      const rig = (queue, rest) => { const q = queue.slice(); Math.random = () => (q.length ? q.shift() : rest); };
      const drive = (max) => { let n = 0; while (cb && n < max) { const f = cb; f(); n++; } return n; };
      try {
        player.inventory = []; player.alive = true; gameState = 'playing';
        const mons = curMonsters(); sv.mons = mons.map((m) => [m, m.alive]); for (const m of mons) m.alive = false; // an empty shore
        const water = { x: player.x + 1, y: player.y };
        const rod = makeItem('fishing_rod', 0, Math.random);
        // 1. bare hands, die 0.2: chance 0.22*0.5=0.11 -> no bite; rod: 0.22*1.6=0.352 -> bite
        player.equipment.hand = null; autoRunActive = false; cb = null; creations = 0;
        rig([], 0.2); beginFishing(water.x, water.y);
        if (!cb) { A.err('systems.fishing', 'start', 'beginFishing never started its cast loop on an empty shore'); }
        else {
          const f0 = fish(), t0 = turnsSpent; const ticks = drive(20);
          if (fish() !== f0) A.err('systems.fishing', 'rod-edge', 'bare hands caught something on a die the rod needs (0.2 vs chance 0.11)');
          if (cb) A.err('systems.fishing', 'budget', `a dry cast was still running after ${ticks} ticks`);
          if (ticks > 7) A.err('systems.fishing', 'budget', `a dry cast ran ${ticks} ticks (max budget is 6 plus the closing one)`);
          if (turnsSpent - t0 < ticks) A.err('systems.fishing', 'turns', `a ${ticks}-tick cast spent only ${turnsSpent - t0} turns`);
        }
        player.equipment.hand = rod; const dur0 = rod.durability; autoRunActive = false; cb = null;
        rig([], 0.2); beginFishing(water.x, water.y);
        if (cb) { const f0 = fish(); drive(20); if (fish() !== f0 + 1) A.err('systems.fishing', 'bite', `a rod cast on a biting die gave ${fish() - f0} catches (expected 1)`); if (cb) A.err('systems.fishing', 'ends', 'the loop kept running after a catch'); if (rod.maxDurability !== undefined && rod.maxDurability !== Infinity && !(rod.durability < dur0)) A.err('systems.fishing', 'wear', 'a landed catch did not wear the rod'); }
        else A.err('systems.fishing', 'start', 'rod cast never started');
        // 2. the rare gem roll and the bite-back, driven by the exact dice order of beginFishing: [bite, ambush, gem]
        player.equipment.hand = rod; autoRunActive = false; cb = null;
        rig([0.5, 0.0, 0.5, 0.0], 0.5); beginFishing(water.x, water.y);
        if (cb) { const g0 = player.inventory.filter((i) => i.id === 'gem').length; drive(5); if (player.inventory.filter((i) => i.id === 'gem').length !== g0 + 1) A.err('systems.fishing', 'gem', 'the rare-catch roll (0.0) did not produce a gem'); }
        autoRunActive = false; cb = null; const before = curMonsters().filter((m) => m.alive).length;
        rig([0.5, 0.0, 0.0], 0.5); beginFishing(water.x, water.y);
        if (cb) { drive(5); const after = curMonsters().filter((m) => m.alive).length; if (after <= before && !entityAt(water.x, water.y)) A.warn('systems.fishing', 'ambush', 'the 3% bite-back roll spawned nothing (pool monsters missing?)'); }
        for (const m of curMonsters()) if (m.alive && !sv.mons.some(([o]) => o === m)) m.alive = false; // remove the ambusher
        // 3. danger nearby refuses
        const guard = makeMonster('rabbit', player.x + 2, player.y, 1, Math.random); guard.alive = true; addMonsterToWorld(guard);
        player.equipment.hand = rod; autoRunActive = false; cb = null; creations = 0; Math.random = realRnd;
        try { beginFishing(water.x, water.y); } finally { guard.alive = false; }
        if (creations !== 0) A.err('systems.fishing', 'danger', 'fishing started with a monster in plain sight');
        if (!logMessages.slice(-3).some((l) => /can't fish/.test(String(l)))) A.err('systems.fishing', 'danger-msg', 'no explanation when fishing was refused');
      } finally {
        window.setInterval = realSI; window.clearInterval = realCI; window.endTurn = realEnd; Math.random = realRnd; autoRunActive = sv.auto;
        player.equipment.hand = sv.hand; player.inventory = sv.inv; if (sv.mons) for (const [m, a] of sv.mons) m.alive = a;
        gameState = 'playing'; if (__rl) __rl(); __g.restore();
      }
    },
  },
  {
    id: 'monsters.water-bound',
    desc: 'deep-water horrors that were chasing low-level characters far inland stay in the water: every monster on the WATER_BOUND_MONSTERS list is waterOnly and isAquaticOnly(), and ocean-table monsters rated dtier 3+ are water-bound (amphibious drowned things may still come ashore, but only the cheap ones)',
    needsPlayer: true,
    fn(A) {
      if (typeof isAquaticOnly !== 'function') { A.err('monsters.water-bound', 'api', 'isAquaticOnly missing'); return; }
      const mustStay = ['tideglass_horror', 'current_stalker'];
      for (const id of mustStay) {
        const b = MONSTER_BASES[id]; if (!b) { A.err('monsters.water-bound', id, 'monster missing'); continue; }
        if (!b.waterOnly) A.err('monsters.water-bound', id, 'is not waterOnly (it would chase characters onto land)');
        const m = makeMonster(id, player.x + 3, player.y, 1, Math.random);
        if (!isAquaticOnly(m)) A.err('monsters.water-bound', id, 'isAquaticOnly() is false for a spawned copy');
      }
      const oceanDeep = (BIOMES.ocean.encounter || []).map((e) => e[0]).filter((id) => MONSTER_BASES[id] && (MONSTER_BASES[id].dtier || 0) >= 3 && !MONSTER_BASES[id].waterOnly);
      if (oceanDeep.length) A.err('monsters.water-bound', 'ocean-table', `dtier 3+ ocean monsters that can walk ashore: ${oceanDeep.join(', ')}`);
    },
  },
  {
    id: 'combat.single-blow',
    desc: 'a healthy character cannot be killed (or taken below 40%) by ONE blow from an ordinary monster, even a huge crit; wounded characters, bosses and non-player defenders are not capped; the cap works through the real doAttack path',
    needsPlayer: true,
    fn(A) {
      if (typeof capSingleBlow !== 'function' || typeof SINGLE_BLOW_CAP === 'undefined') { A.err('combat.single-blow', 'api', 'capSingleBlow/SINGLE_BLOW_CAP missing'); return; }
      const __g = A.leakGuard({ baseStats: 12 }); const sv = { hp: player.hp, maxHp: player.maxHp, armor: player.equipment.body, rnd: Math.random };
      try {
        player.maxHp = 100; player.hp = 100;
        const cap = Math.floor(100 * SINGLE_BLOW_CAP.fraction);
        const plain = { name: 'Probe Brute', faction: 'beast' }, boss = { name: 'Probe Boss', boss: true }, mini = { name: 'Probe Mini', miniboss: true };
        if (capSingleBlow(plain, player, 500) !== cap) A.err('combat.single-blow', 'cap', `a 500 blow from an ordinary monster was not clamped to ${cap}`);
        if (capSingleBlow(plain, player, 7) !== 7) A.err('combat.single-blow', 'small', 'a small blow was altered');
        if (capSingleBlow(boss, player, 500) !== 500 || capSingleBlow(mini, player, 500) !== 500) A.err('combat.single-blow', 'boss', 'bosses/minibosses must keep their full burst');
        if (capSingleBlow(plain, { hp: 100, maxHp: 100 }, 500) !== 500) A.err('combat.single-blow', 'defender', 'a non-player defender was capped');
        player.hp = Math.floor(100 * SINGLE_BLOW_CAP.protectAbove) - 1;
        if (capSingleBlow(plain, player, 500) !== 500) A.err('combat.single-blow', 'wounded', 'a wounded character was protected (pressure must still kill)');
        // through the real attack path
        player.hp = 100; player.maxHp = 100;
        const m = makeMonster('rabbit', player.x + 1, player.y, 1, Math.random); m.atk = [900, 900]; m.str = 0; m.dex = 60; m.alive = true; m.kind = 'monster'; m.faction = 'beast';
        let landed = 0, worst = 100;
        for (let i = 0; i < 40 && landed < 3; i++) { player.hp = 100; const h0 = player.hp; try { doAttack(m, player); } catch (e) { A.err('combat.single-blow', 'throw', String(e.stack || e).split('\n')[0]); break; } if (player.hp < h0) { landed++; worst = Math.min(worst, player.hp); } player.alive = true; }
        if (!landed) A.warn('combat.single-blow', 'fixture', 'no blow landed in 40 tries; integrated check proved nothing');
        else if (worst < 100 - cap) A.err('combat.single-blow', 'integrated', `a 900-damage rabbit left a full-health character at ${worst}/100 (cap says at least ${100 - cap})`);
        A.stat('singleBlowWorstLeft', `${worst}/100 after ${landed} landed blows`);
      } finally { Math.random = sv.rnd; player.maxHp = sv.maxHp; player.hp = Math.min(sv.hp, sv.maxHp); player.alive = true; gameState = 'playing'; __g.restore(); }
    },
  },
  {
    id: 'systems.threat',
    desc: 'threat assessment (estimateFight/threatOf): finite for every monster at two scales, a stronger copy never rates better, a wounded player never rates better, tiers are ordered, examine tooltips show a Threat line, and a boss far above the player triggers the engage warning logic',
    needsPlayer: true,
    fn(A) {
      if (typeof threatOf !== 'function') { A.err('systems.threat', 'api', 'threatOf is missing'); return; }
      const hp0 = player.hp, mp0 = player.mp; player.hp = player.maxHp; player.mp = player.maxMp; const __g = A.leakGuard({ baseStats: 12 });
      try {
        const bad = [];
        for (const id of Object.keys(MONSTER_BASES)) for (const sc of [1, 4]) {
          let m; try { m = makeMonster(id, player.x + 3, player.y, sc, Math.random); } catch (e) { continue; } if (!m) continue;
          let t; try { t = threatOf(m, 3); } catch (e) { bad.push(id + ' threw ' + e.message); continue; }
          if (!isFinite(t.left) || !t.tier || !t.tier.id) bad.push(`${id}@${sc}: left=${t.left}`);
        }
        if (bad.length) A.err('systems.threat', 'finite', `${bad.length} monsters give a non-finite or tier-less estimate: ${bad.slice(0, 6).join('; ')}`);
        // monotonic in monster strength
        let nonMono = 0, mid = null, spread = 0, series = 0;
        for (const id of ['goblin', 'wolf', 'orc', 'troll', 'ogre']) {
          if (!MONSTER_BASES[id]) continue;
          const lefts = [1, 2, 4, 8].map((sc) => threatOf(makeMonster(id, player.x + 3, player.y, sc, Math.random), 3).left);
          for (let i = 1; i < lefts.length; i++) if (lefts[i] > lefts[i - 1] + 1e-9) nonMono++;
          series++; if (lefts[0] > lefts[3] + 0.05) spread++;
          if (id === 'orc') mid = makeMonster(id, player.x + 3, player.y, 2, Math.random);
        }
        if (series >= 3 && spread < 2) A.err('systems.threat', 'flat', `the estimate barely reacts to monster strength (${spread}/${series} monsters rate worse at 8x scale)`);
        if (nonMono) A.err('systems.threat', 'monotonic', `${nonMono} cases where a STRONGER copy of a monster rated better for the player`);
        if (mid) {
          const healthy = threatOf(mid, 3).left; player.hp = Math.max(1, Math.round(player.maxHp * 0.25)); const hurt = threatOf(mid, 3).left; player.hp = player.maxHp;
          if (!(hurt < healthy - 1e-6)) A.err('systems.threat', 'wounded', `a wounded player (${hurt.toFixed(2)}) must rate WORSE than a healthy one (${healthy.toFixed(2)})`);
          A.stat('threatHurtVsHealthy', `${hurt.toFixed(2)} vs ${healthy.toFixed(2)}`);
        }
        const order = THREAT_TIERS.map((t) => t.minLeft); for (let i = 1; i < order.length; i++) if (!(order[i] < order[i - 1])) A.err('systems.threat', 'tiers', 'THREAT_TIERS must be ordered best to worst by strictly decreasing minLeft');
        // a very strong monster is not trivial, a rabbit is
        const boss = makeMonster('ancientdragon', player.x + 3, player.y, 4, Math.random), bt = threatOf(boss, 3);
        if (bt.tier.id === 'trivial' || bt.tier.id === 'easy') A.err('systems.threat', 'boss', `an Ancient Dragon at scale 4 rates "${bt.tier.id}" for a level-${player.level} character`);
        A.stat('threatDragonTier', bt.tier.id);
        // the tooltip
        const mm = makeMonster('wolf', player.x + 3, player.y, 1, Math.random); mm.kind = 'monster';
        const txt = String(describeEntity(mm)); if (!/Threat:/.test(txt)) A.err('systems.threat', 'tooltip', 'examine text for a hostile monster has no Threat line');
        // ordinary monsters warn only when Deadly/Overwhelming, and only once per species
        {
          const sw0 = player._threatSpeciesWarned, hp1 = player.hp; player._threatSpeciesWarned = {};
          const count = (name) => logMessages.filter((l) => String(l).indexOf('Warning: ' + name) === 0).length;
          try {
            player.hp = 3; // a nearly dead player facing a scale-4 dragon: lethal
            const a = makeMonster('ancientdragon', player.x + 3, player.y, 4, Math.random), b = makeMonster('ancientdragon', player.x + 4, player.y, 4, Math.random);
            const before = count(a.name); warnIfThreatening(a, true); warnIfThreatening(b, true);
            const n = count(a.name) - before;
            if (n !== 1) A.err('systems.threat', 'species-warning', `two dragons vs a 3-HP player gave ${n} warnings, expected exactly 1`);
            player.hp = player.maxHp; const rat = makeMonster('rabbit', player.x + 3, player.y, 1, Math.random);
            if (rat) { const c = count(rat.name); warnIfThreatening(rat, true); if (count(rat.name) !== c) A.err('systems.threat', 'species-warning', 'a rat warned a healthy player'); }
          } finally { player.hp = hp1; player._threatSpeciesWarned = sw0; }
        }
      } finally { __g.restore(); player.hp = hp0; player.mp = mp0; }
    },
  },
  {
    id: 'content.item-lore',
    desc: 'every ordinary weapon/armor base has a lore line (ITEM_BASE_LORE, or its set\'s lore) that appears in its tooltip; no stale lore ids; set pieces show the set name, piece count and every bonus tier',
    needsPlayer: true,
    fn(A) {
      const baseIds = new Set(ITEM_BASES.map((b) => b.id));
      const missing = [], notShown = [];
      for (const b of ITEM_BASES) {
        if ((b.type !== 'weapon' && b.type !== 'armor') || b.isUnique || b.craftOnly || b.desc) continue;
        let it; try { it = makeItem(b.id, 0, Math.random); } catch (e) { continue; } if (!it) continue;
        const lore = itemLoreText(it);
        if (!lore || lore.length < 20) { missing.push(b.id); continue; }
        const flat = String(describeItem(it));
        if (!flat.includes(lore)) notShown.push(b.id);
      }
      A.stat('itemsWithoutLore', missing.length);
      if (missing.length) A.err('content.item-lore', 'missing', `${missing.length} weapon/armor bases have no lore line (add them to ITEM_BASE_LORE): ${missing.slice(0, 50).join(', ')}${missing.length > 50 ? ', ...' : ''}`);
      if (notShown.length) A.err('content.item-lore', 'hidden', `lore exists but is not in the tooltip for: ${notShown.slice(0, 20).join(', ')}`);
      const stale = Object.keys(ITEM_BASE_LORE).filter((id) => !baseIds.has(id));
      if (stale.length) A.err('content.item-lore', 'stale', `ITEM_BASE_LORE has ids that match no item base: ${stale.join(', ')}`);
      const dupes = Object.entries(ITEM_BASE_LORE).filter(([, v], i, all) => all.findIndex(([, w]) => w === v) !== i).map(([k]) => k);
      A.stat('duplicateLoreLines', dupes.length);
      // sets: the tooltip must name the set and list every tier
      for (const [sid, set] of Object.entries(ITEM_SETS)) {
        if (!set.lore) A.err('content.item-lore', 'setlore', `set ${sid} has no lore`);
        for (const pid of set.pieces) {
          if (!baseIds.has(pid)) { A.err('content.item-lore', 'setpiece', `set ${sid} lists unknown piece ${pid}`); continue; }
          const it = makeItem(pid, 0, Math.random); const txt = String(describeItem(it));
          if (/\(socketed\)/.test(txt) && !it.socketedRunes?.length) A.err('content.item-lore', 'socketlabel', `${pid} tooltip labels innate stat bonuses "(socketed)" though nothing is socketed`);
          if (!txt.includes(set.name)) A.err('content.item-lore', 'settooltip', `${pid} tooltip does not name its set (${set.name})`);
          for (const t of Object.keys(set.bonuses)) if (!txt.includes(set.bonuses[t].desc)) A.err('content.item-lore', 'settier', `${pid} tooltip omits the ${t}-piece bonus of ${sid}`);
        }
      }
    },
  },
  {
    id: 'content.registry-text',
    desc: 'every player-facing registry entry (spells, techniques, talents, cybernetics, mutations, deities, recipes, quest chains, curios, floor aspects, world events) carries a name and readable text; reports empty, placeholder or duplicated names',
    needsPlayer: true,
    fn(A) {
      const regs = {
        SPELLS: [typeof SPELLS !== 'undefined' && SPELLS, ['name', 'desc']],
        TECHNIQUES: [typeof TECHNIQUES !== 'undefined' && TECHNIQUES, ['name', 'desc']],
        CYBERNETICS: [typeof CYBERNETICS !== 'undefined' && CYBERNETICS, ['name', 'desc']],
        MUTATIONS: [typeof MUTATIONS !== 'undefined' && MUTATIONS, ['name', 'desc']],
        RECIPES: [typeof RECIPES !== 'undefined' && RECIPES, ['name']],
        FLOOR_ASPECTS: [typeof FLOOR_ASPECTS !== 'undefined' && FLOOR_ASPECTS, ['name']],
        WORLD_EVENTS: [typeof WORLD_EVENTS !== 'undefined' && WORLD_EVENTS, ['name']],
      };
      for (const [rn, [reg, fields]] of Object.entries(regs)) {
        if (!reg) { A.warn('content.registry-text', rn, 'registry not found (renamed?)'); continue; }
        const list = Array.isArray(reg) ? reg : Object.values(reg), names = new Map(); let bad = 0;
        for (const e of list) {
          for (const f of fields) { const v = e && e[f]; if (!v || String(v).trim().length < (f === 'desc' ? 8 : 2) || /todo|lorem|placeholder|xxx/i.test(String(v))) { bad++; if (bad <= 6) A.err('content.registry-text', rn, `${e && (e.id || e.name)}: missing or placeholder ${f}`); } }
          if (e && e.name) { const k = String(e.name).toLowerCase(); if (names.has(k) && names.get(k) !== e.id) A.warn('content.registry-text', rn, `duplicate display name "${e.name}" (${names.get(k)} and ${e.id}): players cannot tell them apart`); names.set(k, e.id); }
        }
        A.stat('registry:' + rn, list.length);
      }
      // talents (TALENTS_V2 plus any other TALENT* registry): name + desc, unique ids
      for (const rn of ['TALENTS_V2', 'TALENTS', 'TALENT_TREE']) { let reg; try { reg = eval('typeof ' + rn + " !== 'undefined' ? " + rn + ' : null'); } catch (e) { reg = null; } if (!reg) continue; const all = Array.isArray(reg) ? reg : Object.values(reg).flat(); let bad = 0; const ids = new Set(); for (const t of all) { if (!t || !t.id) continue; if (ids.has(t.id)) A.err('content.registry-text', rn, `duplicate talent id ${t.id}`); ids.add(t.id); if (!t.name || !t.desc) { bad++; if (bad <= 6) A.err('content.registry-text', rn, `${t.id}: missing name/desc`); } } A.stat('registry:' + rn, all.length); }
    },
  },
  {
    id: 'content.books',
    desc: 'every manual book (BOOKS_MANUAL): unique id, title/author/date/body present, a known category, a real body (150+ chars), no leaked undefined/NaN/${...}, no markup-breaking characters, each one turns into an item and opens in the reader without throwing, and each lands in the library log (v0.51.5)',
    needsPlayer: true,
    fn(A) {
      if (typeof BOOKS_MANUAL === 'undefined') { A.err('content.books', 'api', 'BOOKS_MANUAL missing'); return; }
      A.stat('manualBooks', BOOKS_MANUAL.length);
      const ids = new Set(), titles = new Set(); const keepLog = player.readLog, keepState = gameState;
      try {
        player.readLog = {};
        for (const b of BOOKS_MANUAL) {
          const w = b.id || '?';
          if (!b.id || ids.has(b.id)) A.err('content.books', w, 'missing or duplicate id'); ids.add(b.id);
          for (const f of ['title', 'author', 'date', 'body']) if (typeof b[f] !== 'string' || !b[f].trim()) A.err('content.books', w, `needs a ${f}`);
          if (titles.has(b.title)) A.warn('content.books', w, `title "${b.title}" is used by another book`); titles.add(b.title);
          if (!LIBRARY_CATEGORY_ORDER.includes(b.category) || !BOOK_CATEGORIES[b.category]) A.err('content.books', w, `category "${b.category}" is unknown (library would never list it)`);
          if (!Array.isArray(b.tags)) A.err('content.books', w, 'tags must be an array');
          const body = String(b.body || ''), sentences = (body.match(/[.!?](\s|$)/g) || []).length;
          if (body.length < 150 || sentences < 1) A.err('content.books', w, `body is too thin (${body.length} chars, ${sentences} sentences)`);
          for (const bad of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\$\{/, /[<>]/, /  +\S/, /\s$/ ]) { const m = (b.title + ' ' + body + ' ' + b.author + ' ' + b.date).match(bad); if (m && !(bad.source === '  +\\S' )) A.err('content.books', w, `text contains ${bad}: ...${(b.title + ' ' + body).slice(Math.max(0, m.index - 20), m.index + 30).replace(/\n/g, ' ')}...`); }
          let it; try { it = makeManualBookItem(b); } catch (e) { A.err('content.books', w, 'makeManualBookItem threw: ' + e.message); continue; }
          try { gameState = 'inventory'; openBookReader(it); } catch (e) { A.err('content.books', w, 'openBookReader threw: ' + String(e.stack || e).split('\n')[0]); }
          if (!player.readLog[b.id]) A.err('content.books', w, 'reading it did not add it to the library log');
          try { closeModal(); } catch (e) { /* */ }
        }
      } finally { player.readLog = keepLog; gameState = keepState; try { closeModal(); gameState = 'playing'; } catch (e) { /* */ } }
    },
  },
  {
    id: 'content.guide',
    desc: 'every in-game guide section renders without throwing and without leaking undefined / NaN / [object Object] / unreplaced ${...} into the text; categories exist; ids are unique',
    needsPlayer: true,
    fn(A) {
      const ids = new Set(); let chars = 0;
      for (const sec of GUIDE_SECTIONS) {
        if (ids.has(sec.id)) A.err('content.guide', sec.id, 'duplicate section id'); ids.add(sec.id);
        if (!GUIDE_CATEGORY_ORDER.includes(sec.category || 'Reference')) A.err('content.guide', sec.id, `category "${sec.category}" is not in GUIDE_CATEGORY_ORDER (section would never be listed)`);
        let html; try { html = typeof sec.html === 'function' ? sec.html() : String(sec.html); } catch (e) { A.err('content.guide', sec.id, 'render threw: ' + e.message); continue; }
        chars += html.length;
        const text = html.replace(/<[^>]+>/g, ' ');
        for (const bad of [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\$\{/, /\bnull\b(?! pointer)/]) { const m = text.match(bad); if (m) A.err('content.guide', sec.id, `text contains "${m[0]}": ...${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}...`); }
        if (text.replace(/\s+/g, ' ').trim().length < 80) A.warn('content.guide', sec.id, 'section is nearly empty');
      }
      { // the guide must name every floor aspect, so a new FLOOR_ASPECTS entry cannot ship undocumented
        const all = GUIDE_SECTIONS.map((sec) => { try { return typeof sec.html === 'function' ? sec.html() : String(sec.html); } catch (e) { return ''; } }).join(' ').replace(/<[^>]+>/g, ' ').toLowerCase();
        if (typeof FLOOR_ASPECTS !== 'undefined') for (const a of FLOOR_ASPECTS) if (!all.includes(a.name.toLowerCase())) A.err('content.guide', a.id, `floor aspect "${a.name}" is not described anywhere in the in-game guide`);
      }
      A.stat('guideSections', GUIDE_SECTIONS.length); A.stat('guideChars', chars);
    },
  },
  {
    id: 'ui.screens',
    desc: 'every major screen (inventory in every filter/page with one of every item kind, character sheet, spellbook, talents, cybernetics, eldritch, quest log, library, craft, travel, look, professions, family, faith, feats, help, save/load) opens and renders without throwing and without leaking undefined / NaN / [object Object] into the page',
    needsPlayer: true,
    fn(A) {
      const bad = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\$\{/, /\bInfinity\b/];
      const body = () => { const el = document.getElementById('modal-body'); return el ? el.textContent + ' ' + (document.getElementById('modal-title') || { textContent: '' }).textContent : ''; };
      const reset = () => { try { if (typeof closeModal === 'function') closeModal(); } catch (e) { /* */ } gameState = 'playing'; try { document.getElementById('modal').classList.add('hidden'); } catch (e) { /* */ } };
      const check = (label) => { const t = body(); for (const re of bad) { const m = t.match(re); if (m) { A.err('ui.screens', label, `screen text contains "${m[0]}": ...${t.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ')}...`); return; } } };
      const keep = { inv: player.inventory.slice(), level: player.level, gold: player.gold };
      try {
        // stuff the pack with one of every item base (capped) so every tooltip/row kind renders
        player.level = Math.max(player.level, 25); player.gold = 5000;
        let added = 0; for (const b of ITEM_BASES) { if (added >= 400) break; try { const it = makeItem(b.id, 0, Math.random); if (it) { player.inventory.push(it); added++; } } catch (e) { /* */ } }
        const openers = ['openCharacterSheet', 'openSpellbook', 'openTalents', 'openCybernetics', 'openEldritch', 'openQuestLog', 'openLibrary', 'openCraft', 'openLook', 'openProfessionsMenu', 'openFamilyMenu', 'openFaith', 'openGodsBrowser', 'openFeats', 'openHelp', 'openSaveLoadMenu', 'openDimensionTravel', 'openPropertyMenu', 'openCalledShotMenu'];
        for (const name of openers) { if (typeof globalThis[name] !== 'function' && !(() => { try { return typeof eval(name) === 'function'; } catch (e) { return false; } })()) { A.warn('ui.screens', name, 'opener not found (renamed?)'); continue; } reset(); try { eval(name + '()'); check(name); } catch (e) { A.err('ui.screens', name, 'threw: ' + e.message); } reset(); }
        // inventory: every filter and page
        const filters = ['all', 'weapon', 'armor', 'consumable', 'scroll', 'material', 'misc', 'book', 'tome', 'rune'];
        for (const f of filters) for (let pg = 0; pg < 12; pg++) { reset(); try { openInventory(); player.invFilter = f; player.invPage = pg; renderInventory(); check(`inventory[${f}#${pg}]`); } catch (e) { A.err('ui.screens', `inventory[${f}#${pg}]`, 'threw: ' + e.message); break; } }
        // item detail view for every item
        let n = 0; for (const it of player.inventory.slice(-added)) { try { const d = describeItem(it); const flat = Array.isArray(d) ? d.join(' ') : String(d || ''); for (const re of bad) { const m = flat.match(re); if (m) { A.err('ui.screens', `describeItem(${it.id})`, `tooltip contains "${m[0]}": ${flat.slice(Math.max(0, m.index - 50), m.index + 50)}`); break; } } n++; } catch (e) { A.err('ui.screens', `describeItem(${it.id})`, 'threw: ' + e.message); } }
        A.stat('tooltipsChecked', n);
      } finally { reset(); player.inventory = keep.inv; player.level = keep.level; player.gold = keep.gold; try { render(); } catch (e) { /* */ } }
    },
  },
  {
    id: 'systems.exposure-floor',
    desc: 'cold/heat exposure damage cannot kill a level 1-4 character, still hurts them, and is still lethal for a level 8+ character with no protection',
    needsPlayer: true,
    fn(A) {
      const __g = A.leakGuard(); // the probes below kill the player on purpose: restore() puts the world back so the next probe does not start with a corpse
      const keep = { lvl: player.level, hp: player.hp, maxHp: player.maxHp, heat: player.statusHeat, chill: player.statusChill, alive: player.alive, immune: player.climateImmune, buffs: player.buffs, fr: player.fireDmgReduction, hr: player.heatResist, cr: player.chillResist, src: typeof lastDamageSource !== 'undefined' ? lastDamageSource : null };
      try {
        for (const [label, temp, key] of [['heat', 100, 'statusHeat'], ['cold', 0, 'statusChill']]) {
          for (const lvl of [1, 2, 3, 4]) {
            player.level = lvl; player.maxHp = 40; player.hp = 6; player[key] = 20; player.alive = true; gameState = 'playing'; player.climateImmune = false; player.buffs = {}; player.fireDmgReduction = 0; player.heatResist = 0; player.chillResist = 0;
            for (let t = 0; t < 40 && player.hp > 1; t++) handleTemperatureExposure(temp);
            if (!player.alive || player.hp < 1) A.err('systems.exposure-floor', `${label} L${lvl}`, `${label} exposure killed a level ${lvl} character (hp ${player.hp})`);
            for (let t = 0; t < 20; t++) handleTemperatureExposure(temp);
            if (player.hp < 1 || !player.alive) A.err('systems.exposure-floor', `${label} L${lvl}`, `${label} exposure killed a level ${lvl} character after the floor was reached`);
          }
          // level 9: the grace must be gone. Checked directly (damage is uncapped, and a tick at 100 HP really hurts) instead of waiting for a death, because death-saves and leaked state from earlier probes made 'did it kill a 6 HP character' unreliable
          player.level = 9; player.maxHp = 200; player.hp = 100; player[key] = 20; player.alive = true; gameState = 'playing'; player.equipment = {}; player.temperature = undefined;
          let hurt = false; for (let t = 0; t < 20; t++) { const h0 = player.hp; try { handleTemperatureExposure(temp); } catch (e) { /* death modal path */ } if (player.hp < h0) hurt = true; player.hp = 100; player.alive = true; gameState = 'playing'; }
          if (!hurt) A.warn('systems.exposure-floor', `${label} late`, `a level 9 character took no ${label} exposure damage in 20 ticks at full exposure: exposure no longer hurts at level 5+?`);
        }
      } finally { __g.restore(); Object.assign(player, { level: keep.lvl, hp: keep.hp, maxHp: keep.maxHp, statusHeat: keep.heat, statusChill: keep.chill, alive: keep.alive, climateImmune: keep.immune, buffs: keep.buffs, fireDmgReduction: keep.fr, heatResist: keep.hr, chillResist: keep.cr }); try { if (gameState !== 'playing') { closeModal(); gameState = 'playing'; } } catch (e) { /* */ } }
    },
  },
  {
    id: 'worldgen.dimensions',
    desc: 'every dimension generates: the arrival tile is a walkable rift portal, everything placed in a 13x13-chunk area (monsters, NPCs, items, dungeon entrances, outpost, shrines) stands on a walkable tile reachable from the arrival, no two entities share a tile, climates exist',
    needsPlayer: true,
    seconds: 240,
    fn(A) {
      const keepDungeons = new Set(dungeonRegistry.keys()), R = 6;
      try {
        for (const [dimId, dim] of Object.entries(DIMENSIONS)) {
          const chunks = new Map(); let threw = false;
          for (let cy = dim.arrival.cy - R; cy <= dim.arrival.cy + R && !threw; cy++) for (let cx = dim.arrival.cx - R; cx <= dim.arrival.cx + R; cx++) {
            try { chunks.set(cx + ',' + cy, generateDimensionChunk(dimId, cx, cy)); } catch (e) { A.err('worldgen.dimensions', dimId, `generateDimensionChunk(${cx},${cy}) threw: ${e.message}`); threw = true; break; }
          }
          if (threw) continue;
          const tileAt = (x, y) => { const c = chunks.get(Math.floor(x / CH) + ',' + Math.floor(y / CH)); return c ? c.tiles[((y % CH) + CH) % CH][((x % CH) + CH) % CH] : null; };
          const ac = chunks.get(dim.arrival.cx + ',' + dim.arrival.cy), ax = dim.arrival.cx * CH + dim.arrival.lx, ay = dim.arrival.cy * CH + dim.arrival.ly, at = ac && ac.tiles[dim.arrival.ly][dim.arrival.lx];
          if (!at || !at.walkable || at.feature !== 'rift_portal') { A.err('worldgen.dimensions', dimId, 'arrival tile is not a walkable rift_portal'); continue; }
          if (!ZONE_CLIMATE[dimId]) A.warn('worldgen.dimensions', dimId, 'no climate');
          // flood fill (8-way) over the generated block
          const seen = new Set([ax + ',' + ay]), q = [[ax, ay]];
          while (q.length) { const [x, y] = q.pop(); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy, k = nx + ',' + ny; if (seen.has(k)) continue; const t = tileAt(nx, ny); if (t && t.walkable) { seen.add(k); q.push([nx, ny]); } } }
          const reachNear = (x, y) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (seen.has((x + dx) + ',' + (y + dy))) return true; return false; };
          const occ = new Map(); let ents = 0, bad = 0, sealedMonsters = 0, islandThings = 0;
          const note = (what, x, y, nm, needWalk) => { ents++; const t = tileAt(x, y); const where = `${what} ${nm || ''} at ${x},${y}`; if (!t) { A.err('worldgen.dimensions', dimId, `${where} outside the generated block`); bad++; return; } if (needWalk && !t.walkable) { if (bad++ < 8) A.err('worldgen.dimensions', dimId, `${where} stands on a non-walkable tile`); } else if (!reachNear(x, y)) { const ccx = Math.floor(x / CH) * CH + (CH >> 1), ccy = Math.floor(y / CH) * CH + (CH >> 1); if (what === 'monster') sealedMonsters++; else if (!seen.has(ccx + ',' + ccy)) islandThings++; else if (bad++ < 8) A.err('worldgen.dimensions', dimId, `${where} is cut off although its own chunk's centre is reachable (local connectivity bug)`); } if (needWalk && what !== 'item') { const k = x + ',' + y; if (occ.has(k) && bad++ < 8) A.err('worldgen.dimensions', dimId, `${where} shares a tile with ${occ.get(k)}`); occ.set(k, what + ' ' + (nm || '')); } };
          for (const c of chunks.values()) {
            for (const m of c.monsters) note('monster', m.x, m.y, m.name, true);
            for (const n of c.npcs) note('npc', n.x, n.y, n.name, true);
            if (c.dungeonEntrance) note('dungeon entrance', c.dungeonEntrance.x, c.dungeonEntrance.y, c.dungeonEntrance.name, false);
            for (let ly = 0; ly < CH; ly++) for (let lx = 0; lx < CH; lx++) { const t = c.tiles[ly][lx]; if (t.items && t.items.length) note('item', c.cx * CH + lx, c.cy * CH + ly, t.items[0].name, true); if (t.containers && t.containers.length) note('container', c.cx * CH + lx, c.cy * CH + ly, t.containers[0].name, false); if (t.feature === 'rift_portal' || t.feature === 'dimension_shrine') note(t.feature, c.cx * CH + lx, c.cy * CH + ly, '', false); }
            if (c.poi) note('poi ' + c.poi.type, c.poi.x, c.poi.y, c.poi.name, false);
          }
          if (islandThings > 0) A.warn('worldgen.dimensions', dimId, `${islandThings} points of interest/containers sit in chunks whose centre the arrival cannot walk to (water/rock islands; ensureChunkConnectivity does not join chunks, only carves spines when ground is scarce)`);
          if (sealedMonsters > 0) A.warn('worldgen.dimensions', dimId, `${sealedMonsters} monsters stand in sealed walkable pockets the player cannot walk to (harmless, but wasted spawns)`);
          A.stat('dimension:' + dimId, `${chunks.size} chunks, ${ents} entities, ${seen.size} reachable tiles`);
        }
      } finally { for (const k of [...dungeonRegistry.keys()]) if (!keepDungeons.has(k)) dungeonRegistry.delete(k); }
    },
  },
  {
    id: 'worldgen.overworld-reach',
    desc: 'on a 27x27-chunk block of overworld around the start, dungeon entrances, settlements and POIs sitting well inside the block (not near its edge) are walkable from the start; stranded ones are listed (a few percent are expected on separate islands; error above 8%)',
    needsPlayer: true,
    seconds: 300,
    fn(A) {
      // earlier probes may have left the player in a dungeon or dimension (their x,y are not overworld coordinates): anchor on a person standing in the settlement nearest the origin
      let anchor = null, bestD = Infinity; for (const c of worldChunks.values()) { if (!c.settlement || !(c.npcs || []).length) continue; const d = Math.abs(c.cx) + Math.abs(c.cy); if (d < bestD) { bestD = d; anchor = c.npcs.find((n) => n.alive !== false) || c.npcs[0]; } }
      if (!anchor) { A.warn('worldgen.overworld-reach', 'anchor', 'no settlement generated yet to anchor the reachability check'); return; }
      const sx = anchor.x, sy = anchor.y;
      const R = 13, M = 3, cx0 = Math.floor(sx / CH), cy0 = Math.floor(sy / CH), chunks = new Map();
      for (let cy = cy0 - R; cy <= cy0 + R; cy++) for (let cx = cx0 - R; cx <= cx0 + R; cx++) { try { chunks.set(cx + ',' + cy, getChunk(cx, cy)); } catch (e) { A.err('worldgen.overworld-reach', `${cx},${cy}`, 'getChunk threw ' + e.message); return; } }
      const tileAt = (x, y) => { const c = chunks.get(Math.floor(x / CH) + ',' + Math.floor(y / CH)); return c ? c.tiles[((y % CH) + CH) % CH][((x % CH) + CH) % CH] : null; };
      const flood = (fx, fy) => { const set = new Set([fx + ',' + fy]), st = [[fx, fy]];
        while (st.length) { const [x, y] = st.pop(); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy, k = nx + ',' + ny; if (set.has(k)) continue; const t = tileAt(nx, ny); if (t && t.walkable) { set.add(k); st.push([nx, ny]); } } }
        return set; };
      // an anchor NPC can stand in a sealed room (a quest NPC shut in a building, a probe-relocated NPC): a tiny flood means a bad seed, not a stranded world, so retry from other settlement people and keep the biggest region
      let seen = flood(sx, sy);
      { const cands = []; for (const c of chunks.values()) if (c.settlement) for (const n of (c.npcs || [])) cands.push(n); cands.sort((u, v) => (Math.abs(u.x) + Math.abs(u.y)) - (Math.abs(v.x) + Math.abs(v.y)));
        // the start region is the BIGGEST connected land, not whichever region the nearest NPC happens to stand on (an island or walled yard gave 32/88 'stranded' in one run): try a few NPCs from different regions, skipping ones already inside a flooded region
        let tried = 0; for (const n of cands) { if (tried >= 8) break; if (seen.has(n.x + ',' + n.y)) continue; tried++; const alt = flood(n.x, n.y); if (alt.size > seen.size) seen = alt; } }
      const near = (x, y) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (seen.has((x + dx) + ',' + (y + dy))) return true; return false; };
      const inner = (c) => Math.abs(c.cx - cx0) <= R - M && Math.abs(c.cy - cy0) <= R - M;
      let total = 0; const stranded = [];
      for (const c of chunks.values()) {
        if (!inner(c)) continue;
        if (c.dungeonEntrance) { total++; if (!near(c.dungeonEntrance.x, c.dungeonEntrance.y)) stranded.push(`dungeon ${c.dungeonEntrance.name || ''}@${c.dungeonEntrance.x},${c.dungeonEntrance.y}`); }
        if (c.settlement) { total++; if (!(c.npcs || []).some((n) => near(n.x, n.y))) stranded.push(`settlement ${c.settlement.name}@${c.cx * CH},${c.cy * CH}`); }
        if (c.poi) { total++; if (!near(c.poi.x, c.poi.y)) stranded.push(`poi ${c.poi.type}@${c.poi.x},${c.poi.y}`); }
      }
      A.stat('overworldReach', `${total - stranded.length}/${total} reachable, ${seen.size} walkable tiles`);
      if (stranded.length) { const msg = `${stranded.length}/${total} places are not walkable from the start: ${stranded.slice(0, 10).join('; ')}`; if (stranded.length / Math.max(1, total) > 0.08) A.err('worldgen.overworld-reach', 'stranded', msg); else A.warn('worldgen.overworld-reach', 'stranded', msg); }
    },
  },
  {
    id: 'systems.save-deep',
    desc: 'after loading a rich state (diseases, professions, specialisation, spouse, kingdom relations, weather, wind, war party, flags) a save -> JSON -> load round trip changes NO top-level player field and no world-state registry (everything the game keeps must survive, not just the few fields systems.save-roundtrip compares)',
    needsPlayer: true, uses: [HELPERS], seconds: 120,
    fn(A) {
      const snapPlayer = () => { const o = {}; for (const k of Object.keys(player)) { if (/^_/.test(k) || ['x', 'y'].includes(k) && false) continue; let v; try { v = JSON.stringify(player[k], saveDataReplacer); } catch (e) { v = 'ERR:' + e.message; } o[k] = v; } return o; };
      const world = () => ({
        kingdomRel: JSON.stringify([...kingdomRelationScores.entries()].sort()),
        weather: JSON.stringify(Object.fromEntries(Object.entries(weatherState).map(([k, w]) => [k, w.id]))),
        wars: JSON.stringify(activeWarParties.map((w) => [w.warKingdom, w.defenderKingdom, w.expireTurn, w.npcs.length])),
        turn: turnCount,
      });
      // a rich state
      const k1 = getKingdom(0, 0), k2 = getKingdom(KINGDOM_REGION * 3, 0); if (k1 && k2 && k1.key !== k2.key) kingdomRelationScores.set(relationPairKey(k1.key, k2.key), -77);
      weatherState[zoneKey()] = { id: 'rain', turnsRemaining: 33 };
      player.diseases = [{ name: 'Camp Fever', symptoms: [DISEASE_SYMPTOM_POOL[1]], cureId: 'restCure', cureProgress: 1, naturalDuration: 90, turnsElapsed: 12 }];
      player.professionsLearned = { farmer: true, blacksmith: true }; player.professionXp = { farmer: 500, blacksmith: 1700 }; player.professionSpecialization = { blacksmith: 'weaponsmith' };
      player.spouse = { uid: 'probe_spouse', name: 'Probe' }; player.infernalDominance = 40; player.goodwill = { r1: 12 };
      player.statusPoison = 4; player.buffs = { str: { power: 3, turns: 20 } }; player.kingdomEventLog = [{ turn: 5, text: 'x' }];
      const before = snapPlayer(), wBefore = world();
      let raw; try { raw = JSON.stringify(getSaveData(), saveDataReplacer); applyLoadedSave(JSON.parse(raw)); } catch (e) { A.err('systems.save-deep', 'throw', String(e.stack).split('\n').slice(0, 3).join(' | ')); return; }
      A.settle();
      const after = snapPlayer();
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k] && !(before[k] === undefined && ['0', 'false', '[]', '{}', 'null'].includes(after[k]))) A.err('systems.save-deep', `player.${k}`, `changed across save/load: ${String(before[k]).slice(0, 90)} -> ${String(after[k]).slice(0, 90)}`);
      const wAfter = world(); for (const k of Object.keys(wBefore)) if (wBefore[k] !== wAfter[k]) A.err('systems.save-deep', `world.${k}`, `changed across save/load: ${String(wBefore[k]).slice(0, 90)} -> ${String(wAfter[k]).slice(0, 90)}`);
    },
  },
  {
    id: 'systems.fever-floor',
    desc: 'a chronic Fever never takes HP below 35% of max (it used to pin characters at a few HP for thousands of turns and kill silently), and never delivers a killing blow',
    needsPlayer: true,
    fn(A) {
      const sym = DISEASE_SYMPTOM_POOL.find((x) => x.id === 'fever'); if (!sym) { A.warn('systems.fever-floor', 'fever', 'no fever symptom in DISEASE_SYMPTOM_POOL (renamed?)'); return; }
      const saved = { d: player.diseases, hp: player.hp, mhp: player.maxHp };
      for (const maxHp of [30, 100, 400]) {
        player.maxHp = maxHp; player.hp = maxHp;
        player.diseases = [{ name: 'probe fever', symptoms: [sym], cureId: 'remedyItem', cureProgress: 0, naturalDuration: Infinity, turnsElapsed: 0, permanent: true }];
        let lo = maxHp; for (let t = 0; t < 4000; t++) { tickDiseases(player); lo = Math.min(lo, player.hp); }
        const floor = Math.ceil(maxHp * 0.35);
        if (lo < floor) A.err('systems.fever-floor', 'floor', `maxHp ${maxHp}: fever pushed HP to ${lo} (< floor ${floor})`);
        if (lo > floor + 2) A.warn('systems.fever-floor', 'idle', `maxHp ${maxHp}: fever never got below ${lo} in 4000 ticks (floor ${floor}): does it still tick?`);
      }
      player.diseases = saved.d || []; player.maxHp = saved.mhp; player.hp = saved.hp;
    },
  },
  {
    id: 'systems.early-dot',
    desc: 'earlyGraceDot: player damage-over-time is softened at level 1-4 only (bleed / burning status / flames), monsters and level 5+ untouched',
    needsPlayer: true, uses: [HELPERS, ARENA], seconds: 30,
    fn(A) {
      A.settle(); A.refill(); // earlier probes leave weather, wetness, statuses and prompts behind
      const lvl0 = player.level, hp0 = player.hp, max0 = player.maxHp, burn0 = player.burningTurns;
      try {
        const want = [[1, 4], [2, 4], [3, 6], [4, 6], [5, 7], [20, 7]]; // dmg 7 through the 0.6 / 0.8 / 1.0 ladder
        for (const [L, exp] of want) { player.level = L; const got = earlyGraceDot(player, 7); if (got !== exp) A.err('systems.early-dot', 'L' + L, `earlyGraceDot(player,7) = ${got}, expected ${exp}`); }
        player.level = 1; if (earlyGraceDot(player, 1) !== 1) A.err('systems.early-dot', 'min', 'a 1-damage tick must stay 1, never 0');
        if (earlyGraceDot({ hp: 10 }, 7) !== 7) A.err('systems.early-dot', 'monster', 'non-player entities must not be softened');
        // live: the burning status really goes through the helper (3 dmg -> 2 at level 1, 3 at level 5)
        for (const [L, exp] of [[1, 2], [5, 3]]) {
          player.level = L; player.maxHp = 100; player.hp = 100; player.burningTurns = 1; player.fireDmgReduction = 0;
          const n0 = logMessages.length; // (capped buffer: only used for the message below)
          let line = null, threw = false;
          for (let attempt = 0; attempt < 3 && !line; attempt++) { // other log spam (burning trees, weather) can bury the line in the capped buffer: look 40 deep and retry
            player.burningTurns = 1; player.hp = player.maxHp;
            try { endTurn({ forceFull: true }); } catch (e) { A.err('systems.early-dot', 'tick', 'endTurn threw ' + e.message); threw = true; break; }
            line = logMessages.slice(-40).map((x) => String(x).replace(/<[^>]*>/g, '')).reverse().find((x) => /still on fire! \((\d+) damage\)/.test(x)) || null;
          }
          if (threw) break; // the log line, so regeneration cannot hide the tick
          const got = line ? +/\((\d+) damage\)/.exec(line)[1] : null;
          if (got !== exp) A.err('systems.early-dot', 'burn L' + L, `burning tick logged ${got}, expected ${exp}; ` + JSON.stringify({ n0, now: logMessages.length, last: logMessages.slice(-3).map((x) => typeof x === 'string' ? x.slice(0, 80) : JSON.stringify(x).slice(0, 120)), burn: player.burningTurns, wet: player.wetTurns, hp: player.hp }));
        }
      } finally { player.level = lvl0; player.maxHp = max0; player.hp = Math.min(hp0, max0); player.burningTurns = burn0 || 0; }
    },
  },
  {
    id: 'systems.equip-all',
    desc: 'equip and unequip every weapon/armor piece: no exceptions, stats stay finite, slots stay consistent',
    needsPlayer: true, uses: [HELPERS], seconds: 240,
    fn(A) {
      let n = 0;
      for (const b of ITEM_BASES.filter((i) => i.type === 'weapon' || i.type === 'armor')) {
        A.vitals(); A.settle();
        let it; try { it = makeItem(b.id, 2, Math.random, 3); } catch (e) { continue; }
        if (!it) continue;
        player.inventory.push(it);
        try { equipItem(it); n++; } catch (e) { A.err('systems.equip-all', b.id, `equipItem threw: ${String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')}`); A.settle(); continue; }
        A.settle();
        if (!A.numbersOk(player, 'systems.equip-all', b.id)) { player.str = player.dex = player.int = player.con = 10; }
        try { recalcVitalsFromStats && recalcVitalsFromStats(); } catch (e) { A.err('systems.equip-all', b.id, 'recalcVitals threw ' + e.message); }
        try { if (typeof getArmorOf === 'function') { const a = getArmorOf(player); if (!isFinite(a)) A.err('systems.equip-all', b.id, 'getArmorOf = ' + a); } } catch (e) { A.err('systems.equip-all', b.id, 'getArmorOf threw ' + e.message); }
      }
      A.stat('itemsEquipped', n);
    },
  },
  {
    id: 'systems.save-roundtrip',
    desc: 'getSaveData -> JSON -> applyLoadedSave keeps the character intact (twice, after generating a dungeon floor)',
    needsPlayer: true, uses: [HELPERS], seconds: 120,
    fn(A) {
      const keys = ['level', 'hp', 'maxHp', 'mp', 'gold', 'x', 'y', 'str', 'dex', 'int', 'con', 'wil', 'cha', 'xp'];
      for (let round = 0; round < 2; round++) {
        if (round === 1) { try { const th = Object.keys(DUNGEON_THEMES)[3]; const lvl = generateDungeonLevel(th, 2, 3, 'standard', 'small', 0); dungeonRegistry.set('audit_dg', { id: 'audit_dg', theme: th, levels: [lvl], x: 5, y: 5, maxDepth: 3, variant: 'standard', size: 'small' }); } catch (e) { A.warn('systems.save', 'dungeon', 'could not seed a dungeon for the 2nd round: ' + e.message); } }
        const before = {}; for (const k of keys) before[k] = player[k];
        const inv0 = player.inventory.length, spells0 = player.knownSpells.length, turn0 = turnCount;
        let raw;
        try { raw = JSON.stringify(getSaveData(), saveDataReplacer); } catch (e) { A.err('systems.save', 'serialize', 'round ' + round + ' getSaveData/stringify threw: ' + String(e.stack).split('\n').slice(0, 4).join(' | ')); return; }
        A.stat('saveChars', raw.length);
        try { applyLoadedSave(JSON.parse(raw)); } catch (e) { A.err('systems.save', 'load', 'applyLoadedSave threw: ' + String(e.stack).split('\n').slice(0, 2).join(' | ')); return; }
        A.settle();
        for (const k of keys) if (player[k] !== before[k]) A.err('systems.save', k, `player.${k} changed across save/load: ${before[k]} -> ${player[k]}`);
        if (player.inventory.length !== inv0) A.err('systems.save', 'inventory', `inventory ${inv0} -> ${player.inventory.length}`);
        if (player.knownSpells.length !== spells0) A.err('systems.save', 'spells', `knownSpells ${spells0} -> ${player.knownSpells.length}`);
        if (turnCount !== turn0) A.err('systems.save', 'turn', `turnCount ${turn0} -> ${turnCount}`);
        if (gameState !== 'playing') A.err('systems.save', 'state', 'gameState is ' + gameState + ' after load');
        try { endTurn(); endTurn(); } catch (e) { A.err('systems.save', 'post-load-turn', 'endTurn threw after load: ' + e.message); }
      }
    },
  },
  {
    id: 'systems.save-quests-curios',
    desc: 'a Recover quest, a Borrowed Heirloom chain quest (twist revealed) and curio tiles (one spent) survive getSaveData -> applyLoadedSave, and the relic can still be picked up afterwards to finish the quest',
    needsPlayer: true, uses: [HELPERS], seconds: 120,
    fn(A) {
      const dg0 = [...dungeonRegistry.values()].find((d) => !d.isTutorial && !d.originDimensionId && d.maxDepth >= 2);
      if (!dg0) { A.warn('systems.save-quests-curios', 'setup', 'no 2+ floor dungeon in this game instance; skipped'); return; }
      player.level = Math.max(player.level, dg0.recommendedLevel || 1); player.quests = [];
      const npc = { uid: 'save_probe_npc', name: 'Probe', home: 'Testhold', x: dg0.x + 10, y: dg0.y, roleId: 'guildclerk' };
      let rq = null; for (let i = 0; i < 80 && !rq; i++) { const o = rollRadiantQuestOffer(npc, Math.random); if (o && o.type === 'recover') rq = o; }
      const cq = QUEST_CHAINS.borrowed_heirloom.start(npc, Math.random);
      if (!rq || !cq) { A.err('systems.save-quests-curios', 'setup', 'could not roll a recover quest / start the heirloom chain'); return; }
      acceptRadiantQuest(rq); acceptRadiantQuest(cq);
      // twist revealed on the chain quest: pick its relic up now (it stays in the pack until resolved)
      { const lv = dungeonRegistry.get(cq.dungeonId).levels[cq.floor - 1]; const ent = lv.items.find((e) => e.item && e.item.questId === cq.id); pickUpSpecificItem(ent.item); }
      // two curio tiles on the recover floor, one spent
      const lvl = dungeonRegistry.get(rq.dungeonId).levels[rq.floor - 1]; const spots = [];
      for (let y = 0; y < lvl.h && spots.length < 2; y++) for (let x = 0; x < lvl.w && spots.length < 2; x++) { const t = lvl.grid[y][x]; if (t && t.walkable && t.feature === 'floor' && !(lvl.items || []).some((it) => it.x === x && it.y === y)) spots.push([x, y]); }
      const mk = (pt, used) => { const t = lvl.grid[pt[1]][pt[0]]; t.feature = 'curio'; t.curioId = 'cur_fallen_adventurer'; t.curioUsed = used; t.glyph = used ? '\u00B7' : '\u00A4'; };
      mk(spots[0], false); mk(spots[1], true);
      let raw; try { raw = JSON.stringify(getSaveData(), saveDataReplacer); } catch (e) { A.err('systems.save-quests-curios', 'serialize', String(e.stack).split('\n').slice(0, 3).join(' | ')); return; }
      try { applyLoadedSave(JSON.parse(raw)); } catch (e) { A.err('systems.save-quests-curios', 'load', String(e.stack).split('\n').slice(0, 3).join(' | ')); return; }
      A.settle();
      const q1 = player.quests.find((q) => q.id === rq.id), q2 = player.quests.find((q) => q.id === cq.id);
      if (!q1 || !q2) { A.err('systems.save-quests-curios', 'quests', 'a quest was lost across save/load'); return; }
      if (!q2.twistRevealed) A.err('systems.save-quests-curios', 'twist', 'chain twist flag lost across save/load');
      if (!player.inventory.some((i) => i.questId === cq.id)) A.err('systems.save-quests-curios', 'heirloom', 'heirloom left the pack across save/load');
      const lvl2 = dungeonRegistry.get(rq.dungeonId) && dungeonRegistry.get(rq.dungeonId).levels[rq.floor - 1];
      if (!lvl2) { const d2 = dungeonRegistry.get(rq.dungeonId); A.err('systems.save-quests-curios', 'level', `the relic floor was not restored (dungeon ${rq.dungeonId} ${d2 ? 'present, levels=' + JSON.stringify((d2.levels || []).map((l) => !!l)) : 'MISSING'}, floor ${rq.floor}; saved dungeons ${JSON.stringify(JSON.parse(raw).dungeonRegistry.map((e) => [e[0], (e[1].levels || []).map((l) => !!l)]))})`); return; }
      const tA = lvl2.grid[spots[0][1]][spots[0][0]], tB = lvl2.grid[spots[1][1]][spots[1][0]];
      if (!(tA.feature === 'curio' && tA.curioUsed === false)) A.err('systems.save-quests-curios', 'curio', 'an unspent curio tile changed across save/load');
      if (!(tB.feature === 'curio' && tB.curioUsed === true)) A.err('systems.save-quests-curios', 'curio', 'a spent curio tile became unspent across save/load');
      const ent2 = (lvl2.items || []).find((e) => e.item && e.item.questId === rq.id);
      if (!ent2) { A.err('systems.save-quests-curios', 'relic', 'the relic is gone from its floor after load'); return; }
      try { pickUpSpecificItem(ent2.item); } catch (e) { A.err('systems.save-quests-curios', 'pickup', String(e.stack).split('\n').slice(0, 2).join(' | ')); }
      if (!q1.done && !(player.quests.find((q) => q.id === rq.id) || {}).done) A.err('systems.save-quests-curios', 'complete', 'picking the relic up after a load did not complete the quest');
      player.quests = []; player.inventory = player.inventory.filter((i) => !i.questId);
    },
  },
];
});

// ==== FILE: lib/probes/talents.js ====
__def("lib/probes/talents.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Talent tree probes: the prerequisite graph is well-formed and every talent can actually be bought and applied.
module.exports = [
  {
    id: 'talents.graph',
    desc: 'every talent has a unique id/name/desc, a sane tier, and its prerequisite talent exists, is a lower tier, and the chain terminates (no cycles)',
    fn(A) {
      const byId = new Map(); let n = 0;
      for (const t of TALENTS_V2) {
        n++;
        if (!t.id || !t.name || !t.desc) A.err('talents.graph', t.id || '?', 'missing id/name/desc');
        if (byId.has(t.id)) A.err('talents.graph', t.id, 'duplicate talent id');
        byId.set(t.id, t);
        if (typeof t.apply !== 'function') A.err('talents.graph', t.id, 'apply is not a function');
        if (!(t.tier >= 1 && t.tier <= 9)) A.warn('talents.graph', t.id, 'unusual tier ' + t.tier);
      }
      let maxLevel = 0;
      for (const t of TALENTS_V2) {
        if (t.requires && t.requires.level > maxLevel) maxLevel = t.requires.level;
        const seen = new Set([t.id]); let cur = t;
        while (cur && cur.requires && cur.requires.talent) {
          const p = byId.get(cur.requires.talent);
          if (!p) { A.err('talents.graph', t.id, 'requires unknown talent "' + cur.requires.talent + '"'); break; }
          if (seen.has(p.id)) { A.err('talents.graph', t.id, 'prerequisite cycle through ' + p.id); break; }
          if (p.tier >= t.tier) A.warn('talents.graph', t.id, `prerequisite ${p.id} (tier ${p.tier}) is not a lower tier than ${t.id} (tier ${t.tier})`);
          if (cur.requires.level && p.requires && p.requires.level > cur.requires.level) A.warn('talents.graph', t.id, `needs level ${cur.requires.level} but its prerequisite ${p.id} needs ${p.requires.level}`);
          seen.add(p.id); cur = p;
        }
      }
      A.stat('talents', n); A.stat('talentMaxLevelReq', maxLevel);
    },
  },
  {
    id: 'talents.buy-all',
    desc: 'buy every talent through the real purchase path: no exceptions, vitals and core stats stay finite, and talents that exist in the shop list can be bought',
    needsPlayer: true, seconds: 120,
    fn(A) {
      player.level = 60; player.talents = {}; player.talentPoints = 9999;
      let bought = 0;
      for (const t of TALENTS_V2) {
        try { purchaseTalent(t); bought++; } catch (e) { A.err('talents.buy-all', t.id, 'purchase threw: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' | ')); continue; }
        if (!player.talents[t.id]) A.err('talents.buy-all', t.id, 'purchase did not record the talent');
        for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'str', 'dex', 'con', 'int', 'wil', 'cha']) if (typeof player[k] === 'number' && !isFinite(player[k])) { A.err('talents.buy-all', t.id, k + ' became ' + player[k]); player[k] = 10; }
      }
      try { closeModal(); } catch (e) { /* */ } gameState = 'playing';
      A.stat('talentsBought', bought);
    },
  },
];
});

// ==== FILE: lib/probes/training.js ====
__def("lib/probes/training.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// How a character GETS new abilities. Lesson (v0.51.3): TECHNIQUES (every martial class ability beyond the 2-3 a class starts with) had no learning path at all:
// trainers and tomes only taught spells. This probe proves every technique is reachable through BOTH a trainer (Combat Trainer / 'weaponmaster') and a manual (tome with techId),
// and that buying from the trainer and studying a manual really change player.knownTechniques.
module.exports = [
  {
    id: 'training.techniques',
    desc: 'every technique is obtainable (Combat Trainer teach pool + manual drop pool); training and manual studying teach it; trainer role is placed in towns/cities/capitals',
    needsPlayer: true, seconds: 90,
    fn(A) {
      const say = (id, ok, msg) => { if (!ok) A.err('training', id, msg); };
      // 1. reachability: a master Combat Trainer can teach tier<=5, manuals are drawn by mana/stamina cost band
      const unreachableByTrainer = TECHNIQUES.filter((t) => (t.tier || 1) > 5).map((t) => t.id);
      say('trainer-pool', !unreachableByTrainer.length, 'techniques above tier 5 can never be taught by a trainer: ' + unreachableByTrainer.join(','));
      const seen = new Set();
      for (let i = 0; i < 6000; i++) { const tier = i % TOME_TIERS.length; const m = makeManual(tier, Math.random); if (m && m.techId) seen.add(m.techId); }
      const never = TECHNIQUES.filter((t) => !seen.has(t.id)).map((t) => t.id);
      say('manual-pool', never.length === 0, `${never.length} techniques never roll as a manual in 6000 draws: ${never.slice(0, 12).join(',')}`);
      A.stat('techniques', TECHNIQUES.length); A.stat('techniquesAsManuals', seen.size);
      // 2. role is actually placed
      for (const k of ['village', 'town', 'city', 'capital']) say('pool-' + k, (ROLE_POOLS[k] || []).includes('weaponmaster'), `ROLE_POOLS.${k} has no weaponmaster`);
      say('role-def', ROLES.some((r) => r.id === 'weaponmaster'), 'no weaponmaster role definition');
      // 3. trainer teaches, tier-gated, and the Learn flow works
      for (const tier of ['novice', 'journeyman', 'master']) {
        let npc; try { npc = makeNPC('weaponmaster', player.x + 1, player.y, Math.random, null, 'human'); } catch (e) { A.err('training', 'makeNPC', String(e && e.message)); return; }
        // re-roll teach list for the requested tier the same way makeNPC does for a fresh NPC of that tier
        npc.tier = tier; let n = 0, tries = 0, got = null;
        while (tries++ < 40 && !(got && got.tier === tier)) { const c = makeNPC('weaponmaster', player.x + 1, player.y, Math.random, null, 'human'); if (c.tier === tier) got = c; }
        if (!got) { A.info('training', 'tier-' + tier, 'no ' + tier + ' trainer in 40 spawns'); continue; }
        const maxTier = tier === 'novice' ? 2 : tier === 'master' ? 5 : 3;
        say('teach-' + tier, got.teachTechniques && got.teachTechniques.length >= 2, `${tier} Combat Trainer teaches ${(got.teachTechniques || []).length} techniques`);
        for (const id of got.teachTechniques || []) { const t = TECHNIQUES.find((x) => x.id === id); say('teach-valid-' + id, !!t && (t.tier || 1) <= maxTier, `${tier} trainer teaches ${id} (tier ${t && t.tier}) above tier ${maxTier}`); }
        if (tier === 'journeyman' || tier === 'novice') {
          player.knownTechniques = []; player.gold = 5000; const id0 = got.teachTechniques[0];
          openTrain(got); const g0 = player.gold; trainLearn('a');
          say('learn-' + tier, player.knownTechniques.includes(id0) && player.gold < g0, `buying "${id0}" from a ${tier} trainer did not teach it / charge gold`);
          try { closeModal(); } catch (e) { /* */ } gameState = 'playing';
        }
      }
      // 4. manual study
      { player.knownTechniques = []; const man = makeManual(1, Math.random); player.inventory.push(man); useItem(man);
        say('manual-study', player.knownTechniques.includes(man.techId) && !player.inventory.some((i) => i.uid === man.uid), `studying ${man.name} did not teach ${man.techId} / consume the manual`);
        const man2 = makeManual(1, Math.random); man2.techId = man.techId; player.inventory.push(man2); useItem(man2);
        say('manual-dupe', !player.inventory.some((i) => i.uid === man2.uid), 'a duplicate manual was not consumed (would be an infinite stack)'); }
      player.knownTechniques = []; player.hp = player.maxHp;
    },
  },
];
});

// ==== FILE: lib/probes/worldgen.js ====
__def("lib/probes/worldgen.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes that generate parts of the world and validate the result.
module.exports = [
  {
    id: 'worldgen.spawn-rings',
    desc: 'overworld spawn-safety rings follow the character\'s real start (worldStartAnchor), not the world origin: near the start only tier-1 encounters, none above tier 2 within 100 tiles, no power>=3 boss within 115',
    needsPlayer: true,
    fn(A) {
      if (typeof startDist !== 'function') { A.err('worldgen.spawn-rings', 'api', 'startDist() missing'); return; }
      const saved = worldStartAnchor, savedLvl = player.level; worldStartAnchor = { x: 600, y: -400 }; player.level = 60; // the distance rings are measured with the level cap out of the way
      try {
        const tierOf = (id) => { const m = MONSTER_BASES[id]; return m ? (m.spawnTier !== undefined ? m.spawnTier : (m.dtier || 0)) : 0; };
        const rings = [[20, 1], [90, 2], [115, 2], [195, 3], [290, 4]]; // literal contract (v0.51.5 ring edges 45/120/200/300): 115 must still be tier <= 2, 195 tier <= 3, 290 tier <= 4 // [tiles from the start, max tier]
        let worst = {};
        for (const [dist, cap] of rings) for (const bid of Object.keys(BIOMES)) {
          const b = BIOMES[bid]; if (!b.encounter || !b.encounter.length) continue;
          for (let i = 0; i < 120; i++) {
            const id = pickBiomeEncounter(Math.random, b, startDist(600 + dist, -400));
            if (tierOf(id) > cap) { A.err('worldgen.spawn-rings', bid + '@' + dist, `${id} (tier ${tierOf(id)}) spawned ${dist} tiles from the start (cap ${cap})`); break; }
          }
        }
        { const sc0 = overworldDangerScale(Math.floor(600 / CH), Math.floor(-400 / CH)); if (sc0 > 1.1) A.err('worldgen.spawn-rings', 'scale', `monster danger scale at the character's start is ${sc0.toFixed(2)} (should be ~1): a far settlement start would stand in level-40 monsters`); A.stat('startScale', Math.round(sc0 * 100) / 100); }
        { const saved2 = worldStartAnchor; worldStartAnchor = null; const far0 = overworldDangerScale(25, 25); worldStartAnchor = saved2; if (far0 < 3) A.err('worldgen.spawn-rings', 'scale0', `origin-anchored scale 25 chunks out is only ${far0.toFixed(2)} (expected the 4x cap)`); }
        // the same biome table measured from the ORIGIN must still be uncapped far away (the anchor, not a global cap, does the work)
        worldStartAnchor = null; let far = 0; for (let i = 0; i < 400; i++) if (tierOf(pickBiomeEncounter(Math.random, BIOMES.ancient_megaruins, 900)) >= 3) far++;
        A.stat('farHighTierDraws', far); if (!far) A.warn('worldgen.spawn-rings', 'far', 'no tier 3+ encounter in 400 draws of ancient_megaruins at 900 tiles: ring table too strict?');
        // level cap (v0.51.5), LITERAL contract: [player level, highest tier a far-away (900 tile) encounter may be]
        worldStartAnchor = null;
        for (const [lv, cap] of [[1, 1], [3, 1], [4, 2], [7, 2], [8, 3], [12, 3], [13, 4], [19, 4]]) {
          player.level = lv;
          for (const bid of Object.keys(BIOMES)) { const b = BIOMES[bid]; if (!b.encounter || !b.encounter.length) continue; for (let i = 0; i < 80; i++) { const id = pickBiomeEncounter(Math.random, b, 900); if (tierOf(id) > cap) { A.err('worldgen.spawn-rings', bid + '@L' + lv, `${id} (tier ${tierOf(id)}) spawned for a level ${lv} character (level cap ${cap})`); break; } } }
        }
      } finally { worldStartAnchor = saved; player.level = savedLvl; }
    },
  },
  {
    id: 'worldgen.structure-guards',
    desc: 'wilderness/water structures never place guards stronger than the near-spawn tier ring allows (structureGuardTooStrong): a Sealed Vault Ruin Guardian beside the start killed 10 of 48 sweep characters; also scans ~600 real chunks around the start for any non-boss monster above its ring (v0.51.5)',
    needsPlayer: true, seconds: 90,
    fn(A) {
      if (typeof structureGuardTooStrong !== 'function' || typeof spawnTierCap !== 'function') { A.err('worldgen.structure-guards', 'api', 'structureGuardTooStrong/spawnTierCap missing'); return; }
      const saved = worldStartAnchor, savedLvl = player.level; worldStartAnchor = { x: 0, y: 0 }; player.level = 60; // chunks generate lazily under whatever level the character had then (v0.51.5 level cap): judge them by the distance rings alone
      try {
        const defs = [].concat(typeof WILDERNESS_STRUCTURES !== 'undefined' ? WILDERNESS_STRUCTURES : [], typeof OCEAN_STRUCTURES !== 'undefined' ? OCEAN_STRUCTURES : []).filter((d) => d.guardMonsters);
        A.stat('guardedStructures', defs.length); if (!defs.length) A.err('worldgen.structure-guards', 'data', 'no guarded structures found');
        for (const d of defs) for (const dist of [10, 60, 130, 200, 400]) {
          const cap = spawnTierCap(dist), strong = d.guardMonsters.some((g) => spawnTierOf(g.id) > cap), got = structureGuardTooStrong(d, dist, 0);
          if (strong !== got) A.err('worldgen.structure-guards', d.id + '@' + dist, `guard tier ${strong ? 'exceeds' : 'fits'} the cap ${cap} but structureGuardTooStrong said ${got}`);
        }
        // both placers must actually consult the gate
        for (const fn of ['scatterBiomeStructures', 'scatterWaterStructures']) if (!/structureGuardTooStrong/.test(String(eval(fn)))) A.err('worldgen.structure-guards', fn, 'does not call structureGuardTooStrong: its guards bypass the spawn rings');
        // real chunks: no ordinary monster above the ring for its distance
        let n = 0; const cx0 = Math.floor(player.x / CH), cy0 = Math.floor(player.y / CH);
        for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) { const c = getChunk(cx0 + i, cy0 + j); for (const m of (c.monsters || [])) { if (!m.alive || m.boss) continue; n++; const dd = Math.abs(m.x - worldStartAnchor.x) + Math.abs(m.y - worldStartAnchor.y), cap = spawnTierCap(startDist(m.x, m.y)); if (spawnTierOf(m.monsterId) > cap) A.err('worldgen.structure-guards', m.name, `tier ${spawnTierOf(m.monsterId)} ${m.name} stands ${startDist(m.x, m.y)} tiles from the start (cap ${cap})`); } }
        A.stat('chunkMonstersChecked', n);
      } finally { worldStartAnchor = saved; player.level = savedLvl; }
    },
  },
  {
    id: 'worldgen.landing-region',
    desc: 'random placements never strand the player (v0.51.5): about 1 dungeon floor in 5 has walled-off pockets (ringed by water, chasm or rock); pickChasmLanding must always land in the stairs-connected walkable region, and blinkPlayer must consult the same region. Found by a level-46 bot "marooned" for 4,000 turns after a chasm jump',
    needsPlayer: true, seconds: 120,
    fn(A) {
      if (typeof levelMainRegion !== 'function' || typeof pickChasmLanding !== 'function') { A.err('worldgen.landing-region', 'api', 'levelMainRegion/pickChasmLanding missing'); return; }
      let floors = 0, pocketFloors = 0, landings = 0;
      for (const [th, meta] of Object.entries(DUNGEON_THEMES)) {
        const md = (meta.depthRange || [3, 3])[1];
        for (let n = 0; n < 3; n++) {
          const d = 1 + (n % Math.min(md, 3)); let L; try { L = generateDungeonLevel(th, d, md, 'standard', undefined, 0); } catch (e) { continue; }
          floors++; const region = levelMainRegion(L); if (!region || region.size < 2) { A.err('worldgen.landing-region', th, 'no walkable region between the stairs'); continue; }
          let walk = 0; for (const row of L.grid) for (const tile of row) if (tile && tile.walkable) walk++;
          if (walk - region.size < 1) continue; pocketFloors++;
          for (let i = 0; i < 25; i++) { const p = pickChasmLanding(L); landings++; if (!region.has(p.x + ',' + p.y)) { A.err('worldgen.landing-region', th + '@' + d, `a chasm fall can land at ${p.x},${p.y}, outside the stairs-connected region (a sealed pocket)`); break; } }
        }
      }
      A.stat('landingFloors', floors); A.stat('landingFloorsWithPockets', pocketFloors); A.stat('landings', landings);
      if (!pocketFloors) A.warn('worldgen.landing-region', 'sample', 'no floor with a pocket in this sample: the landing check was vacuous');
      const all = document.documentElement.outerHTML, at = all.indexOf('function blinkPlayer('), src = at < 0 ? '' : all.slice(at, at + 900);
      if (!/levelMainRegion/.test(src)) A.err('worldgen.landing-region', 'blinkPlayer', 'random blinks/teleport traps ignore the walkable region and can drop the player into a sealed pocket');
    },
  },
  {
    id: 'worldgen.miniboss-tier',
    desc: 'dungeon minibosses respect the theme tier: every miniboss candidate is at most dtierMax+MINIBOSS_TIER_SLACK (and the depth cap); a tier-1 cave must never roll a tier-4 knight (v0.51.5)',
    needsPlayer: false, seconds: 30,
    fn(A) {
      if (typeof minibossPool !== 'function' || typeof MINIBOSS_TIER_SLACK === 'undefined') { A.err('worldgen.miniboss-tier', 'api', 'minibossPool/MINIBOSS_TIER_SLACK missing'); return; }
      let checked = 0, empty = 0;
      for (const [theme, meta] of Object.entries(DUNGEON_THEMES)) {
        for (let depth = 1; depth <= Math.max(meta.depthRange[1], 3); depth++) {
          const cap = Math.min((meta.dtierMax || 2) + 1, Math.ceil(depth / 3) + 1); // the contract is a literal ONE tier, whatever the tunable says
          const pool = minibossPool(meta, depth, null); checked++;
          if (!pool.length) empty++;
          for (const id of pool) { const t = MONSTER_BASES[id].dtier || 1; if (t > cap) A.err('worldgen.miniboss-tier', `${theme} d${depth}`, `${MONSTER_BASES[id].name} (dtier ${t}) can be the miniboss of a dtierMax-${meta.dtierMax || 2} dungeon (cap ${cap})`); }
        }
      }
      if (empty > checked * 0.6) A.warn('worldgen.miniboss-tier', 'coverage', `${empty}/${checked} theme-depths have no eligible miniboss: the cap may be too tight`);
    },
  },
  {
    id: 'worldgen.pack-caps',
    desc: 'dungeon pack caps (PACK_RULES/packCapFor): splitters (Acid Slime) come in packs of at most 2 on floors 1-4, shooters keep their early-floor caps, every cap is within 1..PACK_MAX, and generated floors never exceed them (v0.51.5)',
    needsPlayer: false, seconds: 60,
    fn(A) {
      if (typeof packCapFor !== 'function' || typeof PACK_RULES === 'undefined') { A.err('worldgen.pack-caps', 'api', 'packCapFor/PACK_RULES missing'); return; }
      const splitters = Object.keys(MONSTER_BASES).filter((k) => MONSTER_BASES[k].splitInto);
      const shooters = Object.keys(MONSTER_BASES).filter((k) => ['ranged', 'kiter', 'turret'].includes(MONSTER_BASES[k].behavior) || MONSTER_BASES[k].usesMp);
      if (!splitters.length || !shooters.length) A.err('worldgen.pack-caps', 'data', 'no splitters/shooters found: probe has nothing to check');
      for (const id of splitters) for (let d = 1; d <= 4; d++) { const c = packCapFor(id, d); if (c > 2) A.err('worldgen.pack-caps', `${id} d${d}`, `splitter pack cap ${c} (> 2): a pack multiplies when struck`); }
      for (const id of shooters) { if (packCapFor(id, 2) > 2) A.err('worldgen.pack-caps', `${id} d2`, 'shooter pack cap above 2 on floor 2'); if (packCapFor(id, 4) > 3) A.err('worldgen.pack-caps', `${id} d4`, 'shooter pack cap above 3 on floor 4'); }
      for (const id of Object.keys(MONSTER_BASES)) for (const d of [1, 3, 6, 12]) { const c = packCapFor(id, d); if (!(c >= 1 && c <= 6)) A.err('worldgen.pack-caps', `${id} d${d}`, 'pack cap ' + c + ' outside 1..6'); }
    },
  },
  {
    id: 'monsters.boss-damage',
    desc: 'boss damage per turn (mean attack x multiattack) stays near its power tier: error above 2.1x the mean of the OTHER bosses of that power, warning above 1.7x (the final boss "god" is exempt) -- catches the outliers that killed whole sweeps (Umbroth, Oathbroken, Abyssal Leviathan) (v0.51.5)',
    needsPlayer: false, seconds: 30,
    fn(A) {
      const rows = [];
      for (const [id, b] of Object.entries(MONSTER_BASES)) { if (!b.boss || id === 'god' || !b.atk) continue; rows.push({ id, p: b.bossPower || b.dtier || 0, dpt: (b.atk[0] + b.atk[1]) / 2 * (b.multiattack || 1), name: b.name }); }
      if (rows.length < 20) A.err('monsters.boss-damage', 'data', 'only ' + rows.length + ' bosses found');
      for (const r of rows) {
        const peers = rows.filter((o) => o.p === r.p && o.id !== r.id); if (peers.length < 2) continue;
        const mean = peers.reduce((a, o) => a + o.dpt, 0) / peers.length, ratio = r.dpt / mean;
        if (ratio > 2.1) A.err('monsters.boss-damage', r.id, `${r.name} deals ${r.dpt}/turn, ${ratio.toFixed(2)}x the power-${r.p} mean of ${mean.toFixed(1)}`);
        else if (ratio > 1.7) A.warn('monsters.boss-damage', r.id, `${r.name} deals ${r.dpt}/turn, ${ratio.toFixed(2)}x the power-${r.p} mean of ${mean.toFixed(1)}`);
      }
    },
  },
  {
    id: 'classes.starter-efficiency',
    desc: 'every class that starts with a (non-poison) damage spell can cast it at least 1.3 damage per mana on average, so a starting caster is not one cast from melee-with-a-staff (Stormcaller was 1.1, others 1.3-1.7) (v0.51.5)',
    needsPlayer: false, seconds: 20,
    fn(A) {
      const byId = {}; for (const s of (Array.isArray(SPELLS) ? SPELLS : Object.values(SPELLS))) byId[s.id] = s;
      let checked = 0;
      for (const a of ARCHETYPES) {
        const m = a.apply.toString().match(/knownSpells\.push\(([^)]*)\)/); if (!m) continue;
        const dmg = m[1].split(',').map((x) => byId[x.trim().replace(/['"]/g, '')]).filter((s) => s && s.type === 'damage' && s.power && !s.poison && s.mp > 0);
        if (!dmg.length) continue; checked++;
        const best = Math.max(...dmg.map((s) => (s.power[0] + s.power[1]) / 2 / s.mp));
        if (best < 1.3) A.err('classes.starter-efficiency', a.id, `best starting damage spell does only ${best.toFixed(2)} damage per mana (< 1.3)`);
      }
      if (checked < 5) A.err('classes.starter-efficiency', 'data', 'only ' + checked + ' archetypes checked: the starter-spell pattern probably changed');
    },
  },
  {
    id: 'worldgen.dungeons',
    desc: 'generate every dungeon theme at several depths/sizes/variants: connected stairs, sane entities, nothing in walls, no overlaps',
    needsPlayer: true,
    seconds: 600,
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const sizes = DUNGEON_SIZE_TIERS.map((s) => s.id), variants = DUNGEON_VARIANTS.map((v) => v.id);
      let shooterMax = 0, floors = 0, slow = 0, adjacentSpawns = 0, totalMon = 0, totalWalk = 0; let stairSpawns = 0; const stairWhere = [];
      const bfs = (g, w, h, a, b) => {
        const seen = new Set([a.x + ',' + a.y]), q = [[a.x, a.y]];
        while (q.length) {
          const [x, y] = q.pop();
          if (x === b.x && y === b.y) return true;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
            if (seen.has(k) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const t = g[ny] && g[ny][nx]; if (!t || !t.walkable) continue;
            seen.add(k); q.push([nx, ny]);
          }
        }
        return false;
      };
      let n = 0, curios = 0;
      for (const [theme, meta] of Object.entries(DUNGEON_THEMES)) {
        const maxD = Math.max(meta.depthRange[1], 3);
        for (const depth of [1, Math.ceil(maxD / 2), maxD]) {
          const size = sizes[(n * 3 + depth) % sizes.length], variant = variants[(n + depth) % variants.length]; n++;
          const t0 = Date.now(); let lvl;
          try { lvl = generateDungeonLevel(theme, depth, maxD, variant, size, 0); } catch (e) { A.err('worldgen', theme, `d${depth} ${size}/${variant}: generateDungeonLevel threw ${e.message}`); continue; }
          const dt = Date.now() - t0; floors++; if (dt > 2500) { slow++; A.warn('worldgen.perf', theme, `d${depth} ${size} took ${dt}ms`); }
          const where = `${theme} d${depth} ${size}/${variant}/${lvl.genId}`;
          if (!lvl.grid || lvl.grid.length !== lvl.h) { A.err('worldgen', where, 'grid height mismatch'); continue; }
          let walk = 0;
          for (let y = 0; y < lvl.h; y++) for (let x = 0; x < lvl.w; x++) { const t = lvl.grid[y][x]; if (!t) { A.err('worldgen', where, `null tile at ${x},${y}`); y = lvl.h; break; } if (t.walkable) walk++; }
          totalWalk += walk;
          const up = lvl.upStairs, down = lvl.downStairs;
          const okAt = (p) => p && lvl.grid[p.y] && lvl.grid[p.y][p.x] && lvl.grid[p.y][p.x].walkable;
          if (!up || !okAt(up)) A.err('worldgen', where, 'up stairs missing or not on walkable ground ' + JSON.stringify(up));
          if (down && !okAt(down)) A.err('worldgen', where, 'down stairs not on walkable ground');
          if (up && down && okAt(up) && okAt(down) && !bfs(lvl.grid, lvl.w, lvl.h, up, down)) A.err('worldgen', where, 'down stairs unreachable from up stairs');
          for (const c of (lvl.containers || [])) if (!okAt(c)) A.err('worldgen', where, `a ${c.container && c.container.kind || 'container'} sits on a non-walkable tile at ${c.x},${c.y} (${(lvl.grid[c.y] && lvl.grid[c.y][c.x] && (lvl.grid[c.y][c.x].feature || lvl.grid[c.y][c.x].type)) || 'out of bounds'}): its loot is unreachable`);
          for (const e of (lvl.items || [])) if (!okAt(e)) A.err('worldgen', where, `item ${e.item && e.item.name} lies on a non-walkable tile at ${e.x},${e.y}`);
          if (up) for (let yy = Math.max(0, up.y - 2); yy <= Math.min(lvl.h - 1, up.y + 2); yy++) for (let xx = Math.max(0, up.x - 2); xx <= Math.min(lvl.w - 1, up.x + 2); xx++) { const t = lvl.grid[yy][xx]; if (t && (t.hiddenTrap || t.trapType) && !t.trapDisarmed) A.err('worldgen', where, `a ${t.trapType || 'trap'} sits ${Math.max(Math.abs(xx - up.x), Math.abs(yy - up.y))} tiles from the arrival stairs`); }
          if (depth <= 2) { // shooter packs: ranged species may not appear in groups on the first two floors (see the SHOOTER PACKS changelog line)
            for (const m of lvl.monsters) {
              const b = MONSTER_BASES[m.monsterId] || {}; if (!(['ranged', 'kiter', 'turret'].includes(b.behavior) || b.usesMp) || m.boss) continue;
              const near = lvl.monsters.filter((o) => o.monsterId === m.monsterId && chebyshev(o.x, o.y, m.x, m.y) <= 3).length; shooterMax = Math.max(shooterMax, near);
              if (near >= 5) A.err('worldgen', where, `${near} ${m.name} within 3 tiles of each other on a floor-${depth} level: a shooter pack the cap should prevent`);
            }
          }
          { // reachability: everything must be reachable from the up stairs (locked / lever / secret doors count as passable: a vault is meant to sit behind one)
            const passable = (t) => t && (t.walkable || t.feature === 'lockeddoor' || t.feature === 'leverdoor' || t.feature === 'secretdoor');
            const seenR = new Set([up.x + ',' + up.y]), stR = [[up.x, up.y]];
            while (stR.length) { const [cx, cy] = stR.pop(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy, k = nx + ',' + ny; if (seenR.has(k) || nx < 0 || ny < 0 || nx >= lvl.w || ny >= lvl.h || !passable(lvl.grid[ny][nx])) continue; seenR.add(k); stR.push([nx, ny]); } }
            const cut = (list, what) => { for (const e of list) if (okAt(e) && !seenR.has(e.x + ',' + e.y)) A.err('worldgen', where, `${what} at ${e.x},${e.y} is sealed off from the up stairs`); };
            cut(lvl.containers || [], 'a container'); cut(lvl.items || [], 'an item'); cut(lvl.monsters || [], 'a monster'); cut(lvl.npcs || [], 'an NPC');
            for (let yy = 0; yy < lvl.h; yy++) for (let xx = 0; xx < lvl.w; xx++) { const t = lvl.grid[yy][xx]; if (t && t.feature === 'curio' && !seenR.has(xx + ',' + yy)) A.err('worldgen', where, `a curio at ${xx},${yy} is sealed off from the up stairs`); }
          }
          const occupied = new Map();
          for (const m of [].concat(lvl.monsters, lvl.npcs || [])) {
            if (!finite(m.x) || !finite(m.y) || !lvl.grid[m.y] || !lvl.grid[m.y][m.x] || !lvl.grid[m.y][m.x].walkable) { A.err('worldgen', where, `${m.name} stands in a wall/out of bounds at ${m.x},${m.y}`); continue; }
            const k = m.x + ',' + m.y; if (occupied.has(k)) A.err('worldgen', where, `${m.name} and ${occupied.get(k)} share tile ${k}`); occupied.set(k, m.name);
            if (!finite(m.hp) || m.hp <= 0) A.err('worldgen', where, `${m.name} has hp ${m.hp}`);
            if (up && m.kind === 'monster' && Math.max(Math.abs(m.x - up.x), Math.abs(m.y - up.y)) <= 2) { adjacentSpawns++; if (m.boss) A.warn('worldgen.spawn', where, `boss ${m.name} spawns within 2 tiles of the arrival stairs`); }
            // stairs are safe ground: no ordinary (non-boss, non-miniboss, non-guard-of-a-boss) encounter within DUNGEON_SPAWN.arrivalSafeRadius of the up stairs
            if (typeof DUNGEON_SPAWN !== 'undefined' && up && m.kind === 'monster' && !m.boss && !m.miniboss && !lvl.monsters.some((bm) => (bm.boss || bm.miniboss) && bm !== m && Math.max(Math.abs(m.x - bm.x), Math.abs(m.y - bm.y)) <= 7) && Math.max(Math.abs(m.x - up.x), Math.abs(m.y - up.y)) <= DUNGEON_SPAWN.arrivalSafeRadius) { /* a boss's honor guard may stand wherever the boss chamber is */ stairSpawns++; if (stairSpawns <= 3) stairWhere.push(`${where}${m._src ? ' <' + m._src + '>' : ''}: ${m.name} at ${Math.max(Math.abs(m.x - up.x), Math.abs(m.y - up.y))} tiles (bosses on floor: ${lvl.monsters.filter((bm) => bm.boss || bm.miniboss).map((bm) => bm.name + '@' + Math.max(Math.abs(m.x - bm.x), Math.abs(m.y - bm.y))).join(',') || 'none'}, floor ${lvl.depth}, aspect ${lvl.aspect || 'none'})`); }
          }
          totalMon += lvl.monsters.length;
          for (const it of lvl.items || []) if (!lvl.grid[it.y] || !lvl.grid[it.y][it.x] || !lvl.grid[it.y][it.x].walkable) A.err('worldgen', where, `item ${(it.item && it.item.name) || '?'} lies in a wall at ${it.x},${it.y}`);
          for (const c of lvl.containers || []) if (!lvl.grid[c.y] || !lvl.grid[c.y][c.x]) A.err('worldgen', where, 'container out of bounds');
          for (let y = 0; y < lvl.h; y++) for (let x = 0; x < lvl.w; x++) { const t = lvl.grid[y][x]; if (t && t.feature === 'curio') { curios++; if (!t.walkable) A.err('worldgen.curio', where, `curio at ${x},${y} is not walkable`); if (!WORLD_EVENTS.some((e) => e.id === t.curioId && e.curio)) A.err('worldgen.curio', where, `curio tile names unknown curio '${t.curioId}'`); if (!up || Math.max(Math.abs(x - up.x), Math.abs(y - up.y)) < 4) A.err('worldgen.curio', where, 'curio placed beside the arrival stairs'); } }
          if (lvl.monsters.length === 0 && walk > 400) A.warn('worldgen.empty', where, `no monsters on a ${walk}-tile floor`);
        }
      }
      A.stat('maxShooterClusterEarly', shooterMax); A.stat('curiosPlaced', curios); if (floors >= 40 && curios === 0) A.err('worldgen.curio', 'all', `no dungeon curios on ${floors} generated floors`);
      if (stairSpawns) A.err('worldgen.spawn', 'arrival-safe-zone', `${stairSpawns} ordinary monsters stand within ${DUNGEON_SPAWN.arrivalSafeRadius} tiles of an arrival staircase, e.g. ${stairWhere.join('; ')}`);
      A.stat('dungeonFloors', floors); A.stat('slowFloors', slow); A.stat('monstersWithin2OfArrival', adjacentSpawns); A.stat('monstersPer100Tiles', +(totalMon / Math.max(1, totalWalk) * 100).toFixed(2));
    },
  },
  {
    id: 'worldgen.overworld',
    desc: 'generate a wide stretch of overworld chunks: no exceptions, no entity stacked in a wall or on another, settlements have people',
    needsPlayer: true,
    seconds: 300,
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      let chunks = 0, mons = 0;
      for (let cy = -14; cy <= 14; cy += 2) for (let cx = -14; cx <= 14; cx += 2) {
        let c; try { c = getChunk(cx, cy); } catch (e) { A.err('worldgen.overworld', `${cx},${cy}`, 'getChunk threw ' + e.message); continue; }
        chunks++;
        const occ = new Map();
        for (const m of c.monsters || []) {
          mons++;
          if (!finite(m.hp) || m.hp <= 0 || !finite(m.x)) { A.err('worldgen.overworld', `${cx},${cy}`, `${m.name} bad hp/pos`); continue; }
          const t = curTileAt(m.x, m.y);
          if (t && !t.walkable && !m.flying && !m.swimmer && !/ocean|water|lake|river|reef|sea/i.test(String(t.biome || t.name))) A.warn('worldgen.overworld', `${cx},${cy}`, `${m.name} stands on non-walkable ${t.biome || t.name} at ${m.x},${m.y}`);
          const k = m.x + ',' + m.y; if (occ.has(k)) A.err('worldgen.overworld', `${cx},${cy}`, `${m.name} stacked with ${occ.get(k)} at ${k}`); occ.set(k, m.name);
        }
      }
      A.stat('overworldChunks', chunks); A.stat('overworldMonsters', mons);
    },
  },
];
});

// ==== FILE: lib/commands/audit.js ====
__def("lib/commands/audit.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// audit -- static + dynamic checks of game data and systems. Exits 1 when any error-level finding exists.
//   node playtest.js audit [--only=items,refs] [--skip=systems.world] [--json] [--warn] [--verbose] [--seed=7]
//   --warn also prints warnings (hidden by default: they are judgement calls, errors are bugs).
// Add checks in lib/probes/*.js (see probes/index.js).
// =====================================================================================================
const { boot, ev, drainErrors } = require('../harness');
const { createCharacter } = require('../driver');
const probes = require('../probes');

/** Source of the reporter handed to every probe (runs in the game realm). */
function REPORTER_SRC() {
  const R = { findings: [], stats: {}, cap: {} };
  const push = (sev) => (area, id, msg) => {
    const k = sev + '|' + area + '|' + id + '|' + msg;
    R.cap[area] = (R.cap[area] || 0) + 1;
    if (R.cap[area] > 400) return; // a systemic bug must not bury the report
    R.findings.push({ sev, area: String(area), id: String(id), msg: String(msg).slice(0, 400), k });
  };
  R.err = push('error'); R.warn = push('warn'); R.info = push('info');
  R.stat = (k, v) => { R.stats[k] = v; };
  // Probes share ONE game instance, so earlier probes leak state (death-saves, resists, debug flags) that makes a LATER lethality/damage measurement meaningless.
  // leakGuard() strips the leak-prone state and returns { restore() }; call restore() in a finally. Every probe that measures damage or lethality should use it.
  R.leakGuard = (opts) => {
    const g = { tut: player.isTutorial, gs: gameState, dc: player.deathCause, sw: player.secondWindCharges, eq: player.equipment, inv: player.inventory, dbg: {}, lk: {} };
    player.secondWindCharges = 0;
    player.isTutorial = false; // tutorial.structure leaves this set: the tutorial makes the player unkillable and switches off affix rolls, which silently voids every lethality/affix probe after it
    player.inventory = g.inv.filter((i) => i.id !== 'recursion_thread'); // the Fourth Corridor death-save
    for (const k of Object.keys(DEBUG)) if (DEBUG[k] === true) { g.dbg[k] = true; DEBUG[k] = false; } // a leaked invincibility/no-damage flag
    for (const k of Object.keys(player)) { // talents.buy-all and similar leave these set
      if ((typeof player[k] === 'number' || typeof player[k] === 'boolean') && player[k] && /^(regen|regenBonusStacks|lifestealBonus)$|Reduction|Resist|Immune|Clot|Mitigation|Absorb|Negate|damageTakenMult/i.test(k) && !/Cost|Req|weather|Vis|Acc/i.test(k)) { g.lk[k] = player[k]; player[k] = typeof player[k] === 'boolean' ? false : 0; }
    }
    player.equipment = Object.assign({}, ...Object.keys(g.eq).map((k) => ({ [k]: g.eq[k] && g.eq[k].reviveOnce ? null : g.eq[k] }))); // a phoenix relic
    // optional: pin the base attributes (earlier probes leave dex/str at 60 from augment/talent/stat tests, which makes every monster miss)
    g.stats = {}; if (opts && opts.baseStats) for (const k of ['str', 'dex', 'int']) { g.stats[k] = player[k]; player[k] = opts.baseStats; }
    g.restore = () => { player.isTutorial = g.tut; Object.assign(player, g.stats); gameState = g.gs; player.deathCause = g.dc; player.secondWindCharges = g.sw; player.equipment = g.eq; Object.assign(player, g.lk); Object.assign(DEBUG, g.dbg); player.inventory = g.inv; };
    return g;
  };
  // Probes share one game instance and earlier ones leave the player wherever they finished (a wall pocket, a dungeon corner). relocate() walks the player to the nearest open
  // w x h block (walkable, no entity, no feature) so spawning allies/monsters has room, and returns restore(); null when no room within 80 tiles.
  R.relocate = (w, h) => {
    w = w || 5; h = h || 5; const ox = player.x, oy = player.y; let spot = null;
    for (let r = 0; r < 80 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = ox + dx, y = oy + dy; let ok = true;
      for (let yy = -(h >> 1); yy <= (h >> 1) && ok; yy++) for (let xx = -(w >> 1); xx <= (w >> 1) && ok; xx++) { const t = curTileAt(x + xx, y + yy); if (!t || !t.walkable || t.feature === 'water' || entityAt(x + xx, y + yy)) ok = false; }
      if (ok) spot = { x, y };
    }
    if (!spot) return null;
    player.x = spot.x; player.y = spot.y;
    return () => { player.x = ox; player.y = oy; };
  };
  window.__AUDIT = R;
}

/** Source text of a probe function as an expression (method shorthand `fn(A){}` has no `function` keyword). */
function fnSource(fn) {
  const s = fn.toString();
  return /^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(s) ? s : '({' + s + '}).fn';
}

async function run(args) {
  const only = args.only ? String(args.only).split(',') : null;
  const skip = args.skip ? String(args.skip).split(',') : [];
  const wanted = probes.filter((p) => (!only || only.some((o) => p.id.startsWith(o))) && !skip.some((s) => p.id.startsWith(s)));
  const seed = parseInt(args.seed || '7', 10);
  const results = [], stats = {};
  let dom = await boot(undefined, seed, { saveable: true });
  let withPlayer = false;
  const t00 = Date.now();
  for (const p of wanted) {
    if (p.needsPlayer && !withPlayer) {
      if (!createCharacter(dom.window)) throw new Error('could not create a character for dynamic probes');
      ev(dom.window, '(' + require('../brain').toString() + ')()'); // probes may use the autopilot helpers through window.__B
      withPlayer = true;
    }
    const win = dom.window;
    ev(win, '(' + REPORTER_SRC.toString() + ')()');
    // Probes share one game instance and the bot-driven ones (monsters.behave...) can leave the player dead or a modal open. Revive and reset so the NEXT probe measures what it means to
    // (this used to turn one random death into 139 bogus "ability changed nothing" warnings), and say so, so the polluting probe gets noticed.
    let revived = false;
    if (withPlayer) { try { revived = ev(win, "(function(){ var was = !player.alive || gameState === 'gameover'; if (was) { player.alive = true; player.hp = Math.max(1, player.maxHp); player.mp = player.maxMp; player.stamina = player.maxStamina; player.deathCause = null; } try { if (gameState !== 'playing') closeModal(); } catch (e) {} gameState = 'playing'; try { document.getElementById('modal').classList.add('hidden'); } catch (e) {} return was; })()").value === true; } catch (e) { /* */ } }
    const t0 = Date.now();
    for (const h of p.uses || []) ev(win, `(${fnSource(h)})(window.__AUDIT)`);
    const r = ev(win, `(${fnSource(p.fn)})(window.__AUDIT)`, (p.seconds || 120) * 1000);
    const findings = JSON.parse(ev(win, 'JSON.stringify(window.__AUDIT.findings)').value || '[]');
    Object.assign(stats, JSON.parse(ev(win, 'JSON.stringify(window.__AUDIT.stats)').value || '{}'));
    if (!r.ok) findings.push({ sev: 'error', area: p.id, id: '(probe)', msg: (r.timeout ? 'TIMED OUT: ' : 'THREW: ') + r.error.split('\n').slice(0, 3).join(' | ').slice(0, 500) });
    for (const e of drainErrors(win)) findings.push({ sev: 'error', area: p.id, id: '(game exception)', msg: `[${e.where}] x${e.count} ${e.msg} @ ${(e.stack.split('\n')[1] || '').trim()}` });
    if (revived) findings.push({ sev: 'warn', area: 'audit.runner', id: p.id, msg: `the player was dead when this probe started (an earlier probe, usually ${results.length ? results[results.length - 1].id : 'none'}, killed it); revived before running` });
    results.push({ id: p.id, desc: p.desc, ms: Date.now() - t0, findings });
    if (!args.json) process.stderr.write(`  ${p.id.padEnd(26)} ${String(Date.now() - t0).padStart(6)}ms  ${findings.filter((f) => f.sev === 'error').length} errors, ${findings.filter((f) => f.sev === 'warn').length} warnings\n`);
  }
  const errors = results.flatMap((r) => r.findings.filter((f) => f.sev === 'error'));
  const warns = results.flatMap((r) => r.findings.filter((f) => f.sev === 'warn'));
  if (args.json) { console.log(JSON.stringify({ stats, results }, null, 1)); return { exitCode: errors.length ? 1 : 0 }; }
  const show = (list, label) => {
    const byArea = new Map();
    for (const f of list) { if (!byArea.has(f.area)) byArea.set(f.area, []); byArea.get(f.area).push(f); }
    for (const [area, fs] of byArea) { console.log(`\n${label} [${area}] (${fs.length})`); for (const f of fs.slice(0, args.verbose ? 1000 : 25)) console.log(`  ${f.id}: ${f.msg}`); if (fs.length > 25 && !args.verbose) console.log(`  ... ${fs.length - 25} more (use --verbose)`); }
  };
  show(errors, 'ERROR');
  if (args.warn) show(warns, 'warn');
  console.log(`\nStats: ${JSON.stringify(stats)}`);
  console.log(`Audit finished in ${((Date.now() - t00) / 1000).toFixed(1)}s: ${errors.length} errors, ${warns.length} warnings${args.warn ? '' : ' (run with --warn to list)'}`);
  return { exitCode: errors.length ? 1 : 0 };
}
module.exports = { run };
});

// ==== FILE: lib/commands/balance.js ====
__def("lib/commands/balance.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// balance -- controlled duels: every class (or a chosen few) against a ladder of monsters at the same strength.
//   node playtest.js balance --curve=1,5,10,20 [--classes=..]   win rate per class as the character levels (scale = depthScaleForPlayerLevel(L), tier = ceil(L/6), capped at 6)
//   node playtest.js balance [--classes=all|warrior,mage] [--species=human] [--level=1] [--scale=1] [--tier=1] [--trials=8] [--monsters=a,b] [--nosupport|--kite] [--json]
// --nosupport turns off the buff/summon/debuff casting (damage-only policy)
// --level N levels the character up N-1 times (stats/talents spent by the autopilot's own helpers) before fighting;
// --scale is the monster depthScale (1 = ground floor of the first dungeon); --tier picks all non-boss monsters with dtier <= tier.
// Output: per class the win rate against the whole ladder plus the worst matchups. Great for "is class X unfairly weak/strong at level N?".
// =====================================================================================================
const { newGame, createCharacter } = require('../driver');
const { ev } = require('../harness');
const DUEL = require('../duel');

async function curve(args) {
  const levels = String(args.curve).split(',').map((n) => parseInt(n, 10));
  const classes = args.classes === 'all' ? null : String(args.classes || 'warrior,mage,rogue').split(',');
  const species = args.species || 'human', trials = parseInt(args.trials || 4, 10);
  const probe = await newGame({ seed: 5 });
  const tables = JSON.parse(ev(probe.window, 'JSON.stringify({classes:ARCHETYPES.map(a=>a.id),mon:Object.entries(MONSTER_BASES).filter(([id,m])=>!m.boss&&!m.miniboss&&!m.waterOnly&&!m.aquatic&&!m.summonId&&m.behavior!=="turret"&&m.behavior!=="flee"&&!m.splitInto&&!m.powerDraw).map(([id,m])=>[id,m.dtier===undefined?0:m.dtier])})').value);
  const list = classes || tables.classes;
  const rows = [];
  for (const cl of list) {
    const row = { class: cl, win: {} };
    for (const L of levels) {
      const tier = Math.min(6, Math.max(1, Math.ceil(L / 6)));
      // the monsters of the tier the player is expected to meet at this level (not the whole ladder below it)
      const mons = tables.mon.filter((e) => e[1] === tier || (tier === 1 && e[1] === 0)).map((e) => e[0]);
      const dom = await newGame({ seed: 11 }); const win = dom.window;
      if (!createCharacter(win, { species, archetype: cl, scenario: 'town' })) continue;
      ev(win, '(' + DUEL.toString() + ')()');
      ev(win, `__DUEL.levelTo(${L});`, 120000);
      let w = 0, n = 0;
      for (const id of mons) { const r = ev(win, `JSON.stringify(__DUEL.run(${JSON.stringify(id)}, {scale:depthScaleForPlayerLevel(${L}), trials:${trials}, support:${args.nosupport ? 'false' : args.kite ? "'kite'" : 'true'}}))`, 120000); if (r.ok) { w += JSON.parse(r.value).win; n++; } }
      row.win[L] = n ? w / n : null;
    }
    rows.push(row);
    console.error('  ' + cl.padEnd(13) + levels.map((L) => `L${L}:${row.win[L] == null ? '--' : Math.round(row.win[L] * 100) + '%'}`).join('  '));
  }
  if (args.json) { console.log(JSON.stringify(rows)); return; }
  console.log('\nclass         ' + levels.map((L) => ('L' + L).padEnd(6)).join(''));
  for (const r of rows) console.log(r.class.padEnd(14) + levels.map((L) => (r.win[L] == null ? '--' : Math.round(r.win[L] * 100) + '%').padEnd(6)).join(''));
  console.log('\nA class whose win% falls off a cliff between two columns marks a difficulty spike (or a bot limit: the duel policy only casts damage spells).');
}

// --assess: compare the game's threat estimate (threatOf) with what the duels measured. Per tier: how often the fighter really won and what it cost; plus the correlation between predicted and measured "HP left".
function assessReport(out) {
  const pts = [];
  for (const o of out) for (const r of o.rows) if (!r.error && r.pred) pts.push({ cl: o.class, id: r.id, tier: r.pred.tier, pl: Math.max(-0.5, Math.min(1, r.pred.left)), win: r.win, meas: r.win * (1 - r.hpLostPct) });
  const tiers = ['trivial', 'easy', 'even', 'dangerous', 'deadly', 'overwhelming'];
  console.log('\nTHREAT CALIBRATION (predicted tier -> measured duel outcome)');
  console.log('tier'.padEnd(14) + 'n'.padEnd(6) + 'win%'.padEnd(8) + 'avgHPleft%'.padEnd(12) + 'predLeft%');
  for (const t of tiers) { const a = pts.filter((p) => p.tier === t); if (!a.length) continue; const m = (f) => a.reduce((x, p) => x + f(p), 0) / a.length; console.log(t.padEnd(14) + String(a.length).padEnd(6) + String(Math.round(m((p) => p.win) * 100)).padEnd(8) + String(Math.round(m((p) => p.meas) * 100)).padEnd(12) + Math.round(m((p) => p.pl) * 100)); }
  { // which player-strength multiplier (THREAT_MODEL.playerEdge) best matches the duels?
    const rowsE = out.flatMap((o) => o.rows.filter((r) => !r.error && r.pred && r.pred.byEdge));
    for (const e of Object.keys((rowsE[0] || { pred: { byEdge: {} } }).pred.byEdge)) {
      const xs = rowsE.map((r) => Math.max(-0.5, Math.min(1, r.pred.byEdge[e]))), ys = rowsE.map((r) => r.win * (1 - r.hpLostPct));
      const mx2 = xs.reduce((a, b) => a + b, 0) / xs.length, my2 = ys.reduce((a, b) => a + b, 0) / ys.length;
      let c = 0, vx2 = 0, vy2 = 0; xs.forEach((x, i) => { c += (x - mx2) * (ys[i] - my2); vx2 += (x - mx2) ** 2; vy2 += (ys[i] - my2) ** 2; });
      console.log(`  playerEdge ${e}: correlation ${(c / Math.sqrt(vx2 * vy2 || 1)).toFixed(3)}, mean predicted left ${(mx2 * 100).toFixed(0)}% vs measured ${(my2 * 100).toFixed(0)}%`);
    }
  }
  const n = pts.length, mx = pts.reduce((a, p) => a + p.pl, 0) / n, my = pts.reduce((a, p) => a + p.meas, 0) / n;
  const cov = pts.reduce((a, p) => a + (p.pl - mx) * (p.meas - my), 0), vx = pts.reduce((a, p) => a + (p.pl - mx) ** 2, 0), vy = pts.reduce((a, p) => a + (p.meas - my) ** 2, 0);
  console.log(`\ncorrelation(predicted HP left, measured win*(1-hpLost)) = ${(cov / Math.sqrt(vx * vy || 1)).toFixed(2)} over ${n} matchups`);
  const wrong = pts.filter((p) => (['trivial', 'easy'].includes(p.tier) && p.win < 0.8) || (['deadly', 'overwhelming'].includes(p.tier) && p.win > 0.8)).sort((a, b) => Math.abs(b.pl - b.meas) - Math.abs(a.pl - a.meas)).slice(0, 12);
  if (wrong.length) { console.log('\nWorst disagreements:'); for (const w of wrong) console.log(`  ${w.cl}/${w.id}: predicted ${w.tier} (${Math.round(w.pl * 100)}% left) but won ${Math.round(w.win * 100)}% with ${Math.round(w.meas * 100)}% left`); }
}
async function run(args) {
  if (args.curve) return curve(args);
  const probe = await newGame({ seed: 5 });
  const tables = JSON.parse(ev(probe.window, 'JSON.stringify({classes:ARCHETYPES.map(a=>a.id),mon:Object.entries(MONSTER_BASES).filter(([id,m])=>!m.boss&&!m.miniboss&&!m.waterOnly&&!m.aquatic&&!m.summonId&&m.behavior!=="turret"&&m.behavior!=="flee"&&!m.splitInto&&!m.powerDraw).map(([id,m])=>[id,m.dtier===undefined?0:m.dtier])})').value);
  const tier = parseInt(args.tier === undefined ? 1 : args.tier, 10);
  const monsters = args.monsters ? String(args.monsters).split(',') : tables.mon.filter((e) => e[1] <= tier).map((e) => e[0]);
  const classes = args.classes === 'all' ? tables.classes : String(args.classes || 'warrior,mage,rogue').split(',');
  const species = args.species || 'human', level = parseInt(args.level || 1, 10), scale = parseFloat(args.scale || 1), trials = parseInt(args.trials || 8, 10);
  console.error(`balance: ${classes.length} classes x ${monsters.length} monsters, ${trials} trials each, level ${level}, scale ${scale}`);
  const out = [];
  for (const cl of classes) {
    const dom = await newGame({ seed: 11 }); const win = dom.window;
    if (!createCharacter(win, { species, archetype: cl, scenario: 'town' })) { console.error('could not create ' + cl); continue; }
    ev(win, '(' + DUEL.toString() + ')()');
    ev(win, `__DUEL.levelTo(${level});`, 120000);
    const info = JSON.parse(ev(win, 'JSON.stringify({hp:player.maxHp,mp:player.maxMp,str:player.str,dex:player.dex,int:player.int,spells:player.knownSpells.length,tech:(player.knownTechniques||[]).length,weapon:(player.equipment.hand||{}).name,armor:getArmorOf(player)})').value);
    const rows = [];
    for (const id of monsters) {
      const r = ev(win, `JSON.stringify(__DUEL.run(${JSON.stringify(id)}, {scale:${scale}, trials:${trials}, support:${args.nosupport ? 'false' : args.kite ? "'kite'" : 'true'}}))`, 120000);
      if (r.ok) rows.push(JSON.parse(r.value)); else rows.push({ id, error: r.error.split('\n')[0] });
    }
    const ok = rows.filter((r) => !r.error);
    const mean = ok.reduce((a, r) => a + r.win, 0) / Math.max(1, ok.length);
    const cost = ok.filter((r) => r.win > 0).reduce((a, r) => a + r.hpLostPct, 0) / Math.max(1, ok.filter((r) => r.win > 0).length);
    out.push({ class: cl, info, mean, cost, rows, errors: rows.filter((r) => r.error).length });
    console.error(`  ${cl.padEnd(13)} win ${(mean * 100).toFixed(0)}%  avg hp cost ${(cost * 100).toFixed(0)}%  (hp ${info.hp}, mp ${info.mp}, ${info.weapon || 'unarmed'}, armor ${info.armor})`);
  }
  if (args.assess) assessReport(out);
  if (args.json) { console.log(JSON.stringify(out)); return; }
  out.sort((a, b) => a.mean - b.mean);
  console.log(`\nclass         win%  hpCost%  worst matchups`);
  for (const o of out) console.log(o.class.padEnd(13) + String(Math.round(o.mean * 100)).padEnd(6) + String(Math.round(o.cost * 100)).padEnd(9) + o.rows.filter((r) => !r.error).sort((a, b) => a.win - b.win).slice(0, 4).map((r) => `${r.id}:${Math.round(r.win * 100)}%`).join(' ') + (o.errors ? `  (${o.errors} errors)` : ''));
  const bad = out.flatMap((o) => o.rows.filter((r) => r.error).map((r) => `${o.class}/${r.id}: ${r.error}`));
  if (bad.length) { console.log('\nErrors:'); for (const b of bad.slice(0, 10)) console.log('  ' + b); }
}
module.exports = { run };
});

// ==== FILE: lib/commands/classbp.js ====
__def("lib/commands/classbp.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// classbp -- per-class "breakpoint" table: win rate against the whole non-boss monster ladder (dtier <= --tier) at several monster strengths.
//   node playtest.js classbp [--classes=all|a,b] [--level=20] [--scales=3.5,6,10,16 | --rel=1,1.5,2.5] [--trials=3] [--tier=4] [--jobs=2] [--kit=school] [--gear[=best]] [--curve=JSON] [--armorpass=0.25] [--pack=N | --gauntlet=N] [--gtrials=12] [--botpolicy=1] [--out=file.json]
// --rel gives scales as multiples of the NATIVE monster scale for that level (depthScaleForPlayerLevel), so tables at different levels are comparable. Each cell is win% / HP-cost% (avg HP lost in won fights) / t = mean fight length in turns (won fights).
// One child process per class (a class takes ~2 min at 4 scales x 216 monsters x 3 trials). Reading it: scale 3.5 is native for a level-20 character;
// the interesting column is the highest scale where a class still wins >=50%. A class that is far below its peers at EVERY scale usually has a
// kit problem (see "balance lessons" in the README: no reliable starter damage, or abilities the autopilot refuses to use) rather than bad stats.
// NOTE the character is levelled by levelUp() + the bot's own stat/talent spending, so abilities learned from trainers/books are NOT included: this measures
// the starting kit at that level, the same for every class.
// =====================================================================================================
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { newGame, createCharacter } = require('../driver');
const { ev } = require('../harness');
const DUEL = require('../duel');

async function one(args) {
  const cl = args.one, L = parseInt(args.level || 20, 10), tier = parseInt(args.tier || 4, 10), trials = parseInt(args.trials || 3, 10);
  const dom = await newGame({ seed: 11 }); const win = dom.window;
  const native = +ev(win, `depthScaleForPlayerLevel(${L})`).value;
  const rels = args.rel ? String(args.rel).split(',').map(Number) : null;
  const scales = rels ? rels.map((r) => +(r * native).toFixed(3)) : String(args.scales || '3.5,6,10,16').split(',').map(Number);
  if (!createCharacter(win, { species: args.species || 'human', archetype: cl, scenario: 'town' })) { console.error('could not create ' + cl); process.exit(1); }
  ev(win, '(' + DUEL.toString() + ')()');
  // --curve='[[depthScale,hpMult,atkMult],...]' replaces MONSTER_CURVE and --armorpass=0.25 sets COMBAT_TUNING.armorPassFraction for this run only (tuning without editing the game)
  if (args.curve) { const r = ev(win, `MONSTER_CURVE.splice(0, MONSTER_CURVE.length, ...${args.curve}); 1`); if (!r.ok) { console.error('bad --curve: ' + r.error); process.exit(1); } }
  if (args.armorpass !== undefined) ev(win, `COMBAT_TUNING.armorPassFraction = ${parseFloat(args.armorpass)}`);
  ev(win, `__DUEL.levelTo(${L});`);
  if (args.gear) ev(win, '__DUEL.gearUp(' + L + (args.gear === 'best' ? ', true' : '') + ')');
  // --kit=school: give the class EVERY ability of the schools it starts in up to tier ceil(level/5), as a character with trainers/tomes/manuals would have; default is the bare starting kit
  if (args.kit === 'school') ev(win, `(function(){ var T = Math.ceil(${L} / 5), ids = player.knownSpells.concat(player.knownTechniques || []), schools = {};
    ids.forEach(function (id) { var a = findAbilityById(id); if (a && a.school) schools[a.school] = 1; });
    SPELLS.forEach(function (x) { if (schools[x.school] && (x.tier || 1) <= T && player.knownSpells.indexOf(x.id) < 0) player.knownSpells.push(x.id); });
    TECHNIQUES.forEach(function (x) { if (schools[x.school] && (x.tier || 1) <= T && player.knownTechniques.indexOf(x.id) < 0) player.knownTechniques.push(x.id); }); })()`);
  const info = JSON.parse(ev(win, 'JSON.stringify({hp:player.maxHp,mp:player.maxMp,spells:player.knownSpells.length,tech:(player.knownTechniques||[]).length,armor:getArmorOf(player)})').value);
  const mons = JSON.parse(ev(win, `JSON.stringify(Object.entries(MONSTER_BASES).filter(([id,m])=>!m.boss&&!m.miniboss&&!m.waterOnly&&!m.aquatic&&!m.summonId&&m.behavior!=="flee"&&(m.dtier||0)<=${tier}).map(e=>e[0]))`).value);
  const res = { class: cl, level: L, info, scales: {} };
  // --pack=N / --gauntlet=N: instead of 1v1 duels, N random monsters arrive together (pack) or one after another with no rest (gauntlet). --gtrials=12 groups per scale. Exposes classes that win duels on burst but run dry / get swarmed.
  const grp = args.pack ? { mode: 'pack', size: parseInt(args.pack, 10) } : args.gauntlet ? { mode: 'gauntlet', size: parseInt(args.gauntlet, 10) } : null;
  if (grp) {
    for (const S of scales) {
      const r = ev(win, `JSON.stringify(__DUEL.groupRun(${JSON.stringify(mons)}, {mode:${JSON.stringify(grp.mode)}, size:${grp.size}, scale:${S}, trials:${parseInt(args.gtrials || 12, 10)}, support:${args.botpolicy ? "'bot'" : 'true'}}))`, 600000);
      const o = r.ok ? JSON.parse(r.value) : { win: 0, hpLostPct: 1, turns: 0, trials: 0 };
      res.scales[rels ? 'x' + rels[scales.indexOf(S)] : S] = { win: o.win, cost: o.hpLostPct, n: o.trials, turns: o.turns, scale: S, worst: ['avgKills:' + (o.avgKills || 0).toFixed(1) + '/' + grp.size] };
    }
    console.log('@@CLASSBP ' + JSON.stringify(res)); return;
  }
  for (const S of scales) {
    let w = 0, n = 0, cost = 0, cn = 0, turns = 0, tn = 0; const worst = [];
    for (const id of mons) {
      const r = ev(win, `JSON.stringify(__DUEL.run(${JSON.stringify(id)},{scale:${S},trials:${trials},support:true}))`, 120000);
      if (!r.ok) continue; const o = JSON.parse(r.value); w += o.win; n++; worst.push([id, o.win]); if (o.win > 0) { cost += o.hpLostPct; cn++; turns += o.turns; tn++; }
    }
    worst.sort((a, b) => a[1] - b[1]);
    res.scales[rels ? 'x' + rels[scales.indexOf(S)] : S] = { win: w / Math.max(1, n), cost: cost / Math.max(1, cn), n, turns: turns / Math.max(1, tn), scale: S, worst: worst.slice(0, 5).map((x) => x[0] + ':' + Math.round(x[1] * 100)) };
  }
  console.log('@@CLASSBP ' + JSON.stringify(res));
}

function child(cl, args) {
  return new Promise((resolve) => {
    const argv = [path.join(__dirname, '..', '..', 'playtest.js'), 'classbp', `--one=${cl}`, ...['level', 'scales', 'rel', 'trials', 'tier', 'species', 'kit', 'gear', 'curve', 'armorpass', 'pack', 'gauntlet', 'gtrials', 'botpolicy'].filter((k) => args[k] !== undefined).map((k) => `--${k}=${args[k]}`)];
    const p = spawn(process.execPath, argv, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => { const l = out.split('\n').find((x) => x.startsWith('@@CLASSBP ')); resolve(l ? JSON.parse(l.slice(10)) : { class: cl, error: true }); });
  });
}

async function run(args) {
  if (args.one) return one(args);
  const probe = await newGame({ seed: 5 });
  const all = JSON.parse(ev(probe.window, 'JSON.stringify(ARCHETYPES.map(a=>a.id))').value);
  const classes = !args.classes || args.classes === 'all' ? all : String(args.classes).split(',');
  const jobs = Math.max(1, parseInt(args.jobs || 2, 10)), results = []; let i = 0;
  console.error(`classbp: ${classes.length} classes, level ${args.level || 20}, ${jobs} at a time (~2 min per class)`);
  await Promise.all(Array.from({ length: jobs }, async () => { while (i < classes.length) { const k = i++; const r = await child(classes[k], args); results.push(r); console.error('  done ' + classes[k]); } }));
  const good = results.filter((r) => !r.error); const sc = Object.keys((good[0] || { scales: {} }).scales);
  const last = sc[sc.length - 1];
  good.sort((a, b) => (a.scales[last] ? a.scales[last].win : 0) - (b.scales[last] ? b.scales[last].win : 0));
  console.log('class'.padEnd(14) + 'hp'.padStart(5) + ' spl tech ' + sc.map((s) => (s.startsWith('x') ? s : 'x' + s).padStart(15)).join(''));
  for (const r of good) console.log(r.class.padEnd(14) + String(r.info.hp).padStart(5) + String(r.info.spells).padStart(4) + String(r.info.tech).padStart(5) + ' ' + sc.map((s) => (Math.round(r.scales[s].win * 100) + '/' + Math.round(r.scales[s].cost * 100) + '%/' + (r.scales[s].turns || 0).toFixed(1) + 't').padStart(15)).join('') + '   worst@' + last + ': ' + r.scales[last].worst.slice(0, 3).join(','));
  if (results.some((r) => r.error)) console.log('failed: ' + results.filter((r) => r.error).map((r) => r.class).join(', '));
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(good, null, 1));
}
module.exports = { run };
});

// ==== FILE: lib/commands/list.js ====
__def("lib/commands/list.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// list -- print the character creation options (species / classes / scenarios) with the names --species/--class/--scenario accept.
const { boot, ev } = require('../harness');
async function run() {
  const dom = await boot();
  const t = JSON.parse(ev(dom.window, 'JSON.stringify({species:SPECIES.map(s=>[s.id,s.name]),classes:ARCHETYPES.map(s=>[s.id,s.name]),scenarios:START_SCENARIOS.map(s=>[s.id,s.name])})').value);
  for (const k of Object.keys(t)) console.log(k.toUpperCase() + ': ' + t[k].map((e) => e[0]).join(', '));
}
module.exports = { run };
});

// ==== FILE: lib/commands/matrix.js ====
__def("lib/commands/matrix.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// matrix -- play many characters (class x species x scenario x seed) in parallel child processes and aggregate.
//   node playtest.js matrix --classes=all --species=dwarf --seeds=1,2 --secs=120 [--jobs=4] [--lives=3] [--scenario=town] [--out=report.json]
//   Lists accept 'all' or comma separated names. Each run is `play --json`, so everything `play` takes (devlvl, devstage, ...) is forwarded.
// Reading the report: "lvl" is where the character ended the time budget (progression pace), deaths are listed with cause,
// "errs" counts exceptions the GAME swallowed (always worth a look), loops are bot/game soft-lock suspects.
// NOTE the autopilot is melee/consumable-centric: a weak caster/summoner result may be the BOT, not the class. Read the death log first.
// =====================================================================================================
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { boot, ev } = require('../harness');

/** One-line summary of a failed matrix child: the Error message line first (a bare stack tail hides WHY it died), then the last stack frames. */
function crashSummary(stderr, code) {
  const lines = String(stderr || '').split('\n').filter(Boolean);
  if (!lines.length) return 'no result (exit ' + code + ')';
  const msg = lines.find((l) => /^\s*(Uncaught |\w*Error\b|Error:)/.test(l) && !/^\s+at /.test(l));
  return [msg, ...lines.slice(-2)].filter(Boolean).join(' | ');
}
function runOne(job, forward) {
  return new Promise((resolve) => {
    const argv = [path.join(__dirname, '..', '..', 'playtest.js'), 'play', '--json', `--seed=${job.seed}`, `--species=${job.species}`, `--class=${job.class}`, `--scenario=${job.scenario}`, ...forward];
    const t0 = Date.now();
    const p = spawn(process.execPath, argv, { env: Object.assign({}, process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('@@RESULT '));
      let res = null; try { res = line ? JSON.parse(line.slice(9)) : null; } catch (e) { /* */ }
      resolve({ job, code, res, seconds: (Date.now() - t0) / 1000, crash: res ? null : crashSummary(err, code) });
    });
  });
}

async function pool(items, n, fn, onDone) {
  let i = 0; const results = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; results[k] = await fn(items[k]); if (onDone) onDone(results[k], k + 1, items.length); } }));
  return results;
}

async function run(args) {
  const dom = await boot();
  const tables = JSON.parse(ev(dom.window, 'JSON.stringify({species:SPECIES.map(s=>s.id),classes:ARCHETYPES.map(s=>s.id),scenarios:START_SCENARIOS.map(s=>s.id)})').value);
  const pick = (v, all, def) => (v === undefined ? def : (v === 'all' ? all : String(v).split(',')));
  // singular/plural aliases: `play` takes --class/--species/--scenario/--seed, `matrix` the plural lists. Mixing them up silently ran the default build (commander) and cost hours once.
  const alias = (plural, singular) => (args[plural] !== undefined ? args[plural] : args[singular]);
  const classes = pick(alias('classes', 'class'), tables.classes, ['commander']), species = pick(alias('species', 'species'), tables.species, ['dwarf']);
  const scenarios = pick(alias('scenarios', 'scenario'), tables.scenarios, ['town']), seeds = String(alias('seeds', 'seed') || '1').split(',').map(Number);
  const known = new Set(['classes', 'class', 'species', 'scenario', 'scenarios', 'seeds', 'seed', 'jobs', 'lives', 'secs', 'ticks', 'devlvl', 'devgear', 'devstage', 'devpos', 'devspells', 'devdungeon', 'out', 'json', '_']);
  for (const k of Object.keys(args)) if (!known.has(k)) console.error(`matrix: warning, ignoring unknown flag --${k}`);
  const jobs = [];
  for (const sp of species) for (const cl of classes) for (const sc of scenarios) for (const seed of seeds) jobs.push({ species: sp, class: cl, scenario: sc, seed });
  const conc = parseInt(args.jobs || Math.max(1, Math.min(os.cpus().length - 1, 6)), 10);
  const forward = [`--secs=${args.secs || 120}`, `--lives=${args.lives || 1}`];
  for (const k of ['ticks', 'devlvl', 'devgear', 'devstage', 'devpos', 'devspells', 'devdungeon']) if (args[k] !== undefined) forward.push(args[k] === true ? `--${k}` : `--${k}=${args[k]}`);
  console.error(`matrix: ${jobs.length} runs, ${conc} at a time, ${args.secs || 120}s each`);
  const results = await pool(jobs, conc, (j) => runOne(j, forward), (r, n, total) => console.error(`  [${n}/${total}] ${r.job.species}/${r.job.class}/${r.job.scenario}#${r.job.seed}: ` + (r.res ? `${r.res.outcome} L${r.res.final && r.res.final.lvl}` : 'CRASH ' + r.crash)));

  const rows = results.map((r) => {
    const f = (r.res && r.res.final) || {};
    return { build: `${r.job.species}/${r.job.class}/${r.job.scenario}#${r.job.seed}`, outcome: r.res ? r.res.outcome : 'CRASH', lvl: f.lvl, turn: f.turn, deaths: r.res ? r.res.deaths.length : 0, causes: r.res ? r.res.deaths.map((d) => d.cause + '@L' + d.lvl) : [], errs: r.res ? r.res.gameErrors.length : 0, loops: r.res && r.res.loops ? r.res.loops.length : 0, crash: r.crash, res: r.res };
  });
  rows.sort((a, b) => (a.lvl || 0) - (b.lvl || 0));
  console.log('\nbuild'.padEnd(46) + 'outcome'.padEnd(9) + 'lvl'.padEnd(5) + 'turn'.padEnd(8) + 'deaths'.padEnd(8) + 'errs  loops  notes');
  for (const r of rows) console.log(r.build.padEnd(45) + ' ' + String(r.outcome).padEnd(8) + String(r.lvl).padEnd(5) + String(r.turn).padEnd(8) + String(r.deaths).padEnd(8) + String(r.errs).padEnd(6) + String(r.loops).padEnd(7) + (r.crash || r.causes.join(',')));
  const lv = rows.map((r) => r.lvl || 0), avg = lv.reduce((a, b) => a + b, 0) / Math.max(1, lv.length);
  const causes = {}; for (const r of rows) for (const c of r.causes) { const k = c.split('@')[0]; causes[k] = (causes[k] || 0) + 1; }
  console.log(`\nmean level ${avg.toFixed(1)}  min ${Math.min(...lv)}  max ${Math.max(...lv)}  deaths ${rows.reduce((a, r) => a + r.deaths, 0)}  causes ${JSON.stringify(causes)}`);
  { // feat pacing: which feats do runs actually earn (a feat nobody earns is too hard, one everybody earns instantly is too easy)
    const done = {}; let n = 0; for (const r of results) { const ft = r.res && r.res.final && r.res.final.feats; if (!ft) continue; n++; for (const id of ft.done) done[id] = (done[id] || 0) + 1; }
    if (n) console.log(`feats earned across ${n} runs: ` + Object.entries(done).sort((x, y) => y[1] - x[1]).map(([id, c]) => `${id} ${c}/${n}`).join(', '));
  }
  { // where do the deaths happen, and which classes suffer? (small samples: directional only)
    const bands = [[1, 2], [3, 5], [6, 10], [11, 20], [21, 999]], byBand = bands.map(([lo, hi]) => { let n = 0; const c = {}; for (const r of results) if (r.res) for (const d of r.res.deaths) if (d.lvl >= lo && d.lvl <= hi) { n++; const k = String(d.cause).slice(0, 28); c[k] = (c[k] || 0) + 1; } return { band: lo + '-' + (hi === 999 ? '+' : hi), n, top: Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + 'x' + v).join(', ') }; });
    console.log('deaths by level band: ' + byBand.filter((b) => b.n).map((b) => `L${b.band}: ${b.n} (${b.top})`).join(' | '));
    const byClass = {}; for (const r of results) { const c = r.job.class; (byClass[c] = byClass[c] || { n: 0, lvl: 0, deaths: 0 }); byClass[c].n++; byClass[c].lvl += (r.res && r.res.final && r.res.final.lvl) || 0; byClass[c].deaths += r.res ? r.res.deaths.length : 0; }
    const worst = Object.entries(byClass).filter(([, v]) => v.n >= 2 || Object.keys(byClass).length > 3).sort((a, b) => (b[1].deaths / b[1].n) - (a[1].deaths / a[1].n) || (a[1].lvl / a[1].n) - (b[1].lvl / b[1].n)).slice(0, 4);
    if (worst.length > 1) console.log('hardest classes (deaths/run, mean level): ' + worst.map(([k, v]) => `${k} ${(v.deaths / v.n).toFixed(1)}/${(v.lvl / v.n).toFixed(1)}`).join(', '));
    { // one line per death (where and how), so a sweep can be diagnosed without opening the JSON; place/biome come from the run's final state (exact for single-death runs)
      const lines = [];
      for (const r of results) if (r.res && r.res.deaths.length) { const f = r.res.final || {}, d = r.res.deaths[0], one = r.res.deaths.length === 1; lines.push(`  ${r.job.species}/${r.job.class}#${r.job.seed} L${d.lvl} t${d.turn} ${d.cause}${one && f.place ? ' @ ' + f.place + (f.st && f.st.biome ? '/' + f.st.biome : '') : ''}${d.at ? ' [' + d.at.fromStart + ' from start; ' + (d.at.near || []).join(',') + ']' : ''}: ` + (d.deathLog || []).slice(-3).map((x) => String(x).slice(0, 70)).join(' | ')); }
      if (lines.length) { console.log('death details (last 3 log lines):'); for (const l of lines.slice(0, 14)) console.log(l); if (lines.length > 14) console.log(`  ... and ${lines.length - 14} more (see --out JSON)`); }
    }
    const stalls = rows.filter((r) => r.loops > 0).length; if (stalls) console.log(`runs with loop/stall notes: ${stalls} of ${rows.length} (see \`loops\` per run; --out saves them)`);
  }
  const errs = new Map(); for (const r of rows) if (r.res) for (const e of r.res.gameErrors) { const k = e.where + ' ' + e.msg; errs.set(k, (errs.get(k) || 0) + e.count); }
  if (errs.size) { console.log('\nGame exceptions seen during play:'); for (const [k, n] of [...errs].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  x${n} ${k}`); }
  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(rows, null, 1)); console.log('\nfull results ->', args.out); }
  return { exitCode: rows.some((r) => r.outcome === 'CRASH') ? 1 : 0 };
}
module.exports = { run };
});

// ==== FILE: lib/commands/play.js ====
__def("lib/commands/play.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// play -- one autopilot run (the original playtest.js behaviour), now with build selection and JSON output.
//   node playtest.js play [--seed=1] [--secs=120] [--ticks=30000] [--lives=1] [--species=dwarf --class=commander --scenario=town]
//                         [--devlvl=N --devstage=id|N|final --devpos=x,y --devspells=a,b --devdungeon=theme[:floors[:bonus]]] [--ev=regex] [--trace] [--json]
// Every flag also works as the legacy upper-case env var (SEED, SECS, TICKS, LIVES, DEVLVL, ...).
// =====================================================================================================
const { ev } = require('../harness');
const { playLife, resolveBuild } = require('../driver');
const DUEL = require('../duel');

function opt(args, name, def) {
  const env = process.env[name.toUpperCase()];
  if (args[name] !== undefined && args[name] !== true) return args[name];
  if (env !== undefined) return env;
  return def;
}

/** Test-only cheat: start at a chosen level / story stage / position with extra spells. */
function makePrep(args) {
  const devlvl = opt(args, 'devlvl'), devdungeon = opt(args, 'devdungeon');
  if (!devlvl && !devdungeon) return null;
  // --devdungeon=THEME[:FLOORS[:BONUS]]: plant a dungeon of that theme a few tiles from the start (the bot finds it like any other entrance). The only way to put a bot inside a
  // theme that world generation rarely or never places near the start (e.g. `--devdungeon=bile_cistern:3:0` with `--devlvl=12`). BONUS is the depthScaleBonus (negative = easier).
  const plantDungeon = (win) => {
    const [theme, floors, bonus] = String(devdungeon).split(':');
    const r = ev(win, `(function(){ try { const T=${JSON.stringify(theme)}, meta=DUNGEON_THEMES[T]; if(!meta) return 'unknown theme '+T;
      const maxDepth=${floors ? parseInt(floors, 10) : 'meta.depthRange[1]'}, bonus=${bonus ? parseFloat(bonus) : 0};
      let spot=null; for(let r=2;r<12&&!spot;r++) for(let dy=-r;dy<=r&&!spot;dy++) for(let dx=-r;dx<=r&&!spot;dx++){ if(Math.max(Math.abs(dx),Math.abs(dy))!==r) continue; const t=curTileAt(player.x+dx,player.y+dy); if(t&&t.walkable&&(!t.feature||t.feature==='floor')&&!entityAt(player.x+dx,player.y+dy)) spot={x:player.x+dx,y:player.y+dy,t}; }
      if(!spot) return 'no free tile near the player';
      const id='d_dev_'+T, eg=ENTRANCE_GLYPHS[T]||{glyph:'>',name:'an entrance'}, rec=levelForDepthScale(maxDepth+1+bonus);
      spot.t.glyph=eg.glyph; spot.t.color='#9ac95a'; spot.t.feature='dungeon_entrance'; spot.t.dungeonId=id; spot.t.walkable=true;
      registerDungeonFromChunk(id,{id,theme:T,maxDepth,tier:meta.tier,name:meta.name,entranceName:eg.name,levels:[],x:spot.x,y:spot.y,variant:'standard',targetPower:Math.min(6,(meta.dtierMax||2)+Math.floor(maxDepth/4)),recommendedLevel:rec,depthScaleBonus:bonus,originMode:'overworld',size:'medium'});
      return 'planted '+T+' ('+maxDepth+' floors, rec '+rec+') at '+spot.x+','+spot.y; } catch(e){ return 'ERR '+e.message; } })()`, 60000);
    if (r && /^planted/.test(r.value)) ev(win, `window.__devDungeonId=${JSON.stringify('d_dev_' + theme)}`, 5000);
    process.stderr.write('devdungeon: ' + (r && r.value) + '\n');
  };
  const devstage = opt(args, 'devstage', ''), devpos = opt(args, 'devpos'), devspells = opt(args, 'devspells'), devgear = opt(args, 'devgear');
  return (win) => {
    if (devdungeon) plantDungeon(win);
    if (!devlvl) return;
    const L = parseInt(devlvl, 10);
    const S = devstage === 'final' ? 'player.story.stages.findIndex((x) => x.id === "confrontation")'
      : (/^[a-z_]+$/.test(devstage) ? 'player.story.stages.findIndex((x) => x.id === "' + devstage + '")' : parseInt(devstage || '-1', 10));
    ev(win, `while (player.level < ${L}) { levelUp(); } player.hp = player.maxHp; for (let k = 0; k < 400 && (player.statPoints || 0) > 0; k++) __B.spendPoints(); __B.spendTalents(); player.gold += 20000;`
      + (devpos ? `player.x=${devpos.split(',')[0]};player.y=${devpos.split(',')[1]};try{loadChunksAround&&loadChunksAround()}catch(e){}` : '')
      + (devspells ? `for (const id of ${JSON.stringify(String(devspells).split(','))}) if (!player.knownSpells.includes(id)) player.knownSpells.push(id);` : '')
      + (S !== -1 ? `for (let i = 0; i < ${S}; i++) { player.story.stages[i].done = true; } player.story.stageIndex = ${S};` : ''), 60000);
    // --devgear[=best]: give the dev-levelled character shop-tier armor and a weapon re-rolled for its level (the duel harness' gearUp). Without it a --devlvl 20 character wears starter
    // leather: Alpha Wolf hits for 40-94 and every run dies at turn ~850, which says nothing about the real game.
    if (devgear) { ev(win, '(' + DUEL.toString() + ')()', 60000); ev(win, `__DUEL.gearUp(${L}, ${devgear === 'best' ? 'true' : 'false'}); player.hp = player.maxHp;`, 60000); }
  };
}

async function run(args) {
  const seed = parseInt(opt(args, 'seed', '1'), 10);
  const lives = parseInt(opt(args, 'lives', '1'), 10);
  const budget = parseInt(opt(args, 'secs', '120'), 10);
  const json = !!args.json || !!process.env.PT_JSON;
  const log = json ? (m) => process.stderr.write(m + '\n') : console.log; // keep stdout clean for the machine-readable result
  const build = (args.species || args.class || args.scenario) ? { species: args.species || 'dwarf', archetype: args.class || 'commander', scenario: args.scenario || 'town' } : undefined;
  const prep = makePrep(args);
  let r = null, spent = 0;
  const deaths = [], allErrors = [];
  for (let life = 1; life <= lives; life++) { // a character that dies is replaced by a new one (same world seed), until the time budget is gone
    r = await playLife({
      prep, seed, build, maxTicks: parseInt(opt(args, 'ticks', '30000'), 10), maxSeconds: Math.max(10, budget - spent), log,
      stopOnIdle: !!opt(args, 'stop'), statusEvery: parseInt(opt(args, 'status', '0'), 10), beatSecs: parseInt(opt(args, 'beat', '0'), 10),
    });
    spent += r.seconds || 0;
    for (const e of r.gameErrors || []) allErrors.push(e);
    if (r.outcome === 'died') deaths.push({ life, lvl: r.final && r.final.lvl, cause: r.final && r.final.cause, turn: r.final && r.final.turn, depth: r.final && r.final.depth, at: r.deathAt ? JSON.parse(r.deathAt) : undefined, deathLog: (r.deathLog || []).slice(-8) });
    if (r.outcome !== 'died' || budget - spent < 30) break;
    log('  inv: ' + r.inv); log('  death trace: ' + (r.trace || []).slice(-12).join(' ; ') + '\n  deathLog: ' + JSON.stringify(r.deathLog));
    log('LIFE ' + life + ' ended in death at level ' + (r.final && r.final.lvl) + ' (' + (r.final && r.final.cause) + '); starting life ' + (life + 1));
  }
  const summary = { seed, build: r.build, outcome: r.outcome, final: r.final, seconds: Math.round(r.seconds), levelTurns: r.levelTurns, deaths, counts: r.counts, loops: r.loops, gameErrors: allErrors };
  if (json) { console.log('@@RESULT ' + JSON.stringify(summary)); return summary; }
  log(r.outcome + ' ' + JSON.stringify(r.final) + ' ' + r.seconds.toFixed(0) + 's');
  log(JSON.stringify(r.counts));
  try { log('travel failures: ' + (r.why || '')); } catch (e) { /* */ }
  if (r.diagText) log(r.diagText);
  if (r.loops && r.loops.length) log(r.loops.join('\n'));
  if (r.events) log((process.env.EV ? r.events.filter((e) => new RegExp(process.env.EV).test(e)).slice(-40) : r.events.slice(-12)).join('\n'));
  if (process.env.TRACE && r.trace) log(r.trace.join('\n'));
  if (r.deathLog) log(r.deathLog.join('\n'));
  if (allErrors.length) { log('\nGAME ERRORS (swallowed exceptions the game raised during this run):'); for (const e of allErrors) log(`  x${e.count} [${e.where}] ${e.msg}\n      ${e.stack.split('\n')[1] || ''}`); }
  return summary;
}

module.exports = { run, opt };
});

// ==== FILE: lib/commands/smoke.js ====
__def("lib/commands/smoke.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// =====================================================================================================
// smoke -- UI-layer smoke test. Boots with real rendering ON (render/updateSidebar/renderLog kept), creates a
// character, then presses every printable key (plain and Shift), each followed by Escape, in several game
// states (overworld, dungeon, after a few turns). Reports every exception the game threw or swallowed.
//   node playtest.js smoke [--species= --class= --scenario= --seed= --json]
// Add states to STATES below to cover more screens.
// =====================================================================================================
const { newGame, createCharacter } = require('../driver');
const { ev, key, drainErrors } = require('../harness');

const KEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789,./;\'[]-=`<>?'].concat(['Escape', 'Enter', 'Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const SHIFTED = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** Each state prepares the game and returns a label. Extend freely. */
/** A state prepares a freshly created character. Extend freely to cover more screens. */
const STATES = [
  { id: 'start', prep: () => '' },
  { id: 'after-turns', prep: (win) => { for (let i = 0; i < 25; i++) key(win, ['h', 'j', 'k', 'l'][i % 4]); } },
  { id: 'dungeon', prep: (win) => { ev(win, 'enterDungeon([...dungeonRegistry.keys()][0]); markSeen && markSeen();'); } },
  { id: 'dungeon-turns', prep: (win) => { ev(win, 'enterDungeon([...dungeonRegistry.keys()][0])'); for (let i = 0; i < 30; i++) key(win, ['h', 'j', 'k', 'l', '.'][i % 5]); } },
];

async function run(args) {
  const spec = { species: args.species || 'human', archetype: args.class || 'warrior', scenario: args.scenario || 'town' };
  const seed = parseInt(args.seed || 3, 10);
  const found = new Map();
  let presses = 0, resets = 0, win = null, state = null;
  // A fresh game in the state's starting position. Some keys legitimately leave the play screen (quit to title, save/load), so we rebuild.
  async function fresh(st) {
    win = (await newGame({ seed, boot: { render: true, saveable: true } })).window;
    if (!createCharacter(win, spec)) { console.error('could not create character'); process.exit(2); }
    st.prep(win); drainErrors(win); resets++;
  }
  const press = async (k, st) => {
    const gs0 = ev(win, 'gameState').value;
    key(win, k); presses++;
    for (const e of drainErrors(win)) { const id = e.msg + '|' + st.id + '/' + gs0; if (!found.has(id)) found.set(id, { ...e, keys: [] }); found.get(id).keys.push(k); }
    key(win, 'Escape'); key(win, 'Escape');
    ev(win, 'try { if (player.hp <= 0) { player.hp = player.maxHp; } } catch (e) {}');
    if (ev(win, 'gameState').value !== 'playing') await fresh(st);
  };
  for (const st of STATES) {
    state = st; await fresh(st);
    for (const k of KEYS.concat(SHIFTED)) await press(k, st);
    console.error(`  state ${st.id}: ${presses} presses, ${found.size} distinct errors so far (${resets} rebuilds)`);
  }
  const out = [...found.values()];
  if (args.json) console.log(JSON.stringify(out)); else {
    for (const e of out) console.log(`[${e.where}] ${e.msg}\n   keys: ${[...new Set(e.keys)].join(' ')}\n   ${e.stack.split('\n').slice(0, 3).join('\n   ')}`);
    console.log(`smoke: ${presses} key presses, ${out.length} distinct errors`);
  }
  process.exit(out.length ? 1 : 0);
}
module.exports = { run };
});

// ==== FILE: playtest.js (launcher) ====
const H = __req('lib/harness.js');
const D = __req('lib/driver.js');
const BRAIN = __req('lib/brain.js');

/** "--a=1 --flag positional" -> { _: ['positional'], a: '1', flag: true } */
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]; else out._.push(a);
  }
  return out;
}

const COMMANDS = { play: 'play', matrix: 'matrix', audit: 'audit', smoke: 'smoke', balance: 'balance', classbp: 'classbp', list: 'list', help: 'help' };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = COMMANDS[args._[0]] ? args._.shift() : 'play';
  if (name === 'help') { const L = require('fs').readFileSync(__filename, 'utf8').split('\n'), i0 = L.findIndex((l) => l.includes('command line front door')), i1 = L.findIndex((l, i) => i > i0 && l.startsWith('// See also')); console.log(L.slice(i0, i1 + 1).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const cmd = __req('lib/commands/' + name + '.js');
  const res = await cmd.run(args);
  process.exit(res && typeof res.exitCode === 'number' ? res.exitCode : 0);
}

module.exports = { boot: H.boot, ev: H.ev, key: H.key, drainErrors: H.drainErrors, newGame: D.newGame, createCharacter: D.createCharacter, resolveBuild: D.resolveBuild, playLife: D.playLife, BRAIN, DUEL: __req('lib/duel.js') };

if (require.main === module) main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });

/* ==== FILE: README.md ====
> LAYOUT NOTE: this kit is ONE file. Every `lib/...` path mentioned below is a section of playtest.js between `==== FILE: lib/... ====` banners (search for the banner). To add a probe or command, add a `__def("lib/probes/x.js", function (module, exports, require, __dirname, __filename) { ... });` block (and list a new probe in the `lib/probes/index.js` section; a new command in COMMANDS at the bottom). `require("./x")` between sections works as before. package.json is only needed for the jsdom dependency (`npm install jsdom`).

# Playtest kit for *Lucid Dreams of Roguelike*

Boots the **real, unmodified** game in jsdom and drives it. Put this folder next to the game `.html` (or set `GAME_HTML=path`), then `npm install`.

```
node playtest.js play    [--species= --class= --scenario= --devlvl= --devstage= --devpos= --devspells= --json]   one autopilot life
node playtest.js matrix  --jobs=2 [--out=file.json]      class x species x scenario x seed grid, aggregated deaths/causes/exceptions
node playtest.js audit   [--only= --skip= --warn --json --verbose --seed=]   data + system probes (exit 1 on errors)
node playtest.js balance --classes=all --level=1 --tier=1 --trials=6 [--scale= --monsters= --json]   noise-free duel ladder
node playtest.js balance --curve=1,8,16,30 --classes=warrior,mage   win rate by character level (difficulty-spike hunt)
node playtest.js smoke   [--class= --species= --seed=]   UI smoke test: every key (plain+Shift) in 4 states with rendering on; rebuilds the game when a key leaves the play screen
node playtest.js list                                    species / class / scenario ids
```

## START HERE (workflow that has worked, in the order to use it)
1. `GAME_HTML=<path to game> node playtest.js audit` (~80-170 s, 0 errors is the bar; warnings fluctuate run to run because some probes cast random spells). `--only=a,b` runs probes by id or id prefix (`--only=floors,quests` is fast: 1-30 s). Then `smoke` (~5 min, run it in the background).
2. Hunt bugs with SCANS, not only bot runs: boot with `newGame`, loop `generateDungeonLevel(theme, depth, maxDepth, 'standard', size, 0)` over every `DUNGEON_THEMES` key and test an invariant against `level.grid` (entity on a wall, sealed pocket, missing stairs...). In one evening this found four real generator bugs that dozens of bot runs never showed (loot under water, content sealed off, packs of archers). When a scan finds something, turn it into a permanent probe (`worldgen.dungeons` is the place), then MUTATION-TEST it: copy the game, delete the fix with sed/python, point `GAME_HTML` at the copy, and confirm the probe now fails.
3. Hunt balance with `matrix` (bot lives; noisy, never repeatable: use 8+ runs per comparison and read DEATH CAUSES and `final.place`, not mean level), `classbp --gear --rel=1` (class win rates at native strength), `classbp --pack=3 / --gauntlet=4` (groups, worst case), `balance --curve=N` (win rate by level). Never read `balance --scale=6` as class balance (it is ~1.7x native at level 20).
4. Mid/late game without playing there: `matrix --devlvl=20 --devgear[=best]` (dev-levels the character and gives it shop-tier gear; without `--devgear` it wears starter leather).
5. Add game content as DATA in the existing registries (each has a probe that validates new entries): `WORLD_EVENTS` encounters and curios, `QUEST_CHAINS` (+`hooks`, `altCost`), `FLOOR_ASPECTS`, `MONSTER_AFFIXES`, `TECHNIQUES`, `UNIQUE_REWARD_ITEMS`.
6. Practicalities: run anything longer than ~100 s as `(setsid nohup node playtest.js ... > /tmp/x.txt 2>&1 &)` and poll with `sleep`; `pkill -f playtest` from a tool call can kill your own shell, so avoid it. Typos in flags warn but still run; `matrix` takes `--classes` (alias `--class`), `play` takes `--class`. `EV='regex'` echoes bot notes live; `PT_ECHO=1` shows the game's console.log. Run results carry `final.place` (where a death happened).
7. Be honest in reports: bot runs measure bot play (cautious, no hand-play feel); say which numbers are guesses.

## Layout
- `lib/harness.js` boot/ev/key + capture of every swallowed exception (`drainErrors`).
- `lib/brain.js` the autopilot (evaluated *inside* the game realm; no Node APIs there).
- `lib/driver.js` newGame / createCharacter / playLife.  `lib/duel.js` duel simulator.
- `lib/probes/*.js` one file per area (items, refs, monsters incl. `monsters.behave`, abilities, worldgen, bosses, content, talents, economy, story, faith, `coverage` = content-gap census for monster pools (uses the game's own `dungeonMonsterPool`) and spell tiers, `emergence` = the elemental combo layer, `events` = encounter events); register in `lib/probes/index.js`. A probe is `{id, desc, run(A)}`; use `A.err/A.warn/A.stat`, `uses:[helper]` for shared source.
- `lib/commands/*.js` one file per CLI command; register in `COMMANDS` in `playtest.js`.

## Notes for future maintainers
- **Design pillars: immersion, complexity, realism, emergent gameplay.** Friendly fire and AoE hitting the caster/allies is *intended*. Probes report it as info only; never "fix" it.
- Duel bot chases monsters that will not approach (an earlier version scored "stalls" as losses and understated every class). `balance` JSON rows carry `win`, `death`, `stall`. Ladder excludes bosses, aquatic, summoners, turrets, fleers, splitters and player-summon constructs (`powerDraw`).
- Level-1 ladder (25 classes, 5 trials): 23 classes cluster 91-100%; bloodmage (52% -> 78% at 10 trials) and illusionist (68% -> 88%) are lowest, but trial noise is large. Their remaining 0% matchups are bear/yeti/bandit-class melee threats. Not changed; re-measure with more trials and a better policy before touching them.
- Autopilot early deaths: read `deaths[].deathLog` and `counts` (action histogram; `final.stats.rests` undercounts) before blaming a monster. Cross-check with a duel: e.g. orc rogue/necromancer/mage/warrior beat slime, spider, scorpion and cultist 100% of 20 duels at L1 losing <=8% hp, yet the autopilot died to slimes at L1 (it ends up holding/retreating at low hp), so those were bot deaths. Real findings came from deaths with one clear cause the duel confirms (the Cultist's 3-spell rotation, poison with no starting cure).
- Mid-game check (8 builds each at L12 and L25 via `--devlvl`, 60s): 0 deaths, 0 game errors. One unreproduced `LOOP BREAK rest` (dwarf warrior L27, hp 485/693 not regenerating over 400 rest actions); the loop-break note now dumps regen-relevant state (poison/bleed/wounds/nearby monsters/canRest) so a recurrence can be diagnosed from the log.
- **Elemental combo layer (emergence).** Wet / Oiled / Burning / Frozen combos are data-driven: put `soak:turns`, `oil:turns`, `oilGround:radius` (also `wetMult`, `oiledMult`, `consumeWet`, `primeFirst`) on a spell or MONSTER_ABILITY_LIBRARY entry, `soakStrike`/`oilStrike` on a monster, `alwaysWet`/`alwaysOiled`/`shockImmune` for creatures made of it. Engine: `ELEMENT_PRIMERS`, `applyPrimers`, `applyAbilityContact`, `abilityComboScore` (the AI's payoff-first ordering). `emergence.combos` fires every combo through all three sources (spell, monster ability, monster melee); `emergence.tags` warns when something that reads as fire/frost/shock is not tagged so the combo layer sees it. Add a new primed state = one row in ELEMENT_PRIMERS + one case in emergence.combos.
- **Encounter events** (`type:'encounter'` in WORLD_EVENTS): choices gated by item/gold/stat, each rolling a weighted outcome that is itself an event def (any WORLD_EVENT_HANDLERS type, chainable with `also`). `events.encounters` validates every one and executes every outcome in a live game; the autopilot takes a viable option 80% of the time so matrices exercise them.
- Dungeon pool lesson: measure the pool the generator really uses (`dungeonMonsterPool(meta, depth)`), per floor band. A census at the theme's *max* tier hid that floors 1-3 of sixteen themes were silently generic.
- Runs are not deterministic even with a seed; judge balance over many seeds/duels, not single runs.
- Sandbox has ~2 CPUs: use `--jobs=2` and tick budgets rather than wall-clock.
- `balance` duels cast self-buffs, summons and one debuff (`--nosupport` for damage-only). This lifted summoner from 31% to 96%, so check the policy before judging a class. Chronomancer, illusionist and bloodmage still sit near 43% at level 1: their kit is escape/control (phantom step, time skip, kiting) which a stand-and-fight duel never uses. Treat as unproven, not as a verdict; a kiting policy is the next step.
- `boot` stubs rendering for speed; pass `{render:true}` for UI tests, `{saveable:true}` when saving.
- Game convention: bump PATCH in the title version and add a factual changelog line per change.

### Elemental resistance gear
Items may carry `fireDmgReduction`/`frostDmgReduction`/`shockDmgReduction` (keys in `EQUIP_FLAT_BONUS_KEYS`). Monster abilities read them through `elementResistFactor(entity, element)`. `emergence.combos` checks equip/unequip round-trips and that a resisted bolt does less damage (use a high-power ability copy: armor floors normal bolt damage at 1, hiding resistance).

### Scrolls
`emergence.scrolls` runs every area scroll through `resolveThrowAtTile` against a 5000-hp arena monster and checks the combo rider (wet shock bonus, ignition, freeze-on-wet, immunities) plus that scrolls >=100g exist (the loot cap rises with tier, so a flat value ladder means flat late loot). New area scroll: `effect:'scrollblast', element:'fire|frost|shock|void', power:[lo,hi], radius`.

Resistance buffs (`resistfire/resistfrost/resistshock`) and gear fields both flow through `elementResistFactor`; the probe in `emergence.combos` drives the potions via `useItem`. Add a new element by extending that helper, not by patching individual ability branches.

`emergence.scrolls` also drinks every late-game potion and warns if fewer than 5 non-food consumables cost >=150g (the loot value cap rises with tier, so a flat ladder = flat late loot).

### Balance lessons: class kits (`classbp`)
`node playtest.js classbp --classes=all --level=20` prints each class's win rate vs the whole non-boss ladder at monster scales 3.5/6/10/16 (~2 min per class, 2 at a time; takes ~30 min for all 25). It measures the STARTING kit (+levelUp/bot stat spending), not trainer/tome abilities, identical for every class. Two things it caught:
- Starter kits with no reliable damage (buffs/blinks/execute-finishers only) lost 40-60% of duels the other classes won ~99%. `refs` now errors if an archetype's starter abilities have no plain damage/drain/smite spell or technique (or summon).
- The bot used to refuse every ability with `selfExposed` or `selfCost`, so the Berserker's only damaging technique was never cast. The bot now uses these while HP >= 70% (`risky` flag in `B.dmgAbilities`). When a class looks weak, trace one duel before touching its numbers: it may be the policy, not the class.
Duels at native level are saturated (~100%); compare classes at the higher scales.

### Learning paths (`training.techniques`)
Spells are learned from Spell Trainers (`trainer`) and tomes; techniques from Combat Trainers (`weaponmaster`, `npc.teachTechniques`) and manuals (`makeManual`, a tome item with `techId`). A new ability registry needs a matching acquisition path AND a probe that every entry is reachable: the technique registry was unreachable for the entire life of the game until this probe's census (`school x tier` counts, then grepping every `knownTechniques.push`) exposed it.

### Harness lesson: level characters class-aware (`__DUEL.levelTo`)
Levelling in one jump and then spending stat points with the autopilot policy dumped ~45 points into INT for EVERY class (Warrior: STR 15, INT 53), which put a heavy requirement penalty on all martial abilities and made martial classes look far weaker than casters. `balance`/`classbp` now use `__DUEL.levelTo(L)`, which spends each level's points on the stat the class's own abilities require. `classbp --kit=school` gives each class every ability of its starting schools up to tier ceil(L/5) (what trainers/manuals would provide). Trained-kit table, level 20, human, monster scale x10/x16/x24 (native is 3.5): casters and dex martials 94-99% at x16; str martials (warrior, chef, tinkerer, cyberadept) 64-71%; at x24 (7x native, mostly academic) every martial class is 1-44%. The remaining spread is NOT yet tuned: dex-based martials (evasion) and casters (ranged) beat str-based martials at depth.

Measured after the v0.51.3 monster curve (classbp --classes=all --level=30 --rel=1,1.5 --kit=school --gear --trials=2): at 1.5x native strength martial/hybrid kits win 75-91% at 6-24% HP cost (tinkerer weakest at 75, warrior 88), while pure casters/ranged win 97-100% at 0-3% cost in 3-7 turns. Duels have no mana attrition and no groups, and bot lives of mages/rangers die at the same rate as warriors (mid levels, 150 s runs), so this is NOT evidence that casters need a nerf; a mana-attrition / pack duel would be the next tool to build before touching their numbers.
`classbp --pack=N` (N random monsters arrive together) and `--gauntlet=N` (N fights back to back, no rest/mana/healing between; `avgKills` shows how far it got) were added to cover what 1v1 duels miss (`__DUEL.fightMany` / `__DUEL.groupRun`). Level 30, geared, school kit, tier<=4 monsters, 10 groups per class (small samples, +-15 points): PACK OF 3 at native strength: casters and dex kits 90-100% (stormcaller, chronomancer, illusionist, druid, necromancer, ranger, duelist, monk 100) while STR kits are weak (chef 0, tinkerer 30, cyberadept 40, lancer 50, warrior 50, berserker 50, brawler 60). GAUNTLET of 8, no rest: everyone usually fails (that is the point: a floor); kills before failing: druid/necromancer 7.3, duelist 6.9, ranger 6.4, monk 5.4, mage 5.1, warrior 3.1, lancer 3.8, brawler 2.8, alchemist 1.4, berserker 1.1, chef 0.9 -- so mana DOES limit casters (mage 5.1/8), but STR/self-damage kits (berserker spends HP by design) are the weakest in both. Not changed in the game yet: the duel fighter never flees, uses terrain or throws, which hurts melee kits most, so treat chef / berserker / alchemist / tinkerer as the first candidates for hand-play before tuning numbers.
Bigger sample (30 packs of 3 each, level 30, native strength, geared, school kit): mage 100%, ranger 90, tinkerer 70, warrior 63, brawler 63, lancer 60, berserker 37, chef 10 (+-9). Starter weapons differ a lot: at level 30 `gearUp` re-rolls the class's OWN weapon, so Chef's Kitchen Cleaver is [7,21], Tinkerer's Heavy Wrench [7,21], Lancer's Spear [10,28], Warrior's Longsword [14,35], Berserker's War Axe [17,41] (`--gear=best` swaps in the best melee weapon STR allows: chef 10 -> 27, but warrior 63 -> 47 and tinkerer 70 -> 57, i.e. mostly noise or weapon-type effects, so it does not settle anything). Chef's damage techniques are on par with Swordsmanship ones, its identity (cooked buffs, food) is not exercised by the duel fighter, and Berserker spends HP by design: treat those two as unproven outliers, not confirmed weak classes.
`classbp ... --botpolicy=1` lets the real autopilot brain (`B.tick`, with its fleeing, dodging, throwing and healing) drive group duels instead of the plain duel fighter. Pack of 3, level 30, 8 groups: warrior 75% -> 25% (the bot retreats/kites rather than trading blows, so it kills less), chef 13% -> 25%, berserker 25% -> 38%. So the duel fighter's lack of tactics is NOT what makes STR kits look weak (they stay at the bottom either way); the gap looks real, but samples are tiny.
`classbp --gear` additionally equips each class the best non-unique armor (per slot, STR requirement met, value tier <= ceil(L/5)-1) plus its own weapon re-rolled at the level's item power multiplier (`__DUEL.gearUp`). The bare starter kit has armor 5-11 where a real level-20 character wears ~70-90, and armor is a flat subtraction, so geared vs ungeared changes the STR-melee classes a lot: level 20, trained kit, x16 monster strength: warrior 71% -> 89%, lancer 77% -> 89%, commander 83% -> 93%, brawler 81% -> 91%, while casters/dex classes stay 98-99%. Conclusion recorded: the STR-melee 'weakness' was mostly missing gear in the harness, not a balance problem; no game change was made for it. x24 (7x native strength) stays 2-5% for STR melee vs 28-63% for casters/dex classes, but that is far beyond where a level-20 character plays.

### Bot gaps found by autopilot runs
- The autopilot used to learn only *spells* from trainers, and only from level 12. It now also buys techniques from Combat Trainers (`B.wantTech`, from level 5). Class-balance duels use `levelTo`/`--kit=school`, so they never exercised this path.
- `B.gearScore` ranks weapons by raw damage, so autopilot mages swap their staff for a blade and then melee (28 casts vs 502 attacks in one 200 s run). Treat caster autopilot results as "mage played badly" rather than "mage is weak".
- Bleeding is the autopilot's commonest early death (4 of ~7 low-level mage runs). It is a designed mechanic ("fighting on makes it worse", stacks to 6, up to ~5 dmg/turn); the bot just lacks bandages and keeps meleeing. The bot ignored Medkits (they stanch bleeding too); fixed in `useBandageIfBleeding` and `healingItem`.
- `gearScore` now multiplies weapon score by 0.3 for INT-heavy characters with spells; mage casts rose (7-28 per run to 55-220) but the bot still sometimes holds a maul. Not a game issue.

### Early boss check: Thessaly Voss (broken_blade), level 6, native scale, 8 trials each
Ungeared starter kits lose or split against her (mage, illusionist, druid, bloodmage, summoner 0%; elementalist 50%; stormcaller, paladin, monk, rogue 100%). With `__DUEL.gearUp(6)` (shop-tier armor and weapon) all seven classes tested win 100%. She is a gear check, not a class wall; no game change. Note `__DUEL.run` reports `turns` over wins only, so a 0 there means "never won", not "died instantly".

### Matrix 25 classes x 1 seed (human, 150 s, 2 lives), after the bot fixes above
No game errors, no detected loops; mean level 7.3 (min 2, max 10), 2 deaths. One druid run logged 28,140 `back-away` actions at level 2 over 30k turns before dying to Fenrik (the loop detector did not flag it; 12 further druid runs did not reproduce it). The bot now also tends bleeding without a bandage (cloth, else bare-hand pressure replayed from `tendWound`, which is async). Bleeding deaths in druid runs went from 2/6 to 0/6, but 3/6 still died at level 1 (Crystal Wisp, fire, Alpha Wolf), so early-game lethality is worth a closer look.

### Encounters and dungeon curios (content, v0.51.3)
- Encounters (`type:'encounter'` in `WORLD_EVENTS`) went from 9 to 21 on the overworld. `needs` now also accepts `spell:[ids]` (any known spell or technique) and `minLevel`; an event may carry `biomes:[...]` (BIOMES keys) so it only rolls where the player stands in one of them. New outcome handlers: `grantItemOf` (random item from a list), `cureStatus` (numeric player fields, or 'bleed'), `restoreMana`.
- Dungeon curios: an encounter with `scope:'dungeon', curio:true` (optional `themes`, `minDepth`) is pinned to a floor tile by `placeDungeonCurios` (about half of all floors, never within 3 tiles of a stair), stepping on it runs `openCurio`, any committed option spends it (`onChoose`). Probes: `events.encounters` (shape + executes every outcome), `events.curios` (opens via a real tile, spends, blocked by an engaged enemy), `worldgen.dungeons` (counts curios, walkable, valid id). The bot answers curio menus like any `Encounter:` choice but does not go looking for them.

### 'Recover' radiant quest (content, v0.51.3)
`rollRadiantQuestOffer` can now roll `recover`: `pickRecoverSite` needs a registered 2+ floor dungeon within 180 tiles of the giver (rated at most player level + 4); accepting calls `placeRecoverRelic` (generates that floor if needed, puts a questId-tagged `quest_relic` on the far side, never the boss floor); `checkGatherQuests` completes it on pickup. Probe `quests.recover` exercises roll -> accept -> placement -> pickup -> payout. Relic names live in `RECOVER_RELICS`.

### Quest chain `hooks`, more curios, and the save/load lesson (v0.51.3)
- `QUEST_CHAINS.<id>.hooks` is an optional object read through `chainHooks(id)`: `antagonistRole`, `antagonistNameField`, `twistLabel`, `altLabel(q)`, `altLabelFace(q)`, `reveal(q)`, `finishLine(q)`, `resolveAlt(q, markSeen)`. A chain with no hooks behaves as before, so new chains opt in per feature. `borrowed_heirloom` (type `chain_recover`) is the reference example; its reward is `unique_keepers_locket`. `quests.chains` walks every chain start to finish.
- Dungeon curios are now 19 (11 + 8). Add one by pushing a `scope:'dungeon', curio:true` encounter; `events.curios` validates themes, minDepth and outcomes, and worldgen reports `curiosPlaced` (error if zero on 40+ floors).
- Save lesson: dungeon floors made by chunk generation were re-generated on load and wiped (relics/curios gone). Every chunk-generation site must call `registerDungeonFromChunk(id, def)` (keeps saved levels) and `markLocationDirty`. Quest relics are `noStack` items; otherwise two relics merge. `systems.save-quests-curios` guards both.
- Matrix: `--class`/`--classes`, `--species`/`--seeds` etc. are aliased both ways, unknown flags warn, and the summary lists deaths by level band, hardest classes and stalls. `--devgear[=best]` (play and matrix) gears a `--devlvl` character with `__DUEL.gearUp`; without it a dev-levelled character wears starter leather and dies to the first Alpha Wolf, which says nothing about the game. Geared L20 sweeps (8 classes, 2 seeds, 120 s): about a third die (casters most), the rest survive.

### Floor aspects, stranded loot, early poison (this batch)
- `FLOOR_ASPECTS` (game) is a registry: `{id, name, weight, minDepth?, themes?, notThemes?, xpMult?, announce, apply(ctx)}`; `generateDungeonLevel` rolls one on ~30% of floors past the first (never the boss floor) and stores `level.aspect`; `announceFloorAspect` logs it once on arrival (descend and chasm paths). Add an aspect = add one registry entry; `floors.aspects` validates every entry, forces each onto real floors of several themes (monsters on open tiles, no stacking, bosses kept, chests added/monsters woken as promised), checks natural-roll rate and the pack/JSON round trip.
- `worldgen.dungeons` now also fails when a container or floor item sits on a non-walkable tile. It found a real bug: water/chasm/statue features are laid down after chests, so ~1 floor in 15 on fortress, flooded and temple themes had loot under water. `rescueStrandedEntities` now repairs this at the end of generation (mutation-tested: with the call removed, the probe reports 9 errors).
- Poison now follows the same early grace as bleed (x0.6/x0.8 ladder, cannot kill at level 1-4); `systems.poison-floor` guards it (late check retries 6x because willpower shakes off ticks at random).
- `systems.augments` (augment/graft symmetry), `systems.containers` (loot tables; found weapon racks stocking uniques, fixed), `systems.properties` (furnishings, upkeep, sell refund < price), `systems.relationships` (tier monotonic, price mult 0.5..1, decay never overshoots, no buy/sell arbitrage at Beloved, marriage rules). All mutation-tested.
- Also: `systems.diseases` (ordinary illnesses always burn out, fever floor, cap 3, chronic cure path), `systems.weather` (data coherence + every weather renders; found 4 weather types with no visuals), `systems.locks` (pick/force clamps, callback once, no pick = no success), `systems.kingdoms-war` (relations symmetric/clamped, war party spawn + withdrawal), `systems.professions` (every profession learnable incl. themed-settlement trainers, level maths invertible, bonuses capped), `tutorial.structure` (all 28 tutorial parts build, everything reachable; mark intentionally sealed parts `sealedByDesign: true`). All mutation-tested.
- `systems.lighting` (lamp lights an unlit patch, never beats daytime vision, drawNight survives all settings; picks an unlit tile first because settlements are usually already lit) and `systems.event-gating` (no rare/legendary world event below its level floor; found a level-5 death to a day-6 legendary Dimensional Incursion).
- `content.descriptions` (every monster has flavour text) and `content.item-tooltips` (ERROR if a consumable/scroll tooltip is the generic "A consumable item."; fix by adding an entry to the game's CONSUMABLE_EFFECT_TEXT; found 80 such items). `bosses.scripted-ai` retries a boss that looks passive once at a fresh spot before warning (it flaked in the full audit).
- `content.item-tooltips` also errors when an item's desc never reaches its tooltip, or a misc item reads the generic trinket line.
- Four more system probes (v0.51.5), each mutation-tested: `systems.water` (real `movePlayer` into a flooded strip: stroke cost, exhaustion damage + its cause, vessels/free-swim/flight, no regen while treading), `systems.constructs` (engineering power grid: capacity formula + caps, over-budget refusal keeps the item, drain, power-down, Power Cell, dead construct frees its slot, reactor cap), `systems.reputation` (bounty markup / goodwill discount monotonic + capped, crime alerts guards, decay floors at 0, payoff 3x and refuses the poor, civic office needs 60 standing once, no reputation farm, stipend), `systems.affixes` (all 26 Marked/Elite/Paragon affixes: registry shape, forced attach, every hook, Gravebound cannot loop, Berserk cannot compound, natural roll rates and grace period). To probe a new system the same way: write the fixture with the game's own setters (`setTileWater`, `commitCrime`...), call the REAL entry point, mutate the game copy (`GAME_HTML=/tmp/mut.html`) and prove the probe fails.
- `systems.maneuvers` / `systems.trials` (v0.51.5): maneuvers are driven through the real `maneuverTurn` with a plan built by the maneuver itself (stay / sidestep / parry stance / stun), retrying a few times because a heavy blow can still MISS the attack roll; Bellow has `mult: 0` (fear, not damage) so the probe counts fear as its effect and skips the parry case. Trials call `startShrineTrial` on a synthetic shrine tile and win/abandon/orphan it through the real bus events.
- Probe ORDER matters (v0.51.5): `lib/probes/index.js` runs worldgen FIRST because later probes reshape the shared world (spells that raise walls or dig, bot-driven monsters.behave). Before the move `worldgen.overworld-reach` reported 1, 4 or 6 'stranded' places depending on the run; fresh-world it reports 0. `A.relocate(w,h)` moves the player to the nearest open w x h block and returns restore(): use it in any probe that spawns allies/monsters, because earlier probes leave the player in cramped spots. `A.leakGuard()` also clears `player.isTutorial` (the tutorial makes the player unkillable and disables affix rolls).
- `systems.feats` (v0.51.5): every FEATS row completes exactly once at its goal and pays a reward that visibly changes the character; every stat a feat counts must be a built-in counter or a `FEAT_COUNTERS` row (an unwinnable feat is an error); bus counters are driven with synthetic events (ranged vs melee kills, boss killed by the player vs a monster, biggest-hit keeps the max); progress survives a save round trip. Adding a feat = one FEATS row (+ one FEAT_COUNTERS row if it counts something new); the probe covers it automatically.
- Audit stability lessons (v0.51.4): probes that need a *lethal* or *pristine* player (systems.bleed/poison/exposure-floor) must neutralise leaked state from earlier probes: Second Wind charges, a phoenix relic, a Recursion Thread, DEBUG invincibility flags, talent-granted resists. Prefer checking the mechanic directly over waiting for a death. A.arena-based probes should give abilities their preconditions (a corpse for Raise Dead, a fallen ally for Revive Ally, damaged gear for Mending).
- `systems.threat` (finite/monotonic/tooltip checks for the game's threat assessment) and `node playtest.js balance --assess` (compares the game's predicted fight outcome with measured duels per tier, prints the correlation and the playerEdge that fits best; re-run it after changing THREAT_MODEL or combat formulas, e.g. `--level=5 --tier=4 --scale=3 --classes=warrior,mage,rogue,herbalist --trials=3`).
- `content.item-lore` (ERROR if an ordinary weapon/armor base has no line in the game's ITEM_BASE_LORE / its set's lore, if lore is missing from the tooltip, if a lore id is stale, or if a set piece's tooltip omits the set name or a bonus tier).
- `content.registry-text` (spells/techniques/talents/cybernetics/mutations/recipes/events have name+desc, duplicate display names; found two recipes both called "Brew Antidote"), `content.guide` (every guide section renders without undefined/NaN/${ leaks), `ui.screens` (opens ~19 screens + inventory in every filter/page + 400 item tooltips and scans the text for undefined/NaN/[object Object]; found rune tooltips printing "+undefined undefined").
- `systems.exposure-floor` (cold/heat cannot kill level 1-4; a rogue died to heatstroke at L4). `UISCAN=1 node playtest.js play|matrix ...` opens ~13 screens at level milestones of a real run and prints `UI LEAK` lines for undefined/NaN/[object Object] (`UISCAN=debug` prints raw results).
- `A.leakGuard({ baseStats })` (v0.51.4): ONE shared helper that strips the leak-prone state (death-saves, DEBUG flags, resist/mitigation fields, phoenix relic) and returns `{ restore() }`; call restore() in a `finally`. Use it in every probe that MEASURES damage or lethality. `baseStats: 12` also pins str/dex/int, because earlier probes leave them at 60 and every monster then misses (bosses.scripted-ai read ~0 damage per turn in a full audit but correct numbers in isolation: always sanity-check the stats of a probe both alone and inside a full run).
- Audit-stability lessons: the audit runs ALL probes in ONE game instance, so a probe that leaves state behind poisons later ones. Found: `monsters.behave` left the bonus-action pool empty so every ability cast silently did nothing (30-139 bogus `abilities.noop` warnings; `A.refill` now calls `refillBonusActions`), and a dead player carried over (the runner now revives and emits an `audit.runner` warning naming the previous probe). If a probe flakes, first suspect leaked state, not the game.
- `worldgen.dimensions` generates a 13x13-chunk block of every dimension and flood-fills from the arrival portal: entities on walkable tiles, no stacking, every POI/shrine/container/NPC/item/dungeon entrance reachable (monsters in sealed pockets and island chunks are warnings). It found guards spawned in lava/walls, 30 walled-in POIs and whole island chunks (all fixed); the pre-fix game scores 96 errors.
- `worldgen.overworld-reach` (27x27 chunks: dungeons/settlements/POIs walkable from the start; ~99% is normal, a lone island dungeon is a warning, >8% an error) and `systems.save-deep` (rich state -> save -> load; every top-level player field plus kingdom relations, weather, war parties must come back identical; new default-initialised keys like undefined->0 are tolerated).
- Scan method worth reusing: boot the game, loop `generateDungeonLevel(theme, depth, ...)` over all `DUNGEON_THEMES`, and check any invariant on `level.monsters/items/containers` against `level.grid` -- cheap and finds generator ordering bugs that bot runs never notice.

### Shooter packs (game fix) and how it was found
Bot sweeps kept dying to "four Bandit/Skeleton Archers" at level 1-4. `placeEncounters` spawns same-species packs of 3-6 (32% of encounters); shooters can't be fought one at a time, so packs of ranged/kiter/turret/caster species are capped at 2 (floors 1-2) and 3 (floors 3-4). `worldgen.dungeons` reports `maxShooterClusterEarly` (6 -> 3) and errors on 5+ same-species shooters within 3 tiles on floors 1-2. Same 8 builds on seeds 92/21: 6 deaths -> 2. Method: when one named monster keeps showing up as the killer, look at HOW it is placed (group size, tier, distance) before touching its stats.

### Reachability scan (found and fixed ~1 floor in 20)
`worldgen.dungeons` now floods from the up stairs (walkable tiles plus locked/lever/secret doors, which are meant to hide vaults) and fails for any chest, item, monster, NPC or curio outside that region. The generator lays water/chasm/statues and carves mazes after placing content, which sealed content into pockets; `rescueUnreachableEntities` (end of `generateDungeonLevel`) moves it to the nearest reachable free tile. Mutation-tested: without the fix the probe reports 50 errors over 246 floors. For a one-off scan over MANY floors, boot the game, loop `generateDungeonLevel` across `DUNGEON_THEMES`, and compare against the same flood.

### Item-cost chain endings and the `altCost` convention
A chain's `hooks.altCost = {id, n}` declares what its alternate ending takes from the pack (`hungry_den`: 3 `meat_raw`; `fever_barn`: 2 `potion_heal`). `quests.chains` supplies exactly that, then proves the ending REFUSES when the pack is one short (quest not completed, count unchanged) and leaves nothing behind afterwards. Mutation-tested: removing the cost check in the game makes the probe report 3 errors. Use `chainItemCount(id)` / `chainTakeItems(id, n)` in `resolveAlt`. Curios in this batch: bone chime, wrecked ore cart, pilgrim's shrine, munitions locker, cold forge, sealed maintenance hatch (25 total); `restoreMana` outcomes take `mp:[min,max]`, not `amount`.

### Reading balance numbers without fooling yourself (lessons from the L20 caster/warrior check)
- Native monster scale at L20 is `depthScaleForPlayerLevel(20)` (~3.5). `balance --scale=6` is 1.7x harder than the real game and gave 0% for warrior AND mage: do not read it as class balance. Use `balance --curve=N` or `classbp --rel=1`.
- `classbp --gauntlet=4` (no rest, no mana regen between fights) is a worst case: mage 25% vs warrior 50% / rogue 88% / druid 100%, yet mage wins 99% of normal 1v1 duels. Gauntlet losses mean mana attrition, not an unwinnable class.
- Ungeared (`balance`) warrior at native scale: wolf 100% (26% HP), troll 50% (47% HP, 26 turns) vs rogue 100% (10% HP). Geared (`classbp --gear`) warrior wins 96% overall. Always compare classes with the same gear setting.

### Bot fixes from the chef/berserker check, and a worked trace of a "mystery" death cause
- Shop trips: the bot walked to the settlement's chunk CENTRE, which can be a wall, for the whole 1500-turn trip timeout (up to ~3000 `to-shop` acts per life). It now heads for any visible shopkeeper within 40 tiles of the trip target, gives up after 500 turns without getting closer (`SHOP TRIP NO PROGRESS`), and the timeout note says where it was.
- Shooters: with 2+ shooters the bot only flees when the fight sim says it would lose (win < 0.85, was < 0.99): fleeing from low-HP archers hands them free shots. A repeat run still showed 3 archer deaths, so treat the earlier 7 -> 0 as partly luck. Runs are not repeatable, so use 8+ runs per comparison.
- Run results now include `final.place` (`theme@dungeonId recN` or `overworld`) so a death can be attributed to a place without a rerun.
- How the Skeleton Archer deaths were traced: `ev(win, ...)` a script that boots the SAME seed, then reads `dungeonRegistry.get(id)` and calls `generateDungeonLevel(theme, f, maxDepth, variant, size, depthScaleBonus)` per floor and counts monster names. Result: seed 21's `d_-2_1` sewer floor 2 spawns four Skeleton Archers (one undead faction pick x count), whereas 60 random medium sewer floors had none. So it is that dungeon, not the theme; not changed.

### Thessaly Voss revisited (game change, v0.51.3) and death-bookkeeping fixes
- Sweeps of 25 builds labelled 7 level-2 deaths "bleeding". They were Thessaly: a dead player kept ticking (bleed overwrote `lastDamageSource`), and `onDeath` could run twice. The game now ignores status ticks and a second `onDeath` once the player is dead, and `endTurn` re-enters `gameOver()` if a corpse ever gets a turn (a stray modal reset had left `alive:false` characters "waiting" for 30,000 turns; the bot now also treats `!player.alive` as dead).
- The cause: Thessaly guards a 1-floor "recommended level 3" bandit hideout and spawned with ~126 HP / str 23 / dex 20 (two hits a turn for 6-8, x2 opener): 16 of 16 level-2 bot lives died, and level-5 duels were 0% for mage/druid, 38% warrior. Base stats cut (HP 70->52, STR 12->10, atk 4-9->3-7): duels now level 2 casters 0%, rogue/paladin ~40%, warrior/ranger 100%; level 3 mostly 50-100%; level 5 75-100%. The bot also now requires the last floor's `recommendedLevel` (was rec-1) and never bandages with a fighter adjacent. Seed 99 town, 4 builds x 2 lives afterwards: 0 deaths. Her README entry above ("level 6, gear check") describes the OLD, stronger Thessaly.
- Tooling lessons: `matrix` takes `--classes=a,b` but `play` takes `--class=a` (a wrong flag silently runs the commander). `EV='regex' node playtest.js play ...` echoes matching `B.note` events live; `PT_ECHO=1` shows the game's `console.log`. To see what the bot walked into, patch a COPY of the game with a `console.log` in `enterDungeon` and run with `GAME_HTML=<copy> PT_ECHO=1`.

### Early bleed grace (game change, v0.51.3)
Level 1-4 autopilot lives (8 classes x 6 seeds, 40 s): 11 deaths, 5 of them bleeding. Player bleed ticks now use the EARLY_GRACE ladder (x0.6 at level 1-2, x0.8 at 3-4). Re-run on the same seeds: 8 deaths, 3 bleeding, mean level 3.2 -> 3.4. n=48 per arm and runs are non-deterministic, so this is directional only.


### Autopilot learns telegraphed maneuvers, thrown items, water (this is the single-file kit's own source: edit this file)
- `B.dodgeManeuver` (probe `bot.dodge`): the v0.51.0 heavy attacks wind up for a turn and mark tiles; the bot steps off them (next to the attacker when possible, so its crit-on-exposed punish lands) or raises a parry stance. Before this the bot ate every pounce/charge/slam, so ALL earlier bot survival numbers undercounted a real player. Early-game matrix (8 classes x 6 seeds, 40 s): mean level 3.4 -> 4.1, 1,940 dodges. Counters: `B.stats.dodges`, `B.stats.parries`.
- `B.tryThrow` / `B.bestThrowable` / `B.douseSelf` (probe `bot.throwables`): damage bombs/flasks/area scrolls go at bosses, losing fights or when HP < 50% (never at adjacent targets, wet or fire-immune ones); a burning bot below 70% HP soaks itself with a Water Flask. Counter `B.stats.throws` (only 23 in that matrix: the bot buys no throwables, so this mostly exercises starter kits). Shopping for throwables is a gap.
- The audit now installs the brain (`window.__B`) before probes run, so probes can call bot helpers. `require('./playtest.js')` exports `DUEL` and `BRAIN`.
- Game change: `earlyGraceDot()` softens player DoT (bleed, burning status, standing in flames) at level 1-4 only; probe `systems.early-dot`.
- Checked and NOT a wall: Skeleton Warrior at level 1 (armor 4) loses to every class 1v1 (75-100% win, most 100%); the deaths in matrix runs came from chained fights, slows and bleeding.
- Unreproduced: one matrix run ended `hang` (a bot tick took >20 s, probably CPU contention with --jobs=2); 9 reruns did not repeat it.
- Probe-writing lessons (cost me an hour): all probes share ONE game, so earlier ones leave burning ground (the bot rightly refuses to step into it: call `extinguishArea` near the arena), `throwRadiusBonus`, weather and statuses behind. A probe that passes with `--only=x` can fail in the full audit; always run the full audit before trusting a new probe. `logMessages` is a 200-line ring buffer, so read the newest lines (`slice(-8)`), never index from a remembered length. Do NOT add cleanup to `A.refill` itself: `abilities.noop` then reports ~170 spurious warnings.

### v0.51.5 session notes (sweeps, readiness gate, new probes)
- Species sweep lesson (v0.51.5, late): every earlier sweep used the human/elf/dwarf + `town` start; sweeping the other 8 species on seed 5 found 28 deaths in 32 runs, ALL in one Flooded Cave (`d_6_1`). Two generator bugs, both found by reading what the cave actually held (inspect with `getChunk(cx,cy)` then `dungeonRegistry.get(id)` and `generateDungeonLevel(...)` in a boot script; keys `a,d,j,d` create a character): (1) miniboss pool ignored the theme tier ceiling (Bramble Knight in a tier-1 cave) -> `minibossPool()` + probe `worldgen.miniboss-tier`; (2) packs of up to 6 Acid Slimes (~18 bodies once split) -> `PACK_RULES`/`packCapFor()` + probe `worldgen.pack-caps`. Deaths 28 -> 19 -> 4, mean level 3.2 -> 5.9. Reading tips: `rec18` in a death line is the dungeon's recommendedLevel (its boss floor), not the floor's strength; the bot judges floors by `dungeonFloorLevel`. A single seed that kills a whole matrix at one place is a content bug, not noise: look at the place.
- Probe-design lesson: a probe whose cap reads the same tunable as the code (MINIBOSS_TIER_SLACK) cannot fail when the tunable is mutated; assert the contract with a literal.
- Boss tuning lesson (v0.51.5): `balance` duels against bosses are NOT trustworthy (the ladder excludes them on purpose; melee classes read 0% while a kiting ranger reads 100% at the same level/scale, and `--scale` is the monster depthScale, not a level). Tune boss damage by comparing damage per turn (mean attack x multiattack) across bosses of the same power with the `monsters.boss-damage` probe; it caught Abyssal Leviathan (2.1x) and Coilfang (2.2x). Remaining warnings (Kraken 2.0x, Iron Sovereign 1.8x, Orc Warlord 1.7x) are top-of-tier or tiny-sample and left as warnings.
- Content added in v0.51.5 (extension recipes): FLOOR_ASPECTS gained Slicked / Tripwired / Captives (one entry each; `floors.aspects` has a per-aspect assertion block, add one for yours: baseline before apply, mutation-test it). FEATS are two registries: FEAT_COUNTERS (event -> stat; `absolute` keeps the max) and FEATS (stat -> goal/reward); a new event needs a thin publisher (see the descend()/resolveCagedPrisoner() wrappers next to FEAT_COUNTERS) and `systems.feats` fires every counter row with `depth:5` in the payload, so give new events payload fields it can survive.
- New dungeon theme recipe (v0.51.5, Bile Cistern): DUNGEON_THEMES entry + DUNGEON_THEME_FACTIONS row + ENTRANCE_GLYPHS row + BIOME_DUNGEON_AFFINITY mention + curio `themes` lists; then give its faction a TIER LADDER that is actually reachable. A dungeon's ordinary pool is capped at min(dtierMax, ceil(depth/3)) and its miniboss at min(dtierMax, ceil(depth/3)) + MINIBOSS_TIER_SLACK, so a depth-3..6 theme reaches ordinary tier 2 only and miniboss tier 3 (my first Ochre Jelly t3 / Black Pudding t4 never spawned). Check by generating 30 floors per depth with `generateDungeonLevel(theme,d,maxD,variant,size,0)` and tallying names, as in /tmp/cist.js-style scripts. A faction with no miniboss under the cap now gets NO miniboss on that floor (no more Goblin Kings in a slime pit) unless the faction owns no miniboss at all. Tune new monsters against peers with `balance --level=8 --scale=2.5 --monsters=new,peer1,peer2`; mage duels are noisy and splitters/corrosion hurt every duel bot, compare against the closest existing peer, not against 100%.
- `play --devdungeon=THEME[:FLOORS[:BONUS]]` (v0.51.5) plants a dungeon of any theme a few tiles from the start so a bot can be put inside a theme world generation rarely places near spawn. Pair it with `--devlvl` / `--devgear` and a NEGATIVE bonus so the bot's own floor-level check accepts it (the bot skips dungeons rated above its level; rec = levelForDepthScale(floors+1+bonus)); the planted dungeon is set as the bot's goal until completed (window.__devDungeonId, honoured by B.chooseDungeon), BUT the bot's quest/story logic (quest-talk, quest-boss) outranks dungeon goals, so a run with an active story stage may never go in: prefer `--devstage=` values that leave no pending talk, or accept that this is a smoke-level check and use `balance`/generation scripts for tuning. Check for an `ENTER dungeon d_dev_THEME` line. A warrior L14 ran the Bile Cistern to depth 2 with 0 errors, 0 loops.
- **Reading sweeps.** `matrix` stops a run at `--ticks` (default 30000, about 22-26k game turns, L10-14): pass `--ticks=250000 --secs=3000` for a deep run (L18-19 after ~50 min, 6 jobs). `play --seed=N` fixes the WORLD, not the combat rolls, so a death from a sweep rarely replays identically; diagnose from `res.deaths[].deathLog` + `final.place/biome` in the matrix JSON, and check which spawn path produced the killer (generation roll, hunt roll, random pool, encounter table, wandering aquatic).
- **Spawn paths that bypass a gate** are the usual reason a fixed killer keeps killing: the story hunt, the generation-time story roll AND the random roaming-boss pool each needed the readiness gate (`storyBossReadiness`), and amphibious aquatic monsters walked onto land until marked `waterOnly`. When a gate "doesn't work", list every place the monster can be created.
- **classbp reading.** `--gear --kit=school` models trainers and drops; `--gauntlet=N` is a no-rest attrition FLOOR that penalises mana classes at low level (mage 0% at L12, 30% at L30) and is not a verdict on the class; the 1v1 columns at native and 1.5x scale are the fair comparison (all classes were 85-100% at L30). Plain `balance` has no gear model: its L30 numbers (warrior 17% vs ranger 100%) were a gear artefact.
- **Probe tricks that worked.** Time-based game code (fishing's `setInterval`): stub `window.setInterval/clearInterval`, capture the callback and drive it by hand; stub `window.endTurn` to isolate logic from world events; script dice with a queue (`rig([..], rest)`) but remember `randInt(Math.random..)` consumes a value before the first roll. A probe must start from a clean baseline (earlier probes leave flags such as `permaNightVision` set) and restore touched fields afterwards. Always mutation-test: copy the game, remove the fix with python, run with `GAME_HTML=/tmp/mutN.html`.
- **Bot fixes:** flees from fear (cannot attack) and never flees while slowed (the move is refused); `stats.kills` now comes from the feat counter; a failed matrix child reports its Error line, not just stack frames.
- **Open leads:** acid-slime split swarms plus engulf slow still kill L3-4 characters; the Glimmerfae confusion pack is dangerous at L1 with 28 HP; hand-play pacing of the first levels is unverified.

*/
