#!/usr/bin/env node
// ============================================================================================
// playtest.js -- Automated Playtest Toolkit for "Lucid Dreams of Roguelike" (single-file build)
// ============================================================================================
//
// Headless automated playtester: boots the game's real, unmodified JS engine (via jsdom),
// drives a character through actual turns using the game's own input handler, and reports
// crashes, soft-locks, and behavioral/balance anomalies it observes.
//
// USAGE:
//   npm install jsdom
//   node playtest.js [numLives] [maxActionsPerLife] [maxStuckActionsBeforeGivingUp]
//   e.g. node playtest.js 20 8000 500     (defaults: 10 / 8000 / 600)
//
// GAME FILE LOCATION: auto-detected (see locateGameHtml() in SECTION 1 below) -- just drop
// this script and the game's .html file (any name) in the same folder, or the game's default
// game/game.html layout also still works. Writes report.json next to this script.
//
// ---- FILE MAP (this used to be 5 separate files; all content is preserved, just
// concatenated in dependency order and with require()/module.exports stripped) ----
//   SECTION 1: harness    -- boots the game in jsdom (canvas/audio stubbed, everything else real)
//   SECTION 2: gameApi    -- low-level wrapper: eval into game scope, press keys, wait for
//                            interval-driven commands, read common state
//   SECTION 3: navigation -- exploration/travel logic
//   SECTION 4: strategies -- one function per behavior (fight, heal, equip, shop, craft, talk...)
//   SECTION 5: bot        -- main driver: composes strategies into full playthroughs, writes
//                            report.json, and is what actually runs when you execute this file
//   (SECTION 5's own header comment below has the full coverage table and "adapting to a
//   changed game" guidance -- read it before assuming something needs rewriting.)
//
// ---- TWO THINGS TO UNDERSTAND BEFORE MODIFYING THIS FILE (full detail inline at point of use) ----
//   1. The game's top-level `let`/`const` (player, gameState, RECIPES, ...) are NOT properties
//      of `window` -- only function declarations are. Always read/call game state via
//      `win.eval('...')` (see evalGame() in SECTION 2), never `win.player` etc.
//   2. `autoExplore`('X'), `autoTravelToStairs`('G'), and `rest`('r') are setInterval-driven
//      in the real game (for smooth real-browser animation), NOT instant. Pressing one and
//      immediately checking state will look like it did nothing. Always use keyAndWait()
//      (SECTION 2) for these three specific keys, never bare key(win, ...). The exact same
//      "looks like it did nothing" shape of bug also hit spellcasting later (SECTION 4's
//      tryCastOffensiveSpell comment has the full story) -- multi-step interactions
//      (real-time OR multi-keypress aim-then-confirm) are the recurring trap in this codebase.
//
// ---- ADAPTING TO A CHANGED/UPDATED GAME (short version -- SECTION 5's header has the full version) ----
//   New content using existing systems (monsters/items/recipes/maps/NPCs/spells) needs NO
//   changes -- strategies query live game data, not a hardcoded list. A wholly new *system*
//   with its own gameState value will just get closed generically (safe, but untested) --
//   check the "UNRECOGNIZED GAME STATES ENCOUNTERED" section printed after every run (and
//   report.summary.unrecognizedStates) to see if that happened, then add a strategy for it if
//   it's worth testing. Only a genuine architecture change to the game (no longer a single
//   global-scope script, simulateKey() removed, off Canvas2D/WebAudio) would require reworking
//   SECTIONS 1-2's core mechanics rather than just adding a strategy.
//
// ============================================================================================

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');


// ==========================================================================================
// SECTION 1: HARNESS (boot the game in jsdom)
// ==========================================================================================

// Boots the game's actual HTML/JS in a headless jsdom environment, with the canvas 2D
// context and Web Audio API stubbed out (this game has no build step and no test mode --
// it's a single HTML file that expects a real browser). Everything else -- game logic,
// combat, inventory, world generation -- runs completely unmodified.
//
// WHY STUBS ARE NEEDED:
//   - <canvas id="canvas"> is used for the map/dungeon rendering. jsdom has no real
//     canvas 2D implementation, so `canvas.getContext('2d')` would throw. We patch
//     HTMLCanvasElement.prototype.getContext to return a no-op context with every method
//     the game calls (fillRect, drawImage, measureText, etc.). This means NOTHING is
//     visually rendered, but every call the game makes into the canvas API succeeds
//     silently, so game logic that happens to run inside a render function still executes.
//   - window.AudioContext doesn't exist in jsdom. The game's Sound module creates one
//     lazily on first real sound event. We stub AudioContext with no-op nodes so any
//     Sound.play(...) call succeeds without throwing.
//
// WHAT IS NOT STUBBED (i.e. is the real thing):
//   - All game logic: combat math, world/dungeon generation, quests, crafting, dialogue,
//     itemization, save/load, everything in the ~31k line script.
//   - localStorage (jsdom implements this natively when a URL is set).
//   - setTimeout/setInterval (real Node timers -- see the "IMPORTANT" note in gameApi.js
//     about why this matters for autoExplore/rest).

const GAME_HTML_PATH = path.join(__dirname, 'game', 'game.html');

/**
 * Locates the game's HTML file without assuming a fixed name or folder layout, since this
 * toolkit is meant to be dropped alongside the game file however the person happens to have
 * it (e.g. "lucid_dreams_of_roguelike.html" sitting next to this script, not necessarily
 * renamed to game.html or nested in a game/ subfolder). Search order:
 *   1. The explicit path passed to boot(), if any (always wins).
 *   2. The conventional ./game/game.html location (kept for backward compatibility with the
 *      layout this toolkit originally shipped with).
 *   3. Any *.html file directly in this script's own directory (__dirname) or its immediate
 *      parent -- these are the two places a dragged-in file realistically ends up relative
 *      to where this script itself was saved, regardless of what it's named.
 *   4. Any *.html file in the current working directory (covers running this from wherever
 *      `node playtest.js` was invoked, if that differs from __dirname).
 * If exactly one HTML file turns up across all of these (after excluding this toolkit's own
 * output like report.json, which isn't HTML anyway), it's used automatically. If more than
 * one is found, the one whose content actually looks like this game (contains the
 * `simulateKey(` test hook every strategy in this toolkit depends on -- see the big comment
 * in SECTION 2/gameApi.js) is preferred; if that still doesn't narrow it to one, or if none
 * are found at all, this throws a clear error listing every candidate path it checked and
 * what it found there, rather than a bare ENOENT -- see that error message first if boot()
 * fails.
 */
function locateGameHtml(explicitPath) {
  if (explicitPath) return explicitPath;
  if (fs.existsSync(GAME_HTML_PATH)) return GAME_HTML_PATH;

  const searchDirs = [__dirname, path.join(__dirname, '..'), process.cwd()];
  const seen = new Set();
  const candidates = [];
  for (const dir of searchDirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.html')) continue;
      const full = path.resolve(dir, entry);
      if (seen.has(full)) continue;
      seen.add(full);
      candidates.push(full);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not find the game's HTML file. Looked for:\n` +
      `  - ${GAME_HTML_PATH} (conventional location)\n` +
      `  - any *.html file in: ${searchDirs.join(', ')}\n` +
      `Fix: either place the game's .html file in one of those locations, or call ` +
      `boot('/exact/path/to/the-game.html') explicitly.`
    );
  }
  if (candidates.length === 1) return candidates[0];

  // Multiple .html files found -- disambiguate by checking which one actually looks like
  // this game (has the simulateKey test hook everything in this toolkit calls through).
  const looksLikeGame = candidates.filter((p) => {
    try { return fs.readFileSync(p, 'utf8').includes('function simulateKey('); }
    catch (e) { return false; }
  });
  if (looksLikeGame.length === 1) return looksLikeGame[0];

  throw new Error(
    `Found multiple .html files and couldn't tell which one is the game:\n` +
    `${candidates.map((p) => '  - ' + p).join('\n')}\n` +
    `Fix: call boot('/exact/path/to/the-game.html') explicitly, or remove the extra .html ` +
    `file(s) from the search directories (${searchDirs.join(', ')}).`
  );
}

function makeStubCtx() {
  const noop = () => {};
  return {
    fillRect: noop, clearRect: noop, strokeRect: noop,
    fillText: noop, strokeText: noop,
    measureText: (t) => ({ width: (t ? String(t).length : 0) * 6 }),
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, fill: noop, stroke: noop, save: noop, restore: noop,
    translate: noop, scale: noop, rotate: noop, drawImage: noop,
    setTransform: noop, createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: [] }),
    putImageData: noop, createPattern: () => null,
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set font(v) {}, get font() { return '10px sans-serif'; },
    set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set textAlign(v) {}, get textAlign() { return 'left'; },
    set textBaseline(v) {}, get textBaseline() { return 'top'; },
    set shadowColor(v) {}, get shadowColor() { return '#000'; },
    set shadowBlur(v) {}, get shadowBlur() { return 0; },
  };
}

function makeStubAudioContext() {
  const noop = () => {};
  const fakeParam = () => ({ value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop, cancelScheduledValues: noop });
  const fakeNode = () => ({ connect: noop, disconnect: noop, gain: fakeParam(), frequency: fakeParam(), Q: fakeParam(), type: 'sine', start: noop, stop: noop, buffer: null });
  return function AudioContextStub() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.createGain = () => fakeNode();
    this.createOscillator = () => fakeNode();
    this.createBiquadFilter = () => fakeNode();
    this.createBufferSource = () => fakeNode();
    this.createBuffer = () => ({ getChannelData: () => new Float32Array(1) });
    this.createDynamicsCompressor = () => ({ ...fakeNode(), threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(), attack: fakeParam(), release: fakeParam() });
    this.resume = noop;
    this.close = noop;
  };
}

/**
 * Boots a fresh instance of the game. Each call creates an independent jsdom window/realm --
 * boot() again for each new "life"/character rather than trying to reset state on one instance.
 * @param {string} [htmlPath] optional override path to the game HTML file.
 * @returns {Promise<import('jsdom').JSDOM>} the booted JSDOM instance. Use dom.window.eval(...)
 *   to read/call anything in the game's global scope (see gameApi.js).
 */
// Resolved once (on first boot() call without an explicit path) and cached, so the
// filesystem search in locateGameHtml() doesn't re-run on every single life -- boot() can be
// called hundreds of times in one run.
let _resolvedGameHtmlPath = null;

async function boot(htmlPath) {
  const resolvedPath = htmlPath || (_resolvedGameHtmlPath = _resolvedGameHtmlPath || locateGameHtml());
  let html = fs.readFileSync(resolvedPath, 'utf8');

  // Strip the Google Fonts @import: jsdom will otherwise try to fetch it over the network
  // on every boot, which fails (no network / no need for it -- the game works fine with
  // its fallback fonts) and spams noisy stack traces to stderr on every single life.
  html = html.replace(/@import\s+url\(['"]https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g, '');

  const dom = new JSDOM(html, {
    url: 'http://localhost/game.html',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return makeStubCtx(); };
      window.AudioContext = makeStubAudioContext();
      window.webkitAudioContext = window.AudioContext;
      window.scrollTo = () => {};
      window.confirm = () => true;   // auto-accept any confirm() dialog (e.g. "quit to title?")
      window.alert = () => {};
    },
  });

  // Silence jsdom's "Not implemented"/resource-loading console noise (CSS @import font
  // fetch failures over the network, etc.) -- these are expected and harmless (the game
  // works fine without external fonts/CSS). jsdom emits these on multiple virtualConsole
  // event types depending on the failure path, so cover all of them rather than just
  // 'jsdomError'.
  if (dom.virtualConsole) {
    ['jsdomError', 'error', 'warn'].forEach((evt) => dom.virtualConsole.on(evt, () => {}));
  }

  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve);
    setTimeout(resolve, 500); // safety net in case 'load' never fires
  });

  return dom;
}

// ==========================================================================================
// SECTION 2: GAME API (low-level wrapper around eval/simulateKey)
// ==========================================================================================

// A wrapper layer around the raw jsdom window, giving programmatic access to the game's
// internal state and functions. Read README.md first -- it explains the two core tricks
// this file depends on (window.eval reaching `let`/`const` globals, and simulateKey()).
//
// Design principle: prefer calling the GAME'S OWN internal functions over reimplementing
// game logic externally. E.g. to check "can I afford this", read player.gold and the
// item's price the same way the game's own trade code does, rather than guessing. When
// adding new capabilities, grep game/game.html for the relevant `function xyz(...)` first --
// there is almost always an existing function to call via run()/evalGame() rather than a
// need to hand-roll it here.

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/**
 * Evaluate a JS expression/statement inside the game's global scope.
 * Returns { ok: true, value } on success or { ok: false, error } if it threw.
 * Because the game's top-level `let`/`const` declarations are NOT properties of `window`
 * (they're global-lexical bindings, not globalThis properties), you cannot read them via
 * `dom.window.player` -- you MUST go through window.eval(), which runs in the same
 * global-lexical scope and can see them. Function DECLARATIONS (e.g. `function foo(){}`)
 * *are* attached to window and could be called directly, but using evalGame() everywhere
 * is simpler and uniform.
 */
function evalGame(win, code) {
  try {
    return { ok: true, value: win.eval(code) };
  } catch (e) {
    return { ok: false, error: (e && e.stack) || String(e) };
  }
}

/**
 * Press a key exactly as the real game's keyboard handler would receive it, via the
 * game's own `simulateKey(key)` test hook (grep game.html for `function simulateKey` --
 * the developer already built this in for testing, it's not something we added).
 * `key` should match what handleKey() expects: single characters ('h','j','g','r','X'...),
 * or named keys ('Escape', 'Tab').
 */
function key(win, k) {
  return evalGame(win, `simulateKey(${JSON.stringify(k)})`);
}

/**
 * *** READ THIS BEFORE CALLING autoExplore ('X'), autoTravelToStairs ('G'), or rest ('r') ***
 *
 * Unlike almost every other action in the game (movement, attacks, item use -- all
 * synchronous, one endTurn() per call), these three commands animate themselves in the
 * real browser using setInterval() at 15-20ms per tick (see runAutoLoop() and doRest() in
 * game.html), so a human sees the map/HP update smoothly instead of jumping instantly to
 * the end state. This is invisible in a real browser but WILL BITE YOU here: if you press
 * 'X' and immediately check turnCount, nothing will have happened yet, because Node's
 * event loop hasn't had a chance to run any interval callbacks -- synchronous code never
 * yields control. Worse: the game treats ANY keypress while an auto-action is running as
 * "interrupt it" (see the `autoRunActive` check at the top of handleKey), so firing a
 * second key immediately after the first will just cancel it before it ever ticks, which
 * looks exactly like "the command did nothing" and is very easy to misdiagnose as a game
 * bug (a prior version of this toolkit did exactly that -- see CHANGELOG in README).
 *
 * The fix: await waitForAutoAction() after triggering one of these three, which polls
 * `autoRunActive` and only returns once the game itself has cleared it (finished, hit a
 * threat, or hit its own internal turn cap).
 */
