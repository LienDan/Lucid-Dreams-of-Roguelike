#!/usr/bin/env node
// =====================================================================================================
// playtest.js -- autopilot for "Lucid Dreams of Roguelike"
// =====================================================================================================
// One autopilot (replaces the old novice/casual/veteran/optimal profiles). It runs inside the game's own
// JS realm, reads the real game state, and simulates fights (Monte Carlo) before taking them.
// Usage:  node playtest.js            env: SEED=n  SECS=seconds  TICKS=n  STOP=level
// Extra env: BEAT=seconds (progress line), DEVLVL=n / DEVSTAGE=n (start a test life at that level / story stage), TRACE, CANDS.
// STATUS: this bot has beaten the game (killed GOD, player.gameCompleted === true) with no debug flags, on seed 501,
// after roughly 230,000 game turns from a fresh character. It levels to 99, clears the story, finds every dimension
// gate (boss kill, Dream Sanctum altar, item + standing-stones), kills each guardian, then the Antagonist and GOD.
// That win came from one character carried across many process restarts (see CKPT/RESUME) while bugs were fixed
// along the way; it has not yet been re-run end to end from scratch with the final code. Runs are not deterministic
// even with the same SEED, and a full run takes hours, so use the checkpoint options below for long runs.
// Long-run env: CKPT=seconds (save the character every N seconds), RESUME=1 (continue from that save),
// CKPT_FILE=path (default /tmp/runs/ckpt_<seed>.json -- create that folder first), LIVES=n (retries after a death),
// EV=regex (print notes that match, e.g. "WON|god-|long-hop"), DEVPOS/DEVSTAGE/DEVLVL/DEVSPELLS are test-only cheats.
// Example: SEED=501 RESUME=1 CKPT=120 TICKS=900000000 SECS=40000 LIVES=20 BEAT=300 node playtest.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// -----------------------------------------------------------------------------------------------------
// 1. HARNESS: boot the real, unmodified game inside jsdom (canvas + audio stubbed out)
// -----------------------------------------------------------------------------------------------------
function findGameHtml(explicit) {
  if (explicit) return explicit;
  const dirs = [__dirname, path.join(__dirname, '..'), process.cwd(), path.join(__dirname, 'game')];
  const found = [];
  for (const d of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(d); } catch (e) { continue; }
    for (const e of entries) if (e.toLowerCase().endsWith('.html')) found.push(path.join(d, e));
  }
  const games = found.filter((p) => { try { return fs.readFileSync(p, 'utf8').includes('function simulateKey('); } catch (e) { return false; } });
  if (!games.length) throw new Error('Could not find the game .html next to playtest.js (looked in: ' + dirs.join(', ') + ')');
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

let _gamePath = null;
async function boot(htmlPath, seed) {
  _gamePath = htmlPath || _gamePath || findGameHtml();
  let html = fs.readFileSync(_gamePath, 'utf8');
  html = html.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g, '');
  const dom = new JSDOM(html, {
    url: 'http://localhost/game.html', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => stubCtx();
      w.AudioContext = stubAudio(); w.webkitAudioContext = w.AudioContext;
      w.scrollTo = () => {}; w.confirm = () => true; w.alert = () => {};
    },
  });
  if (dom.virtualConsole) ['jsdomError', 'error', 'warn'].forEach((e) => dom.virtualConsole.on(e, () => {}));
  await new Promise((res) => { if (dom.window.document.readyState === 'complete') return res(); dom.window.addEventListener('load', res); setTimeout(res, 500); });
  if (seed !== undefined && seed !== null) {
    let a = (seed >>> 0) || 1;
    dom.window.Math.random = function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // Nothing is ever drawn, so skip all drawing/DOM-update work (roughly halves the cost of a turn).
  for (const f of ['render', 'updateSidebar', 'renderLog', 'saveGame', 'hashChunkTiles']) { try { dom.window.eval(`${f} = function(){}`); } catch (e) { /* ignore */ } }
  dom.window.__dom = dom;
  return dom;
}

const vm = require('vm');
function ev(win, code, timeoutMs) {
  try {
    if (win.__dom && timeoutMs) return { ok: true, value: new vm.Script(code).runInContext(win.__dom.getInternalVMContext(), { timeout: timeoutMs }) };
    return { ok: true, value: win.eval(code) };
  } catch (e) { return { ok: false, timeout: !!(e && /timed out/i.test(e.message || '')), error: (e && e.stack) || String(e) }; }
}

