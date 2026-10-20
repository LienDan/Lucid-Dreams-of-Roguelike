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
// Programmatic use:  const { boot, ev, key, newGame, createCharacter, playLife } = require('./playtest.js');
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
      if (/heal|medkit/i.test(i.effect || '') || /heal|health|medkit/i.test(i.id || '')) { if (!best || (i.healAmount || 0) > (best.healAmount || 0)) best = i; }
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
    if (!a || d > a.range || !hasLOS(player.x, player.y, m.x, m.y)) return false;
    return B.cast(a, m);
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
  B.pickTarget = function (maxDist) {
    let best = null, bestScore = -1;
    const all = B.hostiles(0);
    const prey = curIsDungeon() ? [] : curMonsters().filter((m) => m.alive && m.behavior === 'flee');
    for (const m of all.concat(prey)) {
      const d = chebyshev(m.x, m.y, player.x, player.y);
      if (maxDist && d > maxDist) continue;
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
        if (bad && sim.win < 0.6 && !onUp && up && B.flee()) return 'flee-melee'; // a same-speed melee monster cannot hit a target that keeps walking; the stairs end the fight
        B.stats.fights++; return B.attackAdjacent(adj) ? 'attack' : 'attack-fail';
      }
      // not adjacent yet
      if ((bad || (shooters && (player.hp < player.maxHp * 0.6 || (threats.length >= 2 && sim.win < 0.99)))) && shooters && !onUp) { B.note('shot at, bad odds: ' + threats.map((m) => m.name).join(',')); if (B.flee()) return 'flee'; }
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
    if (B.refugeUntil > turnCount) { if (player.hp < player.maxHp && B.canRest()) { B.rest(300, 1.0); return 'rest'; } endTurn(); return 'hide'; }
    if (player.hp < player.maxHp * 0.4 && ((player.statusPoison || 0) > 0 || (player.bleedTurns || 0) > 0 || B.hpFalling())) { if (B.drinkHeal()) return 'heal'; }
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
    if (B.stageWants(dg) && B.dungeonFloorLevel(dg, dg.maxDepth) <= player.level + B.qslack()) {
      if (player.dungeonDepth < dg.maxDepth) goDown = true;
      else if (st.down) { // deepest floor cleared: try to go further -- this is what completes a 'dungeon tier' stage
        if (!(player.story && player.story.stages[player.story.stageIndex] && player.story.stages[player.story.stageIndex].type === 'dungeon_tier')) { /* only a dungeon-tier stage is completed by going below the last floor */ }
        else if (!B.nextBossReady()) { /* finishing this would summon a boss we cannot beat yet */ }
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
  B.dungeonFloorLevel = function (d, floor) { return 1 + (floor + (d.depthScaleBonus || 0) - 1) * 98 / 13; };
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
      if (Math.min(dist, B.home ? chebyshev(d.x, d.y, B.home.x, B.home.y) : dist) > 50 + 12 * player.level + Math.min(400, B.xpIdle() * 0.15) && !(want && B.dungeonFloorLevel(d, d.maxDepth) <= player.level + B.qslack())) continue; // low levels stay near home
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
      for (const st of B.settlements()) { const d = chebyshev(st.x, st.y, player.x, player.y); if (d < bd && d < 260) { bd = d; best = st; } }
      if (!best) { B.shopCool = turnCount + 800; return false; }
      B.trip = { x: best.x, y: best.y, c: best.c, t0: turnCount };
    }
    if (turnCount - B.trip.t0 > 1500) { B.trip = null; B.shopCool = turnCount + 3000; return false; }
    const shopkeeper = B.trip.c.npcs && B.trip.c.npcs.find((n) => n.alive && !n.hostile && n.shop && n.shop.length);
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
      const a = B.wAng + (Math.random() - 0.5) * 0.9, r = 25 + Math.random() * 30; B.wx = { x: Math.round(player.x + Math.cos(a) * r), y: Math.round(player.y + Math.sin(a) * r), until: turnCount + 120 }; }
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
    const m = { uid: 'syn', hp: def.hp * margin * kite, maxHp: def.hp * margin * kite, atk: [Math.round(def.atk[0] * margin), Math.round(def.atk[1] * margin)], str: Math.round((def.str || 10) * margin), dex: def.dex || 10, armor: def.armor || 0, boss: true, scriptedAI: def.scriptedAI || true, poison: def.poison || 0, engaged: true, behavior: def.behavior, abilities: def.abilities || null, powerScale: 1, x: player.x + 1, y: player.y, mp: 20 };
    const sim = B.simulate([m], 80, player.maxHp);
    return sim.win >= 0.9 && sim.loss < player.maxHp * 0.75;
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
      if (B.abLast === turnCount - 1 || B.abLast === turnCount) B.abT++; else B.abT = 0;
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
    if (!B.avoiding) { // pick off easy monsters on the way: cheap XP
      const tg = B.pickTarget(12);
      if (tg && !(tg.behavior === 'flee' && chebyshev(tg.x, tg.y, player.x, player.y) > 4)) { if (B.huntStep(tg)) return 'hunt-ow'; }
    }
    B.avoiding = false;
    const t = curTileAt(player.x, player.y);
    if ((B.noEnterUntil || 0) > turnCount && B.comfy()) { if (player.hp < player.maxHp && B.canRest()) { B.rest(300, 1.0); return 'rest'; } endTurn(); return 'cooldown'; }
    if (B.goalDungeon && B.chooseDungeon() !== B.goalDungeon && !B.goalDungeon.__keep) B.goalDungeon = null;
    if (B.goalDungeon && t && t.feature === 'dungeon_entrance' && t.dungeonId === B.goalDungeon.id) { B.cur = B.goalDungeon; useStairs(); return 'enter'; }
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
    // nothing suitable known yet: farm easy monsters near where we started instead of exploring ever further
    B.home = B.home || { x: player.x, y: player.y };
    { const tg = B.pickTarget(14); if (tg && B.huntStep(tg)) return 'hunt-ow'; }
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
    if (gameState === 'gameover') return 'dead';
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
  D.gearUp = function (L) {
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
  D.fight = function (id, scale, dist, maxTurns, support) {
    const spot = D.arena(dist); if (!spot) return null;
    D.restore();
    const m = makeMonster(id, spot.x + dist, spot.y, scale, Math.random); m.alive = true; m.aiState = 'combat'; m.engaged = true; m.sleeper = false;
    addMonsterToWorld(m);
    const hp0 = player.hp; let turns = 0, minHp = player.hp;
    while (turns < maxTurns && m.alive && m.hp > 0 && player.alive && player.hp > 0) {
      turns++;
      if (gameState !== 'playing') { try { closeModal(); } catch (e) { /* */ } gameState = 'playing'; }
      const t0 = B.sig();
      if (support === 'kite' && chebyshev(m.x, m.y, player.x, player.y) <= 1 && player.hp < player.maxHp * 0.6 && (turns - (D._lastEsc || -99)) > 8 && (D._lastEsc = turns, D.escape(m))) { /* blinked away */ }
      else if (support && D.support(m, turns)) { /* buffed / summoned / debuffed (took its turn) */ }
      else if (player.hp < player.maxHp * 0.35 && B.drinkHeal()) { /* drank */ }
      else if (chebyshev(m.x, m.y, player.x, player.y) <= 1) { if (!B.tryCast(m, 0.2)) B.attackAdjacent([m]); }
      else if (B.tryCast(m, 0.2)) { /* cast */ }
      else if (turns > 4) { const t1 = B.sig(); movePlayer(Math.sign(m.x - player.x), Math.sign(m.y - player.y)); if (B.sig() === t1) endTurn({ forceFull: true }); } // it will not come to us (shy/ranged/fleeing): go and get it
      else endTurn({ forceFull: true }); // let it come to us
      if (B.sig() === t0) endTurn(); // never stall
      if (player.hp < minHp) minHp = player.hp;
    }
    const won = !(m.alive && m.hp > 0) && player.alive && player.hp > 0;
    m.alive = false; m.hp = 0;
    const died = !(player.alive && player.hp > 0);
    return { won, died, turns, hpLostPct: Math.max(0, (hp0 - Math.max(0, player.hp)) / hp0) , minHpPct: Math.max(0, minHp) / hp0 };
  };
  D.run = function (id, opts) {
    opts = opts || {}; const trials = opts.trials || 8; let wins = 0, deaths = 0, lost = 0, turns = 0, ran = 0, worst = 1;
    for (let i = 0; i < trials; i++) {
      const r = D.fight(id, opts.scale || 1, opts.dist || 5, opts.maxTurns || 80, opts.support === undefined ? true : opts.support); if (!r) continue; ran++;
      if (r.died) deaths++;
      if (r.won) { wins++; lost += r.hpLostPct; turns += r.turns; worst = Math.min(worst, r.minHpPct); }
    }
    D.restore();
    return { id, trials: ran, win: ran ? wins / ran : 0, death: ran ? deaths / ran : 0, stall: ran ? (ran - wins - deaths) / ran : 0, hpLostPct: wins ? lost / wins : 1, turns: wins ? turns / wins : 0, worstMinHp: worst };
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
    if (lvl !== lastLvl) { levelTurns[lvl] = turn; log(`level ${lvl} at turn ${turn} (${((Date.now() - t0) / 1000).toFixed(0)}s) nextBossReady=${ev(win, '__B.nextBossReady()').value}`); lastLvl = lvl; }
    if (opts.maxSeconds && Date.now() - t0 > opts.maxSeconds * 1000) { result.outcome = 'time'; break; }
    if (v.startsWith('idle') && opts.stopOnIdle) { result.outcome = v; break; }
  }
  if (process.env.DIAG) { try { result.diagText = ev(win, '__B.diag()').value; } catch (e) { /* */ } }
  result.counts = counts; result.trace = trace; result.why = ev(win, 'JSON.stringify(__B.tpWhy)').value + ' ' + ev(win, 'JSON.stringify(__B.nm)').value + ' AF ' + ev(win, 'JSON.stringify(__B.af)').value;
  result.final = JSON.parse(ev(win, 'JSON.stringify({lvl:player.level,hp:player.hp,maxHp:player.maxHp,turn:turnCount,depth:player.dungeonDepth||0,alive:player.alive,xp:player.xp,gold:player.gold,cause:player.deathCause||null,st:{poison:player.statusPoison,slow:player.statusSlow,chill:player.statusChill,heat:player.statusHeat,rad:player.statusRadiation,bleed:player.bleedTurns,temp:(function(){try{return currentTemperature()}catch(e){return null}})(),biome:(function(){try{return curTileAt(player.x,player.y).biome}catch(e){return null}})()},eq:Object.entries(player.equipment).filter(function(e){return e[1]}).map(function(e){return e[0]+"="+e[1].name+(e[1].dmg?"["+e[1].dmg+"]":"")+(e[1].armor?"(a"+e[1].armor+")":"")}),stats:__B.stats})').value);
  result.events = ev(win, '__B.events.slice(-40)').value;
  result.loops = ev(win, "__B.events.filter(function (e) { return e.indexOf('LOOP BREAK') >= 0 || e.indexOf('DANCE LOOP') >= 0; }).slice(0, 5)").value;
  if (result.outcome === 'died') result.inv = ev(win, 'JSON.stringify([player.gold].concat(player.inventory.filter((i)=>i.type==="consumable").map((i)=>i.name+"x"+(i.qty||1))))').value;
  if (result.outcome === 'died') result.deathLog = ev(win, '(player.deathLog&&player.deathLog.length?player.deathLog:logMessages.map(function(x){return typeof x==="string"?x:(x&&x.text)||""})).slice(-16)').value;
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
    player.abilityCooldowns = {};
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
          const before = snap(), hp0 = tgt.hp;
          const pool = ab.resource || 'mp';
          try {
            castSpell(ab.id);
            if (gameState === 'tiletarget') confirmTileTarget(...(pendingTarget && pendingTarget.kind === 'blink' ? [player.x, player.y + 3] : [tgt.x, tgt.y]));
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
        if (!changedAny) { noops++; A.warn('abilities.noop', ab.id, `${ab.name} (${ab.type}) changed nothing in 3 casts`); }
        else if (dmgType && !hurt) A.warn('abilities.nodamage', ab.id, `${ab.name} (${ab.type}) never reduced the target's hp in 3 casts`);
        if (selfHurt > 0) A.info('abilities.selfdamage', ab.id, `${ab.name} (${ab.type}${ab.aoe ? ', aoe r' + ab.aoeRadius : ''}) hurt its own caster for ${selfHurt} (friendly fire is INTENDED design; informational only) with the target ${ab.range === 1 ? 1 : 2} tile(s) away`);
        const cost = ab.selfCost != null ? ab.selfCost : ab.mp;
        if (changedAny && cost > 0 && paid === false && !['blinklike'].includes(ab.type)) { free++; A.warn('abilities.free', ab.id, `${ab.name} lists a cost of ${cost} (${ab.resource || 'mp'}) but the pool never changed`); }
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
      let ran = 0;
      for (const id of ids) {
        const m = A.arenaBoss(id, 3);
        if (!m) { A.warn('bosses', id, 'no arena space'); continue; }
        player.maxHp = 1e7; player.hp = 1e7;
        // tally every point of damage the player takes (regeneration is ignored) by wrapping the hp accessor
        let backing = 1e7, tally = 0;
        Object.defineProperty(player, 'hp', { configurable: true, enumerable: true, get() { return backing; }, set(v) { if (v < backing) tally += backing - v; backing = Math.min(v, 1e7); } }); player.mp = player.maxMp = 1000; player.stamina = player.maxStamina = 1000; player.armor = player.armor || 0;
        const dmg = [];
        for (const frac of [1, 0.6, 0.25]) {
          m.hp = Math.max(1, Math.round(m.maxHp * frac)); const hp0 = tally;
          for (let t = 0; t < 40; t++) {
            try { endTurn(); } catch (e) { A.err('bosses', id, `endTurn threw at ${Math.round(frac * 100)}% hp, turn ${t}: ${String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')}`); break; }
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
        ran++;
        A.stat('bossDmgPerTurn:' + id, dmg.join('/'));
        if (dmg.every((d) => d <= 0) && !MONSTER_BASES[id].waterOnly && !MONSTER_BASES[id].aquatic) A.warn('bosses.passive', id, `${m.name} dealt no damage to a motionless player in 120 turns (hp phases ${dmg.join('/')})`);
      }
      A.stat('bossesRun', ran);
    },
  },
];
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
      { A.refill(); const c = A.arena('goblin', 50, 1); c.soakStrike = 10; c.atk = [1, 1]; c.str = 5; let got = false; for (let i = 0; i < 300 && !got; i++) { player.hp = player.maxHp = 5000; try { doAttack(c, player); } catch (e) { A.err('emergence.combos', 'melee', 'doAttack threw: ' + e.message); break; } got = player.wetTurns > 0; } say('melee soakStrike', got, 'soakStrike never made the player Wet in 300 melee hits'); }
      { A.refill(); const c = A.arena('goblin', 50, 1); c.oilStrike = 20; c.atk = [1, 1]; c.str = 5; let got = false; for (let i = 0; i < 300 && !got; i++) { player.hp = player.maxHp = 5000; player.wetTurns = 0; try { doAttack(c, player); } catch (e) { A.err('emergence.combos', 'melee', 'doAttack threw: ' + e.message); break; } got = player.oiledTurns > 0; } say('melee oilStrike', got, 'oilStrike never oiled the player in 300 melee hits'); }
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
          const flat = []; ch.outcomes.forEach((o) => { for (let x = o; x; x = x.also) flat.push(x); });
          for (const o of flat) {
            if (!WORLD_EVENT_HANDLERS[o.type]) { A.err('events.encounters', e.id, `${where}: outcome type '${o.type}' has no handler`); continue; }
            if (o.type === 'grantItem' && !itemOk(o.item)) A.err('events.encounters', e.id, `${where}: grants unknown item ${o.item}`);
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
  require('./items'),
  require('./refs'),
  require('./monsters'),
  require('./abilities'),
  require('./worldgen'),
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

// ==== FILE: lib/probes/systems.js ====
__def("lib/probes/systems.js", function (module, exports, require, __dirname, __filename) {
'use strict';
// Probes that exercise whole game systems with a live character.
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
    id: 'worldgen.dungeons',
    desc: 'generate every dungeon theme at several depths/sizes/variants: connected stairs, sane entities, nothing in walls, no overlaps',
    needsPlayer: true,
    seconds: 600,
    fn(A) {
      const finite = (v) => typeof v === 'number' && isFinite(v);
      const sizes = DUNGEON_SIZE_TIERS.map((s) => s.id), variants = DUNGEON_VARIANTS.map((v) => v.id);
      let floors = 0, slow = 0, adjacentSpawns = 0, totalMon = 0, totalWalk = 0;
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
      let n = 0;
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
          const occupied = new Map();
          for (const m of [].concat(lvl.monsters, lvl.npcs || [])) {
            if (!finite(m.x) || !finite(m.y) || !lvl.grid[m.y] || !lvl.grid[m.y][m.x] || !lvl.grid[m.y][m.x].walkable) { A.err('worldgen', where, `${m.name} stands in a wall/out of bounds at ${m.x},${m.y}`); continue; }
            const k = m.x + ',' + m.y; if (occupied.has(k)) A.err('worldgen', where, `${m.name} and ${occupied.get(k)} share tile ${k}`); occupied.set(k, m.name);
            if (!finite(m.hp) || m.hp <= 0) A.err('worldgen', where, `${m.name} has hp ${m.hp}`);
            if (up && m.kind === 'monster' && Math.max(Math.abs(m.x - up.x), Math.abs(m.y - up.y)) <= 2) { adjacentSpawns++; if (m.boss) A.warn('worldgen.spawn', where, `boss ${m.name} spawns within 2 tiles of the arrival stairs`); }
          }
          totalMon += lvl.monsters.length;
          for (const it of lvl.items || []) if (!lvl.grid[it.y] || !lvl.grid[it.y][it.x] || !lvl.grid[it.y][it.x].walkable) A.err('worldgen', where, `item ${(it.item && it.item.name) || '?'} lies in a wall at ${it.x},${it.y}`);
          for (const c of lvl.containers || []) if (!lvl.grid[c.y] || !lvl.grid[c.y][c.x]) A.err('worldgen', where, 'container out of bounds');
          if (lvl.monsters.length === 0 && walk > 400) A.warn('worldgen.empty', where, `no monsters on a ${walk}-tile floor`);
        }
      }
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
      withPlayer = true;
    }
    const win = dom.window;
    ev(win, '(' + REPORTER_SRC.toString() + ')()');
    const t0 = Date.now();
    for (const h of p.uses || []) ev(win, `(${fnSource(h)})(window.__AUDIT)`);
    const r = ev(win, `(${fnSource(p.fn)})(window.__AUDIT)`, (p.seconds || 120) * 1000);
    const findings = JSON.parse(ev(win, 'JSON.stringify(window.__AUDIT.findings)').value || '[]');
    Object.assign(stats, JSON.parse(ev(win, 'JSON.stringify(window.__AUDIT.stats)').value || '{}'));
    if (!r.ok) findings.push({ sev: 'error', area: p.id, id: '(probe)', msg: (r.timeout ? 'TIMED OUT: ' : 'THREW: ') + r.error.split('\n').slice(0, 3).join(' | ').slice(0, 500) });
    for (const e of drainErrors(win)) findings.push({ sev: 'error', area: p.id, id: '(game exception)', msg: `[${e.where}] x${e.count} ${e.msg} @ ${(e.stack.split('\n')[1] || '').trim()}` });
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
//   node playtest.js classbp [--classes=all|a,b] [--level=20] [--scales=3.5,6,10,16] [--trials=3] [--tier=4] [--jobs=2] [--kit=school] [--gear] [--out=file.json]
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
  const scales = String(args.scales || '3.5,6,10,16').split(',').map(Number);
  const dom = await newGame({ seed: 11 }); const win = dom.window;
  if (!createCharacter(win, { species: args.species || 'human', archetype: cl, scenario: 'town' })) { console.error('could not create ' + cl); process.exit(1); }
  ev(win, '(' + DUEL.toString() + ')()');
  ev(win, `__DUEL.levelTo(${L});`);
  if (args.gear) ev(win, '__DUEL.gearUp(' + L + ')');
  // --kit=school: give the class EVERY ability of the schools it starts in up to tier ceil(level/5), as a character with trainers/tomes/manuals would have; default is the bare starting kit
  if (args.kit === 'school') ev(win, `(function(){ var T = Math.ceil(${L} / 5), ids = player.knownSpells.concat(player.knownTechniques || []), schools = {};
    ids.forEach(function (id) { var a = findAbilityById(id); if (a && a.school) schools[a.school] = 1; });
    SPELLS.forEach(function (x) { if (schools[x.school] && (x.tier || 1) <= T && player.knownSpells.indexOf(x.id) < 0) player.knownSpells.push(x.id); });
    TECHNIQUES.forEach(function (x) { if (schools[x.school] && (x.tier || 1) <= T && player.knownTechniques.indexOf(x.id) < 0) player.knownTechniques.push(x.id); }); })()`);
  const info = JSON.parse(ev(win, 'JSON.stringify({hp:player.maxHp,mp:player.maxMp,spells:player.knownSpells.length,tech:(player.knownTechniques||[]).length,armor:getArmorOf(player)})').value);
  const mons = JSON.parse(ev(win, `JSON.stringify(Object.entries(MONSTER_BASES).filter(([id,m])=>!m.boss&&!m.miniboss&&!m.waterOnly&&!m.aquatic&&!m.summonId&&m.behavior!=="flee"&&(m.dtier||0)<=${tier}).map(e=>e[0]))`).value);
  const res = { class: cl, level: L, info, scales: {} };
  for (const S of scales) {
    let w = 0, n = 0, cost = 0, cn = 0; const worst = [];
    for (const id of mons) {
      const r = ev(win, `JSON.stringify(__DUEL.run(${JSON.stringify(id)},{scale:${S},trials:${trials},support:true}))`, 120000);
      if (!r.ok) continue; const o = JSON.parse(r.value); w += o.win; n++; worst.push([id, o.win]); if (o.win > 0) { cost += o.hpLostPct; cn++; }
    }
    worst.sort((a, b) => a[1] - b[1]);
    res.scales[S] = { win: w / Math.max(1, n), cost: cost / Math.max(1, cn), n, worst: worst.slice(0, 5).map((x) => x[0] + ':' + Math.round(x[1] * 100)) };
  }
  console.log('@@CLASSBP ' + JSON.stringify(res));
}

function child(cl, args) {
  return new Promise((resolve) => {
    const argv = [path.join(__dirname, '..', '..', 'playtest.js'), 'classbp', `--one=${cl}`, ...['level', 'scales', 'trials', 'tier', 'species', 'kit', 'gear'].filter((k) => args[k] !== undefined).map((k) => `--${k}=${args[k]}`)];
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
  console.log('class'.padEnd(14) + 'hp'.padStart(5) + ' spl tech ' + sc.map((s) => ('x' + s).padStart(6)).join(''));
  for (const r of good) console.log(r.class.padEnd(14) + String(r.info.hp).padStart(5) + String(r.info.spells).padStart(4) + String(r.info.tech).padStart(5) + ' ' + sc.map((s) => (Math.round(r.scales[s].win * 100) + '%').padStart(6)).join('') + '   worst@' + last + ': ' + r.scales[last].worst.slice(0, 3).join(','));
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
      resolve({ job, code, res, seconds: (Date.now() - t0) / 1000, crash: res ? null : (err.split('\n').filter(Boolean).slice(-4).join(' | ') || 'no result (exit ' + code + ')') });
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
  const classes = pick(args.classes, tables.classes, ['commander']), species = pick(args.species, tables.species, ['dwarf']);
  const scenarios = pick(args.scenario, tables.scenarios, ['town']), seeds = String(args.seeds || '1').split(',').map(Number);
  const jobs = [];
  for (const sp of species) for (const cl of classes) for (const sc of scenarios) for (const seed of seeds) jobs.push({ species: sp, class: cl, scenario: sc, seed });
  const conc = parseInt(args.jobs || Math.max(1, Math.min(os.cpus().length - 1, 6)), 10);
  const forward = [`--secs=${args.secs || 120}`, `--lives=${args.lives || 1}`];
  for (const k of ['ticks', 'devlvl', 'devstage', 'devpos', 'devspells']) if (args[k] !== undefined) forward.push(`--${k}=${args[k]}`);
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
//                         [--devlvl=N --devstage=id|N|final --devpos=x,y --devspells=a,b] [--ev=regex] [--trace] [--json]
// Every flag also works as the legacy upper-case env var (SEED, SECS, TICKS, LIVES, DEVLVL, ...).
// =====================================================================================================
const { ev } = require('../harness');
const { playLife, resolveBuild } = require('../driver');

function opt(args, name, def) {
  const env = process.env[name.toUpperCase()];
  if (args[name] !== undefined && args[name] !== true) return args[name];
  if (env !== undefined) return env;
  return def;
}

/** Test-only cheat: start at a chosen level / story stage / position with extra spells. */
function makePrep(args) {
  const devlvl = opt(args, 'devlvl');
  if (!devlvl) return null;
  const devstage = opt(args, 'devstage', ''), devpos = opt(args, 'devpos'), devspells = opt(args, 'devspells');
  return (win) => {
    const L = parseInt(devlvl, 10);
    const S = devstage === 'final' ? 'player.story.stages.findIndex((x) => x.id === "confrontation")'
      : (/^[a-z_]+$/.test(devstage) ? 'player.story.stages.findIndex((x) => x.id === "' + devstage + '")' : parseInt(devstage || '-1', 10));
    ev(win, `while (player.level < ${L}) { levelUp(); } player.hp = player.maxHp; for (let k = 0; k < 400 && (player.statPoints || 0) > 0; k++) __B.spendPoints(); __B.spendTalents(); player.gold += 20000;`
      + (devpos ? `player.x=${devpos.split(',')[0]};player.y=${devpos.split(',')[1]};try{loadChunksAround&&loadChunksAround()}catch(e){}` : '')
      + (devspells ? `for (const id of ${JSON.stringify(String(devspells).split(','))}) if (!player.knownSpells.includes(id)) player.knownSpells.push(id);` : '')
      + (S !== -1 ? `for (let i = 0; i < ${S}; i++) { player.story.stages[i].done = true; } player.story.stageIndex = ${S};` : ''), 60000);
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
    if (r.outcome === 'died') deaths.push({ life, lvl: r.final && r.final.lvl, cause: r.final && r.final.cause, turn: r.final && r.final.turn, depth: r.final && r.final.depth, deathLog: (r.deathLog || []).slice(-8) });
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

module.exports = { boot: H.boot, ev: H.ev, key: H.key, drainErrors: H.drainErrors, newGame: D.newGame, createCharacter: D.createCharacter, resolveBuild: D.resolveBuild, playLife: D.playLife, BRAIN };

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

### Early bleed grace (game change, v0.51.3)
Level 1-4 autopilot lives (8 classes x 6 seeds, 40 s): 11 deaths, 5 of them bleeding. Player bleed ticks now use the EARLY_GRACE ladder (x0.6 at level 1-2, x0.8 at 3-4). Re-run on the same seeds: 8 deaths, 3 bleeding, mean level 3.2 -> 3.4. n=48 per arm and runs are non-deterministic, so this is directional only.

*/