async function waitForAutoAction(win, maxMs = 4000) {
  const start = Date.now();
  await sleep(20); // let the interval actually get scheduled/start
  while (evalGame(win, 'autoRunActive').value === true) {
    if (Date.now() - start > maxMs) {
      evalGame(win, 'autoRunActive = false'); // force-stop; don't leave a dangling interval
      break;
    }
    await sleep(25);
  }
  await sleep(10); // let the final render()/clearInterval settle
}

/** Press a key and, if it started an interval-driven auto-action, wait for it to finish. */
async function keyAndWait(win, k, maxMs = 4000) {
  const r = key(win, k);
  await waitForAutoAction(win, maxMs);
  return r;
}

// ---------------------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------------------

/** Snapshot of the most commonly-needed player/game state, as plain data (safe to log/JSON). */
function getState(win) {
  const r = evalGame(win, `
    JSON.stringify({
      gameState: gameState,
      turnCount: turnCount,
      alive: player.alive,
      hp: player.hp, maxHp: player.maxHp,
      mp: player.mp, maxMp: player.maxMp,
      level: player.level, xp: player.xp,
      gold: player.gold,
      x: player.x, y: player.y,
      isDungeon: curIsDungeon(),
      bleedTurns: player.bleedTurns||0, bleedStacks: player.bleedStacks||0,
      species: (getSpecies(player.speciesId)||{}).name,
      scenario: player.scenario,
      invCount: player.inventory.length,
      knownRecipeCount: (player.knownRecipes||[]).length,
      activeQuestCount: (player.quests||[]).filter(q=>!q.done).length,
    })
  `);
  if (!r.ok) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}

function getInventorySummary(win) {
  const r = evalGame(win, `
    JSON.stringify(player.inventory.map(it => ({
      name: it.name, type: it.type, slot: it.slot,
      dmg: it.dmg||0, armor: it.armor||0,
      recipeId: it.recipeId || null,
    })))
  `);
  if (!r.ok) return [];
  try { return JSON.parse(r.value); } catch (e) { return []; }
}

/** Are there any living monsters in the 8 tiles adjacent to the player? */
function nearbyMonster(win) {
  return evalGame(win, `
    (function(){
      const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
      for (const [dx,dy] of dirs) {
        const t = entityAt(player.x+dx, player.y+dy);
        if (t && t.kind === 'monster') return true;
      }
      return false;
    })()
  `).value === true;
}

/** Direction key (h/j/k/l/y/u/b/n) toward the first adjacent monster found, or null. */
function directionToAdjacentMonster(win) {
  return evalGame(win, `
    (function(){
      const dirs = [['h',-1,0],['l',1,0],['k',0,-1],['j',0,1],['y',-1,-1],['u',1,-1],['b',-1,1],['n',1,1]];
      for (const [k,dx,dy] of dirs) {
        const t = entityAt(player.x+dx, player.y+dy);
        if (t && t.kind === 'monster') return k;
      }
      return null;
    })()
  `).value;
}

/**
 * Generic reader/resolver for the game's presentChoice() menus (gameState 'choice').
 * presentChoice() is the game's own catch-all for "here are N labeled options, pick one" --
 * used for container interactions (open/pick-lock/force-open), item pickup ("take
 * everything"), fishing, salvaging, "talk to whom?" when multiple NPCs are adjacent, called-
 * shot target selection, and any other one-off menu content authors add later. Rather than
 * hardcoding which letter means what (which breaks the moment the option list's *order*
 * changes, e.g. a locked vs. unlocked container produces a different first option), this
 * reads the actual live label text and matches it against caller-supplied preference regexes
 * -- the same "query live data, don't hardcode" principle the rest of this toolkit follows.
 * Returns the label text it chose, or null if there was nothing to choose (gameState wasn't
 * 'choice', or it had no options).
 */
function readPendingChoiceLabels(win) {
  const r = evalGame(win, `JSON.stringify((typeof pendingChoiceOptions !== 'undefined' && pendingChoiceOptions || []).map(o => o.label))`);
  if (!r.ok) return [];
  try { return JSON.parse(r.value || '[]'); } catch (e) { return []; }
}

/**
 * `prefer`: ordered array of regexes; the first label matching the first regex wins, else the
 * first label matching the second regex, etc. `avoid`: labels matching any of these are never
 * chosen unless nothing else is left. Falls back to the first option overall if nothing in
 * `prefer` matches and not everything is in `avoid` (never returns null once options exist --
 * always resolves the menu so the bot can't stall on it).
 */
function resolveChoiceMenu(win, log, { prefer = [], avoid = [], logPrefix = null } = {}) {
  const labels = readPendingChoiceLabels(win);
  if (!labels.length) return null;
  let idx = -1;
  for (const re of prefer) {
    idx = labels.findIndex((l) => re.test(l));
    if (idx !== -1) break;
  }
  if (idx === -1) {
    idx = labels.findIndex((l) => !avoid.some((re) => re.test(l)));
  }
  if (idx === -1) idx = 0;
  key(win, String.fromCharCode(97 + idx));
  if (log && logPrefix) log(`${logPrefix}${labels[idx]}`);
  return labels[idx];
}

// ==========================================================================================
// SECTION 3: NAVIGATION (exploration/travel)
// ==========================================================================================

// Movement/exploration. See gameApi.js's big comment on waitForAutoAction() before touching
// this file -- autoExplore ('X') and autoTravelToStairs ('G') are both interval-driven, not
// instant, and MUST be awaited via keyAndWait, not key().


const MOVE_DIRS = [
  ['h', -1, 0], ['l', 1, 0], ['k', 0, -1], ['j', 0, 1],
  ['y', -1, -1], ['u', 1, -1], ['b', -1, 1], ['n', 1, 1],
];

/**
 * One step of "make progress exploring/traveling". Tries, in order:
 *   1. the game's own autoExplore ('X')
 *   2. the game's own autoTravelToStairs ('G')
 *   3. stairs directly, if standing on them ('>')
 *   4. a WIDE manual pathfind: call the game's own findNearestFrontier()/bfsFirstStep()
 *      directly with a much larger radius than autoExplore's built-in cap (~20 tiles),
 *      for cases like an overworld spawn boxed in by ocean/mountains just past that cap.
 *   5. last resort: commit to a random wander direction for a stretch, so a fully-boxed
 *      dead end (e.g. a small island) doesn't just repeat one blocked step forever.
 * Returns { progressed: boolean, turnCountAfter: number }.
 */
async function exploreStep(win, wanderState) {
  const before = evalGame(win, 'turnCount').value;

  await keyAndWait(win, 'X', 4000);
  if (evalGame(win, 'turnCount').value !== before) return { progressed: true, turnCountAfter: evalGame(win, 'turnCount').value };

  await keyAndWait(win, 'G', 4000);
  if (evalGame(win, 'turnCount').value !== before) return { progressed: true, turnCountAfter: evalGame(win, 'turnCount').value };

  key(win, '>');
  if (evalGame(win, 'turnCount').value !== before) return { progressed: true, turnCountAfter: evalGame(win, 'turnCount').value };

  const far = evalGame(win, 'findNearestFrontier(220)').value;
  if (far) {
    const step = evalGame(win, `bfsFirstStep(player.x, player.y, ${far.x}, ${far.y}, 260)`).value;
    if (step) {
      const dirEntry = MOVE_DIRS.find(([, dx, dy]) => dx === step.dx && dy === step.dy);
      if (dirEntry) {
        key(win, dirEntry[0]);
        if (evalGame(win, 'turnCount').value !== before) return { progressed: true, turnCountAfter: evalGame(win, 'turnCount').value };
      }
    }
  }

  // Last resort: committed random wander (avoids flailing a fresh random direction every
  // single call, which tends to just oscillate against the same wall).
  if (!wanderState.dir || wanderState.stepsLeft <= 0) {
    wanderState.dir = MOVE_DIRS[Math.floor(Math.random() * MOVE_DIRS.length)];
    wanderState.stepsLeft = 15 + Math.floor(Math.random() * 10);
  }
  key(win, wanderState.dir[0]);
  const after = evalGame(win, 'turnCount').value;
  if (after === before) wanderState.stepsLeft = 0; // blocked; pick a new direction next time
  else wanderState.stepsLeft--;

  return { progressed: after !== before, turnCountAfter: after };
}

// ==========================================================================================
// SECTION 4: STRATEGIES (one function per bot behavior)
// ==========================================================================================

// Modular "what should the bot do right now" behaviors, one function per concern.
// The main driver (bot.js) calls these in priority order each action. Each function
// returns true if it took an action this turn (caller should move on to the next loop
// iteration) or false if it declined to act (caller should try the next-lower-priority
// strategy). This makes it easy for another Claude session to add a new strategy: write
// a function with this same signature, and splice it into bot.js's priority list.
//
// COVERAGE STATUS (see README.md "Coverage" section for the full breakdown; see SECTION 5's
// header for the fuller version of this list):
//   Solid:      movement, exploration, PROACTIVE supply-seeking travel when curatives run low
//               (not just opportunistic restocking), ranged AND melee AND called-shot combat,
//               proactive retreat from a monster that could nearly one-shot the player (before
//               it lands) plus reactive retreat once critically hurt, equip-upgrades, resting,
//               healing/bleed response, item pickup INCLUDING containers (lockpick/force-open/
//               take-all, handles multiple containers per tile correctly), full-pass shopping
//               (restock+sell+lockpick in one visit), basic crafting, character-growth (stat
//               points, talent points, cybernetic installs, eldritch rituals), training NPCs,
//               occasional gift-giving, custom point-buy character creation (alternates with
//               random-archetype creation across lives), quest-aware navigation for kill_boss/
//               dungeon_tier/dimension_trail main-quest stages AND boss_bounty side quests.
//   Best-effort: dialogue (Trade/Train/Gift > quest-turn-in > substantive/non-hostile option >
//               escape -- "Attack" is deliberately excluded from the random pick, see SECTION
//               5's coverage notes for why), quest acceptance (accepts simple board/NPC quest
//               offers when presented as a plain choice menu; kill-N-of-species quests track
//               automatically on any matching kill rather than being deliberately hunted, since
//               they have no fixed location to path toward).
//   Not implemented (documented hooks below, left for extension): crafting deliberately toward
//               a specific gear upgrade, farming, deliberate companion "send to tile" commands
//               (companions already fight/follow/disengage fully autonomously on their own --
//               see companionFollowAI in game.html -- so this is a small remaining gap, not a
//               missing system).


// ---------------------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------------------

/**
 * Shared "step away from the nearest adjacent hostile" pathing used by both
 * tryAvoidOverwhelmingMonster and tryFleeIfCritical: picks the open, walkable adjacent tile
 * that maximizes distance from any currently-adjacent monster. Returns a movement key, or null
 * if boxed in with nowhere to retreat.
 */
function bestRetreatStep(win) {
  return evalGame(win, `
    (function(){
      const dirs = [['h',-1,0],['l',1,0],['k',0,-1],['j',0,1],['y',-1,-1],['u',1,-1],['b',-1,1],['n',1,1]];
      let bestKey = null, bestDist = -1;
      for (const [k,dx,dy] of dirs) {
        const nx = player.x+dx, ny = player.y+dy;
        if (!curWalkable(nx,ny) || entityAt(nx,ny)) continue;
        let minD = Infinity;
        const dirs8 = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
        for (const [ddx,ddy] of dirs8) {
          const ent = entityAt(player.x+ddx, player.y+ddy);
          if (ent && ent.kind === 'monster') { const dd = chebyshev(nx,ny, player.x+ddx, player.y+ddy); if (dd < minD) minD = dd; }
        }
        if (minD > bestDist) { bestDist = minD; bestKey = k; }
      }
      return bestKey;
    })()
  `).value;
}

/**
 * Retreat from an adjacent monster whose potential single hit could take a huge chunk of the
 * player's CURRENT hp, rather than reflexively bump-attacking anything adjacent regardless of
 * how it's statted. Every monster instance carries a live `atk: [min,max]` roll range set at
 * spawn time (see makeMonster in game.html -- scaled off depthScale, not a fixed per-species
 * number), so an out-of-depth wanderer or a dungeon monster far past the player's own level
 * shows up here as a real, numeric "this could nearly one-shot me" signal, without hardcoding
 * any monster name or tier. This is what a wary player does BEFORE taking the first hit --
 * tryFleeIfCritical (elsewhere) is the reactive version once already hurt, and this is the
 * proactive one, added after testing surfaced exactly the failure mode it's missing prevented:
 * multiple otherwise-healthy characters one-shot by a single monster their build had no way to
 * have seen coming or recovered from once it landed.
 * Threshold uses atk[1] (the roll's max) times a conservative crit-ceiling estimate against
 * CURRENT hp (not max hp) -- what matters is whether the hit on the table right now could take
 * out most of what's actually left, not some fixed fraction of a full health bar.
 */
async function tryAvoidOverwhelmingMonster(win, log) {
  const danger = evalGame(win, `
    (function(){
      const dirs8 = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
      let worst = 0;
      for (const [dx,dy] of dirs8) {
        const m = entityAt(player.x+dx, player.y+dy);
        if (m && m.kind === 'monster' && m.alive) {
          const maxHit = (m.atk ? m.atk[1] : 0) * 1.8; // rough crit-ceiling estimate
          if (maxHit > worst) worst = maxHit;
        }
      }
      return worst;
    })()
  `).value;
  if (!danger) return false;
  const hp = evalGame(win, 'player.hp').value;
  if (typeof hp !== 'number' || danger < hp * 0.6) return false;

  const step = bestRetreatStep(win);
  if (!step) return false; // boxed in -- fall through and fight
  const before = evalGame(win, 'turnCount').value;
  key(win, step);
  const after = evalGame(win, 'turnCount').value;
  if (after !== before) { if (log) log(`Retreated from an overwhelming threat (potential hit ~${Math.round(danger)} vs ${hp} hp).`); return true; }
  return false;
}