// -----------------------------------------------------------------------------------------------------
// 2. THE BRAIN: this function's SOURCE is evaluated inside the game's own world, so it can call the
//    game's functions and read its variables directly (player, curMonsters(), movePlayer(), ...).
//    Nothing in here runs in Node. Everything is synchronous (no timers), so it is fast.
// -----------------------------------------------------------------------------------------------------
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
    const b = player.inventory.find((i) => /bandage/i.test(i.name || '') || i.id === 'bandage');
    if (!b) return false;
    const t0 = B.sig(); useItem(b); if (gameState !== 'playing') closeModal();
    return true;
  };
  B.healingItem = function () {
    let best = null;
    for (const i of player.inventory) {
      if (i.type !== 'consumable') continue;
      if (/heal/i.test(i.effect || '') || /heal|health/i.test(i.id || '')) { if (!best || (i.healAmount || 0) > (best.healAmount || 0)) best = i; }
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
    if (tot >= player.hp - 3 && B.drinkHeal()) return true;
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
      if (s.selfExposed || s.selfCost) continue;
      const res = s.resource || 'mp'; if (res !== 'mp' && res !== 'stamina') continue;
      const def = abilityRequirementDeficit(s), pf = abilityPenaltyFactor(def), fail = Math.min(0.5, def * 0.04);
      const pool = abilityPoolOf(id);
      const mult = (1 + (player.spellDmgBonus || 0) + (pool === 'technique' ? (player.techniqueDmgBonus || 0) : 0)) * pf * playerLevelPowerMult(player.level);
      const avg = (s.power[0] + s.power[1]) / 2 * mult * (1 - fail);
      out.push({ s, id, res, cost: effectiveCost(s), avg, range: s.range || 1, aoe: !!s.aoe });
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
  B.trainTick = function () {
    if (player.level < 12 || player.gold < 300 || (B.trainCool || 0) > turnCount) return false;
    const near = curNPCs().filter((n) => n.alive && !n.hostile && n.teachSpells && n.teachSpells.some(B.wantSpell) && chebyshev(n.x, n.y, player.x, player.y) <= 1);
    if (near.length) {
      const npc = near[0]; let got = 0;
      openTrain(npc);
      for (let k = 0; k < 12; k++) {
        const idx = trainEntries.findIndex((e) => e.kind === 'spell' && B.wantSpell(e.id)); if (idx < 0) break;
        const g = player.gold; trainLearn(String.fromCharCode(97 + idx)); if (player.gold === g) break; got++;
      }
      closeModal(); gameState = 'playing';
      B.note('trainer ' + npc.name + ' taught ' + got + ' spells; know ' + (player.knownSpells || []).join(','));
      B.trip2 = null; B.trainCool = turnCount + (got ? 100 : 2000); return 'train';
    }
    if (!B.trip2) {
      let best = null, bd = 1e9;
      for (const c of worldChunks.values()) { if (!c.npcs) continue; for (const n of c.npcs) { if (!n.alive || n.hostile || !n.teachSpells || !n.teachSpells.some(B.wantSpell)) continue; const d = chebyshev(n.x, n.y, player.x, player.y); if (d < bd && d < 500) { bd = d; best = n; } } }
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
      B.note('LOOP BREAK ' + act + ' hp ' + player.hp + '/' + player.maxHp + ' stam ' + player.stamina + '/' + player.maxStamina + ' temp ' + Math.round(currentTemperature()) + ' hunger ' + player.hunger + ' turn ' + turnCount);
    }
    if (actK === 'dance' && B.streak === 600 && curIsDungeon()) {
      const th = B.threats(); const sm = B.simulate(th, 60);
      B.note('DANCE LOOP depth ' + player.dungeonDepth + ' hp ' + player.hp + '/' + player.maxHp + ' sim win ' + sm.win + ' loss ' + Math.round(sm.loss) + ' threats ' + th.map((m) => m.name + '(hp' + m.hp + ' d' + chebyshev(m.x, m.y, player.x, player.y) + ' ' + (m.behavior || '') + ' ' + (m.aiState || '') + ' w' + B.simulate([m], 40).win + ')').join(','));
    }
    return act;
  };
}

// -----------------------------------------------------------------------------------------------------
// 3. DRIVER
// -----------------------------------------------------------------------------------------------------
function key(win, k) { return ev(win, `simulateKey(${JSON.stringify(k)})`); }

async function newGame(opts) {
  opts = opts || {};
  const dom = await boot(undefined, opts.seed);
  const win = dom.window;
  ev(win, '(' + BRAIN.toString() + ')()');
  return dom;
}

// species/archetype/scenario letters: see the lists printed by --list
const BUILD = { species: 'c' /* dwarf */, archetype: 'i' /* commander */, scenario: 'd' /* town */ };
function createCharacter(win, b) {
  b = b || BUILD;
  for (const k of ['a', b.species, b.archetype, b.scenario]) key(win, k);
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
    if (lvl !== lastLvl) { log(`level ${lvl} at turn ${turn} (${((Date.now() - t0) / 1000).toFixed(0)}s) nextBossReady=${ev(win, '__B.nextBossReady()').value}`); lastLvl = lvl; }
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
  return result;
}

module.exports = { boot, ev, key, newGame, createCharacter, playLife, BRAIN };

if (require.main === module) {
  (async () => {
    const seed = parseInt(process.env.SEED || '1', 10);
    const prep = process.env.DEVLVL ? (win) => { // test helper: start with a pre-levelled character at a chosen story stage
      const L = parseInt(process.env.DEVLVL, 10), S = process.env.DEVSTAGE === 'final' ? 'player.story.stages.findIndex((x) => x.id === "confrontation")' : (/^[a-z_]+$/.test(process.env.DEVSTAGE || '') ? 'player.story.stages.findIndex((x) => x.id === "' + process.env.DEVSTAGE + '")' : parseInt(process.env.DEVSTAGE || '-1', 10));
      ev(win, `while (player.level < ${L}) { levelUp(); } player.hp = player.maxHp; for (let k = 0; k < 400 && (player.statPoints || 0) > 0; k++) __B.spendPoints(); __B.spendTalents(); player.gold += 20000;` + (process.env.DEVPOS ? `player.x=${process.env.DEVPOS.split(',')[0]};player.y=${process.env.DEVPOS.split(',')[1]};try{loadChunksAround&&loadChunksAround()}catch(e){}` : '') + (process.env.DEVSPELLS ? `for (const id of ${JSON.stringify((process.env.DEVSPELLS || '').split(','))}) if (!player.knownSpells.includes(id)) player.knownSpells.push(id);` : '') + (S !== -1 ? `for (let i = 0; i < ${S}; i++) { player.story.stages[i].done = true; } player.story.stageIndex = ${S};` : ''), 60000);
    } : null;
    const lives = parseInt(process.env.LIVES || '1', 10); let r = null, spent = 0; const budget = parseInt(process.env.SECS || '120', 10);
    for (let life = 1; life <= lives; life++) { // a character that dies is replaced by a new one (same world seed), until the time budget is gone
      r = await playLife({ prep, seed, maxTicks: parseInt(process.env.TICKS || '30000', 10), maxSeconds: Math.max(10, budget - spent), log: console.log, stopOnIdle: !!process.env.STOP, statusEvery: parseInt(process.env.STATUS || '0', 10), beatSecs: parseInt(process.env.BEAT || '0', 10) });
      spent += r.seconds || 0; if (r.outcome !== 'died' || budget - spent < 30) break; console.log('  inv: ' + r.inv); console.log('  death trace: ' + (r.trace || []).slice(-12).join(' ; ') + '\n  deathLog: ' + JSON.stringify(r.deathLog)); console.log('LIFE ' + life + ' ended in death at level ' + (r.final && r.final.lvl) + ' (' + (r.final && r.final.cause) + '); starting life ' + (life + 1));
    }
    console.log(r.outcome, JSON.stringify(r.final), r.seconds.toFixed(0) + 's');
    console.log(JSON.stringify(r.counts));
    try { console.log('travel failures: ' + (r.why || '')); } catch (e) { /* */ }
    if (r.diagText) console.log(r.diagText);
    if (r.loops && r.loops.length) console.log(r.loops.join('\n'));
    if (r.events) console.log((process.env.EV ? r.events.filter((e) => new RegExp(process.env.EV).test(e)).slice(-40) : r.events.slice(-12)).join('\n'));
    if (process.env.TRACE && r.trace) console.log(r.trace.join('\n'));
    if (r.deathLog) console.log(r.deathLog.join('\n'));
    process.exit(0);
  })();
}