/**
 * When curatives are running low and there's no immediate danger, proactively travel toward
 * the nearest ALREADY-DISCOVERED settlement to restock, using the game's own auto-travel
 * feature (key 'H' -> autoTravelHome() -> nearestSettlement() + bfsFirstStep(), the exact
 * mechanism a human clicking "travel home" would use) rather than a bespoke pathfinder
 * duplicated here. autoTravelHome()'s own driver (runAutoLoop) already halts itself safely if a
 * hostile comes into view or a bleed starts mid-route (see its guards in game.html) -- so this
 * is safe to fire with imperfect information about what's ahead; the game's own travel logic
 * handles interruption, this just has to press the key and wait for the resulting multi-tick
 * interval-driven walk to finish (reusing waitForAutoAction, same mechanism doRest already uses
 * -- see the file header's "interval-driven commands" note for why this pattern matters).
 * No-ops (0 turns spent, returns false) if no settlement has been discovered yet -- ordinary
 * exploration naturally discovers one over time, at which point this starts being useful.
 * This directly targets the single biggest surviving cause of death found in testing:
 * characters running out of bandages long before ever crossing paths with a merchant, because
 * the rest of this bot only shops opportunistically (see tryShopIfTrading) when a merchant
 * happens to be adjacent, rather than ever deliberately going to find one.
 */
const SUPPLY_SEEK_THRESHOLD = 2; // travel to restock once curatives on hand drop below this
async function trySeekSupplies(win, log) {
  const curatives = evalGame(win, `player.inventory.filter(it => it.type==='consumable' && (it.effect==='heal'||it.effect==='bandage'||it.healAmount||it.hpRestore||/heal|bandage|antidote|potion|elixir|medkit|tonic|salve/i.test(it.name))).length`).value;
  if (typeof curatives !== 'number' || curatives >= SUPPLY_SEEK_THRESHOLD) return false;
  if (nearbyMonster(win)) return false; // let combat/flee handle immediate danger first
  const bleeding = evalGame(win, '(player.bleedTurns||0) > 0').value === true;
  if (bleeding) return false; // autoTravelHome would refuse to even start -- see runAutoLoop's guard

  const beforeTurn = evalGame(win, 'turnCount').value;
  await keyAndWait(win, 'H', 8000);
  const afterTurn = evalGame(win, 'turnCount').value;
  if (afterTurn === beforeTurn) return false; // no settlement discovered yet, or already there
  if (log) log(`Traveling to restock supplies (${curatives} curative(s) on hand).`);
  return true;
}

/**
 * Occasionally take aim before attacking an adjacent monster, exercising the called-shot system
 * (openCalledShotMenu -> presentChoice -> beginCalledShot -> consumed by the very next attack,
 * whichever kind -- see beginCalledShot's comment in game.html). Low frequency and skipped
 * against monsters already at low relative threat (not worth the accuracy penalty called shots
 * cost -- see rollHit -- against something that's dying anyway); this is here to exercise the
 * feature and give tougher fights a sometimes-better tool, not to replace normal attacking.
 * Uses resolveChoiceMenu for the body-part pick like every other choice menu here -- head first
 * (bypass armor) as the generally strongest pick, so this stays correct even if the exact wording
 * or ordering of the three options ever changes.
 */
function tryCalledShot(win, log, chance = 0.15) {
  if (!nearbyMonster(win)) return false;
  if (Math.random() > chance) return false;
  if (evalGame(win, 'player.calledShotTarget').value) return false; // one already queued
  key(win, 'a');
  if (evalGame(win, 'gameState').value !== 'choice') { key(win, 'Escape'); return false; }
  const label = resolveChoiceMenu(win, log, { prefer: [/head/i, /legs/i, /arm/i] });
  if (label && log) log(`Called shot: aimed for ${label}.`);
  return !!label;
}

/** If a monster is adjacent, bump-attack it. Returns true if it acted. */
async function tryFightAdjacent(win) {
  const dir = directionToAdjacentMonster(win);
  if (!dir) return false;
  key(win, dir);
  return true;
}

/**
 * If the equipped hand item is a ranged weapon (bow/crossbow/sling/wand -- anything with
 * `.ranged` truthy, read live off the item rather than a hardcoded name list) and a hostile is
 * within its effective range (fireRangedWeapon uses nearestHostile(7) internally), fire at it
 * via the game's own 'f' key instead of closing to melee. Checked ahead of tryFightAdjacent so
 * a ranged-focused build actually plays like one (kiting/sniping) instead of the bot always
 * walking a bowman into melee range, which is both unrealistic play and worse DPS for that
 * build. Skipped if a monster is already adjacent -- melee is instant and free of any "no
 * target in range" edge case, and there's nothing to be gained by stepping back to shoot
 * something already next to you.
 */
function tryFireRanged(win, log) {
  const hasRanged = evalGame(win, '!!(player.equipment.hand && player.equipment.hand.ranged)').value === true;
  if (!hasRanged) return false;
  if (nearbyMonster(win)) return false; // already adjacent -- let melee handle it
  const hasTarget = evalGame(win, 'typeof nearestHostile === "function" && !!nearestHostile(7)').value === true;
  if (!hasTarget) return false;
  const before = evalGame(win, 'turnCount').value;
  key(win, 'f');
  const after = evalGame(win, 'turnCount').value;
  if (after !== before) { if (log) log('Fired ranged weapon.'); return true; }
  return false;
}

/**
 * Retreat instead of trading blows when a fight is going badly and there's no way to turn it
 * around right now (no heal spell, no curative, can't stanch bleeding). A real player facing
 * lethal odds disengages rather than fighting to the death on principle; without this, the bot
 * always attacks back even at 1 HP against something clearly winning, which is how a lot of the
 * "died to a critical hit while already at critical HP" reports happen. Only fires below a much
 * lower threshold than tryRecoverHp's rest/heal threshold (this is the last resort once
 * genuinely cornered, not the first response to being hurt) and only when melee-adjacent to a
 * threat (a ranged attacker already keeps its distance via tryFireRanged). Moves to the open
 * tile that maximizes distance from the nearest hostile; if fully boxed in with nowhere to
 * retreat, falls through and lets combat proceed (better to swing back than stand still).
 */
async function tryFleeIfCritical(win, log, hpFrac = 0.18) {
  const st = evalGame(win, 'JSON.stringify({hp:player.hp,maxHp:player.maxHp})').value;
  let hp, maxHp;
  try { ({ hp, maxHp } = JSON.parse(st)); } catch (e) { return false; }
  if (typeof hp !== 'number' || typeof maxHp !== 'number' || hp >= maxHp * hpFrac) return false;
  if (!nearbyMonster(win)) return false;

  // If we have any real way to turn this around this turn, don't flee -- use it instead (these
  // are cheap/no-op to check and the caller already tries them at higher priority, but a life
  // total this low is worth double-checking before committing to a retreat that costs a turn).
  const canRecover = evalGame(win, `
    (function(){
      if ((player.bleedTurns||0) > 0 && player.inventory.some(it => it.effect==='bandage' || /bandage/i.test(it.name))) return true;
      const healSpell = (player.knownSpells||[]).map(id=>findAbilityById(id)).some(s=>s && s.type==='heal' && player.mp>=s.mp);
      if (healSpell) return true;
      const healItem = player.inventory.some(it => it.type==='consumable' && (it.effect==='heal' || it.healAmount || /heal|potion|elixir|bandage|medkit/i.test(it.name)));
      return healItem;
    })()
  `).value === true;
  if (canRecover) return false;

  const step = bestRetreatStep(win);
  if (!step) return false; // boxed in -- let normal combat handle it
  const before = evalGame(win, 'turnCount').value;
  key(win, step);
  const after = evalGame(win, 'turnCount').value;
  if (after !== before) { if (log) log(`Fled at critical HP (${hp}/${maxHp}).`); return true; }
  return false;
}

// ---------------------------------------------------------------------------------------
// Spellcasting (generic -- reads player.knownSpells/SPELLS live, no spell names hardcoded)
// ---------------------------------------------------------------------------------------

/**
 * If a hostile is in range and the player knows an affordable 'damage'-type spell, cast the
 * strongest one it can afford instead of closing to melee.
 *
 * IMPORTANT: castSpell() does NOT resolve damage/drain/debuff/execute/smite spells
 * synchronously -- for these types it calls beginTileTargeting() and sets gameState to
 * 'tiletarget', same as a real player aiming a ranged spell at a tile. The actual damage only
 * applies once a target tile is confirmed (confirmTileTarget/quickConfirmTileTarget), which
 * in the real game happens via a mouse click or pressing Enter/Space to "snap to the nearest
 * foe" (see the in-game hint text castSpell logs: "...or press Enter/Space to snap to the
 * nearest foe"). An earlier version of this function called castSpell() and assumed it had
 * resolved, then logged success -- it hadn't: MP was never paid and no turn was consumed, so
 * the bot would re-attempt the "same" cast every subsequent idle turn forever (each attempt
 * re-opening targeting mode, which the bot's own generic 'tiletarget' handling would then
 * immediately cancel via Escape before the next loop iteration, having never turned into a
 * cast at all). This is what that looked like from the report.json logs: dozens of "Cast
 * Firebolt" lines at the exact same turn count, sat right alongside "STUCK" from actual
 * lack of progress -- a bot bug, not a game bug (confirmed by reading castSpell/
 * beginTileTargeting/resolveSpellAtTile directly; nothing about turn/cost payment is
 * actually skipped for these spell types in the real code path a human player uses).
 *
 * Fix: press Enter immediately after castSpell() to confirm/snap onto the nearest foe, the
 * same way a human mashing "cast then confirm" would, and verify MP actually dropped before
 * reporting success.
 */
function tryCastOffensiveSpell(win, log) {
  const r = evalGame(win, `
    (function(){
      const known = (player.knownSpells||[]).map(id => findAbilityById(id)).filter(s => s && s.type==='damage');
      if (!known.length) return null;
      const usable = known.filter(s => player.mp >= s.mp && nearestHostile(s.range));
      if (!usable.length) return null;
      usable.sort((a,b) => ((b.power[0]+b.power[1]) - (a.power[0]+a.power[1])));
      const spell = usable[0];
      const mpBefore = player.mp;
      castSpell(spell.id);
      return { name: spell.name, mpBefore, gsAfter: gameState };
    })()
  `);
  if (!r.ok || !r.value) return false;

  if (r.value.gsAfter === 'tiletarget') {
    key(win, 'Enter'); // snap-confirm onto the nearest foe, same as a human pressing Enter/Space
  }
  const mpAfter = evalGame(win, 'player.mp').value;
  if (mpAfter < r.value.mpBefore) {
    if (log) log(`Cast ${r.value.name}.`);
    return true;
  }
  // MP didn't actually drop -- the cast didn't resolve (e.g. no valid nearest-foe snap target
  // after all, or targeting got cancelled). Don't report success; let the caller fall through
  // to melee/other strategies instead of silently doing nothing this turn.
  return false;
}

/**
 * If HP is low and the player knows an affordable 'heal'-type spell, cast it instead of
 * reaching for an item or resting. Checked by tryRecoverHp before its item/rest fallback.
 */
function tryCastHealSpell(win, log) {
  const r = evalGame(win, `
    (function(){
      const known = (player.knownSpells||[]).map(id => findAbilityById(id)).filter(s => s && s.type==='heal');
      const usable = known.filter(s => player.mp >= s.mp);
      if (!usable.length) return null;
      usable.sort((a,b) => ((b.power[0]+b.power[1]) - (a.power[0]+a.power[1])));
      const spell = usable[0];
      castSpell(spell.id);
      return spell.name;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Cast ${r.value} to heal.`); return true; }
  return false;
}



/**
 * If bleeding, use a Bandage (by item id/name) if one is in inventory. This is checked
 * ahead of the general low-HP threshold below because bleed ticks every turn -- including
 * during rest -- so it's the more urgent problem regardless of current HP%.
 * Returns true if it used a bandage; false if not bleeding or none available (in which case
 * the caller should still know it's bleeding via getState().bleedTurns for its own logging).
 */
async function tryStanchBleeding(win, log) {
  const bleeding = evalGame(win, '(player.bleedTurns||0) > 0').value === true;
  if (!bleeding) return false;
  const r = evalGame(win, `
    (function(){
      const b = player.inventory.find(it => it.effect === 'bandage' || /bandage/i.test(it.name));
      if (!b) return false;
      try { useItem(b); return true; } catch(e){ return 'ERR:'+e.message; }
    })()
  `);
  if (r.ok && r.value === true) { if (log) log('Used a bandage to stop bleeding.'); return true; }
  if (log && r.ok && r.value === false) log('Bleeding with no bandage available.');
  return false;
}

/**
 * Below `hpFrac` of max HP and no monster adjacent: try a curative item first (anything
 * consumable matching common heal-item naming), else rest (async, interval-driven -- see
 * gameApi.waitForAutoAction). Returns true if it took *some* recovery action.
 */
async function tryRecoverHp(win, log, hpFrac = 0.35) {
  const st = evalGame(win, 'JSON.stringify({hp:player.hp,maxHp:player.maxHp})').value;
  let hp, maxHp;
  try { ({ hp, maxHp } = JSON.parse(st)); } catch (e) { return false; }
  if (typeof hp !== 'number' || typeof maxHp !== 'number') return false;
  if (hp >= maxHp * hpFrac) return false;
  if (nearbyMonster(win)) return false; // don't try to rest/quaff mid-fight; let combat handle it

  if (tryCastHealSpell(win, log)) return true;

  const usedItem = evalGame(win, `
    (function(){
      // Match on the item's own declared effect fields first (effect==='heal'/'bandage', or a
      // healAmount/hpRestore-style numeric field), not just name text -- a heal-type consumable
      // added with a flavorful, non-obvious name (e.g. a quest reward or a themed dimension's
      // reskinned potion) wouldn't match the name regex at all, but its data still says what it
      // does. Name regex kept as a fallback for the common case where the data doesn't expose a
      // dedicated field but the name is unambiguous.
      const isHealish = (it) => it.type==='consumable' && (
        it.effect==='heal' || it.effect==='bandage' || it.healAmount || it.hpRestore ||
        /heal|potion|elixir|bandage|medkit|ration|food|tonic|salve/i.test(it.name)
      );
      const heals = player.inventory.filter(isHealish)
        .sort((a,b) => (b.healAmount||b.hpRestore||0) - (a.healAmount||a.hpRestore||0));
      if (!heals.length) return false;
      try { useItem(heals[0]); return true; } catch(e){ return 'ERR:'+e.message; }
    })()
  `);
  if (usedItem.ok && usedItem.value === true) {
    if (log) log(`Used a curative at hp ${hp}/${maxHp}.`);
    return true;
  }

  // doRest() (the game's own 'r' handler) unconditionally refuses to even start while bleeding
  // -- see its comment in game.html: bleed doesn't fade on its own and would just eat through
  // the rest faster than it heals, so it blocks outright rather than starting a doomed loop.
  // That means pressing 'r' here while bleeding (with no bandage -- tryStanchBleeding already
  // ran and failed this same turn, at higher priority) is a genuine no-op: no turn consumed, no
  // state changed. Reporting that as "acted" would leave the bot pressing 'r' forever, unable to
  // rest (blocked) and unable to progress. Falling through to false here lets the caller move on
  // to exploration/shopping instead, which is a bleeding player's only real recourse without a
  // bandage on hand: find one, or a settlement, and accept the bleed damage in the meantime.
  const bleeding = evalGame(win, '(player.bleedTurns||0) > 0').value === true;
  if (bleeding) return false;

  const beforeTurn = evalGame(win, 'turnCount').value;
  await keyAndWait(win, 'r', 6000);
  const afterTurn = evalGame(win, 'turnCount').value;
  const isResting = evalGame(win, 'typeof autoRunActive !== "undefined" && !!autoRunActive').value === true;
  if (afterTurn === beforeTurn && !isResting) return false; // rest refused (danger appeared, etc.)
  return true;
}

// ---------------------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------------------

/** Equip anything in inventory that scores higher than what's currently worn in its slot. */
function tryEquipUpgrades(win, log) {
  const r = evalGame(win, `
    (function(){
      const msgs = [];
      try {
        player.inventory.filter(it=>it.type==='weapon'||it.type==='armor').forEach(it=>{
          const cur = player.equipment[it.slot];
          const itScore = (it.dmg||0)+(it.armor||0)+(it.acc||0);
          const curScore = cur ? (cur.dmg||0)+(cur.armor||0)+(cur.acc||0) : -999;
          if (!cur || itScore > curScore) { equipItem(it); msgs.push(it.name); }
        });
      } catch(e) { msgs.push('ERR:'+e.message); }
      return msgs.join('; ');
    })()
  `);
  if (r.ok && r.value && log) log(`Equipped: ${r.value}`);
  return r.ok && !!r.value;
}

// ---------------------------------------------------------------------------------------
// Character growth: stat points, talent points, cybernetics, training, eldritch ritual
// ---------------------------------------------------------------------------------------
// These all correspond to real player-facing progression systems the earlier version of this
// toolkit left completely untouched by leaving their gameStates in GENERIC_CLOSE_STATES --
// meaning every stat point and talent point a leveling-up character earned just sat unspent
// forever, and cybernetics/training/rituals were never exercised at all. That's the single
// biggest gap for "can this bot build a proper character": a level 20 character that never
// spent a single stat or talent point is not meaningfully built at all, regardless of how well
// combat/exploration otherwise performed.

/**
 * Spend any unspent stat points (player.statPoints, granted +2/level, +3 bonus every 10th --
 * see gainXP in game.html) via the real Character Sheet screen ('c' to open, 1-6 to spend,
 * Escape to close -- see spendStat). Allocation is read live off the character's OWN current
 * build rather than a fixed "always max STR" rule: weights toward CON a little always (nobody
 * regrets more HP), then splits the rest between STR/DEX (if it has any melee/ranged weapon
 * equipped or no spells known) and INT/WIL (if it knows any spells), so a caster-leaning
 * random archetype naturally grows into INT/WIL and a fighter-leaning one grows into STR/DEX,
 * without hardcoding which archetypes exist.
 */
function trySpendStatPoints(win, log) {
  const points = evalGame(win, 'player.statPoints||0').value;
  if (!points) return false;
  key(win, 'c'); // openCharacterSheet
  if (evalGame(win, 'gameState').value !== 'character') { key(win, 'Escape'); return false; }
  const spent = evalGame(win, `
    (function(){
      const isCaster = (player.knownSpells||[]).length > 0;
      const hasMeleeOrRanged = !!(player.equipment.hand && (player.equipment.hand.dmg || player.equipment.hand.ranged));
      // index order matches createStatsKey's keys array: str,dex,int,con,wil,cha (1-6)
      const weights = [
        hasMeleeOrRanged || !isCaster ? 3 : 1, // str
        hasMeleeOrRanged || !isCaster ? 2 : 1, // dex
        isCaster ? 3 : 1,                       // int
        2,                                       // con -- always valuable
        isCaster ? 2 : 1,                       // wil
        1,                                       // cha
      ];
      let spentCount = 0;
      let guard = 0;
      while (player.statPoints > 0 && guard++ < 200) {
        const total = weights.reduce((a,b)=>a+b,0);
        let roll = Math.random() * total, idx = 0;
        for (; idx < weights.length; idx++) { if (roll < weights[idx]) break; roll -= weights[idx]; }
        spendStat(idx);
        spentCount++;
      }
      return spentCount;
    })()
  `);
  key(win, 'Escape');
  if (spent.ok && spent.value) { if (log) log(`Spent ${spent.value} stat point(s).`); return true; }
  return false;
}

/**
 * Spend any unspent talent points (player.talentPoints, granted every 3 levels -- see
 * gainXP) via the real Talents screen ('T' to open). Talents unlock progressively (each may
 * require a level and/or a prerequisite talent already owned -- see TALENTS_V2's `requires`),
 * so this just buys whatever's currently unlocked-and-affordable each visit; a talent that
 * isn't unlocked yet simply won't appear in talentPurchasable (built fresh by renderTalents())
 * until its prerequisites are met on some future visit.
 */
function trySpendTalentPoints(win, log) {
  const points = evalGame(win, 'player.talentPoints||0').value;
  if (!points) return false;
  key(win, 'T'); // openTalents
  if (evalGame(win, 'gameState').value !== 'talents') { key(win, 'Escape'); return false; }
  const bought = evalGame(win, `
    (function(){
      const names = [];
      let guard = 0;
      while (player.talentPoints > 0 && (talentPurchasable||[]).length && guard++ < 50) {
        const t = talentPurchasable[0];
        purchaseTalent(t); // also refreshes talentPurchasable via renderTalents()
        names.push(t.name);
      }
      return names;
    })()
  `);
  key(win, 'Escape');
  if (bought.ok && bought.value && bought.value.length) { if (log) log(`Learned talent(s): ${bought.value.join(', ')}.`); return true; }
  return false;
}

/**
 * Install any known-but-not-installed cybernetics into free slots via the Cybernetics screen
 * ('Y'). Purely additive (never uninstalls anything already worn), so this is safe to call
 * opportunistically -- it only ever does something on the turn right after a new cybernetic
 * was learned/found and a slot happens to be free.
 */
function tryInstallCybernetics(win, log) {
  const canInstall = evalGame(win, `
    (function(){
      if (!player.knownCyberIds || !player.knownCyberIds.length) return false;
      const free = (player.cyberSlots||3) - (player.installedCyber||[]).length;
      if (free <= 0) return false;
      return player.knownCyberIds.some(id => !player.installedCyber.includes(id));
    })()
  `).value === true;
  if (!canInstall) return false;
  key(win, 'Y'); // openCybernetics
  if (evalGame(win, 'gameState').value !== 'cyber') { key(win, 'Escape'); return false; }
  const installed = evalGame(win, `
    (function(){
      const names = [];
      let guard = 0;
      while (player.installedCyber.length < (player.cyberSlots||3) && guard++ < 20) {
        // Rebuild the same flat entries list renderCybernetics()/toggleCyber() use, since
        // installing one shifts the "known, not installed" section's positions.
        const known = player.knownCyberIds.filter(id => !player.installedCyber.includes(id));
        if (!known.length) break;
        const entries = player.installedCyber.map(id => ({kind:'installed',id})).concat(known.map(id=>({kind:'known',id})));
        cyberListCache = { entries };
        const idx = entries.findIndex(e => e.kind === 'known');
        if (idx === -1) break;
        const c = CYBERNETICS.find(x => x.id === entries[idx].id);
        toggleCyber(String.fromCharCode(97 + idx));
        names.push(c ? c.name : entries[idx].id);
      }
      return names;
    })()
  `);
  key(win, 'Escape');
  if (installed.ok && installed.value && installed.value.length) { if (log) log(`Installed cybernetic(s): ${installed.value.join(', ')}.`); return true; }
  return false;
}

/**
 * If standing on a Forbidden Altar (feature 'ritual_altar') with enough HP margin to safely pay
 * the ritual's flat HP cost, occasionally perform the ritual for a chance at a new mutation via
 * the Eldritch screen ('U' then 'r' -- see performRitual). Deliberately low-frequency (a dice
 * roll, not "always ritual on sight") since it's a real risk/reward tradeoff a human player
 * would weigh rather than a strictly-better action to spam every visit -- it costs HP and
 * raises Corruption for a chance (not a guarantee) at a mutation, and repeatedly farming an
 * altar the instant it's found isn't how a real player engages with a "something old takes
 * notice of you" flavored system either.
 */
function tryPerformRitual(win, log, chance = 0.5) {
  const onAltar = evalGame(win, `
    (function(){ if (curIsDungeon()) return false; const t = curTileAt(player.x, player.y); return !!(t && t.feature === 'ritual_altar'); })()
  `).value === true;
  if (!onAltar) return false;
  const hpOk = evalGame(win, 'player.hp > 15 + player.maxHp*0.3').value === true;
  if (!hpOk) return false;
  if (Math.random() > chance) return false;
  key(win, 'U'); // openEldritch
  if (evalGame(win, 'gameState').value !== 'eldritch') { key(win, 'Escape'); return false; }
  const before = evalGame(win, 'player.mutations.length').value;
  key(win, 'r'); // performRitual
  const after = evalGame(win, 'player.mutations.length').value;
  key(win, 'Escape');
  if (log) log(after > before ? 'Performed a ritual at the altar -- gained a mutation.' : 'Performed a ritual at the altar.');
  return true;
}

/**
 * If in dialogue and the NPC offers "Give gift" (see openGiftPicker in game.html), occasionally
 * give away the single cheapest non-essential item on hand -- giveGift() scales affection with
 * item.value (see game.html), so a real player building rapport reaches for a cheap trinket,
 * not their main weapon or their last bandage. "Non-essential" is read live off the player's
 * own state rather than a fixed item-name blocklist: never the equipped item in the slot it
 * occupies (checked against player.equipment directly), and never anything counted as a
 * curative by the same isHealish-style check tryRecoverHp/tryShopIfTrading use, if giving it
 * away would drop the reserve below SHOP_CURATIVE_RESERVE. Low frequency (a real player doesn't
 * hand over a gift literally every single conversation) and skipped entirely if nothing
 * qualifies as safe-to-give -- returning false in that case lets the dialogue handler fall
 * through to its normal option picker instead.
 */
function tryGiftIfOffered(win, log, chance = 0.25) {
  const opts = evalGame(win, `JSON.stringify((dialogueOptions||[]).map(o=>({key:o.key,label:o.label})))`);
  let list = [];
  try { list = JSON.parse(opts.value || '[]'); } catch (e) {}
  const giftOpt = list.find((o) => /gift/i.test(o.label));
  if (!giftOpt) return false;
  if (Math.random() > chance) return false;

  const gift = evalGame(win, `
    (function(){
      const equippedUids = new Set(Object.values(player.equipment).filter(Boolean).map(i => i.uid));
      const isHealish = (it) => it.type==='consumable' && (
        it.effect==='heal' || it.effect==='bandage' || it.healAmount || it.hpRestore ||
        /heal|potion|elixir|bandage|medkit|ration|food|tonic|salve/i.test(it.name)
      );
      const curativeCount = player.inventory.filter(isHealish).length;
      const safe = player.inventory.filter(it =>
        !equippedUids.has(it.uid) && it.type !== 'chest' && it.type !== 'corpse' &&
        !(isHealish(it) && curativeCount <= ${SHOP_CURATIVE_RESERVE})
      ).sort((a,b) => (a.value||0) - (b.value||0));
      return safe.length ? { uid: safe[0].uid, name: safe[0].name } : null;
    })()
  `);
  if (!gift.ok || !gift.value) return false;

  key(win, giftOpt.key); // openGiftPicker
  if (evalGame(win, 'gameState').value !== 'giftpick') { key(win, 'Escape'); return false; }
  const given = evalGame(win, `
    (function(){
      const idx = giftList.findIndex(i => i.uid === '${gift.value.uid}');
      if (idx === -1) return false;
      giveGift(dialogueNPC, giftList[idx]);
      return true;
    })()
  `);
  if (evalGame(win, 'gameState').value !== 'playing') key(win, 'Escape');
  if (given.ok && given.value) { if (log) log(`Gave a gift: ${gift.value.name}.`); return true; }
  return false;
}

/**
 * If a Hack Chip is carried and an adjacent monster is one of the Neo-Kalyx dimension's
 * hackable machine types (turret/drone/android/nanite -- read live off HACKABLE_KALYX_IDS, not
 * duplicated here), convert it to an ally instead of fighting it. Checked ahead of melee combat
 * since it only ever applies in that one specific dimension/monster-type intersection and is
 * strictly better than fighting the same thing (permanent ally instead of a fight).
 */
function tryUseHackChip(win, log) {
  const r = evalGame(win, `
    (function(){
      if (typeof HACKABLE_KALYX_IDS === 'undefined' || !curIsDimension() || player.dimensionId !== 'neo_kalyx') return false;
      const chip = player.inventory.find(it => it.id === 'hack_chip' || /hack chip/i.test(it.name));
      if (!chip) return false;
      const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]];
      const hackable = dirs.some(([dx,dy]) => { const m = entityAt(player.x+dx, player.y+dy); return m && m.kind==='monster' && HACKABLE_KALYX_IDS.has(m.monsterId); });
      if (!hackable) return false;
      useHackChip(chip);
      return true;
    })()
  `);
  if (r.ok && r.value) { if (log) log('Used a Hack Chip on a nearby machine.'); return true; }
  return false;
}

/**
 * If in dialogue and the NPC offers "Learn" (npc.teachSpells/teachRecipes -- see game.html's
 * dialogue option builder), enter training and learn everything currently affordable, cheapest
 * first, the way a player restocking gold for it would rather than learning one thing and
 * leaving. Mirrors tryShopIfTrading's "do the whole pass in one visit" approach. Checked in the
 * dialogue handler ahead of the generic substantive-option picker so a trainer NPC reliably
 * gets used for training, not just randomly talked to and left.
 */
function tryTrainIfOffered(win, log) {
  const opts = evalGame(win, `JSON.stringify((dialogueOptions||[]).map(o=>({key:o.key,label:o.label})))`);
  let list = [];
  try { list = JSON.parse(opts.value || '[]'); } catch (e) {}
  const learnOpt = list.find((o) => /^learn$/i.test(o.label.trim()));
  if (!learnOpt) return false;
  key(win, learnOpt.key); // openTrain
  if (evalGame(win, 'gameState').value !== 'train') { key(win, 'Escape'); return false; }
  const learned = evalGame(win, `
    (function(){
      const names = [];
      let guard = 0;
      while (guard++ < 30) {
        renderTrain(); // rebuilds trainEntries fresh off current knownSpells/knownRecipes
        if (!trainEntries.length) break;
        // cheapest affordable entry first, same "restock efficiently" spirit as the shop pass
        let bestIdx = -1, bestCost = Infinity;
        trainEntries.forEach((e, idx) => {
          const cost = e.kind === 'spell' ? 30 + SPELLS.find(s=>s.id===e.id).mp * 8 : 25;
          if (cost <= player.gold && cost < bestCost) { bestCost = cost; bestIdx = idx; }
        });
        if (bestIdx === -1) break;
        const e = trainEntries[bestIdx];
        const label = e.kind === 'spell' ? SPELLS.find(s=>s.id===e.id).name : RECIPES.find(r=>r.id===e.id).name;
        trainLearn(String.fromCharCode(97 + bestIdx));
        names.push(label);
      }
      return names;
    })()
  `);
  key(win, 'Escape');
  if (log) log(learned.ok && learned.value.length ? `Trained: ${learned.value.join(', ')}.` : 'Visited a trainer (nothing affordable to learn).');
  return true;
}

// ---------------------------------------------------------------------------------------
// Items / pickup
// ---------------------------------------------------------------------------------------

/**
 * Interact with whatever is on the current tile: items, containers (chests/cabinets/vaults),
 * salvageable wrecks, or a fishing spot. Returns true if it took an action.
 *
 * pickUp() (the game's 'g' handler) builds a presentChoice() menu whose CONTENTS and ORDER
 * depend on what's actually here (a locked container contributes two options -- pick lock,
 * force open -- an unlocked one contributes one -- "Open X" -- multiple items contribute one
 * option each plus a "Pick up everything" if there's more than one, etc.), so this reads the
 * live label text via resolveChoiceMenu() rather than assuming a fixed letter means a fixed
 * thing. If the menu opens a container (gameState becomes 'container'), takes everything from
 * it and leaves; if it opened anything else this function doesn't specifically recognize
 * (e.g. a rare bespoke interaction some tile adds), just closes it rather than guessing.
 */
function tryPickUpHere(win, log) {
  // ---- containers: handle every unlocked container with real contents directly via the
  // game's own openContainer()/containerTakeAll(), one tile can hold MULTIPLE containers (e.g.
  // several cabinets in one room), and presentChoice()'s menu lists an "Open X" entry per
  // container using the same generic label regardless of whether it's already empty -- so
  // resolveChoiceMenu's first-match-wins regex has no way to distinguish "the cabinet with
  // loot" from "the cabinet already looted" when both produce the literal label "Open Cabinet".
  // An earlier version of this function went through the menu for this and got stuck reopening
  // the same already-empty container forever whenever a full one shared its tile. Reading
  // containersAt() directly and calling the take functions on each one that actually has
  // contents.length > 0 sidesteps the ambiguity entirely -- both functions are free of any
  // turn cost (see their definitions in game.html; same as trade), so doing several in one
  // pass here is exactly as "free" as a human clicking through a few cabinets in one room.
  const lootedUnlocked = evalGame(win, `
    (function(){
      const names = [];
      const list = containersAt(player.x, player.y).filter(c => !c.locked && c.contents.length > 0);
      for (const c of list) {
        openContainer(c);
        const taken = c.contents.map(i => i.name);
        containerTakeAll();
        names.push(...taken);
      }
      if (list.length) { gameState = 'playing'; closeModal(); }
      return names;
    })()
  `);
  if (lootedUnlocked.ok && lootedUnlocked.value && lootedUnlocked.value.length) {
    if (log) log(`Looted: ${lootedUnlocked.value.join(', ')}.`);
    return true;
  }

  // ---- anything left needing the real menu: a locked container (needs pick-lock/force-open,
  // both of which DO cost a turn -- see attemptPickLock/attemptForceOpen -- so these have to go
  // through the actual keyed flow, one attempt per call here, same as a human would need
  // multiple turns for a stubborn lock), loose items on the tile, or a fishing spot.
  const hasLockedContainer = evalGame(win, 'containersAt(player.x, player.y).some(c => c.locked)').value === true;
  const itemsHere = evalGame(win, 'itemsAt(player.x, player.y).filter(i=>i.type!=="corpse").length').value;
  if (!hasLockedContainer && !itemsHere) return false;

  key(win, 'g');
  const gs1 = evalGame(win, 'gameState').value;

  if (gs1 === 'choice') {
    // Prefer: pick a lock (only offered if we're actually carrying a lockpick -- see
    // attemptPickLock -- so this never wastes a turn fumbling with bare hands when picking
    // isn't really an option) > take everything at once > force a lock open (last-resort on a
    // locked container: no lockpick, so this is the only way in, at the cost of a chance to
    // fail and a possible "crime" flag) > pick up a single named item > salvage a wreck > fish.
    // Deliberately NOT preferring "^open X" here: every unlocked container WITH real contents
    // was already looted directly above, before 'g' was ever pressed -- see the lootedUnlocked
    // block -- so any "Open X" entry still present in this menu can only belong to an
    // already-empty container. An earlier version put that pattern first in this list anyway,
    // which meant it kept "successfully" reopening an empty crate forever every time real loose
    // items ALSO sat on the same tile, since the empty-crate option always won the preference
    // order and the actual items were never reached. Explicitly avoided unless nothing else
    // qualifies: fishing (ties up many turns for a minor food item -- fine as a fallback, not a
    // priority over anything with clearer immediate value).
    resolveChoiceMenu(win, log, {
      prefer: [/pick the lock/i, /pick up everything/i, /force .* open/i, /^pick up /i, /salvage/i],
      avoid: [/fish here/i, /^open /i],
      logPrefix: 'Interacted with tile: ',
    });
  } else if (gs1 !== 'playing' && gs1 !== 'container') {
    // Single option got auto-resolved by presentChoice() itself (real length===1 shortcut), or
    // some other menu opened -- nothing more for us to pick here.
  }

  // If a container is now open, loot it completely, then leave. 'A' = take all (only valid
  // while containerMode is its default 'take'), safe to press unconditionally here since we
  // only reach this branch immediately after opening one.
  if (evalGame(win, 'gameState').value === 'container') {
    key(win, 'A');
    if (log) log('Looted a container.');
    key(win, 'Escape');
  }

  if (evalGame(win, 'gameState').value !== 'playing') key(win, 'Escape');
  return true;
}

// ---------------------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------------------

/**
 * Craft the first known, currently-affordable recipe whose output name matches `wantRegex`
 * (default: curatives). Returns true if something was crafted. Note: player.knownRecipes
 * starts EMPTY for most archetypes (see README "Known limitations") -- this can only craft
 * recipes the character has actually learned from an NPC/scroll/starting kit, exactly like
 * a real player.
 */
function tryCraftUseful(win, log, wantRegex = /heal|bandage|antidote|potion/i) {
  const r = evalGame(win, `
    (function(){
      const rid = (player.knownRecipes||[]).find(id => {
        const rec = RECIPES.find(x=>x.id===id);
        if (!rec) return false;
        const outBase = ITEM_BASES.find(b=>b.id===rec.output.id);
        if (!outBase || !${wantRegex.toString()}.test(outBase.name)) return false;
        return hasIngredients(rec);
      });
      if (!rid) return null;
      craftRecipe(rid);
      return rid;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Crafted via recipe: ${r.value}`); return true; }
  return false;
}

// ---------------------------------------------------------------------------------------
// Shopping (when gameState === 'trade')
// ---------------------------------------------------------------------------------------

/**
 * If currently in a trade screen, do a COMPLETE shopping pass in one visit, the way a real
 * player restocking at a merchant would, rather than one transaction per menu-visit: buy
 * curatives up to a small standing reserve (not just "one if desperately needed"), buy a
 * lockpick if we don't carry one (opens more of tryPickUpHere's container options), then sell
 * every piece of genuinely excess weapon/armor gear (scores strictly worse than what's
 * equipped in the same slot -- same scoring tryEquipUpgrades uses, so this never sells
 * anything an upgrade check would want to keep) plus surplus duplicate curatives beyond the
 * reserve target, for gold to fund the next purchase pass. All of this happens inside a single
 * evalGame() call using the game's own tradeTransact()/repriced values directly (buying and
 * selling here cost no in-game turns -- see tradeTransact in game.html, closeModal() just
 * resets gameState with no endTurn() -- so doing many transactions in one visit is exactly as
 * "free" as a human clicking through several purchases before leaving the counter).
 * Returns true unconditionally (always closes the menu when done, so the caller's turn always
 * counts as "handled" whether or not anything was actually bought/sold).
 */
const SHOP_CURATIVE_RESERVE = 4; // keep at least this many curatives on hand when affordable
function tryShopIfTrading(win, log) {
  if (evalGame(win, 'gameState').value !== 'trade') return false;

  const result = evalGame(win, `
    (function(){
      const npc = dialogueNPC;
      if (!npc || !npc.shop) return null;
      const repMult = repPriceMult(getKingdom(Math.floor(npc.x/CH), Math.floor(npc.y/CH)).key)
        * tradeSpeciesPriceMult(npc) * npcTierPriceMult(npc) * relationshipPriceMult(npc);
      const isCurative = (it) => /heal|bandage|antidote|potion|elixir|medkit|tonic|salve/i.test(it.name);
      const bought = [], sold = [];

      // ---- BUY PASS: top up curatives to the reserve target, cheapest first, then grab a
      // lockpick if we don't have one. Re-reads npc.shop fresh each loop since tradeTransact()
      // splices the bought item out (shifting later indices), rather than computing indices once
      // against a now-stale array.
      tradeMode = 'buy'; tradePage = 0;
      let ownedCuratives = player.inventory.filter(isCurative).length;
      let guard = 0;
      while (ownedCuratives < ${SHOP_CURATIVE_RESERVE} && guard++ < 30) {
        let bestIdx = -1, bestPrice = Infinity;
        npc.shop.forEach((it, idx) => {
          if (!isCurative(it)) return;
          const price = Math.round(it.value * 1.2 * repMult);
          if (price <= player.gold && price < bestPrice) { bestPrice = price; bestIdx = idx; }
        });
        if (bestIdx === -1) break;
        const name = npc.shop[bestIdx].name;
        tradePage = Math.floor(bestIdx / PAGE_SIZE);
        tradeTransact(String.fromCharCode(97 + (bestIdx % PAGE_SIZE)));
        bought.push(name);
        ownedCuratives++;
      }
      if (!player.inventory.some(it => it.id === 'lockpick')) {
        const idx = npc.shop.findIndex(it => it.id === 'lockpick');
        if (idx !== -1) {
          const price = Math.round(npc.shop[idx].value * 1.2 * repMult);
          if (price <= player.gold) {
            tradePage = Math.floor(idx / PAGE_SIZE);
            tradeTransact(String.fromCharCode(97 + (idx % PAGE_SIZE)));
            bought.push('Lockpick');
          }
        }
      }

      // ---- SELL PASS: every weapon/armor that scores worse than what's equipped in its slot,
      // plus curatives beyond the reserve (keeps inventory from filling up with 20 bandages when
      // 4 is plenty). Re-reads the filtered sell list fresh each loop for the same
      // index-shifts-after-removal reason as the buy loop above.
      tradeMode = 'sell'; tradePage = 0;
      guard = 0;
      while (guard++ < 40) {
        const sellList = player.inventory.filter(i => i.type !== 'misc');
        let junkIdx = -1;
        const curativesHeld = sellList.filter(isCurative).length;
        let curativesPassed = 0;
        for (let idx = 0; idx < sellList.length; idx++) {
          const it = sellList[idx];
          if (it.type === 'weapon' || it.type === 'armor') {
            const cur = player.equipment[it.slot];
            if (cur) {
              const itScore = (it.dmg||0)+(it.armor||0)+(it.acc||0);
              const curScore = (cur.dmg||0)+(cur.armor||0)+(cur.acc||0);
              if (itScore < curScore) { junkIdx = idx; break; }
            }
          } else if (isCurative(it)) {
            curativesPassed++;
            if (curativesHeld - curativesPassed >= ${SHOP_CURATIVE_RESERVE} && curativesPassed <= curativesHeld - ${SHOP_CURATIVE_RESERVE}) { junkIdx = idx; break; }
          }
        }
        if (junkIdx === -1) break;
        const name = sellList[junkIdx].name;
        tradePage = Math.floor(junkIdx / PAGE_SIZE);
        tradeTransact(String.fromCharCode(97 + (junkIdx % PAGE_SIZE)));
        sold.push(name);
      }
      return { bought, sold };
    })()
  `);

  if (result.ok && result.value) {
    const { bought, sold } = result.value;
    if (log && bought.length) log(`Bought from shop: ${bought.join(', ')}.`);
    if (log && sold.length) log(`Sold excess gear: ${sold.join(', ')}.`);
  }
  key(win, 'Escape');
  return true;
}

// ---------------------------------------------------------------------------------------
// Dialogue (when gameState === 'dialogue')
// ---------------------------------------------------------------------------------------

/**
 * If currently in dialogue, prefer in order: Trade > a quest/task hub option (keyword match,
 * e.g. the top-level "Work available" menu entry) > an actual quest/task OFFER (detected by
 * the reward-pattern all radiant/personal/bounty offers share: "...(NNg, NNxp)" or similar --
 * see acceptRadiantQuest/offerPersonalQuest/etc. in game.html) > any other substantive,
 * non-declining option chosen AT RANDOM among the substantive ones (this also covers main-
 * quest story CHOICE stages -- presentMainQuestChoice() routes through this exact same
 * dialogue mechanism -- and NPC-rescue/help-style choices; randomizing rather than always
 * picking the first substantive option means running many lives samples different branches
 * instead of the same one every time) > ending the conversation (Talk/Chat/Farewell/Leave/
 * Goodbye -- these close the dialogue back to 'playing') > first option > escape.
 *
 * Ending-conversation is deliberately LOW priority now (it used to be checked right after
 * quest keywords): most non-ending options actually accomplish something (accept a quest,
 * make a story choice, help/attack an NPC), so trying them before giving up on the
 * conversation is what lets this function drive real content instead of just avoiding
 * getting stuck. Getting stuck is still prevented the same way as before -- once nothing
 * matches Trade/quest/substantive, the ending-word tier (or the final opts[0] fallback,
 * which is always eventually a real UI option) still fires, so this can't loop forever.
 */
const DIALOGUE_DECLINE_RE = /never ?mind|nothing|decline|refuse|not now|cancel/i;
const DIALOGUE_ENDING_RE = /^(talk|chat|farewell|leave|goodbye|bye)$/i;
const DIALOGUE_REWARD_OFFER_RE = /\(\+?\d+\s*g[old]*,?\s*\+?\d+\s*xp\)|\(\d+g,\s*\d+xp\)/i;
// Dialogue options that start a fight or otherwise turn a friendly NPC hostile. These are
// EXCLUDED from the random "any substantive option" fallback below, not just deprioritized:
// picking "Attack" at random against whichever NPC the bot happens to be talking to is not
// something a real player does opportunistically, and doing so was directly responsible for
// a wave of early deaths in testing -- a level-1, freshly-created character (especially a
// custom-built one with no starting bandages -- see draftCustomCharacter's comment) picking a
// fight with a random townsperson roughly 1-in-N times it opens a conversation. A quest that
// genuinely requires defeating a specific NPC is something tryAdvanceMainQuest's kill_boss
// handling paths toward as a real dungeon encounter (see its own comment for why), not
// something reached by rolling "Attack" in idle dialogue with strangers.
const DIALOGUE_HOSTILE_RE = /^attack$|^fight$|^duel$|^kill /i;

function tryHandleDialogueIfOpen(win, log) {
  if (evalGame(win, 'gameState').value !== 'dialogue') return false;

  // Training is checked first and separately (not folded into the `pick` chain below) because
  // it opens a whole different gameState ('train') that needs its own multi-purchase pass --
  // see tryTrainIfOffered -- rather than a single simulateKey() press like every other dialogue
  // option here.
  if (tryTrainIfOffered(win, log)) return true;
  if (tryGiftIfOffered(win, log)) return true;

  const optInfo = evalGame(win, 'JSON.stringify((dialogueOptions||[]).map(o=>({key:o.key,label:o.label})))');
  let opts = [];
  try { opts = JSON.parse(optInfo.value || '[]'); } catch (e) {}
  if (!opts.length) { key(win, 'Escape'); return true; }

  const pick =
    opts.find((o) => /trade/i.test(o.label))
    || opts.find((o) => /quest|task|bounty|board/i.test(o.label) && !DIALOGUE_DECLINE_RE.test(o.label))
    || (() => {
      const offers = opts.filter((o) => DIALOGUE_REWARD_OFFER_RE.test(o.label));
      return offers.length ? offers[Math.floor(Math.random() * offers.length)] : null;
    })()
    || (() => {
      const substantive = opts.filter((o) => !DIALOGUE_DECLINE_RE.test(o.label) && !DIALOGUE_ENDING_RE.test(o.label.trim()) && !DIALOGUE_HOSTILE_RE.test(o.label.trim()));
      return substantive.length ? substantive[Math.floor(Math.random() * substantive.length)] : null;
    })()
    || opts.find((o) => DIALOGUE_ENDING_RE.test(o.label.trim()))
    || opts.find((o) => !DIALOGUE_HOSTILE_RE.test(o.label.trim()))
    || opts[0];

  key(win, pick.key);
  if (log) log(`Dialogue: chose "${pick.label}".`);
  return true;
}

/**
 * If adjacent to an NPC we haven't already talked to this life (tracked via `talkedNpcUids`,
 * a Set passed in by the caller), initiate talk. Without this cooldown, a bot that always
 * "talks whenever idle and adjacent to an NPC" will re-open dialogue every single turn
 * forever once one exists nearby, because talking doesn't move the player away from them --
 * an earlier version of this toolkit hit exactly this infinite loop. Trade is intentionally
 * exempt from the cooldown (see bot.js: gameState 'trade' is handled every turn regardless),
 * so a bot can still restock/sell on a later visit even after "talking" once.
 */
function tryTalkToAdjacentNpc(win, log, talkedNpcUids) {
  const r = evalGame(win, `
    (function(){
      const nearby = findAdjacentNPCs();
      for (const n of nearby) if (!(${JSON.stringify([...talkedNpcUids])}.includes(n.uid))) return { uid: n.uid, name: n.name };
      return null;
    })()
  `);
  if (!r.ok || !r.value) return false;
  talkedNpcUids.add(r.value.uid);
  key(win, 't');
  if (!['playing', 'dialogue'].includes(evalGame(win, 'gameState').value)) {
    key(win, 'a'); // "Talk to whom?" choice menu when findAdjacentNPCs() has >1 result
  }
  if (log) log(`Talked to ${r.value.name} (first time).`);
  return true;
}

// ---------------------------------------------------------------------------------------
// Main quest awareness (generic -- reads the game's own curStoryStage()/dungeonRegistry
// live; no quest/boss/dungeon names hardcoded)
// ---------------------------------------------------------------------------------------

/**
 * The game tracks a single main-quest "story" as a sequence of stages with a small, stable
 * type vocabulary (see curStoryStage()/questStageHint() in game.html): 'kill_boss',
 * 'dungeon_tier', 'discover_kingdoms', 'discover_dimension', 'dimension_trail', 'choice',
 * 'auto', 'locked'. This reads that live and, for the two types with a concretely locatable
 * target using registries the game already maintains, steers exploration toward it instead
 * of wandering randomly. Returns a {dx,dy} step direction object, or null if the current
 * stage doesn't have (or doesn't yet have a discovered) concrete target to path toward --
 * callers should fall through to normal exploration in that case, which is also exactly
 * right for 'discover_kingdoms'/'discover_dimension' (the correct action there really is
 * "keep exploring outward", which the existing wide-frontier explore already does) and for
 * 'choice'/'auto'/'locked' (no map target exists; 'choice' is resolved via dialogue --
 * presentMainQuestChoice() routes through gameState 'dialogue', handled by
 * tryHandleDialogueIfOpen -- and 'auto'/'locked' need no player action at all).
 *
 * Deliberately does NOT attempt 'dimension_trail' navigation: reaching an unopened dimension
 * requires either killing a specific gatekeeper boss (already covered organically -- if the
 * bot's normal combat strategy happens to fight that monster, the dimension unlocks) or,
 * for a few dimensions, finding a specific named world structure and using a specific
 * crafted/found item there (DIMENSION_GATE_INFO's 'item_structure'/'discovery' kinds) --
 * there's no existing generic registry of named structures to path toward the way
 * dungeonRegistry covers dungeons, so this is left as a documented gap (see README) rather
 * than a fragile guess.
 */
function getMainQuestNavigationTarget(win) {
  const r = evalGame(win, `
    (function(){
      const stage = curStoryStage();
      if (stage) {
        if (stage.type === 'kill_boss') {
          const themeInfo = (typeof BOSS_DUNGEON_THEME !== 'undefined') ? BOSS_DUNGEON_THEME[stage.targetBossId] : null;
          if (themeInfo) {
            const found = nearestRegisteredDungeonOfTheme(themeInfo.theme, player.x, player.y);
            if (found) return { x: found.dg.x, y: found.dg.y, why: 'kill_boss -> ' + found.dg.name };
          }
          // no early return here -- an undiscovered/free-roaming main-quest boss falls through
          // to the side-quest check below (a boss_bounty side quest pointing at a DIFFERENT,
          // already-discovered dungeon is still worth heading toward this turn) and finally to
          // normal exploration if neither has anything concrete yet.
        } else if (stage.type === 'dungeon_tier') {
          let best = null, bestD = Infinity;
          for (const dg of dungeonRegistry.values()) {
            if (dg.tier !== stage.targetTier) continue;
            const d = chebyshev(player.x, player.y, dg.x, dg.y);
            if (d < bestD) { bestD = d; best = dg; }
          }
          if (best) return { x: best.x, y: best.y, why: 'dungeon_tier -> ' + best.name };
        } else if (stage.type === 'dimension_trail' && typeof DIMENSION_GATE_INFO !== 'undefined') {
          // Mirrors questStageHint()'s own dimension_trail logic in game.html exactly (same
          // three phases, same functions) rather than reimplementing dimension-gate logic from
          // scratch -- if the real hint text can point somewhere concrete, so can this.
          const dimId = stage.targetDimensionId;
          const gate = DIMENSION_GATE_INFO[dimId];
          if ((player.discoveredDimensions || []).includes(dimId)) {
            // Rift found -- once actually inside, hunt the trail Guardian's dungeon theme.
            if ((player.visitedDimensions || []).includes(dimId) && typeof DIMENSION_TRAIL_GUARDIANS !== 'undefined') {
              const guardTheme = DIMENSION_TRAIL_GUARDIANS[dimId] ? DIMENSION_TRAIL_GUARDIANS[dimId].theme : null;
              const found = guardTheme ? nearestRegisteredDungeonOfTheme(guardTheme, player.x, player.y) : null;
              if (found) return { x: found.dg.x, y: found.dg.y, why: 'dimension_trail guardian -> ' + found.dg.name };
            }
            // Rift is open somewhere but no registry tracks exactly where -- same real
            // limitation the game's own hint text has here (it says "find the rift you opened",
            // not a coordinate) -- falls through to exploration, faithfully.
          } else if (gate && gate.bossId) {
            // Covers both 'boss_kill' gates (defeating this boss opens the dimension) and
            // 'item_structure' gates (this boss drops the item needed at the gate structure) --
            // both have a real, locatable dungeon via the same BOSS_DUNGEON_THEME registry
            // kill_boss uses above, so heading there is genuine progress in both cases even
            // though 'item_structure' has a further "use it at the structure" step this can't
            // navigate (the structure's location isn't tracked anywhere queryable -- see the
            // 'discovery' case below for the same honest limitation).
            const themeInfo = BOSS_DUNGEON_THEME[gate.bossId];
            if (themeInfo) {
              const found = nearestRegisteredDungeonOfTheme(themeInfo.theme, player.x, player.y);
              if (found) return { x: found.dg.x, y: found.dg.y, why: 'dimension_trail(' + gate.kind + ') -> ' + found.dg.name };
            }
          }
          // 'discovery'-kind gates (currently just lucid_expanse) have no bossId and no tracked
          // structure location -- the real game's own questStageHint() doesn't give one either
          // (it returns flavor text ending in "somewhere out there"), so faithfully falling
          // through to normal exploration here matches the game's own designed-in mystery
          // rather than fabricating a target the base game deliberately doesn't provide.
        }
      }
      // ---- side quests: any active 'boss_bounty' quest (see makeRadiantQuest et al in
      // game.html -- target is a boss species id, same vocabulary as the main quest's
      // kill_boss.targetBossId) gets the exact same BOSS_DUNGEON_THEME + dungeonRegistry
      // lookup the main quest uses above -- this isn't quest-specific logic, it's "any boss id
      // we know of, go find its dungeon if one's been discovered." Picks the nearest such
      // target across all active boss_bounty quests, not just the first one accepted.
      if (typeof BOSS_DUNGEON_THEME !== 'undefined' && player.quests) {
        let best = null, bestD = Infinity;
        for (const q of player.quests) {
          if (q.done || q.type !== 'boss_bounty' || !q.target) continue;
          const themeInfo = BOSS_DUNGEON_THEME[q.target];
          if (!themeInfo) continue;
          const found = nearestRegisteredDungeonOfTheme(themeInfo.theme, player.x, player.y);
          if (!found) continue;
          const d = chebyshev(player.x, player.y, found.dg.x, found.dg.y);
          if (d < bestD) { bestD = d; best = { x: found.dg.x, y: found.dg.y, why: 'boss_bounty(' + q.target + ') -> ' + found.dg.name }; }
        }
        if (best) return best;
      }
      return null;
    })()
  `);
  return (r.ok && r.value) ? r.value : null;
}

/**
 * If the main quest has a concrete, currently-known map target (see above), take one step
 * toward it via the game's own bfsFirstStep pathfinder; otherwise return false so the caller
 * falls through to normal exploration. This intentionally reuses the exact same pathfinding
 * primitive as the wide-frontier explore fallback in navigation.js, just with a purposeful
 * destination instead of "nearest unexplored tile".
 */
function tryAdvanceMainQuest(win, log) {
  const target = getMainQuestNavigationTarget(win);
  if (!target) return false;
  const already = evalGame(win, `chebyshev(player.x, player.y, ${target.x}, ${target.y})`).value;
  if (already <= 1) return false; // already there -- let stairs/dive/explore-local handle the rest
  const step = evalGame(win, `bfsFirstStep(player.x, player.y, ${target.x}, ${target.y}, 300)`).value;
  if (!step) return false;
  const MOVE_DIRS = [['h',-1,0],['l',1,0],['k',0,-1],['j',0,1],['y',-1,-1],['u',1,-1],['b',-1,1],['n',1,1]];
  const dirEntry = MOVE_DIRS.find(([, dx, dy]) => dx === step.dx && dy === step.dy);
  if (!dirEntry) return false;
  const before = evalGame(win, 'turnCount').value;
  key(win, dirEntry[0]);
  if (evalGame(win, 'turnCount').value === before) return false; // blocked -- let normal explore handle it
  if (log && Math.random() < 0.05) log(`Heading toward main quest target (${target.why}).`); // sampled, not every step
  return true;
}



/**
 * Catch-all for any gameState that isn't one we specifically handle above. Tries Escape
 * first (closes almost every modal cleanly); if that doesn't change state, tries 'a' as a
 * fallback for presentChoice-style menus, matching the game's own convention of listing
 available options as consecutive letters starting at 'a'.
 */
function tryEscapeUnknownMenu(win) {
  const before = evalGame(win, 'gameState').value;
  key(win, 'Escape');
  if (evalGame(win, 'gameState').value !== before) return true;
  key(win, 'a');
  return true;
}

// ==========================================================================================
// SECTION 5: BOT (main driver -- this is what runs)
// ==========================================================================================


// (This section originally did `const nav = require('./navigation')` and
// `const strat = require('./strategies')` to get these two namespace objects; since
// everything is one file now, they're reconstructed here from the plain functions defined
// in SECTIONS 3 and 4 above instead, so the rest of this section's code -- which calls
// `nav.exploreStep(...)` / `strat.tryFightAdjacent(...)` etc. -- doesn't need to change.)
const nav = { MOVE_DIRS, exploreStep };
const strat = {
  tryFightAdjacent, tryFireRanged, tryFleeIfCritical, tryAvoidOverwhelmingMonster, tryUseHackChip,
  tryCalledShot, tryCastOffensiveSpell, tryCastHealSpell, tryStanchBleeding, tryRecoverHp,
  tryEquipUpgrades, tryPickUpHere, tryCraftUseful, tryShopIfTrading, tryTrainIfOffered,
  tryGiftIfOffered, tryHandleDialogueIfOpen, tryTalkToAdjacentNpc, tryAdvanceMainQuest,
  getMainQuestNavigationTarget, tryEscapeUnknownMenu, trySpendStatPoints, trySpendTalentPoints,
  tryInstallCybernetics, tryPerformRitual, trySeekSupplies,
};
// Main autonomous playtest driver. Usage:
//   node bot.js [numLives] [maxActionsPerLife] [maxStuckActions]
//   node bot.js 25 10000 600
//
// Produces report.json (machine-readable) and prints a human-readable summary to stdout.
// See README.md for how to interpret the report and how to extend this for deeper coverage
// (quests, dimension travel, spellcasting, etc.).
//
// ---- TESTING A CHANGED OR UPDATED GAME ----
// This bot does NOT hardcode a list of monsters/items/recipes/dungeons -- most strategies
// query live game data (player.inventory, entityAt(), RECIPES, etc.) and call the game's own
// functions, so new CONTENT added using the game's EXISTING systems (new monster types, new
// items, new recipes, new dimensions/maps, new NPCs, tuned numbers) is exercised automatically
// with zero changes needed here. Just re-run against the updated game.html.
//
// What does need attention after an update: a wholly NEW SYSTEM with its own `gameState`
// value (e.g. a new minigame, a new top-level menu) has no dedicated strategy yet, so the
// bot will just close it generically via strat.tryEscapeUnknownMenu -- safe, but it means
// that feature isn't actually being tested. You don't have to guess whether this happened:
// every run's summary prints an "UNRECOGNIZED GAME STATES ENCOUNTERED" section listing any
// gameState value seen that isn't already in SPECIFICALLY_HANDLED_STATES or
// GENERIC_CLOSE_STATES below. Workflow after a game update:
//   1. Re-run `node bot.js` against the new game.html.
//   2. Check the summary for unrecognized states. None -> nothing new to wire up, you're done.
//   3. For each one found: decide if it's worth deep testing.
//        - If a generic "close it" is fine (a menu with no meaningful choices to explore),
//          just add its name to GENERIC_CLOSE_STATES below so it stops being flagged.
//        - If it's worth actually exercising, add a real strategy function to strategies.js
//          (signature `(win, log) => boolean`, returns true if it acted -- copy the pattern
//          of tryShopIfTrading or tryHandleDialogueIfOpen) and give it a dedicated branch in
//          the main loop below, the same way 'trade' and 'dialogue' are handled.
//
// This only breaks down on a genuine architecture change to the game itself -- e.g. it stops
// being a single global-scope script (moves to modules/a bundler), drops the simulateKey()
// test hook, or switches off Canvas2D/WebAudio. Those would require updating harness.js/
// gameApi.js's core mechanics, not just adding a strategy. See the two big comments below
// ("let/const globals" and "interval-driven commands") for why those specific mechanisms
// are load-bearing.
//
// ---- COVERAGE STATUS ----
//   Solid: character creation (BOTH paths -- "Random archetype" AND full custom point-buy
//     stat/ability/starting-item allocation, alternated across lives, see draftCustomCharacter),
//     movement/exploration (+ wide-radius pathfind fallback past the built-in ~20-tile frontier
//     cap), melee bump-attack AND ranged weapon combat (tryFireRanged -- reads
//     player.equipment.hand.ranged live, no weapon-name hardcoding), called-shot combat
//     (tryCalledShot -- exercises openCalledShotMenu via the generic choice resolver),
//     proactive retreat from a monster whose potential hit could nearly one-shot the player
//     BEFORE taking that hit (tryAvoidOverwhelmingMonster, reads each monster's live atk[] roll
//     range, no name/tier hardcoding) and reactive retreat once already critically hurt with no
//     way to recover (tryFleeIfCritical), offensive/heal spellcasting (reads player.knownSpells
//     live -- see the big comment on tryCastOffensiveSpell for a real two-step-targeting bug
//     this caught and fixed), equip-upgrades, bleed/low-HP response (including the rest-while-
//     bleeding no-op the game itself refuses, and a broader isHealish() check that reads an
//     item's effect/healAmount fields, not just its name), item pickup INCLUDING containers
//     (multiple unlocked containers on one tile handled directly via openContainer()+
//     containerTakeAll(), locked ones via lockpick-if-carried > force-open through the choice
//     menu -- an earlier version got stuck re-opening an already-emptied container forever when
//     a full one shared its tile), full-pass shopping (restocks curatives to a standing reserve
//     AND buys a lockpick AND sells all excess gear in one visit, not one transaction per
//     visit), PROACTIVE supply-seeking (trySeekSupplies -- travels to the nearest discovered
//     settlement via the game's own 'H' autoTravelHome() once curatives run low, rather than
//     only ever restocking opportunistically when a merchant happens to be adjacent -- the
//     single biggest lever found on early-game survival in testing), training NPCs (learns
//     everything affordable in one visit), occasional gift-giving to build NPC affection
//     (tryGiftIfOffered -- always the single cheapest non-essential item on hand, never
//     equipped gear or reserve curatives), stat-point and talent-point spending (both were
//     previously never spent at all -- a leveling character's build was frozen at creation),
//     cybernetic installs, eldritch ritual (mutation gambling at an altar), Neo-Kalyx hack-chip
//     use on hackable machines in place of fighting them, dialogue (prefers Trade/Train/Gift >
//     quest offers > any substantive/non-declining/non-hostile option, chosen at random among
//     ties, over just ending the conversation or picking a random fight -- an earlier version
//     let "Attack" get chosen at random against ordinary NPCs, which was directly responsible
//     for a wave of early deaths in testing; this is also what accepts radiant/personal quest
//     offers AND resolves main-quest story CHOICE stages, since presentMainQuestChoice() routes
//     through the exact same dialogue mechanism), quest-aware navigation covering the main
//     quest's kill_boss/dungeon_tier/dimension_trail stages (the last mirrors questStageHint()'s
//     own three-phase gate logic in game.html: undiscovered dimension -> path to the gate boss's
//     dungeon; discovered-but-not-entered -> no tracked target, same honest limitation the
//     game's own hint text has; entered -> path to the trail Guardian's dungeon theme) AND
//     active boss_bounty side quests (same BOSS_DUNGEON_THEME+dungeonRegistry lookup, picks
//     whichever known target is nearest -- see getMainQuestNavigationTarget).
//   Best-effort: quest acceptance is broad (see dialogue above) but there's no pathfinding to
//     actively pursue a quest's specific objective beyond the boss/dungeon-tier/dimension-trail
//     navigation above -- kill-N-of-species quests (bounty/dimension_bounty/chain_kill/etc.)
//     still track progress automatically on any matching kill the bot's normal combat produces
//     (that's how the game itself works: these targets are a species, not a fixed location, so
//     there's genuinely nowhere concrete to path toward beyond "keep fighting things"), but
//     nothing here deliberately detours toward a specific quest's target species over any other
//     monster encountered. Fishing is reachable (the lowest-priority option in tryPickUpHere's
//     choice resolver) but never deliberately sought out -- it only happens to fire when nothing
//     else on the tile outranks it. A 'discovery'-kind dimension gate (currently just
//     lucid_expanse/Dream Sanctum) IS actually locatable (dream_sanctum is a real, normally-
//     placed dungeon theme -- see DUNGEON_THEMES in game.html) but questStageHint() itself
//     doesn't expose that connection generically (it's the one gate kind with no bossId to hang
//     a lookup off), so this wasn't wired in to avoid a special-cased hardcode for one dimension.
//   Not implemented (real extension points): crafting deliberately toward a specific gear
//     upgrade (tryCraftUseful only crafts known/affordable curatives), farming, deliberate
//     companion/ally direct command (allies already fight and follow fully autonomously via
//     companionFollowAI -- see game.html -- including defensive/passive stances and disengaging
//     from danger on their own, so this is a much smaller gap than it sounds: a companion in a
//     bot-played game already behaves like a real one without any instruction from here; only
//     the deliberate "send to a specific tile" command (beginCompanionGotoTargeting) goes
//     unused, which has little value for an autonomous playtester with no strategic reason to
//     relocate a companion away from itself).


// Any gameState value we don't have a dedicated strategy for gets a generic "close it"
// (Escape, then 'a' as a presentChoice fallback) so the bot never gets stuck or crashes on
// unfamiliar UI -- but that also means it does NOT meaningfully exercise that feature. This
// set is the states we specifically know are safe/correct to just close (existing menus
// that don't need deep interaction). Anything encountered that ISN'T in this set, in
// KNOWN_STATES below, or one of the states with a real handler ('playing'/'trade'/
// 'dialogue'/'gameover') gets flagged in the end-of-run summary as UNRECOGNIZED -- this is
// the signal that the game added a new mode/menu since this bot was last updated. See
// "Testing a changed or updated game" in the header comment above.
// Several of these (character/talents/cyber/eldritch/train/container) now ALSO have real
// dedicated strategy functions (trySpendStatPoints, trySpendTalentPoints, tryInstallCybernetics,
// tryPerformRitual, tryTrainIfOffered, tryPickUpHere) that open, use, and close them as part of
// a normal turn -- so in practice the main loop rarely sees these gameStates at the top of an
// iteration at all (they're entered and exited synchronously inside those calls, same pattern
// as 'trade'/'dialogue'/'choice'). This list is what happens if one of them is EVER seen open at
// the top of the loop anyway (e.g. some edge case those functions didn't anticipate) -- a safe
// generic close, not a sign the feature goes untested.
const GENERIC_CLOSE_STATES = [
  'inventory', 'character', 'spellbook', 'questlog', 'craft', 'talents', 'library',
  'cyber', 'eldritch', 'saveload', 'dungeonmap', 'travel', 'tiletarget', 'look', 'help',
  'container', 'train', 'giftpick', 'choice', 'itemaction', 'quickslotassign', 'bookreader',
];
// States handled with dedicated logic elsewhere in playOneLife (not exhaustive of every
// possible value -- just the ones with real strategy code, for the "did we recognize this"
// check below). 'title'/'create_species'/'create_archetype'/'create_stats'/'create_abilities'/
// 'create_final'/'start' are creation-flow states only ever seen before the main loop begins
// (driven by createRandomCharacter()/draftCustomCharacter() -- see their comments for how both
// the "Random archetype" and "Custom point-buy" creation paths are covered), so they're not
// re-checked here.
const SPECIFICALLY_HANDLED_STATES = ['playing', 'trade', 'dialogue', 'gameover'];

/**
 * Builds a full custom (point-buy) character via the real 'create_stats'/'create_abilities'/
 * 'create_final' flow (see game.html's showCreateStats/showCreateAbilities/showCreateFinal),
 * rather than the "Random archetype" shortcut, which never touches this system at all -- see
 * the big header comment above main() for why exercising both matters. Randomly rolls one of
 * three build "focuses" (melee/caster/hybrid) each time so repeated runs sample different
 * stat/ability allocations rather than the same build every time; the resulting distribution
 * (which stats get points, which ability categories get bought) reads game data live
 * (CREATION_ABILITY_CATS, CYBERNETICS, CREATION_STARTING_ITEM_POOL, CREATION_GOLD_PER_POINT,
 * CREATION_MAX_STAT_ADD/CREATION_MAX_STARTING_CYBER caps) rather than hardcoding stat/spell/
 * item names, so new content in any of those pools is automatically eligible to be rolled.
 * The draft is populated directly on `creationDraft` (the same object the real screens read
 * and write) rather than simulating dozens of individual keypresses across paginated ability
 * screens -- both approaches produce an identical creationDraft, but this is far more direct;
 * the actual character is still built by the game's own finishCustomCreation(), reached by
 * pressing Enter through the three screens exactly as a human clicking "Next" three times
 * would, so nothing about validation/application of the draft is bypassed.
 */
function draftCustomCharacter(win) {
  return evalGame(win, `
    (function(){
      const d = creationDraft;
      const focus = choice(Math.random, ['melee','caster','hybrid']);
      const weights = focus === 'caster' ? {str:1,dex:1,int:4,con:2,wil:2,cha:1}
        : focus === 'melee' ? {str:4,dex:2,int:1,con:3,wil:1,cha:1}
        : {str:2,dex:2,int:2,con:2,wil:2,cha:2};

      // ---- stats: budgeted at roughly 40% of the total point pool (not "spend until capped"),
      // leaving real room for abilities and starting gold/items below. Without this split, a
      // caster/melee-weighted distribution across only 2-3 non-zero-weight stats (capped at
      // CREATION_MAX_STAT_ADD=6 each, well above what 40% of the budget can reach) would happily
      // absorb the ENTIRE point pool into stats alone and leave nothing for abilities -- exactly
      // what an earlier version of this function did (a "caster" build with 0 known spells).
      const statBudget = Math.min(d.points, Math.round(d.points * 0.4));
      let statSpent = 0;
      let guardA = 0;
      while (statSpent < statBudget && d.points > 0 && guardA++ < 300) {
        const keys = Object.keys(weights).filter(k => d.statAdds[k] < CREATION_MAX_STAT_ADD);
        if (!keys.length) break;
        const total = keys.reduce((s,k) => s + weights[k], 0);
        let roll = Math.random() * total, chosen = keys[0];
        for (const k of keys) { if (roll < weights[k]) { chosen = k; break; } roll -= weights[k]; }
        d.statAdds[chosen]++; d.points--; statSpent++;
      }

      // ---- abilities: leave a small reserve for the gold/items screen, spend the rest on
      // categories matching the rolled focus, taking roughly half of what's affordable in each
      // category (not maxing one category outright) for a more varied, less min-maxed spread ----
      const reserve = Math.min(d.points, 3);
      const catOrder = focus === 'caster' ? ['spells','techniques','mutations','cyber']
        : focus === 'melee' ? ['techniques','spells','mutations','cyber']
        : ['spells','techniques','mutations','cyber'];
      let guardB = 0;
      for (const catKey of catOrder) {
        const cat = CREATION_ABILITY_CATS.find(c => c.key === catKey);
        if (!cat) continue;
        for (const a of cat.pool()) {
          if (guardB++ > 800) break;
          if (d.abilities.includes(a.id)) continue;
          const cost = cat.costFn(a);
          if (d.points - cost < reserve) continue;
          if (cat.key === 'cyber') {
            const chosen = d.abilities.filter(id => CYBERNETICS.some(c2 => c2.id === id)).length;
            if (chosen >= CREATION_MAX_STARTING_CYBER) continue;
          }
          if (Math.random() < 0.4) { d.points -= cost; d.abilities.push(a.id); }
        }
      }

      // ---- gold & starting items: occasionally grab an item (3pt each), convert the rest to gold ----
      let guardC = 0;
      while (d.points >= 3 && guardC++ < 20 && Math.random() < 0.5) {
        const b = choice(Math.random, CREATION_STARTING_ITEM_POOL);
        d.points -= 3; d.items.push(b.id);
      }
      d.gold += d.points * CREATION_GOLD_PER_POINT;
      d.points = 0;

      return { focus, statAdds: {...d.statAdds}, abilityCount: d.abilities.length, itemCount: d.items.length, gold: d.gold };
    })()
  `);
}

async function createRandomCharacter(win, log) {
  const useCustom = Math.random() < 0.5;
  const speciesSteps = [
    ['a', 'title -> species picker'],
    ['9', 'species picker -> random species'],
  ];
  const errors = [];
  for (const [k, desc] of speciesSteps) {
    const r = key(win, k);
    if (!r.ok) errors.push([desc, r.error]);
  }

  if (useCustom) {
    const r0 = key(win, '0'); // archetype picker -> Custom (point-buy)
    if (!r0.ok) errors.push(['archetype picker -> custom', r0.error]);
    if (evalGame(win, 'gameState').value === 'create_stats') {
      const draft = draftCustomCharacter(win);
      if (!draft.ok) errors.push(['draft custom character', draft.error]);
      else log(`Custom build rolled: focus=${draft.value.focus}, ${draft.value.abilityCount} abilities, ${draft.value.itemCount} starting items, ${draft.value.gold}g.`);
      // create_stats -> create_abilities -> create_final -> finishCustomCreation() -> 'start'
      for (const k of ['Enter', 'Enter', 'Enter']) {
        const r = key(win, k);
        if (!r.ok) errors.push(['custom creation Enter', r.error]);
      }
    } else {
      errors.push(['post-custom-select state', `expected create_stats, got ${evalGame(win, 'gameState').value}`]);
    }
  } else {
    const r9 = key(win, '9'); // archetype picker -> random premade archetype (skips straight to 'start')
    if (!r9.ok) errors.push(['archetype picker -> random archetype', r9.error]);
  }

  // Scenario picker: pick a random one rather than always the first, for a bit more coverage
  // of START_SCENARIOS' differing home-goodwill/flavor effects (see SCENARIO_HOME_GOODWILL).
  if (evalGame(win, 'gameState').value === 'start') {
    const n = evalGame(win, 'START_SCENARIOS.length').value || 1;
    const letter = String.fromCharCode(97 + Math.floor(Math.random() * n));
    const r = key(win, letter);
    if (!r.ok) errors.push(['start screen -> scenario', r.error]);
  }

  const st = getState(win);
  if (!st || st.gameState !== 'playing') {
    errors.push(['post-creation state', `expected playing, got ${st && st.gameState}`]);
    return { ok: false, errors };
  }
  log(`Created character: species=${st.species} scenario=${st.scenario}${useCustom ? ' (custom build)' : ' (random archetype)'}`);
  return { ok: true, errors };
}

async function playOneLife(dom, maxActions, maxStuckActions) {
  const win = dom.window;
  const events = [];
  const errors = [];
  const windowErrors = [];
  win.addEventListener('error', (ev) => {
    windowErrors.push(ev.error ? (ev.error.stack || String(ev.error)) : ev.message);
  });

  const log = (msg) => {
    const tc = evalGame(win, 'turnCount').value;
    const line = `[t=${tc}] ${msg}`;
    const last = events[events.length - 1];
    // Collapse immediate repeats (e.g. "bleeding with no bandage" logged every idle turn
    // while genuinely stuck) into a counter instead of spamming thousands of identical
    // lines -- keeps report.json readable without losing the information that it happened.
    const lastBase = last ? last.replace(/ \(x\d+\)$/, '') : null;
    const thisBase = line.replace(/^\[t=\d+\] /, (m) => '[t=~] ');
    const lastBaseNorm = lastBase ? lastBase.replace(/^\[t=\d+\] /, '[t=~] ') : null;
    if (lastBaseNorm === thisBase) {
      const m = last.match(/ \(x(\d+)\)$/);
      const count = m ? parseInt(m[1], 10) + 1 : 2;
      events[events.length - 1] = `${lastBase} (x${count})`;
    } else {
      events.push(line);
    }
  };

  const creation = await createRandomCharacter(win, log);
  errors.push(...creation.errors);
  if (!creation.ok) return { events, errors, windowErrors, died: false, reason: 'failed-to-start', actionsUsed: 0, stateCounts: {}, unrecognizedStates: [] };

  let lastTurnCount = evalGame(win, 'turnCount').value;
  let stuckCounter = 0;
  const wanderState = { dir: null, stepsLeft: 0 };
  const talkedNpcUids = new Set();
  const stateCounts = {};       // every gameState value seen, with a tally
  const unrecognizedStates = new Set(); // subset of the above we have no real handler for
  let actionsUsed = 0;

  const noteState = (gs) => {
    stateCounts[gs] = (stateCounts[gs] || 0) + 1;
    if (!SPECIFICALLY_HANDLED_STATES.includes(gs) && !GENERIC_CLOSE_STATES.includes(gs)) {
      unrecognizedStates.add(gs);
    }
  };

  for (let i = 0; i < maxActions; i++) {
    actionsUsed = i;
    const gs = evalGame(win, 'gameState').value;
    noteState(gs);

    if (gs === 'gameover') {
      // player.deathCause (see game.html's death handling) is the game's own purpose-built
      // field for exactly this -- the killer's name, or lastDamageSource for hazards/environment
      // -- and is more reliable than scraping player.deathLog's last line (which is a snapshot
      // of the general message log, not guaranteed to end on the actual kill line depending on
      // exactly when it was captured relative to the death message itself).
      const cause = evalGame(win, 'player.deathCause').value;
      log(`DIED: ${cause || '(unknown cause)'}`);
      return { events, errors, windowErrors, died: true, reason: 'died', actionsUsed, stateCounts, unrecognizedStates: [...unrecognizedStates] };
    }

    if (gs === 'trade') { strat.tryShopIfTrading(win, log); continue; }
    if (gs === 'dialogue') { strat.tryHandleDialogueIfOpen(win, log); continue; }
    if (gs !== 'playing') {
      if (unrecognizedStates.has(gs) && stateCounts[gs] === 1) {
        // first time we've ever seen this exact state in this life -- worth a log line so
        // it's visible in report.json even if the run otherwise ends uneventfully.
        log(`Entered unrecognized gameState "${gs}" -- no dedicated strategy, closing generically.`);
      }
      strat.tryEscapeUnknownMenu(win);
      continue;
    }

    // --- sanity checks on core numeric state (catches real engine bugs) ---
    const st = getState(win);
    if (st) {
      if (typeof st.hp === 'number' && isNaN(st.hp)) errors.push(['hp-nan', `hp is NaN at turn ${lastTurnCount}`]);
      if (typeof st.hp === 'number' && st.hp < 0) errors.push(['hp-negative', `hp=${st.hp} without gameover, turn ${lastTurnCount}`]);
    }

    // --- periodic main-quest-stage diagnostic (not an action, just visibility into whether
    // the bot is making real story progress or just surviving in place) ---
    if (i % 100 === 0) {
      const stageInfo = evalGame(win, `
        (function(){ const s = curStoryStage(); return s ? (s.type + (s.title ? ': ' + s.title : '')) : 'no active stage'; })()
      `);
      if (stageInfo.ok) log(`Main quest stage: ${stageInfo.value}`);
    }

    // --- priority-ordered strategies; first one that acts wins this iteration ---
    // Survival first (bleed/heal/flee), then offense (hack > spell > ranged > melee), then
    // world interaction (pickup/talk), then periodic character-growth checks (stat/talent
    // points, cybernetics, rituals -- these are cheap no-ops most turns so checking often is
    // fine, but they're placed after combat/survival so a mid-fight turn never gets spent
    // opening a menu instead of acting), then quest/exploration.
    let acted = false;
    acted = acted || await strat.tryStanchBleeding(win, log);
    if (!acted) acted = await strat.tryRecoverHp(win, log);
    if (!acted) acted = await strat.tryFleeIfCritical(win, log);
    if (!acted) acted = await strat.tryAvoidOverwhelmingMonster(win, log);
    if (!acted) acted = strat.tryUseHackChip(win, log);
    if (!acted) acted = strat.tryCastOffensiveSpell(win, log);
    if (!acted) acted = strat.tryFireRanged(win, log);
    if (!acted) strat.tryCalledShot(win, log); // never counts as "acted" on its own -- setup only
    if (!acted) acted = await strat.tryFightAdjacent(win);
    if (!acted) acted = strat.tryPickUpHere(win, log);
    if (!acted) acted = strat.tryTalkToAdjacentNpc(win, log, talkedNpcUids);
    if (!acted && i % 40 === 0) acted = strat.tryEquipUpgrades(win, log);
    if (!acted && i % 25 === 0) acted = strat.tryCraftUseful(win, log);
    if (!acted && i % 15 === 0) acted = strat.trySpendStatPoints(win, log);
    if (!acted && i % 15 === 0) acted = strat.trySpendTalentPoints(win, log);
    if (!acted && i % 30 === 0) acted = strat.tryInstallCybernetics(win, log);
    if (!acted && i % 10 === 0) acted = strat.tryPerformRitual(win, log);
    if (!acted) acted = strat.tryAdvanceMainQuest(win, log);
    if (!acted) acted = await strat.trySeekSupplies(win, log);
    if (!acted) {
      const { progressed } = await nav.exploreStep(win, wanderState);
      acted = true;
      if (!progressed) { stuckCounter++; log('No navigable progress this step (explored/blocked).'); }
      else stuckCounter = 0;
    }

    const newTc = evalGame(win, 'turnCount').value;
    if (newTc === lastTurnCount) stuckCounter++; else { stuckCounter = 0; lastTurnCount = newTc; }

    if (stuckCounter > maxStuckActions) {
      const stX = evalGame(win, 'player.x').value, stY = evalGame(win, 'player.y').value;
      log(`STUCK: no turn progress for ${stuckCounter}+ actions at x=${stX} y=${stY}, dungeon=${evalGame(win, 'curIsDungeon()').value}`);
      return { events, errors, windowErrors, died: false, reason: 'stuck', actionsUsed, stateCounts, unrecognizedStates: [...unrecognizedStates] };
    }
  }

  const finalSt = getState(win);
  log(`Reached action budget. hp=${finalSt && finalSt.hp} level=${finalSt && finalSt.level}`);
  return { events, errors, windowErrors, died: false, reason: 'budget-reached', actionsUsed, finalState: finalSt, stateCounts, unrecognizedStates: [...unrecognizedStates] };
}

async function main() {
  const NUM_LIVES = parseInt(process.argv[2] || '10', 10);
  const MAX_ACTIONS = parseInt(process.argv[3] || '8000', 10);
  const MAX_STUCK = parseInt(process.argv[4] || '600', 10);

  const report = { meta: { numLives: NUM_LIVES, maxActions: MAX_ACTIONS, maxStuck: MAX_STUCK, startedAt: new Date().toISOString() }, lives: [] };

  for (let i = 0; i < NUM_LIVES; i++) {
    process.stderr.write(`\n=== Life ${i + 1}/${NUM_LIVES} ===\n`);
    let dom;
    try {
      dom = await boot();
    } catch (e) {
      report.lives.push({ events: [], errors: [['boot-failed', e.stack || String(e)]], windowErrors: [], died: false, reason: 'boot-failed' });
      continue;
    }
    let result;
    try {
      result = await playOneLife(dom, MAX_ACTIONS, MAX_STUCK);
    } catch (e) {
      result = { events: [], errors: [['fatal-exception', e.stack || String(e)]], windowErrors: [], died: false, reason: 'fatal' };
    }
    report.lives.push(result);
    process.stderr.write(`Life ${i + 1}: ${result.reason}, actions=${result.actionsUsed || 0}, errors=${result.errors.length}, windowErrors=${(result.windowErrors || []).length}\n`);
  }

  const outPath = path.join(__dirname, 'report.json');
  const allStateCounts = {};
  const allUnrecognized = new Set();
  report.lives.forEach((l) => {
    Object.entries(l.stateCounts || {}).forEach(([k, v]) => { allStateCounts[k] = (allStateCounts[k] || 0) + v; });
    (l.unrecognizedStates || []).forEach((s) => allUnrecognized.add(s));
  });
  report.summary = { allStateCounts, unrecognizedStates: [...allUnrecognized] };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // ---- human-readable summary ----
  const byReason = {};
  report.lives.forEach((l) => { byReason[l.reason] = (byReason[l.reason] || 0) + 1; });
  const totalErrors = report.lives.reduce((s, l) => s + l.errors.length, 0);
  const totalWindowErrors = report.lives.reduce((s, l) => s + (l.windowErrors || []).length, 0);

  console.log('\n=== PLAYTEST SUMMARY ===');
  console.log(`Lives: ${report.lives.length}`);
  console.log('Outcomes:', byReason);
  console.log(`Total logic errors caught: ${totalErrors}`);
  console.log(`Total uncaught window errors (real engine crashes): ${totalWindowErrors}`);
  if (allUnrecognized.size) {
    console.log('\n--- UNRECOGNIZED GAME STATES ENCOUNTERED ---');
    console.log('(no dedicated strategy exists for these -- bot only closed them generically;');
    console.log(' add a real handler in strategies.js if these represent content worth testing)');
    [...allUnrecognized].forEach((s) => console.log(`  "${s}" -- seen ${allStateCounts[s]} time(s) across this batch`));
  } else {
    console.log('\nNo unrecognized game states encountered -- every state seen this run has either');
    console.log('a dedicated strategy or is a known/expected generic-close menu.');
  }
  if (totalErrors || totalWindowErrors) {
    console.log('\n--- Errors (see report.json for full stack traces) ---');
    report.lives.forEach((l, i) => {
      l.errors.forEach(([tag, msg]) => console.log(`life ${i}: [${tag}] ${String(msg).split('\n')[0]}`));
      (l.windowErrors || []).forEach((msg) => console.log(`life ${i}: [window error] ${String(msg).split('\n')[0]}`));
    });
  }
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
