#!/usr/bin/env node
// ============================================================================================
// playtest.js -- Automated Playtest Toolkit for "Lucid Dreams of Roguelike" (single-file build)
// ============================================================================================
//
// Headless automated playtester: boots the game's real, unmodified JS engine (via jsdom),
// drives a character through actual turns using the game's own input handler, and reports
// crashes, soft-locks, and behavioral/balance anomalies it observes.
//
// TWO WAYS TO USE THIS FILE... but really three -- see #3 below, which is the one to reach for
// if you're a Claude session that wants to make its OWN decisions turn-by-turn instead of
// running the canned autonomous strategies:
//
//   1. STANDALONE CLI -- run a full autonomous batch of lives, exactly as before:
//        npm install jsdom
//        node playtest.js [numLives] [maxActionsPerLife] [maxStuckActions] [profile]
//        e.g. node playtest.js 20 8000 500 veteran     (defaults: 10 / 8000 / 600 / casual)
//      Writes report.json next to this script. See PROFILES (SECTION 0) for what the last
//      argument does. Good for: unattended crash/regression hunting at scale. NOT good for:
//      testing a specific build/tactic/new mechanic on purpose -- the canned SECTION 4
//      strategies make every decision, not you (see #3 for that).
//
//   2. AS A LIBRARY -- require() this file from your OWN script (or have a Claude session
//      write one) to drive/inspect a live game session directly, without running a full
//      autonomous batch. Requiring this file has NO side effects (main() only runs when this
//      file is executed directly, not when required) -- see `module.exports` at the very
//      bottom of the file for the complete list of what's exposed: the low-level game-control
//      primitives (openGame/boot, evalGame, key, keyAndWait), every individual strategy
//      function (strat.tryFightAdjacent, strat.tryCastOffensiveSpell, ...), the debug-menu
//      control API (debug.setFlags, debug.teleportToDimension, debug.giveItem, ...), the
//      character-creation helpers, playOneLife itself, and the BOT_PROFILE/PROFILES/
//      applyProfile behavior-tuning system. A short example:
//
//        const pt = require('./playtest.js');
//        (async () => {
//          const dom = await pt.boot();                    // launch the real game in jsdom
//          const win = dom.window;
//          await pt.createRandomCharacter(win, console.log);
//          pt.debug.setFlags(win, { infiniteHealth: true, noclip: true }); // can't die, walk through walls
//          pt.debug.teleportToDungeonType(win, 'crypt');    // drop straight into a specific dungeon type
//          for (let i = 0; i < 200; i++) await pt.strat.tryFightAdjacent(win); // or drive it yourself
//          console.log(pt.getState(win));
//        })();
//
//      Three more patterns worth knowing about (all SECTION 7, full detail there):
//        - pt.playOneLife(dom, maxActions, maxStuck, { onAction }) -- pass a callback to watch
//          every single action live as it happens and optionally stop the life early (return
//          false) once some condition you care about is met, instead of only inspecting a
//          finished run's report afterward.
//        - pt.runContentSweep(win) -- deterministically visits EVERY dungeon type, dimension,
//          spell, recipe, weather type, and world event at least once under god-mode, catching
//          real crashes -- the "did we actually test everything" answer, not a probabilistic one.
//        - pt.simulateCombat(win, monsterId, {trials, spellId}) / pt.runComparison(configs) --
//          isolated, repeatable balance testing: how many hits to kill X with weapon/spell Y,
//          or is profile A actually meaningfully safer than profile B, with real numbers.
//
//   3. INTERACTIVE AGENT SESSION (SECTION 8) -- START HERE if you're a Claude session and want
//      to make your OWN decisions (pursue a specific build, react to a new mechanic turn-by-
//      turn, test a specific tactic) rather than delegate to SECTION 4's fixed heuristics:
//        node playtest.js --serve [port]      (default 4691)
//      boots ONE game session and keeps it running as a tiny local HTTP API. From a shell:
//        curl localhost:4691/help             <- self-documenting: full verb list + current state
//        curl localhost:4691/state            <- rich JSON: vitals, inventory/equipment (with
//                                                 uids), every known spell/technique/cyber/
//                                                 mutation ability WITH live affordability, all
//                                                 nearby entities, any open menu's options
//        curl -X POST -d '{"type":"castSpell","id":"firebolt"}' localhost:4691/act
//        curl -X POST -d '{"method":"spawnMonster","args":["boar",{"radius":1}]}' localhost:4691/debug
//      Nothing in /act decides anything for you -- it executes exactly the one action given,
//      same as a human pressing one key, and hands back real resulting state so you can decide
//      the next move yourself. This is a genuinely separate mode from #1/#2 above, not a
//      replacement -- SECTION 4's autonomous strategies are still what CLI batch mode uses.
//      NOTE: a server started this way does NOT survive past the current shell session/sandbox
//      lifetime in most agentic coding environments -- if it's gone next turn, that's expected,
//      just restart it. See SECTION 8's own header comment for the full verb list, targeting
//      quirks, and design rationale before assuming something isn't possible through it -- the
//      {type:'key', key:'...'} raw escape hatch means nothing is actually locked out, just not
//      given a dedicated named verb yet.
//
// GAME FILE LOCATION: auto-detected (see locateGameHtml() in SECTION 1 below) -- just drop
// this script and the game's .html file (any name) in the same folder, or the game's default
// game/game.html layout also still works.
//
// ---- FILE MAP (this used to be 5 separate files; all content is preserved, just
// concatenated in dependency order and with require()/module.exports stripped) ----
//   SECTION 0: profiles   -- BOT_PROFILE tunable behavior knobs + named presets (novice/
//                            casual/veteran), read live by SECTION 4's strategies
//   SECTION 1: harness    -- boots the game in jsdom (canvas/audio stubbed, everything else real)
//   SECTION 2: gameApi    -- low-level wrapper: eval into game scope, press keys, wait for
//                            interval-driven commands, read common state
//   SECTION 3: navigation -- exploration/travel logic
//   SECTION 4: strategies -- one function per behavior (fight, heal, equip, shop, craft, talk...)
//   SECTION 5: bot        -- main driver: composes strategies into full playthroughs, writes
//                            report.json (now WITH per-life combat telemetry + a vitals growth
//                            timeline by default, and an optional onAction live-observer hook),
//                            and is what actually runs when you execute this file. ITS OWN
//                            HEADER COMMENT BELOW IS THE AUTHORITATIVE, CONTINUOUSLY-UPDATED
//                            COVERAGE TABLE -- read it before assuming something is or isn't
//                            tested, rather than guessing from this summary or from memory of a
//                            past conversation about this project.
//   SECTION 6: debug      -- thin wrappers around the game's OWN dev/debug menu (DEBUG flags,
//                            teleport to any dimension/dungeon type, spawn any monster, grant
//                            items/abilities, level up, force weather/events) for directed
//                            testing without waiting on a probability or risking a death
//                            mid-investigation
//   SECTION 7: telemetry & coverage -- structured combat/growth data (not just prose logs),
//                            a deterministic full-content coverage sweep, an isolated combat
//                            simulator for weapon/spell/monster balance testing, and a
//                            multi-config comparison runner (e.g. "is profile A safer than B")
//   SECTION 8: interactive agent session -- turn-by-turn HTTP control surface (usage mode #3
//                            above) plus the rich state reader/action dispatcher it's built on;
//                            read ITS header comment for the full verb list and design
//                            rationale before assuming an interaction isn't possible.
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
// SECTION 0: BOT PROFILES -- tunable "how good/careful is this character's play" knobs
// ==========================================================================================
// IMPORTANT NUANCE: this does NOT restrict what the bot *knows* about the game state -- every
// strategy in SECTION 4 reads real internal fields (player.hp, monster.atk, etc.) via evalGame
// regardless of profile, because that's what makes this tool reliable for automated testing at
// all; a bot that could only "see" what a human player's screen shows would be far too fragile
// (mis-parsing rendered text, missing state changes) to trust for crash/regression detection.
// What DOES change per profile is decision-making: how cautious, how proactive, how willing to
// spend a turn on an advanced tactic (called shots, rituals) versus just doing the simple thing.
// Every field here is read live (as default parameter values, re-evaluated on every call -- see
// each strategy function's signature in SECTION 4) rather than baked in once, so switching
// profiles mid-run (e.g. from a required script) takes effect on the very next strategy call,
// no restart needed.
const PROFILES = {
  // Reacts late, under-prepares, and sticks to simple choices -- a first-timer's instincts.
  novice: {
    fleeHpFrac: 0.10,            // waits until nearly dead before disengaging a losing fight
    avoidOverwhelmingEnabled: false, // doesn't recognize "this could nearly one-shot me" in advance
    overwhelmThreshold: 0.6,
    recoverHpFrac: 0.25,         // doesn't stop to heal/rest until quite hurt
    curativeReserve: 2,          // doesn't stock up much on bandages/potions
    supplySeekThreshold: 1,      // doesn't go restock until almost completely out
    calledShotChance: 0,         // never bothers with the called-shot tactic
    ritualChance: 0.8,           // high risk tolerance -- gambles on rituals readily, doesn't weigh it
    giftChance: 0.25,
    customCreateChance: 0.2,     // mostly picks premade "Random" archetypes over building custom
    debuffChance: 0.1,           // rarely thinks to weaken a foe first instead of just attacking
    buffChance: 0.3,             // sometimes forgets to buff up before a fight
    summonChance: 0.5,
  },
  // The tuned baseline this toolkit shipped and was validated with -- competent, not optimal.
  casual: {
    fleeHpFrac: 0.18,
    avoidOverwhelmingEnabled: true,
    overwhelmThreshold: 0.6,
    recoverHpFrac: 0.35,
    curativeReserve: 4,
    supplySeekThreshold: 2,
    calledShotChance: 0.15,
    ritualChance: 0.5,
    giftChance: 0.25,
    customCreateChance: 0.5,
    debuffChance: 0.35,
    buffChance: 0.6,
    summonChance: 0.7,
  },
  // Cautious and deliberate -- disengages earlier, keeps deeper reserves, uses advanced tactics
  // more, and is choosier about real-risk gambles like eldritch rituals.
  veteran: {
    fleeHpFrac: 0.30,
    avoidOverwhelmingEnabled: true,
    overwhelmThreshold: 0.45,    // retreats from smaller threats too, not just near-one-shots
    recoverHpFrac: 0.5,
    curativeReserve: 6,
    supplySeekThreshold: 3,
    calledShotChance: 0.35,
    ritualChance: 0.3,
    giftChance: 0.25,
    customCreateChance: 0.8,     // prefers deliberately building a character over rolling random
    debuffChance: 0.6,           // consistently softens up dangerous foes before committing
    buffChance: 0.85,
    summonChance: 0.9,
  },
};
// The live, mutable profile every strategy function's default parameters read from. Start on
// 'casual' (this toolkit's original tuned baseline); call applyProfile(name) or mutate fields
// on BOT_PROFILE directly to change behavior for anything called after that point.
const BOT_PROFILE = { ...PROFILES.casual };
function applyProfile(name) {
  if (!PROFILES[name]) throw new Error(`Unknown profile "${name}". Known profiles: ${Object.keys(PROFILES).join(', ')}`);
  Object.assign(BOT_PROFILE, PROFILES[name]);
  return BOT_PROFILE;
}


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
/**
 * Attach a real-engine-crash listener to a booted window and return a handle whose `.errors`
 * array grows on every uncaught exception (stack trace or message, whichever's available).
 * Factored out of playOneLife so both the standard autonomous driver AND the content-coverage
 * sweep / any library-mode script (SECTION 7) share the exact same crash-detection mechanism
 * rather than each reimplementing it -- an uncaught error means the real game code threw, which
 * is exactly the "regression/crash" signal every consumer of this file cares about most.
 */
function attachErrorCapture(win) {
  const handle = { errors: [] };
  win.addEventListener('error', (ev) => {
    handle.errors.push(ev.error ? (ev.error.stack || String(ev.error)) : ev.message);
  });
  return handle;
}

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
  if (!BOT_PROFILE.avoidOverwhelmingEnabled) return false; // novice profile: no preemptive threat read
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
  if (typeof hp !== 'number' || danger < hp * BOT_PROFILE.overwhelmThreshold) return false;

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
// SUPPLY_SEEK_THRESHOLD removed as a fixed const -- trySeekSupplies now reads BOT_PROFILE.supplySeekThreshold live (see SECTION 0).
//
// BUG FIX (found via runContentSweep-style batch analysis, not a single crash): the original
// version below judged "do I need supplies?" purely off a *bundled* curative count (bandages +
// antidotes + heal potions + elixirs, all summed together) against one threshold. That let a
// character carrying several heal potions but ZERO bandages read as "well-supplied" and never
// trigger a restock trip -- even though only a bandage can stanch bleeding (tryStanchBleeding
// matches strictly on effect==='bandage'/name-regex 'bandage', see above) and only an antidote
// can cure poison (tryCurePoison, same pattern). Across two validation batches (15 lives total,
// casual profile) this produced an 8/10 and 3/5 bleeding-death rate: characters would stock up
// on generic potions, satisfy the bundled threshold, then bleed out hundreds of turns later with
// zero bandages and no way to travel home (autoTravelHome refuses to even start while bleeding --
// see the guard below) or rest (the game's own doRest() refuses while bleeding too). One life
// even survived 446 actions on a single early shop visit before dying this way, with the last
// ~60 turns of its event log nothing but "Bleeding with no bandage available."
// Fix: track bandage and antidote stock SEPARATELY from the general curative bundle, and treat
// either specific shortage as its own trigger to seek supplies, independent of how many generic
// heal potions/elixirs happen to be on hand.
async function trySeekSupplies(win, log) {
  const counts = evalGame(win, `
    (function(){
      const inv = player.inventory.filter(it => it.type==='consumable');
      const bandages = inv.filter(it => it.effect==='bandage' || /bandage/i.test(it.name)).length;
      const antidotes = inv.filter(it => it.effect==='cureposion' || it.effect==='cureall' || /antidote/i.test(it.name)).length;
      const curatives = inv.filter(it => it.effect==='heal'||it.effect==='bandage'||it.healAmount||it.hpRestore||/heal|bandage|antidote|potion|elixir|medkit|tonic|salve/i.test(it.name)).length;
      return JSON.stringify({ bandages, antidotes, curatives });
    })()
  `).value;
  let bandages, antidotes, curatives;
  try { ({ bandages, antidotes, curatives } = JSON.parse(counts)); } catch (e) { return false; }
  if (typeof curatives !== 'number') return false;
  const bandageShort = bandages < BOT_PROFILE.supplySeekThreshold;
  const antidoteShort = antidotes < BOT_PROFILE.supplySeekThreshold;
  const curativesShort = curatives < BOT_PROFILE.supplySeekThreshold;
  if (!bandageShort && !antidoteShort && !curativesShort) return false;
  if (nearbyMonster(win)) return false; // let combat/flee handle immediate danger first
  const bleeding = evalGame(win, '(player.bleedTurns||0) > 0').value === true;
  if (bleeding) return false; // autoTravelHome would refuse to even start -- see runAutoLoop's guard

  const beforeTurn = evalGame(win, 'turnCount').value;
  await keyAndWait(win, 'H', 8000);
  const afterTurn = evalGame(win, 'turnCount').value;
  if (afterTurn === beforeTurn) return false; // no settlement discovered yet, or already there
  const reason = bandageShort ? `only ${bandages} bandage(s)` : antidoteShort ? `only ${antidotes} antidote(s)` : `${curatives} curative(s)`;
  if (log) log(`Traveling to restock supplies (${reason} on hand).`);
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
function tryCalledShot(win, log, chance = BOT_PROFILE.calledShotChance) {
  if (!nearbyMonster(win)) return false;
  if (Math.random() > chance) return false;
  if (evalGame(win, 'player.calledShotTarget').value) return false; // one already queued
  // BUG FIX (found via SECTION 8 verb testing, then traced back here): pressing 'a' does NOT
  // reach the called-shot handler. MOVE_KEYS defines a WASD scheme where a:[-1,0] (move west),
  // and that binding is checked BEFORE key==='a''s openCalledShotMenu() in the game's own
  // handleKey dispatch order -- so 'a' always moves the player west instead, consuming a real
  // turn, and the called-shot key handler is unreachable dead code in the base game (a bug in
  // the game itself, not something fixable by choosing a different key from the keyboard --
  // there may be a mouse-only path a real player could use, but no keyboard one). This function
  // correctly detected the resulting failure (gameState never became 'choice') and returned
  // false -- so it never *reported* success incorrectly -- but the side effect (an extra,
  // unlogged move west, every time the calledShotChance roll succeeded) was real and silent:
  // roughly 15-35% of combat turns near a monster, across every batch this project has ever
  // run, depending on profile. Confirmed via direct before/after position + turnCount check.
  // Fixed by calling openCalledShotMenu() directly instead of going through the shadowed key.
  evalGame(win, 'openCalledShotMenu();');
  if (evalGame(win, 'gameState').value !== 'choice') { return false; } // no adjacent target, no key press happened, nothing to undo
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
async function tryFleeIfCritical(win, log, hpFrac = BOT_PROFILE.fleeHpFrac) {
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
// ---- UNIFIED ABILITY POOL -----------------------------------------------------------------
// The game resolves spells, techniques, active cybernetics, and active mutations through one
// shared pipeline: findAbilityById() looks across all four pools, isAbilityKnown() checks all
// four, castSpell(id) (despite the name) casts/activates ANY of them, and each pays from its
// own resource (ability.resource: 'mp' default, 'stamina' for techniques, 'charge' for cyber,
// 'hp' for many mutations) via getPoolValue()/effectiveCost() -- see castSpell/paySpellCost/
// findAbilityById in the game source. Everything in SECTION 4 before this point only ever read
// player.knownSpells and compared against player.mp -- which meant techniques, active
// cybernetics, and active mutations were never invoked by the autonomous bot at all (known,
// installed, completely unused), and spell TYPES other than 'damage'/'heal' (buff/debuff/
// summon/execute/smite/drain/raise/...) were ignored even within the one pool that WAS read.
// Found via a direct grep audit, not a crash -- nothing here ever errored, it just silently
// never exercised roughly half the game's ability surface. This block gives every strategy
// below one correct, content-agnostic way to enumerate "everything I currently know across all
// four systems and can currently afford," reusing the game's OWN cost math (effectiveCost/
// getPoolValue) rather than reimplementing it -- the same "don't re-derive game math, ask the
// game" rule that gearScore() etc. already follow elsewhere in this file.
function knownAffordableAbilities(win, typeFilter) {
  const typesJson = typeFilter ? JSON.stringify(typeFilter) : 'null';
  return evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const types = ${typesJson};
      return ids.map(id => findAbilityById(id)).filter(Boolean)
        .filter(a => !types || types.includes(a.type))
        .filter(a => getPoolValue(a.resource||'mp') >= effectiveCost(a))
        .map(a => ({ id: a.id, name: a.name, type: a.type, power: a.power||null, range: a.range||0, stat: a.stat||null, dur: a.dur||null, summonId: a.summonId||null }));
    })()
  `);
}

/** Confirms tile-targeting the same way a human pressing Enter/Space would (snap to nearest
 * valid target) -- shared by every "cast at a foe" strategy below and by SECTION 8's
 * castSpell action, so there's exactly one place that knows this quirk exists. */
function confirmSpellTargetIfNeeded(win) {
  if (evalGame(win, 'gameState').value === 'tiletarget') key(win, 'Enter');
}

/**
 * Casts the single best offensive ability currently known and affordable, drawn from ALL FOUR
 * ability pools (spells, techniques, active cyber, active mutations) -- not just player-spells
 * of type 'damage' like the original version of this function. 'execute'/'smite'/'drain' are
 * included too (they all resolve through the same manual-tile-targeting path in castSpell, see
 * the unified pool comment above); 'debuff' is deliberately excluded here even though it shares
 * that targeting path, because it has no power[]/damage semantics to sort by -- see
 * tryCastDebuffAbility below for that one. Picks the highest average-power option among what's
 * actually usable right now (affordable AND has a valid nearestHostile(range) target).
 */
function tryCastOffensiveSpell(win, log) {
  const r = evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const OFFENSIVE = new Set(['damage','execute','smite','drain']);
      const known = ids.map(id => findAbilityById(id)).filter(s => s && OFFENSIVE.has(s.type) && Array.isArray(s.power));
      const usable = known.filter(s => getPoolValue(s.resource||'mp') >= effectiveCost(s) && nearestHostile(s.range));
      if (!usable.length) return null;
      usable.sort((a,b) => ((b.power[0]+b.power[1]) - (a.power[0]+a.power[1])));
      const spell = usable[0];
      const before = getPoolValue(spell.resource||'mp');
      castSpell(spell.id);
      return { name: spell.name, resource: spell.resource||'mp', before, gsAfter: gameState };
    })()
  `);
  if (!r.ok || !r.value) return false;

  confirmSpellTargetIfNeeded(win);
  const after = evalGame(win, `getPoolValue(${JSON.stringify(r.value.resource)})`).value;
  if (after < r.value.before) {
    if (log) log(`Used ${r.value.name}.`);
    return true;
  }
  // Resource didn't actually drop -- the cast/activation didn't resolve (no valid nearest-foe
  // snap target after all, or targeting got cancelled). Don't report success; let the caller
  // fall through to melee/other strategies instead of silently doing nothing this turn.
  return false;
}

/**
 * If HP is low and an affordable 'heal'/'cleanse'/'purify' ability is known -- across all four
 * pools, same reasoning as tryCastOffensiveSpell above -- cast it instead of reaching for an
 * item or resting. Checked by tryRecoverHp before its item/rest fallback.
 */
function tryCastHealSpell(win, log) {
  const r = evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const HEALING = new Set(['heal','cleanse','purify']);
      const known = ids.map(id => findAbilityById(id)).filter(s => s && HEALING.has(s.type));
      const usable = known.filter(s => getPoolValue(s.resource||'mp') >= effectiveCost(s));
      if (!usable.length) return null;
      usable.sort((a,b) => {
        const bp = Array.isArray(b.power) ? (b.power[0]+b.power[1]) : (b.power||0);
        const ap = Array.isArray(a.power) ? (a.power[0]+a.power[1]) : (a.power||0);
        return bp - ap;
      });
      const spell = usable[0];
      castSpell(spell.id);
      return spell.name;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Used ${r.value} to heal.`); return true; }
  return false;
}

/**
 * Weakens the nearest hostile with a known, affordable 'debuff' ability (slow/fear/poison/
 * silence/etc., from any of the four ability pools) before or during a fight -- previously
 * NEVER exercised: no strategy anywhere read type==='debuff' at all, so a build that rolled
 * Fear or Crippling Shot carried it completely unused for the entire life. Debuffs have no
 * power[]/damage semantics to rank by, so this doesn't try to pick the "best" one -- it just
 * fires whichever affordable debuff has a valid target, gated by BOT_PROFILE.debuffChance so
 * it's a real tactical choice (sometimes softening a foe first) rather than a mandatory
 * pre-step every single fight. Doesn't check whether the target is already debuffed with the
 * same stat (monster status-tracking field names aren't uniform enough across the roster to
 * check generically without risking a false-negative that silently disables this strategy) --
 * a harmless re-application in the worst case, and real exercise of the debuff-casting code
 * path against a wide variety of monsters in the common case, which is the actual goal here.
 */
function tryCastDebuffAbility(win, log, chance = BOT_PROFILE.debuffChance) {
  if (Math.random() > chance) return false;
  const r = evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const known = ids.map(id => findAbilityById(id)).filter(s => s && s.type==='debuff');
      const usable = known.filter(s => getPoolValue(s.resource||'mp') >= effectiveCost(s) && nearestHostile(s.range));
      if (!usable.length) return null;
      const spell = choice(Math.random, usable);
      const before = getPoolValue(spell.resource||'mp');
      castSpell(spell.id);
      return { name: spell.name, resource: spell.resource||'mp', before };
    })()
  `);
  if (!r.ok || !r.value) return false;
  confirmSpellTargetIfNeeded(win);
  const after = evalGame(win, `getPoolValue(${JSON.stringify(r.value.resource)})`).value;
  if (after < r.value.before) { if (log) log(`Used ${r.value.name} on a foe.`); return true; }
  return false;
}

/**
 * Self-buffs with a known, affordable 'buff' ability (any of the four pools) when a hostile is
 * nearby and that specific buff isn't already active -- previously NEVER exercised for the
 * same reason as debuffs above. Buffs are self-targeted (range 0) and resolve immediately via
 * the game's own applyBuff(), no tile-targeting confirm needed. Checks player.buffs[stat]
 * directly (the game's real buff-tracking structure -- see applyBuff in the source) rather
 * than a separate cooldown timer, so it naturally refreshes a buff that's about to expire and
 * never wastes a turn re-casting one that's still got most of its duration left.
 */
function tryCastBuffAbility(win, log, chance = BOT_PROFILE.buffChance) {
  if (!nearbyMonster(win)) return false;
  if (Math.random() > chance) return false;
  const r = evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const known = ids.map(id => findAbilityById(id)).filter(s => s && s.type==='buff');
      const usable = known.filter(s => {
        if (getPoolValue(s.resource||'mp') < effectiveCost(s)) return false;
        const active = player.buffs[s.stat];
        return !active || active.turns <= 3; // not active, or about to expire -- worth refreshing
      });
      if (!usable.length) return null;
      const spell = choice(Math.random, usable);
      castSpell(spell.id);
      return spell.name;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Buffed with ${r.value}.`); return true; }
  return false;
}

/**
 * Conjures a temporary ally with a known, affordable 'summon' ability (any of the four pools)
 * when none is currently active -- previously NEVER exercised. Summons are self-targeted
 * (range 0, resolve immediately via the game's own spawnAlly(), which pushes onto
 * player.allies) -- checking player.allies for anything still alive is the same real state the
 * game itself tracks summons/companions in, so a build that already has a permanent companion
 * (spouse, hired follower, etc.) correctly won't burn resources summoning a redundant second
 * ally either. Deliberately excludes type:'raise' (same conjure-an-ally family, but needs a
 * corpse in range rather than being purely self-targeted) -- see the SECTION 5 header's open
 * gaps list for that one.
 */
function tryCastSummonAbility(win, log, chance = BOT_PROFILE.summonChance) {
  if (!nearbyMonster(win)) return false;
  if (Math.random() > chance) return false;
  if (evalGame(win, '(player.allies||[]).some(a => a.alive)').value === true) return false;
  const r = evalGame(win, `
    (function(){
      const ids = [...new Set([
        ...(player.knownSpells||[]), ...(player.knownTechniques||[]),
        ...(player.installedCyber||[]), ...(player.mutations||[]),
      ])];
      const known = ids.map(id => findAbilityById(id)).filter(s => s && s.type==='summon');
      const usable = known.filter(s => getPoolValue(s.resource||'mp') >= effectiveCost(s));
      if (!usable.length) return null;
      const spell = choice(Math.random, usable);
      castSpell(spell.id);
      return spell.name;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Summoned help with ${r.value}.`); return true; }
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
 * Same "cure it the moment it's active, don't wait for HP to drop" principle as
 * tryStanchBleeding, for poison (player.statusPoison -- see processEntityStatus in game.html):
 * poison ticks a flat few HP of damage every single turn regardless of current HP, so reactively
 * waiting for tryRecoverHp's hp-fraction threshold to trip means several turns of guaranteed,
 * avoidable damage tick by first. Matches on effect==='cureposion'/'cureall' first (what
 * useItem's own switch statement actually dispatches on), falling back to name regex for
 * anything not exposing that field explicitly.
 */
function tryCurePoison(win, log) {
  const poisoned = evalGame(win, '(player.statusPoison||0) > 0').value === true;
  if (!poisoned) return false;
  const r = evalGame(win, `
    (function(){
      const cure = player.inventory.find(it => it.effect === 'cureposion' || it.effect === 'cureall' || /antidote/i.test(it.name));
      if (!cure) return false;
      try { useItem(cure); return true; } catch(e){ return 'ERR:'+e.message; }
    })()
  `);
  if (r.ok && r.value === true) { if (log) log('Used an antidote to cure poison.'); return true; }
  if (log && r.ok && r.value === false) log('Poisoned with no antidote available.');
  return false;
}

/**
 * Below `hpFrac` of max HP and no monster adjacent: try a curative item first (anything
 * consumable matching common heal-item naming), else rest (async, interval-driven -- see
 * gameApi.waitForAutoAction). Returns true if it took *some* recovery action.
 */
async function tryRecoverHp(win, log, hpFrac = BOT_PROFILE.recoverHpFrac) {
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
          // BUG FIX: weapon 'dmg' is a [min,max] array on both bases and generated instances
          // (see makeItem in game.html), not a flat number -- naively doing (it.dmg||0) in a
          // sum lets JS's '+' silently fall back to STRING CONCATENATION the moment it hits a
          // truthy array operand (e.g. [3,9]+0 -> "3,90", not 12), and the result contaminates
          // the whole sum into a string. Comparing two such strings with '>' then does
          // lexicographic (not numeric) comparison, which happens to look plausible for
          // single-digit damage but silently misjudges upgrades once damage reaches double
          // digits (e.g. "10,20" sorts LOWER than "9,15" as strings). Averaging the range into
          // a real number here is what every score computation below should have been doing.
          const scoreOf = (x) => (Array.isArray(x.dmg) ? (x.dmg[0]+x.dmg[1])/2 : (x.dmg||0)) + (x.armor||0) + (x.acc||0);
          const itScore = scoreOf(it);
          const curScore = cur ? scoreOf(cur) : -999;
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
function tryPerformRitual(win, log, chance = BOT_PROFILE.ritualChance) {
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
function tryGiftIfOffered(win, log, chance = BOT_PROFILE.giftChance) {
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
        !(isHealish(it) && curativeCount <= ${BOT_PROFILE.curativeReserve})
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

/**
 * Craft a weapon/armor recipe if a known, currently-affordable one would be a real upgrade over
 * whatever's equipped in that slot -- the crafting-side counterpart to tryEquipUpgrades
 * (checking loot) and tryShopIfTrading (checking the shop). Reads RECIPES/ITEM_BASES/
 * hasIngredients live rather than a hardcoded recipe list, so any weapon/armor recipe added to
 * the game later (the base game currently has real ones for longsword/staff/warhammer, plus
 * tool-weapons like fishing_rod/hoe) is automatically eligible without touching this function.
 * Uses the SAME (dmg-array-averaging) gearScore fix as tryEquipUpgrades/tryShopIfTrading -- see
 * the comment there for why treating dmg as a plain number was silently wrong for any weapon.
 * Only crafts a CLEAR upgrade (>15% better) so this doesn't burn materials on a lateral/minor
 * change, and only ever crafts one recipe per call (called periodically, not every turn, same
 * pattern as the other low-frequency character-growth checks in the main loop).
 */
function tryCraftGearUpgrade(win, log) {
  const r = evalGame(win, `
    (function(){
      const gearScore = (x) => (Array.isArray(x.dmg) ? (x.dmg[0]+x.dmg[1])/2 : (x.dmg||0)) + (x.armor||0) + (x.acc||0);
      let best = null, bestGain = 0;
      for (const rid of (player.knownRecipes||[])) {
        const rec = RECIPES.find(x => x.id === rid);
        if (!rec) continue;
        const outBase = ITEM_BASES.find(b => b.id === rec.output.id);
        if (!outBase || (outBase.type !== 'weapon' && outBase.type !== 'armor')) continue;
        if (!hasIngredients(rec)) continue;
        const cur = player.equipment[outBase.slot];
        const outScore = gearScore(outBase);
        const curScore = cur ? gearScore(cur) : 0;
        if (curScore <= 0 && outScore <= 0) continue; // both worthless, not a real upgrade signal
        const gain = curScore > 0 ? (outScore - curScore) / curScore : Infinity;
        if (gain > 0.15 && gain > bestGain) { bestGain = gain; best = rid; }
      }
      if (!best) return null;
      craftRecipe(best);
      // Equip immediately rather than waiting for tryEquipUpgrades' next periodic pass -- match
      // by base item id among currently-unequipped inventory (there should only be the one just
      // added, but picking the highest-scoring match if several exist is still correct).
      const outBase = ITEM_BASES.find(b => b.id === RECIPES.find(x => x.id === best).output.id);
      const equippedUids = new Set(Object.values(player.equipment).filter(Boolean).map(i => i.uid));
      const candidates = player.inventory.filter(it => it.id === outBase.id && !equippedUids.has(it.uid));
      if (candidates.length) {
        candidates.sort((a,b) => gearScore(b) - gearScore(a));
        equipItem(candidates[0]);
      }
      return best;
    })()
  `);
  if (r.ok && r.value) { if (log) log(`Crafted gear upgrade via recipe: ${r.value}`); return true; }
  return false;
}

/**
 * Till/plant/harvest via the exact same "interact with this tile" menu tryPickUpHere already
 * drives for containers/items/salvage/fishing (see pickUp() in game.html) -- till requires a
 * Hoe equipped, plant needs a seed item already in inventory, harvest needs a matured farmplot.
 * Checked at low priority since farming is a genuinely optional side-activity for an adventurer,
 * not a survival necessity, and tilling requires briefly equipping a Hoe -- this only does so
 * when it's safe to (no monster nearby, checked by the caller) and immediately swaps back to
 * whatever was equipped before, in the SAME turn, so the character is never left weaponless
 * mid-exploration. tryShopIfTrading buys a spare Hoe when one's on offer specifically so this
 * has something to work with; without ever finding a Hoe, tilling simply never triggers, which
 * is correct (a real player without one couldn't till either).
 * Reads CROPS/isTillableGround/tillSoil/plantCrop/harvestCrop directly off the game rather than
 * assuming which crop ids exist, so a new crop type added later works automatically as long as
 * its seed item shares an id with its CROPS entry, exactly like the game's own menu code does.
 */
function tryFarm(win, log) {
  if (nearbyMonster(win)) return false;
  const r = evalGame(win, `
    (function(){
      if (curIsDungeon()) return null;
      const t = curTileAt(player.x, player.y);
      // ---- harvest: highest-value action here, no equipment swap needed ----
      if (t && t.feature === 'farmplot' && t.cropId && t.growStage >= 2) {
        const name = CROPS[t.cropId].name;
        harvestCrop(t, player.x, player.y);
        endTurn();
        return { action: 'harvest', name };
      }
      // ---- plant: needs a seed already in inventory, no equipment swap needed ----
      if (t && t.feature === 'farmplot' && !t.cropId) {
        const seedId = Object.keys(CROPS).find(id => player.inventory.some(i => i.id === id));
        if (!seedId) return null;
        consumeMaterial(seedId, 1);
        plantCrop(t, player.x, player.y, seedId);
        endTurn();
        return { action: 'plant', name: CROPS[seedId].name };
      }
      // ---- till: needs a Hoe, temporarily equipped then swapped back so this never leaves the
      // character unarmed after this turn ----
      if (isTillableGround(t)) {
        const hoe = player.inventory.find(it => it.id === 'hoe' || /hoe/i.test(it.name));
        if (!hoe) return null;
        const prevHand = player.equipment.hand;
        equipItem(hoe);
        tillSoil(player.x, player.y);
        wearItem(hoe, 1);
        if (prevHand) equipItem(prevHand);
        endTurn();
        return { action: 'till' };
      }
      return null;
    })()
  `);
  if (r.ok && r.value) {
    const a = r.value.action;
    if (log) log(a === 'harvest' ? `Harvested ${r.value.name}.` : a === 'plant' ? `Planted ${r.value.name}.` : 'Tilled soil for farming.');
    return true;
  }
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
// SHOP_CURATIVE_RESERVE removed as a fixed const -- tryShopIfTrading/tryGiftIfOffered now read BOT_PROFILE.curativeReserve live (see SECTION 0).
function tryShopIfTrading(win, log) {
  if (evalGame(win, 'gameState').value !== 'trade') return false;

  const result = evalGame(win, `
    (function(){
      const npc = dialogueNPC;
      if (!npc || !npc.shop) return null;
      const repMult = repPriceMult(getKingdom(Math.floor(npc.x/CH), Math.floor(npc.y/CH)).key)
        * tradeSpeciesPriceMult(npc) * npcTierPriceMult(npc) * relationshipPriceMult(npc);
      const isCurative = (it) => /heal|bandage|antidote|potion|elixir|medkit|tonic|salve/i.test(it.name);
      const isBandage = (it) => it.effect === 'bandage' || /bandage/i.test(it.name);
      const isAntidote = (it) => it.effect === 'cureposion' || it.effect === 'cureall' || /antidote/i.test(it.name);
      const gearScore = (x) => (Array.isArray(x.dmg) ? (x.dmg[0]+x.dmg[1])/2 : (x.dmg||0)) + (x.armor||0) + (x.acc||0);
      const bought = [], sold = [];

      // ---- BUY PASS ----
      // BUG FIX: buying used to top up ONE bundled "curatives" count (bandages + antidotes +
      // heal potions + elixirs all lumped together), picking the globally cheapest matching item
      // each iteration. Since heal potions/elixirs are usually cheaper than bandages, that loop
      // would happily fill the entire reserve with potions and never buy a single bandage -- a
      // character could visit a shop a dozen times, always "restock successfully", and still
      // carry zero bandages the whole game (only a bandage cures bleeding -- see tryStanchBleeding
      // -- and only an antidote cures poison -- see tryCurePoison -- heal potions do neither).
      // Confirmed via batch analysis: 8/10 casual-profile lives ended in a bleed-out death with
      // repeated "restocked supplies" log lines immediately beforehand, bandage count unchanged.
      // Fix: run two small dedicated passes for bandages and antidotes specifically (up to the
      // same reserve target) BEFORE the generic top-up, so a shop with both cheap potions and
      // bandages in stock buys the bandages a bleeding character actually needs, not just
      // whatever's cheapest overall.
      tradeMode = 'buy'; tradePage = 0;
      function buySpecific(matchFn, reserve) {
        let owned = player.inventory.filter(matchFn).length;
        let g = 0;
        while (owned < reserve && g++ < 30) {
          let bestIdx = -1, bestPrice = Infinity;
          npc.shop.forEach((it, idx) => {
            if (!matchFn(it)) return;
            const price = Math.round(it.value * 1.2 * repMult);
            if (price <= player.gold && price < bestPrice) { bestPrice = price; bestIdx = idx; }
          });
          if (bestIdx === -1) break;
          const name = npc.shop[bestIdx].name;
          tradePage = Math.floor(bestIdx / PAGE_SIZE);
          tradeTransact(String.fromCharCode(97 + (bestIdx % PAGE_SIZE)));
          bought.push(name);
          owned++;
        }
      }
      buySpecific(isBandage, ${BOT_PROFILE.curativeReserve});
      buySpecific(isAntidote, ${BOT_PROFILE.curativeReserve});

      let ownedCuratives = player.inventory.filter(isCurative).length;
      let guard = 0;
      while (ownedCuratives < ${BOT_PROFILE.curativeReserve} && guard++ < 30) {
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
      // Same "grab one if it's on offer and we don't have one" pattern as the lockpick above --
      // this is the only way tryFarm's tilling step ever has a Hoe to work with, since farming
      // is otherwise never forced on the character.
      if (!player.inventory.some(it => it.id === 'hoe')) {
        const idx = npc.shop.findIndex(it => it.id === 'hoe');
        if (idx !== -1) {
          const price = Math.round(npc.shop[idx].value * 1.2 * repMult);
          if (price <= player.gold) {
            tradePage = Math.floor(idx / PAGE_SIZE);
            tradeTransact(String.fromCharCode(97 + (idx % PAGE_SIZE)));
            bought.push('Hoe');
          }
        }
      }

      // ---- SELL PASS: every weapon/armor that scores worse than what's equipped in its slot,
      // plus curatives beyond the reserve (keeps inventory from filling up with 20 bandages when
      // 4 is plenty). Re-reads the filtered sell list fresh each loop for the same
      // index-shifts-after-removal reason as the buy loop above.
      // BUG FIX: this used to judge "surplus" off the same bundled curatives count as the old buy
      // pass, so it could sell the character's ONLY bandage as "excess" whenever total curatives
      // (bandages+potions+antidotes+elixirs combined) exceeded the reserve -- e.g. 1 bandage + 3
      // heal potions with a reserve of 2 would sell 2 items, and whichever happened to come first
      // in inventory order (including the bandage) got sold, undoing the dedicated bandage/
      // antidote buy passes above. Fix: bandages and antidotes are only ever sold down to their
      // OWN reserve floor, tracked separately from the generic curative bundle.
      tradeMode = 'sell'; tradePage = 0;
      guard = 0;
      while (guard++ < 40) {
        const sellList = player.inventory.filter(i => i.type !== 'misc');
        let junkIdx = -1;
        const bandagesHeld = sellList.filter(isBandage).length;
        const antidotesHeld = sellList.filter(isAntidote).length;
        const otherCurativesHeld = sellList.filter(it => isCurative(it) && !isBandage(it) && !isAntidote(it)).length;
        let bandagesPassed = 0, antidotesPassed = 0, otherPassed = 0;
        for (let idx = 0; idx < sellList.length; idx++) {
          const it = sellList[idx];
          if (it.type === 'weapon' || it.type === 'armor') {
            const cur = player.equipment[it.slot];
            if (cur) {
              // Same array-vs-string pitfall as tryEquipUpgrades -- see gearScore above,
              // shared here so buy/sell/equip all agree on what "better" means.
              if (gearScore(it) < gearScore(cur)) { junkIdx = idx; break; }
            }
          } else if (isBandage(it)) {
            bandagesPassed++;
            if (bandagesHeld - bandagesPassed >= ${BOT_PROFILE.curativeReserve}) { junkIdx = idx; break; }
          } else if (isAntidote(it)) {
            antidotesPassed++;
            if (antidotesHeld - antidotesPassed >= ${BOT_PROFILE.curativeReserve}) { junkIdx = idx; break; }
          } else if (isCurative(it)) {
            otherPassed++;
            if (otherCurativesHeld - otherPassed >= ${BOT_PROFILE.curativeReserve}) { junkIdx = idx; break; }
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
  tryCalledShot, tryCastOffensiveSpell, tryCastHealSpell, tryCastDebuffAbility, tryCastBuffAbility,
  tryCastSummonAbility, tryStanchBleeding, tryCurePoison, tryRecoverHp,
  tryEquipUpgrades, tryPickUpHere, tryFarm, tryCraftUseful, tryCraftGearUpgrade, tryShopIfTrading, tryTrainIfOffered,
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
//     whichever known target is nearest -- see getMainQuestNavigationTarget), and (added in a
//     later pass, see "UNIFIED ABILITY POOL" below) offensive/heal/buff/debuff/summon use of
//     EVERY ability pool the game has -- spells, techniques, active cybernetics, and active
//     mutations -- not just player spells.
//
//   ---- UNIFIED ABILITY POOL (the single biggest coverage gap found and closed after initial
//   shipping, via a direct code audit rather than a crash -- nothing here ever errored, entire
//   ability systems just silently never got used) ----
//   The game resolves spells, techniques, active cybernetics, and active mutations through ONE
//   shared pipeline: findAbilityById() looks across all four pools, isAbilityKnown() checks all
//   four, castSpell(id) (despite the name) casts/activates ANY of them, and each pays from its
//   own resource (mp/stamina/charge/hp) via getPoolValue()/effectiveCost(). The strategies as
//   first written only ever read player.knownSpells and compared against player.mp directly --
//   which meant TECHNIQUES, ACTIVE CYBERNETICS, and ACTIVE MUTATIONS were known/installed but
//   NEVER INVOKED by the autonomous bot at all, and even within the one pool that was read,
//   only spell TYPES 'damage' and 'heal' were ever cast -- 'buff'/'debuff'/'summon'/'execute'/
//   'smite'/'drain'/'cleanse'/'purify' sat on a character's knownSpells for an entire life,
//   completely unused, regardless of build. Concretely: a caster build that happened to roll
//   Haste, Fear, or Summon Skeleton got real, permanent variety in WHAT it knew (character
//   creation's RNG is genuine -- see "BUILD VARIETY" below) but zero variety in what it
//   actually DID with that build, because the strategies covered maybe half the game's ability
//   surface. Fixed via knownAffordableAbilities()/tryCastOffensiveSpell/tryCastHealSpell/
//   tryCastDebuffAbility (new)/tryCastBuffAbility (new)/tryCastSummonAbility (new), all pulling
//   from the real unified pool and using the game's own effectiveCost()/getPoolValue() rather
//   than reimplementing the cost math. Confirmed firing in real batch runs (not just unit-
//   tested in isolation) -- see SECTION 8's header for how to check this yourself against a
//   freshly-updated game.html. Still not covered by this fix: 'raise' (same conjure-an-ally
//   family as 'summon', but needs a corpse in range rather than being purely self-targeted --
//   see corpseblast's targeting pattern for the template if this is worth adding), and neither
//     debuff nor buff selection is remotely optimal (debuff picks uniformly at random among
//   affordable options rather than reasoning about what a specific monster is vulnerable to;
//   buff doesn't sequence multiple buffs in any particular order) -- both get real EXERCISE now,
//   which is what this toolkit optimizes for, but neither is a good in-game player.
//
//   ---- BUILD VARIETY (real, verified against the actual RNG calls, not assumed) ----
//   Species and "Random archetype" picks both resolve via the game's own choice(Math.random,
//   ARCHETYPES)/equivalent species roll (see archetypeChoice('9') in game.html) -- a genuine
//   uniform pick across all 25 archetypes / every species, not a fixed favorite. The custom
//   point-buy path (draftCustomCharacter, used ~20/50/80% of lives on novice/casual/veteran --
//   see customCreateChance) independently randomizes: focus (melee/caster/hybrid, uniform),
//   stat-point allocation (weighted-random by focus, not deterministic maxing of one stat),
//   which abilities get bought (each affordable candidate in the focus's category order gets an
//   independent 40% roll, not "buy the N cheapest" or "buy everything"), and how many starting
//   items vs. how much gold to end up with. This is NOT pure "different flavor text, same
//   plan" variety -- it produces genuinely different resource situations, including harsh ones
//   (a hybrid build that spent almost its whole budget on abilities can start with as little as
//   1 item and 0 gold, observed in real batch testing -- see the bleeding-death investigation
//   in this project's history for how that surfaced). If you want to deliberately stress a
//   SPECIFIC build/scenario rather than wait on RNG to produce it, that's exactly what SECTION
//   6's debug API + SECTION 8's interactive session are for (debug.giveByName/giveById/
//   addGold/spawnMonster/teleport* to construct the exact starting conditions you want, then
//   drive or observe play from there).
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
//     upgrade (tryCraftUseful only crafts known/affordable curatives), farming toward a
//     specific goal (tryFarm exists but isn't goal-directed), deliberate companion/ally direct
//     command (allies already fight and follow fully autonomously via companionFollowAI -- see
//     game.html -- including defensive/passive stances and disengaging from danger on their own,
//     so this is a much smaller gap than it sounds: a companion in a bot-played game already
//     behaves like a real one without any instruction from here; only the deliberate "send to a
//     specific tile" command (beginCompanionGotoTargeting) and the openOrdersMenu stance-setting
//     dialogue go unused), 'raise'-type abilities (see UNIFIED ABILITY POOL above), and no claim
//     of exhaustive coverage beyond what's listed here -- this list reflects what's been
//     specifically audited and fixed, not a systematic walk of every gameState/function in the
//     game. IMPORTANT FOR A NEW SESSION: if you need to test something not listed as covered
//     above, don't assume it's untested OR assume it's fine -- check for yourself (grep this
//     file for the relevant game.html function name, or just try it directly via SECTION 8's
//     interactive session and see what happens), and add a real strategy function (or extend
//     an existing one, the way tryCastOffensiveSpell was broadened above) if it's worth folding
//     into the autonomous bot rather than only ever being reachable by hand.


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
  const useCustom = Math.random() < BOT_PROFILE.customCreateChance;
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

async function playOneLife(dom, maxActions, maxStuckActions, opts = {}) {
  const { collectTelemetry = true, vitalsInterval = 25, onAction = null } = opts;
  const win = dom.window;
  const events = [];
  const errors = [];
  const errCapture = attachErrorCapture(win);
  const windowErrors = errCapture.errors;
  // Structured (non-prose) data collected alongside the normal event log -- see SECTION 7's
  // header for why this exists: a prose event log is fine for "what happened", but "how much
  // damage did X deal on average" or "how did HP/level/gold trend over the run" needs real
  // numbers, not scraped log lines. combatLog uses the same snapshot-diff technique as
  // runContentSweep/simulateCombat (SECTION 7); vitalsTimeline is a lightweight periodic
  // snapshot of the core numbers a growth-curve or balance analysis would want.
  const combatLog = [];
  const vitalsTimeline = [];
  let hasBeenPlaying = false; // tracks whether we've ever reached 'playing' -- see the
  // implicit-death handling below, right before the main loop.

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

  const buildResult = (reason, actionsUsed, stateCounts, unrecognizedStates, extra = {}) => ({
    events, errors, windowErrors, died: reason === 'died', reason, actionsUsed,
    stateCounts, unrecognizedStates: [...unrecognizedStates],
    combatLog, combatSummary: summarizeCombatLog(combatLog), vitalsTimeline, ...extra,
  });

  const creation = await createRandomCharacter(win, log);
  errors.push(...creation.errors);
  if (!creation.ok) return buildResult('failed-to-start', 0, {}, new Set());

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

  /** Cheap: is there anything within combat-relevant range worth snapshotting for telemetry
   * this turn? Gates the (more expensive) full snapshotCombatants() call so pure exploration
   * turns -- the majority of any run -- don't pay for it. 10 tiles covers melee, ranged, and
   * every spell range in the game (the widest is 7, see SPELLS in game.html). */
  const combatRelevantNearby = () => evalGame(win, `typeof nearestHostile === 'function' && !!nearestHostile(10)`).value === true;

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
      return buildResult('died', actionsUsed, stateCounts, unrecognizedStates);
    }

    if (gs === 'trade') { strat.tryShopIfTrading(win, log); continue; }
    if (gs === 'dialogue') { strat.tryHandleDialogueIfOpen(win, log); continue; }
    if (gs === 'playing') { hasBeenPlaying = true; }
    // BUG FIX (found via a "died: bleeding" life whose event log inexplicably restarted mid-
    // way through, complete with a second "Pick up A Crumpled Note" at the exact same early
    // turn number as the very first action of the life): this game does NOT always route death
    // through 'gameover' -- at least one death path (observed after a bleed-out with the
    // character critically low and no cure available) skips straight from 'playing' to
    // 'start'/a creation screen with a brand-new character already rolled, no game-over screen
    // in between. Before this fix, that fell through to the generic "unrecognized state, close
    // it" handler below, which happened to press exactly the key needed to dismiss the new
    // character's confirm screen -- so the SAME counted "life" silently continued playing as a
    // completely different character, with the real death never logged and never counted. That
    // undercounts real deaths and corrupts actionsUsed/combat-telemetry continuity for any life
    // this happens in. Treat re-entering a creation screen AFTER having already been in
    // 'playing' at least once as the same terminal event 'gameover' is: log it and end this
    // life here, rather than transparently carrying on into a second character. (Landing on
    // these screens BEFORE ever having played is normal and expected -- that's just the
    // original character being created -- so hasBeenPlaying is the necessary guard.)
    if (hasBeenPlaying && (gs === 'start' || gs === 'create_species' || gs === 'create_archetype' || gs === 'title')) {
      const cause = evalGame(win, 'player.deathCause').value;
      log(`DIED: ${cause || '(unknown cause -- game auto-rerolled a new character without a gameover screen)'}`);
      return buildResult('died', actionsUsed, stateCounts, unrecognizedStates);
    }
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

    // --- periodic vitals snapshot: cheap, and gives a real growth-curve timeline for the
    // report rather than just a single before/after pair ---
    if (collectTelemetry && vitalsInterval > 0 && i % vitalsInterval === 0) {
      const v = evalGame(win, `JSON.stringify({turn:turnCount, hp:player.hp, maxHp:player.maxHp, level:player.level, xp:player.xp, gold:player.gold, x:player.x, y:player.y, dungeon:curIsDungeon(), dimension:player.dimensionId||null})`);
      if (v.ok) { try { vitalsTimeline.push(JSON.parse(v.value)); } catch (e) {} }
    }

    // --- combat telemetry: snapshot before, act, snapshot after, diff -- only when something
    // combat-relevant is actually nearby (see combatRelevantNearby's comment above) ---
    const wantTelemetry = collectTelemetry && combatRelevantNearby();
    const combatBefore = wantTelemetry ? snapshotCombatants(win) : null;

    // --- priority-ordered strategies; first one that acts wins this iteration ---
    // Survival first (bleed/heal/flee), then offense (hack > spell > ranged > melee), then
    // world interaction (pickup/talk), then periodic character-growth checks (stat/talent
    // points, cybernetics, rituals -- these are cheap no-ops most turns so checking often is
    // fine, but they're placed after combat/survival so a mid-fight turn never gets spent
    // opening a menu instead of acting), then quest/exploration.
    let acted = false;
    let actionLabel = 'explore';
    acted = acted || await strat.tryStanchBleeding(win, log); if (acted) actionLabel = 'bandage';
    if (!acted) { acted = strat.tryCurePoison(win, log); if (acted) actionLabel = 'antidote'; }
    if (!acted) { acted = await strat.tryRecoverHp(win, log); if (acted) actionLabel = 'recover'; }
    if (!acted) { acted = await strat.tryFleeIfCritical(win, log); if (acted) actionLabel = 'flee'; }
    if (!acted) { acted = await strat.tryAvoidOverwhelmingMonster(win, log); if (acted) actionLabel = 'retreat'; }
    if (!acted) { acted = strat.tryUseHackChip(win, log); if (acted) actionLabel = 'hack'; }
    if (!acted) { acted = strat.tryCastBuffAbility(win, log); if (acted) actionLabel = 'buff'; }
    if (!acted) { acted = strat.tryCastSummonAbility(win, log); if (acted) actionLabel = 'summon'; }
    if (!acted) { acted = strat.tryCastDebuffAbility(win, log); if (acted) actionLabel = 'debuff'; }
    if (!acted) { acted = strat.tryCastOffensiveSpell(win, log); if (acted) actionLabel = 'spell'; }
    if (!acted) { acted = strat.tryFireRanged(win, log); if (acted) actionLabel = 'ranged'; }
    if (!acted) strat.tryCalledShot(win, log); // never counts as "acted" on its own -- setup only
    if (!acted) { acted = await strat.tryFightAdjacent(win); if (acted) actionLabel = 'melee'; }
    if (!acted) acted = strat.tryPickUpHere(win, log);
    if (!acted) acted = strat.tryFarm(win, log);
    if (!acted) acted = strat.tryTalkToAdjacentNpc(win, log, talkedNpcUids);
    if (!acted && i % 40 === 0) acted = strat.tryEquipUpgrades(win, log);
    if (!acted && i % 25 === 0) acted = strat.tryCraftUseful(win, log);
    if (!acted && i % 35 === 0) acted = strat.tryCraftGearUpgrade(win, log);
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

    if (combatBefore) {
      const combatAfter = snapshotCombatants(win);
      combatLog.push(...diffCombatSnapshots(combatBefore, combatAfter, actionLabel));
    }

    // --- optional live hook: lets a caller (e.g. another Claude session driving this via
    // require()) observe every single action as it happens, not just read a report after the
    // fact -- and, by returning false, stop the life early right here (e.g. "pause once level 5
    // is reached so I can inspect/take over manually"). Never throws the life off course if the
    // caller doesn't pass one; onAction is entirely opt-in. ---
    if (onAction) {
      const shouldContinue = await onAction({ i, actionLabel, acted, gameState: evalGame(win, 'gameState').value, state: getState(win) }, win);
      if (shouldContinue === false) {
        log('Stopped early by onAction callback.');
        return buildResult('stopped-by-caller', actionsUsed, stateCounts, unrecognizedStates);
      }
    }

    const newTc = evalGame(win, 'turnCount').value;
    if (newTc === lastTurnCount) stuckCounter++; else { stuckCounter = 0; lastTurnCount = newTc; }

    if (stuckCounter > maxStuckActions) {
      const stX = evalGame(win, 'player.x').value, stY = evalGame(win, 'player.y').value;
      log(`STUCK: no turn progress for ${stuckCounter}+ actions at x=${stX} y=${stY}, dungeon=${evalGame(win, 'curIsDungeon()').value}`);
      return buildResult('stuck', actionsUsed, stateCounts, unrecognizedStates);
    }
  }

  const finalSt = getState(win);
  log(`Reached action budget. hp=${finalSt && finalSt.hp} level=${finalSt && finalSt.level}`);
  return buildResult('budget-reached', actionsUsed, stateCounts, unrecognizedStates, { finalState: finalSt });
}

// ==========================================================================================
// SECTION 6: DEBUG CONTROL API -- thin wrappers around the game's OWN dev/debug menu
// ==========================================================================================
// The game ships a real, thorough debug menu (Settings -> Debug tab, see DEBUG/renderDebugTab
// in game.html) built for exactly this need: exploring/testing a specific area or scenario
// without dying, without waiting on a random encounter to happen, or without needing to earn
// or find something first. Every function below is a direct, thin wrapper that calls the
// game's OWN debug function via evalGame() -- none of this reimplements game logic, it just
// gives a controlling script (this file's CLI, or another Claude session driving via
// `require('./playtest.js')`) a clean way to call it. A few of the real UI's onclick handlers
// read their parameters (qty, rarity, weather duration) off DOM `<input>` elements that only
// exist while the Settings modal is actually open and rendered -- those are reimplemented here
// against the exact same underlying primitives (makeItem/addItemToList, ensureWeather, etc.)
// but taking the parameter directly as a function argument instead, so these work whether or
// not any menu is currently open on screen.
//
// These are NOT used by the autonomous strategies in SECTION 4/5 -- normal playthroughs never
// touch DEBUG or these functions, so a standard `node playtest.js` run is completely unaffected
// by this section existing. This is specifically for DIRECTED testing: "drop me in the Crypt
// dungeon type with all spells and infinite health so I can watch how spellcasting behaves
// there" is a single `debug.teleportToDungeonType()` + `debug.setFlags()` + `debug.getAllSpells()`
// call away, instead of needing to actually earn/find that dungeon and those spells first.

/** Merge flags into the game's live DEBUG object (see DEBUG in game.html for the full field
 * list: infiniteHealth, noDamage, infiniteMana, infiniteStamina, infiniteVision, xrayVision,
 * freezeTime, noclip, invisibleToEnemies, oneHitKill). Pass only the fields you want to change;
 * anything omitted keeps its current value. Returns the resulting full DEBUG object. */
function debugSetFlags(win, flags) {
  const r = evalGame(win, `(function(){ Object.assign(DEBUG, ${JSON.stringify(flags)}); if (gameState==='settings') renderSettingsTab('debug'); return JSON.stringify(DEBUG); })()`);
  return r.ok ? JSON.parse(r.value) : null;
}
/** Read the current state of every DEBUG toggle. */
function debugGetFlags(win) {
  const r = evalGame(win, 'JSON.stringify(DEBUG)');
  return r.ok ? JSON.parse(r.value) : null;
}
/** Reset every DEBUG toggle to off -- exact wrapper of the real "Reset All Debug Toggles" button. */
function debugResetAllFlags(win) { evalGame(win, 'debugResetAllFlags()'); }
/** Force HP/MP/Stamina/Charge to full and clear poison/fear/confuse/buffs. */
function debugFullRestore(win) { evalGame(win, 'debugFullRestore()'); }
/** Turn all four survival toggles (infiniteHealth/noDamage/infiniteMana/infiniteStamina) on or off at once. */
function debugSetVitalFlags(win, enabled) { evalGame(win, `debugSetVitalFlags(${!!enabled})`); }
/** Reveal a ~48-tile radius of previously-unseen terrain around the player's current position. */
function debugRevealMap(win) { evalGame(win, 'debugRevealMap()'); }
/** Instantly kill every living monster currently in view/loaded near the player. */
function debugKillAllNearby(win) { evalGame(win, 'debugKillAllNearby()'); }
/** Add `amount` gold. */
function debugAddGold(win, amount) { evalGame(win, `debugAddGold(${Number(amount) || 0})`); }
/** Grant `times` level-ups directly (bumps level/stats without touching real XP progress). */
function debugLevelUp(win, times = 1) { evalGame(win, `debugLevelUp(${Number(times) || 1})`); }
/** Learn every spell/technique in the game. */
function debugGetAllSpells(win) { evalGame(win, 'debugGetAllSpells()'); }
function debugGetAllTechniques(win) { evalGame(win, 'debugGetAllTechniques()'); }
/** Grant every eldritch mutation / install every cyberware in the game. */
function debugGetAllMutations(win) { evalGame(win, 'debugGetAllMutations()'); }
function debugGetAllCyber(win) { evalGame(win, 'debugGetAllCyber()'); }

/** List every monster species id/name/tier in the game (live off MONSTER_BASES). */
function debugListMonsters(win) {
  const r = evalGame(win, `JSON.stringify(Object.keys(MONSTER_BASES).map(id => ({ id, name: MONSTER_BASES[id].name, dtier: MONSTER_BASES[id].dtier || null, hp: MONSTER_BASES[id].hp, boss: !!MONSTER_BASES[id].boss })))`);
  return r.ok ? JSON.parse(r.value) : [];
}
/** Spawn a monster by id adjacent to (or within `radius` tiles of) the player, using the game's
 * OWN spawn primitives (makeMonster + addMonsterToWorld + findOpenAdjacent -- see game.html) --
 * the exact same functions the game itself uses for random encounters, so the spawned monster
 * is placed, chunk-registered, and depth-scaled exactly as if it had spawned naturally. No
 * hardcoded monster list: any id from debugListMonsters (or added to MONSTER_BASES later) works.
 * `depthScale` defaults to the player's own level, matching the difficulty they'd actually meet
 * a wild one at right now; pass a specific number to test a monster at a different power level. */
function debugSpawnMonster(win, monsterId, opts = {}) {
  const radius = opts.radius || 1;
  const depthScaleExpr = opts.depthScale != null ? String(Number(opts.depthScale)) : '(player.level || 1)';
  const r = evalGame(win, `
    (function(){
      if (!MONSTER_BASES[${JSON.stringify(monsterId)}]) return { ok:false, reason:'unknown monster id' };
      const spot = findOpenAdjacent(player.x, player.y, ${radius});
      if (!spot) return { ok:false, reason:'no open tile nearby' };
      const m = makeMonster(${JSON.stringify(monsterId)}, spot.x, spot.y, ${depthScaleExpr}, Math.random);
      addMonsterToWorld(m);
      // BUG FIX (found via snapshotState/restoreState testing): addMonsterToWorld() never marks
      // the chunk it pushes into as dirty, and getSaveData() only persists dirty chunks --
      // everything else is expected to regenerate identically from SEED on revisit, which is
      // exactly right for NORMAL monster spawns (they came from the seeded RNG in the first
      // place, so they'll come back the same way). A debug-spawned monster uses Math.random(),
      // not the seeded RNG, so it is NOT reproducible from SEED -- without this, it silently
      // vanishes on any snapshotState()/restoreState() round-trip (confirmed: spawned a boar,
      // snapshotted, restored into a fresh session, boar was gone). Marking the chunk dirty
      // here makes a debug-spawned monster survive a snapshot exactly like a naturally-
      // encountered one already does -- important since "set up a specific scenario via debug,
      // then branch multiple tactics against it via restore" is the whole point of SECTION 9.
      if (curIsDungeon()) { /* dungeon levels are always saved in full already, nothing to flag */ }
      else if (curIsDimension()) { const c = getDimensionChunk(player.dimensionId, Math.floor(m.x/CH), Math.floor(m.y/CH)); if (c) c.dirty = true; }
      else { const c = getChunk(Math.floor(m.x/CH), Math.floor(m.y/CH)); if (c) c.dirty = true; }
      return { ok:true, uid: m.uid, name: m.name, hp: m.hp, maxHp: m.hp, x: m.x, y: m.y };
    })()
  `);
  return r.ok ? r.value : { ok: false, reason: r.error };
}

/** Search every item/spell/technique/mutation/cyberware by name -- same registry the real
 * debug search box queries. Returns an array of {kind, id, name, tag}. */
function debugSearchRegistry(win, query) {
  const r = evalGame(win, `JSON.stringify(debugRegistrySearch(${JSON.stringify(query)}))`);
  return r.ok ? JSON.parse(r.value) : [];
}
/** Give an item/spell/technique/mutation/cyberware by its exact registry id (see
 * debugSearchRegistry to find one by name first). `opts.qty`/`opts.rarity` only apply to
 * kind==='item' (rarity 0=Common..4=Legendary, matching the real menu's dropdown). Re-implements
 * the real debugGiveByKindId()'s logic directly against player state rather than calling it,
 * since the real function reads qty/rarity off DOM <input> elements that don't exist unless the
 * Settings modal is actually open -- this takes them as real arguments instead. */
function debugGiveById(win, kind, id, opts = {}) {
  const qty = Math.max(1, Math.min(99, opts.qty || 1));
  const rarity = Math.max(0, Math.min(4, opts.rarity != null ? opts.rarity : 2));
  const r = evalGame(win, `
    (function(){
      const kind = ${JSON.stringify(kind)}, id = ${JSON.stringify(id)};
      if (kind === 'item') {
        const base = ITEM_BASES.find(b => b.id === id);
        if (!base) return { ok:false, reason:'unknown item id' };
        for (let i = 0; i < ${qty}; i++) { const it = makeItem(id, ${rarity}, Math.random, 1); if (it) addItemToList(player.inventory, it); }
        return { ok:true, name: base.name, qty: ${qty} };
      } else if (kind === 'spell') {
        if (!SPELLS.find(s=>s.id===id)) return { ok:false, reason:'unknown spell id' };
        if (!player.knownSpells.includes(id)) player.knownSpells.push(id);
        return { ok:true, name: SPELLS.find(s=>s.id===id).name };
      } else if (kind === 'technique') {
        if (!TECHNIQUES.find(t=>t.id===id)) return { ok:false, reason:'unknown technique id' };
        if (!player.knownTechniques.includes(id)) player.knownTechniques.push(id);
        return { ok:true, name: TECHNIQUES.find(t=>t.id===id).name };
      } else if (kind === 'mutation') {
        const granted = debugGrantMutationSilent(id);
        return { ok:true, name: (MUTATIONS.find(m=>m.id===id)||{}).name || id, granted };
      } else if (kind === 'cyber') {
        const granted = debugGrantCyberSilent(id);
        return { ok:true, name: (CYBERNETICS.find(c=>c.id===id)||{}).name || id, granted };
      }
      return { ok:false, reason:'unknown kind' };
    })()
  `);
  if (r.ok) evalGame(win, 'updateSidebar()');
  return r.ok ? r.value : { ok: false, reason: r.error };
}
/** Convenience: search by name and give the single best (first) match. Returns null if no match. */
function debugGiveByName(win, query, opts = {}) {
  const matches = debugSearchRegistry(win, query);
  if (!matches.length) return null;
  return debugGiveById(win, matches[0].kind, matches[0].id, opts);
}

/** List every dimension id/name in the game (live off DIMENSIONS). */
function debugListDimensions(win) {
  const r = evalGame(win, 'JSON.stringify(debugDimensionList())');
  return r.ok ? JSON.parse(r.value) : [];
}
/** List every dungeon theme id/name/tier in the game (live off DUNGEON_THEMES). */
function debugListDungeonTypes(win) {
  const r = evalGame(win, 'JSON.stringify(debugDungeonTypeList())');
  return r.ok ? JSON.parse(r.value) : [];
}
/** Teleport straight into a dimension by id (see debugListDimensions). Sets up return-path
 * bookkeeping exactly like a real rift crossing -- debugReturnToOverworld() unwinds it.
 * NOTE: this and the three functions below all end by calling the real game's closeSettings()
 * (since normally you'd trigger these FROM the open Settings/Debug modal, and it needs to close
 * behind you). closeSettings() decides where to land by reading `settingsReturnState`, a
 * variable normally set the moment the Settings modal is actually opened -- which never happens
 * here, since these are called directly. Its default value is 'title', so without setting it
 * first, EVERY debug teleport would silently kick the session back to the title screen right
 * after moving the player (confirmed by testing: 94/94 content-sweep stops hit this before the
 * fix below was added -- see runContentSweep's notableFindings tracking, which is what caught
 * it). Setting it to 'playing' immediately before each call makes these behave exactly as if
 * triggered from a normal, already-in-game Settings visit. */
function debugTeleportToDimension(win, dimId) { evalGame(win, `settingsReturnState = 'playing'; debugTeleportToDimension(${JSON.stringify(dimId)})`); }
/** Spawn a fresh instance of a dungeon theme by id (see debugListDungeonTypes) and drop the
 * player onto its up-stairs, exactly like walking up to a real entrance and pressing '>'. */
function debugTeleportToDungeonType(win, themeId) { evalGame(win, `settingsReturnState = 'playing'; debugTeleportToDungeonType(${JSON.stringify(themeId)})`); }
function debugTeleportRandomDimension(win) { evalGame(win, `settingsReturnState = 'playing'; debugTeleportRandomDimension()`); }
function debugTeleportRandomDungeonType(win) { evalGame(win, `settingsReturnState = 'playing'; debugTeleportRandomDungeonType()`); }
/** Unwind however many debug jumps deep (dungeon-in-dimension, chained jumps, etc.) back to
 * the true overworld in one call. */
function debugReturnToOverworld(win) { evalGame(win, `settingsReturnState = 'playing'; debugReturnToOverworld()`); }

/** List every weather type / world event id+name in the game. */
function debugListWeatherTypes(win) {
  const r = evalGame(win, 'JSON.stringify(Object.keys(WEATHER_TYPES).map(id=>({id,name:WEATHER_TYPES[id].name})))');
  return r.ok ? JSON.parse(r.value) : [];
}
function debugListWorldEvents(win) {
  const r = evalGame(win, 'JSON.stringify(WORLD_EVENTS.map(e=>({id:e.id,name:e.name})))');
  return r.ok ? JSON.parse(r.value) : [];
}
/** Force the current zone's weather by id for `duration` turns (default 200). No-ops
 * underground, same as the real menu ("Weather doesn't apply underground"). Reimplements
 * debugForceWeather()'s logic directly rather than calling it, since the real function reads
 * duration off a DOM <input>. */
function debugForceWeather(win, id, duration = 200) {
  evalGame(win, `
    (function(){
      if (!WEATHER_TYPES[${JSON.stringify(id)}]) return;
      if (curIsDungeon()) return;
      const st = ensureWeather(zoneKey());
      st.id = ${JSON.stringify(id)}; st.turnsRemaining = ${Number(duration) || 200};
      updateSidebar();
    })()
  `);
}
function debugClearWeather(win) { evalGame(win, 'debugClearWeather()'); }
/** Fire a world event immediately by id (same dispatcher a real organic trigger uses, skipping
 * only the rarity/zone/day gating). */
function debugTriggerEvent(win, id) { evalGame(win, `debugTriggerEvent(${JSON.stringify(id)})`); }
/** Schedule a world event with its real telegraph warning (if it has one), resolving after its
 * normal delay -- use this instead of debugTriggerEvent to test the warn-then-resolve flow. */
function debugScheduleEvent(win, id) { evalGame(win, `debugScheduleEvent(${JSON.stringify(id)})`); }
function debugClearActiveEvents(win) { evalGame(win, 'debugClearActiveEvents()'); }
function debugClearPendingEvents(win) { evalGame(win, 'debugClearPendingEvents()'); }

const debug = {
  setFlags: debugSetFlags, getFlags: debugGetFlags, resetAllFlags: debugResetAllFlags,
  fullRestore: debugFullRestore, setVitalFlags: debugSetVitalFlags,
  revealMap: debugRevealMap, killAllNearby: debugKillAllNearby,
  addGold: debugAddGold, levelUp: debugLevelUp,
  getAllSpells: debugGetAllSpells, getAllTechniques: debugGetAllTechniques,
  getAllMutations: debugGetAllMutations, getAllCyber: debugGetAllCyber,
  listMonsters: debugListMonsters, spawnMonster: debugSpawnMonster,
  searchRegistry: debugSearchRegistry, giveById: debugGiveById, giveByName: debugGiveByName,
  listDimensions: debugListDimensions, listDungeonTypes: debugListDungeonTypes,
  teleportToDimension: debugTeleportToDimension, teleportToDungeonType: debugTeleportToDungeonType,
  teleportRandomDimension: debugTeleportRandomDimension, teleportRandomDungeonType: debugTeleportRandomDungeonType,
  returnToOverworld: debugReturnToOverworld,
  listWeatherTypes: debugListWeatherTypes, listWorldEvents: debugListWorldEvents,
  forceWeather: debugForceWeather, clearWeather: debugClearWeather,
  triggerEvent: debugTriggerEvent, scheduleEvent: debugScheduleEvent,
  clearActiveEvents: debugClearActiveEvents, clearPendingEvents: debugClearPendingEvents,
};

// ==========================================================================================
// SECTION 7: TELEMETRY & CONTENT COVERAGE -- balance data + deterministic "test everything"
// ==========================================================================================
// Two things a real playtester/balance-pass wants that pure autonomous play can't reliably
// give you: (1) structured numeric combat data (not prose logs) to spot outliers -- "this
// monster hits way harder than anything else at its depth", "this weapon barely scratches
// anything" -- and (2) a GUARANTEE that every piece of content got exercised at least once,
// rather than hoping a long enough random playthrough happens to wander into it. Both of these
// build entirely on the primitives above (evalGame, the debug API) -- neither one modifies or
// reimplements any game logic.

// ---- combat telemetry: HP-delta snapshotting, not function-hooking --------------------------
// Deliberately reads observable STATE (hp before/after) rather than monkey-patching a specific
// internal function like doAttack() or castSpell(). Damage in this game is applied inline in
// dozens of different branches (melee, ranged, ~15 different spell types, poison ticks, thorns,
// traps, ...) with no single choke point to hook -- but every single one of them, present or
// future, has to eventually change some entity's `hp` field, because that's what "damage" IS in
// this engine. Snapshotting hp before/after an action and diffing is therefore automatically
// correct for any damage source the game has now OR adds later, with zero maintenance burden,
// which a hook on a specific function name would not be.
/** Snapshot the player and every monster within `radius` tiles (default 12 -- generous enough
 * to cover a whole small room/encounter) for later diffing. */
function snapshotCombatants(win, radius = 12) {
  const r = evalGame(win, `
    JSON.stringify({
      turn: turnCount, playerHp: player.hp, playerMaxHp: player.maxHp,
      monsters: curMonsters().filter(m => m.alive && chebyshev(m.x,m.y,player.x,player.y) <= ${radius})
        .map(m => ({ uid: m.uid, monsterId: m.monsterId, name: m.name, hp: m.hp })),
    })
  `);
  return r.ok ? JSON.parse(r.value) : null;
}
/** Diff two snapshotCombatants() results into structured events: damage dealt to each monster
 * present in both (by uid, so it's the SAME monster instance, not just same species), damage
 * taken by the player, and deaths (present+alive before, gone or hp<=0 after). `actionLabel` is
 * just a caller-supplied tag (e.g. 'melee:Longsword', 'spell:Fireball') for grouping later. */
function diffCombatSnapshots(before, after, actionLabel) {
  if (!before || !after) return [];
  const events = [];
  const playerDmgTaken = Math.max(0, before.playerHp - after.playerHp);
  if (playerDmgTaken > 0) events.push({ type: 'damageTaken', target: 'player', amount: playerDmgTaken, action: actionLabel, turn: after.turn });
  const afterByUid = new Map(after.monsters.map(m => [m.uid, m]));
  for (const mBefore of before.monsters) {
    const mAfter = afterByUid.get(mBefore.uid);
    const hpAfter = mAfter ? mAfter.hp : 0; // gone from the snapshot radius almost always means it died
    const dmg = Math.max(0, mBefore.hp - hpAfter);
    // uid included on every event (not just monsterId/species) so a caller tracking ONE specific
    // spawned instance -- see simulateCombat below -- can filter to exactly that monster and
    // never accidentally attribute damage dealt to/by some unrelated wild monster that happened
    // to wander within snapshot radius during the same window. This is what a first version of
    // simulateCombat got wrong: it summed ALL monsters' damage in range, inflating results
    // whenever the real, live overworld/dungeon put another creature nearby mid-trial.
    if (dmg > 0) events.push({ type: 'damageDealt', uid: mBefore.uid, target: mBefore.monsterId, targetName: mBefore.name, amount: dmg, action: actionLabel, turn: after.turn });
    if (mBefore.hp > 0 && hpAfter <= 0) events.push({ type: 'kill', uid: mBefore.uid, target: mBefore.monsterId, targetName: mBefore.name, action: actionLabel, turn: after.turn });
  }
  return events;
}
/** Aggregate a flat array of diffCombatSnapshots() events (e.g. life.combatLog after a run)
 * into per-action-label and per-monster summary stats -- total/average damage dealt and taken,
 * kill counts, all grouped by the action tag. This is the "spot the balance outlier" view. */
function summarizeCombatLog(events) {
  const byAction = {}, byMonster = {};
  const bump = (map, key, field, amount) => {
    if (!map[key]) map[key] = { count: 0, totalDamageDealt: 0, totalDamageTaken: 0, kills: 0 };
    map[key][field] += amount;
    map[key].count++;
  };
  for (const e of events) {
    const actionKey = e.action || 'unknown';
    const monsterKey = e.target === 'player' ? null : (e.target || 'unknown');
    if (e.type === 'damageDealt') { bump(byAction, actionKey, 'totalDamageDealt', e.amount); if (monsterKey) bump(byMonster, monsterKey, 'totalDamageDealt', e.amount); }
    if (e.type === 'damageTaken') { bump(byAction, actionKey, 'totalDamageTaken', e.amount); }
    if (e.type === 'kill') { if (!byAction[actionKey]) byAction[actionKey] = { count: 0, totalDamageDealt: 0, totalDamageTaken: 0, kills: 0 }; byAction[actionKey].kills++; if (monsterKey) { if (!byMonster[monsterKey]) byMonster[monsterKey] = { count: 0, totalDamageDealt: 0, totalDamageTaken: 0, kills: 0 }; byMonster[monsterKey].kills++; } }
  }
  for (const k of Object.keys(byAction)) byAction[k].avgDamagePerHit = byAction[k].count ? +(byAction[k].totalDamageDealt / byAction[k].count).toFixed(1) : 0;
  for (const k of Object.keys(byMonster)) byMonster[k].avgDamagePerHit = byMonster[k].count ? +(byMonster[k].totalDamageDealt / byMonster[k].count).toFixed(1) : 0;
  return { byAction, byMonster };
}

// ---- content coverage sweep: deterministically visit every piece of content -----------------
/**
 * Systematically exercises every dungeon theme, every dimension, every known spell/technique,
 * every recipe, every weather type, and every world event at least once, using the debug API
 * (god-mode on throughout, so nothing here can end the run by dying) and catching real engine
 * crashes via attachErrorCapture. This is the deterministic complement to autonomous play: a
 * long random playthrough MIGHT wander into the one dungeon theme or spell with a bug in it,
 * eventually, if you're patient (or unlucky) enough for the RNG to cooperate -- this guarantees
 * every one of them gets touched at least once in a single run, and tells you exactly which
 * piece of content was active when anything went wrong.
 *
 * Entirely data-driven off the game's own registries (debug.listDungeonTypes/listDimensions
 * read DUNGEON_THEMES/DIMENSIONS live, spells/recipes read player.knownSpells/knownRecipes
 * after granting all of them) -- nothing here is a hardcoded content list, so new dungeon
 * themes, dimensions, spells, recipes, weather types, or world events the game adds later are
 * automatically included in the sweep with zero changes needed to this function.
 *
 * @param {object} opts
 *   turnsPerDungeon (default 40): how many normal strategy-loop turns to spend in each dungeon
 *     theme/dimension before moving to the next -- enough to actually fight a few monsters and
 *     touch a few tiles, not just glance at the entrance.
 *   include (default all true): { dungeons, dimensions, spells, recipes, weather, events } --
 *     set any to false to skip that category (e.g. for a faster, targeted sweep).
 *   onProgress(msg): optional callback for real-time progress output (sweeps can take a while).
 * @returns { crashes: [{phase, contentId, error}], visited: {dungeons,dimensions,spells,...},
 *            combatLog: [...] } -- crashes is the headline result; an empty array is a genuine
 *            "nothing in the game crashed when every piece of content was touched" finding.
 */
async function runContentSweep(win, opts = {}) {
  const {
    turnsPerDungeon = 40,
    include = { dungeons: true, dimensions: true, spells: true, recipes: true, weather: true, events: true },
    onProgress = () => {},
  } = opts;
  const errCapture = attachErrorCapture(win);
  const crashes = [];
  const combatLog = [];
  const notableFindings = [];
  const visited = { dungeons: [], dimensions: [], spells: [], recipes: [], weather: [], events: [] };

  const checkNewCrashes = (phase, contentId) => {
    while (errCapture.errors.length > 0) {
      crashes.push({ phase, contentId, error: errCapture.errors.shift() });
    }
  };
  const safely = async (phase, contentId, fn) => {
    try { await fn(); } catch (e) { crashes.push({ phase, contentId, error: e.stack || String(e) }); }
    checkNewCrashes(phase, contentId);
  };

  // God mode for the whole sweep -- the point is coverage, not a fair fight. NOTE: this does
  // NOT guarantee immortality -- see the death-recovery handling in runTurnsHere below, which
  // is there because testing surfaced a real, worth-knowing-about finding: some death paths
  // (environmental hazards resolved outside the normal combat-damage code path these DEBUG
  // flags gate, e.g. a chasm fall or similar) can still end a "god mode" character. Rather than
  // let that silently derail the whole sweep (once dead, more keypresses land on the title
  // screen instead of gameplay, producing confusing unrelated errors), this detects it, records
  // exactly which content phase it happened during as a real finding, and recovers by rerolling
  // a fresh character so the sweep can continue covering everything else.
  debugSetFlags(win, { infiniteHealth: true, infiniteMana: true, infiniteStamina: true, noDamage: true });

  const recoverFromDeathIfNeeded = async (phase, contentId) => {
    const gs = evalGame(win, 'gameState').value;
    if (gs === 'playing') return false;
    if (gs === 'gameover' || gs === 'title' || gs === 'start' || gs === 'create_species' || gs === 'create_archetype') {
      notableFindings.push({
        phase, contentId,
        note: `Character died/reset despite god-mode flags being active (gameState was '${gs}'). This is a real finding worth investigating manually with the debug API -- likely an environmental/instant-death path that doesn't check DEBUG.infiniteHealth/noDamage.`,
      });
      // Reroll a fresh character and reapply god mode so the sweep can keep going.
      if (gs !== 'title') { key(win, 'Escape'); await sleep(20); }
      if (evalGame(win, 'gameState').value !== 'title') evalGame(win, "gameState = 'title'");
      await createRandomCharacter(win, () => {});
      debugSetFlags(win, { infiniteHealth: true, infiniteMana: true, infiniteStamina: true, noDamage: true });
      return true;
    }
    key(win, 'Escape'); // some other stray menu -- just close it, not a death
    return false;
  };

  const runTurnsHere = async (n, phase, contentId) => {
    for (let i = 0; i < n; i++) {
      if (await recoverFromDeathIfNeeded(phase, contentId)) return; // stop early this stop; move to the next one
      const before = snapshotCombatants(win);
      let acted = await strat.tryFightAdjacent(win);
      if (!acted) acted = strat.tryPickUpHere(win, null);
      if (!acted) { const { progressed } = await nav.exploreStep(win, { dir: null, stepsLeft: 0 }); acted = progressed; }
      const after = snapshotCombatants(win);
      combatLog.push(...diffCombatSnapshots(before, after, 'sweep'));
      if (evalGame(win, 'gameState').value !== 'playing') await recoverFromDeathIfNeeded(phase, contentId);
    }
  };

  if (include.dungeons) {
    for (const dg of debugListDungeonTypes(win)) {
      onProgress(`dungeon: ${dg.name} (${dg.id})`);
      await safely('dungeon', dg.id, async () => {
        debugTeleportToDungeonType(win, dg.id);
        await runTurnsHere(turnsPerDungeon, 'dungeon', dg.id);
        debugReturnToOverworld(win);
      });
      visited.dungeons.push(dg.id);
    }
  }
  if (include.dimensions) {
    for (const dim of debugListDimensions(win)) {
      onProgress(`dimension: ${dim.name} (${dim.id})`);
      await safely('dimension', dim.id, async () => {
        debugTeleportToDimension(win, dim.id);
        await runTurnsHere(turnsPerDungeon, 'dimension', dim.id);
        debugReturnToOverworld(win);
      });
      visited.dimensions.push(dim.id);
    }
  }
  if (include.spells) {
    debugGetAllSpells(win); debugGetAllTechniques(win);
    const spellIds = evalGame(win, 'JSON.stringify([...(player.knownSpells||[]), ...(player.knownTechniques||[])])');
    for (const id of (spellIds.ok ? JSON.parse(spellIds.value) : [])) {
      onProgress(`ability: ${id}`);
      await safely('ability', id, async () => {
        // Cast against whatever's nearest if one's needed; utility/buff/self spells just fire.
        // castSpell() itself handles "no target in range" gracefully (logs and returns) for
        // anything requiring one, so this never blocks waiting on a target that isn't there.
        evalGame(win, `castSpell(${JSON.stringify(id)})`);
      });
    }
    visited.spells = spellIds.ok ? JSON.parse(spellIds.value) : [];
  }
  if (include.recipes) {
    const allRecipeIds = evalGame(win, 'JSON.stringify(RECIPES.map(r=>r.id))');
    for (const rid of (allRecipeIds.ok ? JSON.parse(allRecipeIds.value) : [])) {
      onProgress(`recipe: ${rid}`);
      await safely('recipe', rid, async () => {
        // Grant every input material directly rather than hunting for it, so this exercises
        // craftRecipe() itself (the thing actually worth testing) instead of the drop tables.
        evalGame(win, `
          (function(){
            const rec = RECIPES.find(r=>r.id===${JSON.stringify(rid)});
            if (!rec) return;
            player.knownRecipes = player.knownRecipes || [];
            if (!player.knownRecipes.includes(rec.id)) player.knownRecipes.push(rec.id);
            for (const inp of (rec.inputs||[])) {
              const have = player.inventory.filter(i=>i.id===inp.id).reduce((s,i)=>s+(i.amount||1),0);
              if (have < inp.qty) {
                const it = makeItem(inp.id, 2, Math.random, inp.qty - have);
                if (it) addItemToList(player.inventory, it);
              }
            }
            craftRecipe(rec.id);
          })()
        `);
      });
    }
    visited.recipes = allRecipeIds.ok ? JSON.parse(allRecipeIds.value) : [];
  }
  if (include.weather) {
    for (const w of debugListWeatherTypes(win)) {
      onProgress(`weather: ${w.name} (${w.id})`);
      await safely('weather', w.id, async () => { debugForceWeather(win, w.id, 5); });
      visited.weather.push(w.id);
    }
    debugClearWeather(win);
  }
  if (include.events) {
    for (const ev of debugListWorldEvents(win)) {
      onProgress(`event: ${ev.name} (${ev.id})`);
      await safely('event', ev.id, async () => { debugTriggerEvent(win, ev.id); await runTurnsHere(3, 'event', ev.id); });
      visited.events.push(ev.id);
    }
    debugClearActiveEvents(win); debugClearPendingEvents(win);
  }

  debugResetAllFlags(win); // leave the session clean for whatever the caller does next
  return { crashes, notableFindings, visited, combatLog, combatSummary: summarizeCombatLog(combatLog) };
}

// ---- combat simulator: isolated, repeatable weapon/spell/monster balance testing -------------
/**
 * The tool a real balance pass actually reaches for: fight a specific monster (or cast a
 * specific spell at it) N times in a row, in isolation, with the player fully restored between
 * fights, and get back real numbers -- kill rate, average turns to kill, average damage taken.
 * This is what answers "does a Longsword actually kill a Rust Sentinel faster than a Fireball
 * does" or "is this new monster's damage output in line with others at its tier" with data
 * instead of impressions from watching a few random encounters go by.
 *
 * Uses debug.spawnMonster (real spawn primitives) to summon a fresh instance of the target each
 * trial, and either bump-attacks it (default) or casts `opts.spellId` at it every turn if given
 * -- either way this is going through the SAME attack/cast code paths a normal playthrough uses
 * (doAttack/castSpell), just repeated under controlled conditions, not a separate combat model.
 *
 * Does NOT force god-mode itself -- that's the caller's choice and changes what's being
 * measured: leave DEBUG.infiniteHealth off to also learn how much damage the player actually
 * takes per fight (real survivability data), or turn it on first (via debug.setFlags) to
 * isolate pure damage-output/time-to-kill without any death risk interrupting the trial series.
 *
 * @param {object} opts
 *   trials (default 10), maxTurnsPerFight (default 100, a fight that runs this long without a
 *   kill is recorded as 'timeout' rather than looping forever), spellId (optional -- cast this
 *   instead of bump-attacking), depthScale (optional -- passed to debug.spawnMonster), fullRestoreBetween
 *   (default true -- calls debug.fullRestore() before each trial so trials start from a clean,
 *   comparable baseline rather than compounding fatigue/HP loss from the previous fight).
 * @returns { monsterId, trials: [{outcome, turns, dmgDealt, dmgTaken}], summary: {...} }
 */
async function simulateCombat(win, monsterId, opts = {}) {
  const {
    trials = 10, maxTurnsPerFight = 100, spellId = null, depthScale = null,
    fullRestoreBetween = true,
  } = opts;
  const errCapture = attachErrorCapture(win);
  const results = [];

  for (let t = 0; t < trials; t++) {
    if (fullRestoreBetween) debugFullRestore(win);
    // Clear anything else nearby first -- this is real, live gameplay, not a sealed arena, so a
    // wild monster can genuinely wander adjacent mid-trial. Without this, its damage dealt/taken
    // would contaminate this trial's numbers even with the uid-filtering below (that filtering
    // protects the DAMAGE-DEALT side precisely, but a wild monster attacking the player is still
    // real damage taken that has nothing to do with the monster actually being tested).
    debugKillAllNearby(win);
    const spawn = debugSpawnMonster(win, monsterId, depthScale != null ? { depthScale } : {});
    if (!spawn.ok) { results.push({ outcome: 'spawn-failed', reason: spawn.reason }); continue; }

    const before = snapshotCombatants(win);
    let turns = 0, outcome = 'timeout';
    while (turns < maxTurnsPerFight) {
      const stillThere = evalGame(win, `(function(){ const m = curMonsters().find(x=>x.uid===${JSON.stringify(spawn.uid)}); return m && m.alive; })()`).value === true;
      if (!stillThere) { outcome = 'kill'; break; }
      if (spellId) {
        // castSpell() for anything requiring a target enters gameState 'tiletarget' and waits
        // for a confirm keypress -- see tryCastOffensiveSpell's comment above for the full story
        // of how easy this is to get silently wrong (a first version of THIS function made
        // exactly that mistake: calling castSpell() alone and never confirming meant every
        // spell trial recorded zero damage dealt, looking like the spell did nothing rather
        // than like the cast was never actually completed).
        evalGame(win, `castSpell(${JSON.stringify(spellId)})`);
        if (evalGame(win, 'gameState').value === 'tiletarget') key(win, 'Enter');
      } else {
        const dir = directionToAdjacentMonster(win); if (!dir) { outcome = 'monster-unreachable'; break; } key(win, dir);
      }
      turns++;
      if (evalGame(win, 'player.hp').value <= 0) { outcome = 'player-down'; break; }
      if (errCapture.errors.length) { outcome = 'crashed'; break; }
    }
    const after = snapshotCombatants(win);
    // Filter strictly to the ONE spawned instance (by uid) and to damage taken BY the player --
    // see diffCombatSnapshots' comment on why uid-filtering matters: this is real gameplay, not
    // a sealed arena, so another wild monster can genuinely wander within snapshot radius mid-
    // trial, and without filtering its damage would silently inflate this trial's numbers.
    const events = diffCombatSnapshots(before, after, spellId ? `spell:${spellId}` : 'melee')
      .filter(e => e.target === 'player' || e.uid === spawn.uid);
    const dmgDealt = events.filter(e => e.type === 'damageDealt').reduce((s, e) => s + e.amount, 0);
    const dmgTaken = events.filter(e => e.type === 'damageTaken').reduce((s, e) => s + e.amount, 0);
    results.push({ outcome, turns, dmgDealt, dmgTaken });
    if (errCapture.errors.length) results[results.length - 1].error = errCapture.errors.shift();
  }

  const ok = results.filter(r => r.outcome !== 'spawn-failed');
  const kills = ok.filter(r => r.outcome === 'kill');
  const summary = {
    trials: results.length,
    kills: kills.length,
    killRate: ok.length ? +(kills.length / ok.length).toFixed(2) : null,
    avgTurnsToKill: kills.length ? +(kills.reduce((s, r) => s + r.turns, 0) / kills.length).toFixed(1) : null,
    avgDamageDealtPerFight: ok.length ? +(ok.reduce((s, r) => s + r.dmgDealt, 0) / ok.length).toFixed(1) : null,
    avgDamageTakenPerFight: ok.length ? +(ok.reduce((s, r) => s + r.dmgTaken, 0) / ok.length).toFixed(1) : null,
    playerDowned: ok.filter(r => r.outcome === 'player-down').length,
    crashed: ok.filter(r => r.outcome === 'crashed').length,
  };
  return { monsterId, spellId, trials: results, summary };
}

/**
 * Convenience wrapper around simulateCombat: run it for every attack option worth comparing
 * (the player's current melee weapon plus a list of spell ids) against the SAME monster, so the
 * results are directly comparable -- "which of my options is actually best against this thing".
 * `attackOptions` is an array where each entry is either `null` (meaning "bump-attack with
 * whatever's currently equipped") or a spell id string.
 */
async function compareAttackOptions(win, monsterId, attackOptions, opts = {}) {
  const table = {};
  for (const opt of attackOptions) {
    const label = opt == null ? `melee:${evalGame(win, "(player.equipment.hand && player.equipment.hand.name) || 'unarmed'").value}` : `spell:${opt}`;
    const r = await simulateCombat(win, monsterId, { ...opts, spellId: opt });
    table[label] = r.summary;
  }
  return table;
}

// ---- batch comparison: "is X actually meaningfully different from Y", with real numbers ------
/**
 * Runs several full autonomous playthroughs per named configuration (default: one config per
 * BOT_PROFILE preset) and returns a comparison table -- survival rate, average actions/turns
 * survived, average level/gold reached, and a death-cause breakdown -- so a question like "is
 * the veteran profile actually meaningfully safer than novice, and by how much" gets answered
 * with real aggregate data instead of a guess from watching a handful of runs. Each config gets
 * its own fresh boot() per life (a completely clean game instance, no state leaking between
 * lives OR between configs), so results are directly comparable.
 *
 * @param {Array<{label, profile?, livesEach?, opts?}>} configs -- opts is passed through to
 *   playOneLife (e.g. { collectTelemetry:false } for a faster run when you only care about the
 *   aggregate outcome stats, not per-life combat detail).
 * @param {object} runOpts -- shared defaults: livesEach (default 10), maxActions (default 3000),
 *   maxStuckActions (default 500), onProgress(configLabel, lifeIndex).
 * @returns { [configLabel]: { livesRun, survivalRate, avgActionsSurvived, avgFinalLevel,
 *   avgFinalGold, deathCauses: {cause: count}, outcomes: {died,stuck,'budget-reached',...} } }
 */
async function runComparison(configs, runOpts = {}) {
  const { livesEach = 10, maxActions = 3000, maxStuckActions = 500, onProgress = () => {} } = runOpts;
  const table = {};
  for (const cfg of configs) {
    if (cfg.profile) applyProfile(cfg.profile);
    const n = cfg.livesEach || livesEach;
    const lives = [];
    for (let i = 0; i < n; i++) {
      onProgress(cfg.label, i);
      const dom = await boot();
      const life = await playOneLife(dom, cfg.maxActions || maxActions, cfg.maxStuckActions || maxStuckActions, cfg.opts || {});
      lives.push(life);
    }
    const outcomes = {};
    const deathCauses = {};
    for (const l of lives) {
      outcomes[l.reason] = (outcomes[l.reason] || 0) + 1;
      if (l.died) {
        const last = l.events[l.events.length - 1] || '';
        const cause = last.replace(/^\[t=\d+\] DIED: /, '') || 'unknown';
        deathCauses[cause] = (deathCauses[cause] || 0) + 1;
      }
    }
    const survived = lives.filter(l => !l.died).length;
    const finalLevels = lives.map(l => (l.finalState && l.finalState.level) || (l.vitalsTimeline.length ? l.vitalsTimeline[l.vitalsTimeline.length - 1].level : null)).filter(v => v != null);
    const finalGold = lives.map(l => (l.finalState && l.finalState.gold) || (l.vitalsTimeline.length ? l.vitalsTimeline[l.vitalsTimeline.length - 1].gold : null)).filter(v => v != null);
    table[cfg.label] = {
      livesRun: lives.length,
      survivalRate: +(survived / lives.length).toFixed(2),
      avgActionsSurvived: +(lives.reduce((s, l) => s + l.actionsUsed, 0) / lives.length).toFixed(1),
      avgFinalLevel: finalLevels.length ? +(finalLevels.reduce((s, v) => s + v, 0) / finalLevels.length).toFixed(1) : null,
      avgFinalGold: finalGold.length ? +(finalGold.reduce((s, v) => s + v, 0) / finalGold.length).toFixed(0) : null,
      outcomes, deathCauses,
    };
  }
  return table;
}

async function main() {
  const NUM_LIVES = parseInt(process.argv[2] || '10', 10);
  const MAX_ACTIONS = parseInt(process.argv[3] || '8000', 10);
  const MAX_STUCK = parseInt(process.argv[4] || '600', 10);
  const PROFILE_NAME = process.argv[5] || 'casual';
  applyProfile(PROFILE_NAME);

  const report = { meta: { numLives: NUM_LIVES, maxActions: MAX_ACTIONS, maxStuck: MAX_STUCK, profile: PROFILE_NAME, startedAt: new Date().toISOString() }, lives: [] };

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

// ==========================================================================================
// SECTION 8: INTERACTIVE AGENT SESSION -- live, turn-by-turn control for a DECIDING agent
// (another Claude session, or a human), as opposed to the canned SECTION 4/5 autonomous bot.
// ==========================================================================================
//
// WHY THIS EXISTS: SECTIONS 4/5 are a fixed set of ~29 heuristic strategy functions with a
// baked-in priority order (flee before heal, heal before fight, etc.) -- great for unattended
// batch crash-hunting (that's what CLI mode and runContentSweep are for), but the DECISIONS
// are the toolkit's, not the controlling agent's. If you (a Claude session) want to actually
// choose a specific build, try a specific tactic, or deliberately test a new mechanic by
// reacting to it turn-by-turn -- rather than delegating that judgment to tryFightAdjacent's
// fixed logic -- SECTIONS 4/5 aren't the right tool. This section is: it exposes the same
// low-level primitives SECTION 4 is built on (evalGame/key/keyAndWait, the debug API) through
// a small, generic, content-agnostic verb set, and hands every decision to whoever is calling
// act() one step at a time. Nothing here decides anything; it only reports state and executes
// exactly the one action requested, the same way a human pressing one key at a time would.
//
// TWO WAYS TO DRIVE IT:
//   (a) Same-process library use: `const {startInteractiveSession} = require('./playtest.js');
//       const sess = await startInteractiveSession(); const st = sess.state();
//       await sess.act({type:'move', dir:'n'});` -- fine when the controlling code is itself
//       a Node script in this process.
//   (b) Cross-process HTTP: `node playtest.js --serve [port]` boots ONE game session and keeps
//       it alive, exposing it as a tiny local REST API (loopback only, no external deps --
//       uses Node's built-in http module). This is the one that matters for a Claude chat
//       session driving the game across many separate tool calls (each shell/tool call is a
//       fresh process, so it can't hold a live jsdom window itself) -- run the server once
//       (backgrounded/detached so it survives between tool calls), then every decision is just
//       `curl localhost:PORT/state` to see what's happening and `curl -X POST -d '{...}'
//       localhost:PORT/act` to act on it, read the result, and decide the next move. Call
//       GET /help first for the full verb list and current example state -- that alone should
//       be enough to drive a session without re-reading this file.
//
// CONTENT-AGNOSTIC BY THE SAME RULE AS EVERYWHERE ELSE: richState() never hardcodes spell/item/
// monster names -- it reflects back whatever's actually live on player.knownSpells,
// player.inventory, MONSTER_BASES, etc., the same way SECTION 4 does. Adding new spells/items/
// monsters/mechanics to the game needs zero changes here; they just show up in the next
// state() call. A wholly new interaction MODE (not covered by the verbs below) is still
// reachable via the {type:'key', key} raw escape hatch, which presses any key exactly like
// SECTION 2's key() -- nothing is ever locked out, just not given a dedicated named verb yet.

/** Rich, JSON-safe snapshot of everything a controlling agent needs to decide its next move:
 * vitals, position, full equipment+inventory (with per-item uid so actions can target a
 * specific stack unambiguously), every known spell/technique WITH live castability (affordable
 * + in range right now, not just known), nearby entities with distance/threat-relevant fields,
 * the tile underfoot, and -- if a menu is currently open (choice/dialogue/trade) -- its exact
 * selectable options so the agent can choose intelligently instead of guessing letters. */
function richState(win) {
  const r = evalGame(win, `
    (function(){
      const dirs = [['n',0,-1],['s',0,1],['w',-1,0],['e',1,0],['nw',-1,-1],['ne',1,-1],['sw',-1,1],['se',1,1]];
      const nearby = [];
      for (let dy=-6; dy<=6; dy++) for (let dx=-6; dx<=6; dx++) {
        if (!dx && !dy) continue;
        const t = entityAt(player.x+dx, player.y+dy);
        if (t && (t.kind === 'monster' || t.kind === 'npc')) {
          nearby.push({
            uid: t.uid, kind: t.kind, name: t.name,
            dx, dy, dist: Math.max(Math.abs(dx),Math.abs(dy)),
            adjacent: Math.abs(dx)<=1 && Math.abs(dy)<=1,
            hp: t.hp, maxHp: (t.maxHp!=null? t.maxHp : t.hp),
            hostile: t.kind==='monster' ? !(t.tamed||t.companion) : false,
          });
        }
      }
      nearby.sort((a,b) => a.dist - b.dist);
      const eq = {};
      Object.keys(player.equipment||{}).forEach(slot => {
        const it = player.equipment[slot];
        eq[slot] = it ? { uid: it.uid, id: it.id, name: it.name, dmg: it.dmg||null, armor: it.armor||null, acc: it.acc||null } : null;
      });
      const inv = player.inventory.map(it => ({
        uid: it.uid, id: it.id, name: it.name, type: it.type, slot: it.slot||null,
        dmg: it.dmg||null, armor: it.armor||null, effect: it.effect||null, value: it.value||null,
      }));
      // BUG FIX: this used to hardcode player.mp for spell affordability (correct only for
      // spells specifically) and gave techniques no real affordability check at all (just a
      // raw cost number, resource-blind), while active cybernetics/mutations weren't surfaced
      // here at all -- even though castSpell() can invoke any of the four pools uniformly (see
      // the "UNIFIED ABILITY POOL" comment above tryCastOffensiveSpell). An agent reading
      // state() had no correct way to know what it could actually afford to cast right now
      // across techniques/cyber/mutations. Fixed by using the same effectiveCost()/
      // getPoolValue() the game itself uses for every pool, uniformly.
      const abilityView = (id) => {
        const a = findAbilityById(id); if (!a) return null;
        const resource = a.resource || 'mp';
        return {
          id, name: a.name, type: a.type, resource, cost: effectiveCost(a),
          range: a.range||null, power: a.power||null,
          affordable: getPoolValue(resource) >= effectiveCost(a),
          hasTarget: (a.type === 'damage' || a.type === 'execute' || a.type === 'smite' || a.type === 'drain' || a.type === 'debuff') ? !!nearestHostile(a.range||1) : true,
        };
      };
      const spells = (player.knownSpells||[]).map(abilityView).filter(Boolean);
      const techniques = (player.knownTechniques||[]).map(abilityView).filter(Boolean);
      const activeCyber = (player.installedCyber||[]).map(abilityView).filter(Boolean);
      const activeMutations = (player.mutations||[]).map(abilityView).filter(Boolean);
      // BUG FIX: entityAt(x,y) returns an ENTITY (player/ally/monster/npc) standing at those
      // coordinates -- NOT the terrain tile. Since the player always occupies (player.x,
      // player.y), a naive entityAt(player.x, player.y) here would silently just be the
      // player object, and player.items is undefined (items live on player.INVENTORY) --
      // meaning tileHasItems/tileGroundItems were wrong (always empty) since this file first
      // shipped, and nothing caught it until testing dropItem() just now and noticing a
      // freshly-dropped item never showed up underfoot. itemsAt(x,y) is the correct, already
      // dungeon/overworld-aware helper for this (same one tryPickUpHere in SECTION 4 already
      // uses, which is why the autonomous bot's pickup behavior was never affected by this --
      // this bug was isolated to this newer richState() code).
      const groundItems = itemsAt(player.x, player.y);
      let menu = null;
      if (gameState === 'choice' && typeof pendingChoiceOptions !== 'undefined') {
        menu = { kind: 'choice', prompt: (typeof pendingChoicePrompt!=='undefined'?pendingChoicePrompt:null), options: pendingChoiceOptions.map((o,i)=>({index:i, label:o.label})) };
      } else if (gameState === 'dialogue' && typeof dialogueOptions !== 'undefined') {
        menu = { kind: 'dialogue', npc: dialogueNPC ? dialogueNPC.name : null, options: (dialogueOptions||[]).map((o,i)=>({index:i, label:o.label||o.text})) };
      } else if (gameState === 'trade' && dialogueNPC && dialogueNPC.shop) {
        menu = { kind: 'trade', npc: dialogueNPC.name, mode: tradeMode,
          shop: dialogueNPC.shop.map((it,i) => ({ index: i, id: it.id, name: it.name, value: it.value })),
          sellable: player.inventory.filter(i=>i.type!=='misc').map(it => ({ uid: it.uid, id: it.id, name: it.name })) };
      } else if (gameState === 'tiletarget') {
        menu = { kind: 'tiletarget', note: 'Press Enter/space to confirm on nearest valid target, or use act({type:"key",key:"Enter"}).' };
      }
      // ---- CHARACTER CREATION: full picker data for every step, not just enough to survive
      // navigating it. The real game UI has NO restriction tying stat/ability choices to a
      // "focus" or archetype -- that's purely a bot-only heuristic in draftCustomCharacter()
      // (SECTION 5) for its own autonomous random rolls. Once you're in the '0' (Custom) path,
      // every stat and every ability across ALL FOUR categories (spells/techniques/mutations/
      // cyber) is freely mixable against one shared point pool -- see createStatsKey/
      // createAbilitiesKey in the game source. This block exists so a controlling agent can
      // build ANY combination that pool allows, deliberately, rather than being limited to
      // picking a premade archetype or letting the bot's random weighting decide.
      let creation = null;
      if (gameState === 'create_species') {
        creation = { step: 'species', options: SPECIES.map((sp,i) => ({
          index: i, id: sp.id, name: sp.name, desc: sp.desc, statMods: sp.statMods,
          traits: sp.traits.map(t => t.name),
        })) };
      } else if (gameState === 'create_archetype') {
        creation = { step: 'archetype', species: getSpecies(pendingSpeciesId).name,
          customAvailable: true, // pickArchetype({custom:true}) for full free-form point-buy
          options: ARCHETYPES.map((a,i) => ({ index: i, id: a.id, name: a.name, desc: a.desc })) };
      } else if (gameState === 'create_stats' && typeof creationDraft !== 'undefined') {
        const d = creationDraft;
        creation = { step: 'stats', pointsRemaining: d.points, maxPerStat: CREATION_MAX_STAT_ADD,
          current: d.statAdds, baseStats: { str: player.str, dex: player.dex, int: player.int, con: player.con, wil: player.wil, cha: player.cha },
          note: 'allocateStat adds ONE point per call (matches the real UI) -- call repeatedly. No un-spend once added.' };
      } else if (gameState === 'create_abilities' && typeof creationDraft !== 'undefined') {
        const d = creationDraft;
        creation = { step: 'abilities', pointsRemaining: d.points, currentCategory: d.abilityCat,
          categories: CREATION_ABILITY_CATS.map(c => c.key), selected: d.abilities,
          note: 'toggleAbility works by id directly, from ANY category, regardless of currentCategory -- no need to switch tabs first.',
          pool: CREATION_ABILITY_CATS.find(c => c.key === d.abilityCat).pool().map(a => ({
            id: a.id, name: a.name, cost: CREATION_ABILITY_CATS.find(c => c.key === d.abilityCat).costFn(a),
            selected: d.abilities.includes(a.id), type: a.type || null,
          })) };
      } else if (gameState === 'create_final' && typeof creationDraft !== 'undefined') {
        const d = creationDraft;
        creation = { step: 'final', pointsRemaining: d.points, goldPerPoint: CREATION_GOLD_PER_POINT,
          bonusGoldSoFar: d.gold, selectedItems: d.items,
          pool: CREATION_STARTING_ITEM_POOL.map(b => ({ id: b.id, name: b.name, cost: 3 })) };
      } else if (gameState === 'start') {
        creation = { step: 'scenario', options: START_SCENARIOS.map((s,i) => ({ index: i, id: s.id, name: s.name, desc: s.desc })) };
      }
      // ---- EVERY OTHER SCREEN: bespoke structured data where it's worth the code, and a
      // generic DOM-text scrape fallback for everything else so nothing is ever a total blind
      // spot (found via grepping every gameState assignment in the game source -- there are
      // ~27 distinct screens; the ones below without bespoke handling still get readable
      // title/body/hint text scraped straight from the real rendered modal, the same text a
      // human player would be looking at).
      let screen = null;
      const modalEl = document.getElementById('modal');
      const generic = () => ({
        title: (document.getElementById('modal-title')||{}).textContent || null,
        bodyText: (document.getElementById('modal-body')||{}).innerText || null,
        hint: (document.getElementById('modal-hint')||{}).textContent || null,
      });
      if (gameState === 'inventory') {
        const list = filteredInventory();
        screen = { kind: 'inventory', filter: player.invFilter, page: player.invPage||0,
          equipped: SLOT_ORDER.filter(s => player.equipment[s]).map(s => ({ slot: s, id: player.equipment[s].id, name: player.equipment[s].name })),
          items: list.slice((player.invPage||0)*PAGE_SIZE, (player.invPage||0)*PAGE_SIZE+PAGE_SIZE).map(it => ({ uid: it.uid, id: it.id, name: it.name, type: it.type })),
          note: 'selectItem {id} opens the item-action menu for it (works from any filter/page -- no need to page manually).' };
      } else if (gameState === 'itemaction') {
        const it = invSelected;
        screen = { kind: 'itemaction', item: it ? { uid: it.uid, id: it.id, name: it.name, type: it.type, equipped: !!invSelectedSlot } : null,
          canThrow: it ? canThrowItem(it) : false, canSocket: it ? canSocket(it) : false,
          canUnsocket: it ? (it.socketedRunes||[]).length > 0 : false,
          canReforge: it ? (canReforge(it) && !!salvageYieldFor(it)) : false,
          canSalvage: it ? !!salvageYieldFor(it) : false };
      } else if (gameState === 'container') {
        const c = containerTarget;
        screen = { kind: 'container', name: c ? c.name : null, mode: containerMode,
          contents: c ? c.contents.map(it => ({ uid: it.uid, id: it.id, name: it.name })) : [],
          capacity: c ? c.capacity : null };
      } else if (gameState === 'giftpick') {
        screen = { kind: 'giftpick', npc: dialogueNPC ? dialogueNPC.name : null,
          options: giftList.map(it => ({ uid: it.uid, id: it.id, name: it.name })) };
      } else if (gameState === 'socketpick' || gameState === 'unsocketpick') {
        const runes = gameState === 'socketpick' ? openSocketableRunesFor(invSelected) : (invSelected.socketedRunes||[]);
        screen = { kind: gameState, item: invSelected ? invSelected.name : null,
          options: runes.map((r,i) => ({ index: i, id: r.id||null, name: r.name })) };
      } else if (gameState === 'quickslotassign') {
        screen = { kind: 'quickslotassign', item: invSelected ? invSelected.name : null, currentSlots: player.quickslots||[] };
      } else if (gameState === 'character') {
        screen = { kind: 'character', statPointsAvailable: player.statPoints||0,
          stats: { str: player.str, dex: player.dex, int: player.int, con: player.con, wil: player.wil, cha: player.cha },
          note: 'spendStatPoint {stat} spends ONE earned stat point (post-creation leveling, separate from character-creation allocateStat).' };
      } else if (gameState === 'craft') {
        screen = { kind: 'craft', page: player.craftPage||0,
          recipes: (player.knownRecipes||[]).map(id => { const r = RECIPES.find(x=>x.id===id); return r ? { id: r.id, name: r.name } : null; }).filter(Boolean) };
      } else if (gameState === 'talents') {
        screen = { kind: 'talents', talentPoints: player.talentPoints||0,
          options: (talentPurchasable||[]).map(t => ({ id: t.id, name: t.name, desc: t.desc||null })) };
      } else if (gameState === 'train') {
        screen = { kind: 'train', gold: player.gold,
          options: (trainEntries||[]).map(e => ({ id: e.id, kind: e.kind, name: (e.kind==='spell' ? (SPELLS.find(s=>s.id===e.id)||{}).name : (RECIPES.find(r=>r.id===e.id)||{}).name) })) };
      } else if (gameState === 'cyber') {
        screen = { kind: 'cyber', slotsUsed: (player.installedCyber||[]).length, slotsTotal: player.cyberSlots||3,
          options: (cyberListCache.entries||[]).map(e => ({ id: e.id, installed: e.kind === 'installed', name: (CYBERNETICS.find(c=>c.id===e.id)||{}).name })) };
      } else if (gameState === 'digpick') {
        screen = { kind: 'digpick', note: 'dig {dir} to dig in that direction (same dir values as move).' };
      } else if (gameState === 'questlog') {
        screen = { kind: 'questlog', quests: (player.quests||[]).filter(q=>!q.done).map(q => ({ id: q.id, stage: q.stage||null, kind: q.kind||null })), ...generic() };
      } else if (modalEl && !modalEl.classList.contains('hidden') && gameState !== 'playing') {
        screen = { kind: gameState, ...generic() }; // generic fallback for anything without bespoke handling above
      }
      return JSON.stringify({
        gameState, turnCount, alive: player.alive,
        hp: player.hp, maxHp: player.maxHp, mp: player.mp, maxMp: player.maxMp,
        stamina: player.stamina, maxStamina: player.maxStamina,
        charge: player.charge||0, maxCharge: player.maxCharge||0,
        level: player.level, xp: player.xp, gold: player.gold,
        x: player.x, y: player.y, isDungeon: curIsDungeon(),
        bleedTurns: player.bleedTurns||0, statusPoison: player.statusPoison||0,
        species: (getSpecies(player.speciesId)||{}).name, scenario: player.scenario,
        equipment: eq, inventory: inv, spells, techniques, activeCyber, activeMutations,
        nearby, tileHasItems: groundItems.length > 0,
        tileGroundItems: groundItems.map(it=>({id:it.id,name:it.name})),
        activeQuests: (player.quests||[]).filter(q=>!q.done).map(q => ({ id: q.id, stage: q.stage||null, kind: q.kind||null })),
        menu, creation, screen,
      });
    })()
  `);
  if (!r.ok) return { error: r.error };
  try { return JSON.parse(r.value); } catch (e) { return { error: 'parse-failed: ' + r.value }; }
}

const DIR_TO_KEY = { n: 'k', s: 'j', w: 'h', e: 'l', nw: 'y', ne: 'u', sw: 'b', se: 'n' };

/** Find one inventory item matching a caller-given ref (uid exact match first, then id exact,
 * then case-insensitive substring on name) -- same "give the agent a name/id, resolve it live
 * against real data" pattern as debugGiveByName, so callers never need to know internal uids
 * up front (state() gives you the uid once you've seen the item, for disambiguating duplicates
 * afterward). Returns the JS snippet finding it (evaluated inside the caller's evalGame IIFE). */
function itemMatchExpr(listExpr, ref) {
  const j = JSON.stringify(String(ref));
  return `(${listExpr}.find(it=>it.uid===${j}) || ${listExpr}.find(it=>it.id===${j}) || ${listExpr}.find(it=>it.name && it.name.toLowerCase().includes(${j}.toLowerCase())))`;
}

/** Apply exactly one caller-specified action and return { ok, message, state }. Every action
 * type maps directly onto one real user-facing key/function -- see the big header comment
 * above for the design rationale. Unknown/malformed actions return ok:false with a message,
 * never throw, so a driving loop can always inspect the result and try something else. */
async function applyAction(win, action) {
  const type = action && action.type;
  const fail = (message) => ({ ok: false, message, state: richState(win) });
  const okResult = async (message, { wait = false, waitKey = null } = {}) => {
    if (wait) await waitForAutoAction(win);
    return { ok: true, message, state: richState(win) };
  };

  if (!type) return fail('Missing action.type. GET /help (or see SECTION 8 header) for the verb list.');

  switch (type) {
    case 'key': {
      if (!action.key) return fail('key action needs a "key" field.');
      const before = evalGame(win, 'turnCount').value;
      key(win, action.key);
      await sleep(15);
      return okResult(`Pressed "${action.key}".`);
    }
    case 'move': case 'attack': {
      const k = DIR_TO_KEY[action.dir];
      if (!k) return fail(`Unknown dir "${action.dir}". Use one of: ${Object.keys(DIR_TO_KEY).join(', ')}.`);
      key(win, k);
      return okResult(`Moved/attacked ${action.dir}.`);
    }
    case 'wait': key(win, '.'); return okResult('Waited a turn.');
    case 'pickup': key(win, 'g'); return okResult('Attempted pickup.');
    case 'rest': await keyAndWait(win, 'r'); return okResult('Rested (or refused if unsafe -- check state.hp/bleedTurns).');
    case 'explore': await keyAndWait(win, 'X'); return okResult('Auto-explored.');
    case 'travelHome': await keyAndWait(win, 'H'); return okResult('Auto-traveled toward home settlement (no-op if none discovered).');
    case 'travelToStairs': await keyAndWait(win, 'G'); return okResult('Auto-traveled toward known stairs.');
    case 'descend': key(win, '>'); return okResult('Attempted to descend stairs.');
    case 'ascend': key(win, '<'); return okResult('Attempted to ascend stairs.');
    case 'talk': {
      key(win, 't');
      await sleep(15);
      return okResult('Pressed talk. If multiple NPCs were adjacent, check state.menu (kind:"choice") and act({type:"choose",...}) to pick one.');
    }
    case 'calledShot': {
      // Same fix as SECTION 4's tryCalledShot -- see its header comment for the full story:
      // pressing 'a' is shadowed by the WASD move-west binding and never reaches the real
      // called-shot handler, so this calls openCalledShotMenu() directly instead.
      evalGame(win, 'openCalledShotMenu();');
      if (evalGame(win, 'gameState').value !== 'choice') return fail('No adjacent target for a called shot right now.');
      const label = resolveChoiceMenu(win, null, { prefer: action.bodyPart ? [new RegExp(action.bodyPart, 'i')] : [] });
      return okResult(`Called shot aimed: ${label}.`);
    }
    case 'castSpell': {
      if (!action.id) return fail('castSpell needs an "id" (see state().spells/techniques for known ids -- active cybernetics/mutations work too, just not listed there yet; use state().win or debug to inspect player.installedCyber/player.mutations directly).');
      const r = evalGame(win, `
        (function(){
          const s = findAbilityById(${JSON.stringify(action.id)});
          if (!s) return { ok:false, reason:'unknown ability id (spell/technique/cyber/mutation)' };
          if (!isAbilityKnown(${JSON.stringify(action.id)})) return { ok:false, reason:'not known' };
          const resource = s.resource || 'mp';
          if (getPoolValue(resource) < effectiveCost(s)) return { ok:false, reason:'not enough ' + resource };
          const before = getPoolValue(resource);
          castSpell(${JSON.stringify(action.id)});
          return { ok:true, name: s.name, resource, before, gsAfter: gameState };
        })()
      `);
      if (!r.ok || !r.value || !r.value.ok) return fail((r.value && r.value.reason) || r.error || 'Cast failed.');
      if (r.value.gsAfter === 'tiletarget') {
        // Real player-like choice, not just "nearest": if a specific target was given, resolve
        // it to real world coordinates and confirm there directly via confirmTileTarget(wx,wy)
        // -- the same function a mouse click calls in the real UI. This is actually MORE
        // freedom than a keyboard-only human has in this game: the real keyboard handler for
        // gameState==='tiletarget' supports only Enter/Space (nearest-snap) or Escape (cancel)
        // -- there is no keyboard cursor-steering at all, only mouse click. Falling back to
        // Enter (nearest) when no specific target is given keeps that convenient default.
        if (action.targetUid) {
          const t = evalGame(win, `(function(){ const dirs=[]; for(let dy=-8;dy<=8;dy++) for(let dx=-8;dx<=8;dx++){ const e=entityAt(player.x+dx,player.y+dy); if(e && e.uid===${JSON.stringify(action.targetUid)}) return {x:player.x+dx,y:player.y+dy}; } return null; })()`);
          if (t.ok && t.value) { evalGame(win, `confirmTileTarget(${t.value.x}, ${t.value.y})`); }
          else {
            evalGame(win, 'cancelTileTargeting()'); // don't leave the session stuck mid-target
            return fail(`targetUid "${action.targetUid}" not found within 8 tiles -- check state().nearby for current uids (it may have moved, died, or fled since your last state() read).`);
          }
        } else if (action.targetTile) {
          evalGame(win, `confirmTileTarget(${Number(action.targetTile.x)}, ${Number(action.targetTile.y)})`);
        } else {
          key(win, action.targetKey || 'Enter'); // convenience default: nearest valid target
        }
      }
      const after = evalGame(win, `getPoolValue(${JSON.stringify(r.value.resource)})`).value;
      if (after >= r.value.before) return fail(`${r.value.name} didn't resolve (no valid target at that location/range, or targeting got cancelled) -- nothing was spent, try again.`);
      return okResult(`Cast ${r.value.name}${action.targetUid ? ' at ' + action.targetUid : ''}.`);
    }
    case 'useItem': {
      if (!action.id) return fail('useItem needs an "id" (uid, item id, or name substring).');
      const r = evalGame(win, `
        (function(){
          const it = ${itemMatchExpr('player.inventory', action.id)};
          if (!it) return { ok:false, reason:'no matching item in inventory' };
          try { useItem(it); return { ok:true, name: it.name }; } catch(e){ return { ok:false, reason: e.message }; }
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || r.error || 'useItem failed.');
      return okResult(`Used ${r.value.name}.`);
    }
    case 'equip': {
      if (!action.id) return fail('equip needs an "id" (uid, item id, or name substring).');
      const r = evalGame(win, `
        (function(){
          const it = ${itemMatchExpr('player.inventory', action.id)};
          if (!it) return { ok:false, reason:'no matching item in inventory' };
          if (it.type !== 'weapon' && it.type !== 'armor') return { ok:false, reason:'not equippable' };
          equipItem(it); return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || r.error || 'equip failed.');
      return okResult(`Equipped ${r.value.name}.`);
    }
    case 'unequip': {
      if (!action.slot) return fail('unequip needs a "slot" (see state().equipment for current slot names).');
      const r = evalGame(win, `
        (function(){
          if (!player.equipment[${JSON.stringify(action.slot)}]) return { ok:false, reason:'slot already empty' };
          const name = player.equipment[${JSON.stringify(action.slot)}].name;
          unequipSlot(${JSON.stringify(action.slot)}); return { ok:true, name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || r.error || 'unequip failed.');
      return okResult(`Unequipped ${r.value.name}.`);
    }
    case 'choose': {
      // Generic resolver for whatever menu is currently open (choice/dialogue/trade "talk to
      // whom"-style option lists) -- accepts either the numeric index from state().menu.options
      // or a label substring, so the agent can act on what state() just showed it either way.
      const gs = evalGame(win, 'gameState').value;
      if (gs !== 'choice' && gs !== 'dialogue') return fail(`No choice/dialogue menu open (gameState is "${gs}").`);
      if (action.index != null) {
        key(win, String.fromCharCode(97 + Number(action.index)));
        return okResult(`Chose option index ${action.index}.`);
      }
      if (action.label) {
        const label = resolveChoiceMenu(win, null, { prefer: [new RegExp(action.label, 'i')] });
        return okResult(`Chose: ${label}.`);
      }
      return fail('choose needs "index" or "label".');
    }
    case 'buy': case 'sell': {
      if (evalGame(win, 'gameState').value !== 'trade') return fail('Not currently in a trade menu.');
      if (!action.id) return fail(`${type} needs an "id".`);
      tradeMode_set: {
        evalGame(win, `tradeMode = ${JSON.stringify(type === 'buy' ? 'buy' : 'sell')}; tradePage = 0;`);
      }
      const listExpr = type === 'buy' ? 'dialogueNPC.shop' : "player.inventory.filter(i=>i.type!=='misc')";
      const r = evalGame(win, `
        (function(){
          const list = ${listExpr};
          const it = ${itemMatchExpr('list', action.id)};
          if (!it) return { ok:false, reason:'no matching item' };
          const idx = list.indexOf(it);
          tradePage = Math.floor(idx / PAGE_SIZE);
          const goldBefore = player.gold;
          tradeTransact(String.fromCharCode(97 + (idx % PAGE_SIZE)));
          return { ok:true, name: it.name, goldDelta: player.gold - goldBefore };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || r.error || `${type} failed.`);
      return okResult(`${type === 'buy' ? 'Bought' : 'Sold'} ${r.value.name} (gold ${r.value.goldDelta >= 0 ? '+' : ''}${r.value.goldDelta}).`);
    }
    case 'closeMenu': key(win, 'Escape'); return okResult('Closed current menu.');

    // ---- CHARACTER CREATION: free-form build verbs. See richState()'s "creation" block for
    // the exact options/ids/costs available at whatever step you're currently on. The whole
    // point of these is that NOTHING here is limited to a premade archetype or the bot's
    // random-weighted picks -- pickArchetype({custom:true}) plus toggleAbility/allocateStat
    // lets you build literally any stat/ability combination the point pool allows, mixing
    // freely across all four ability categories with no "focus" restriction (that restriction
    // only exists in SECTION 5's autonomous bot, never in the real game).
    case 'pickSpecies': {
      if (evalGame(win, 'gameState').value !== 'create_species') return fail('Not on the species screen.');
      const ref = action.id != null ? action.id : (action.index != null ? action.index : 'random');
      const r = evalGame(win, `
        (function(){
          if (${JSON.stringify(ref)} === 'random') { speciesChoice('9'); return {ok:true, name:'Random'}; }
          let idx = (typeof ${JSON.stringify(ref)} === 'number') ? ${JSON.stringify(ref)}
            : SPECIES.findIndex(s => s.id === ${JSON.stringify(ref)} || s.name.toLowerCase() === String(${JSON.stringify(ref)}).toLowerCase());
          if (idx < 0 || !SPECIES[idx]) return {ok:false, reason:'species not found'};
          speciesChoice(String.fromCharCode(97+idx));
          return {ok:true, name: SPECIES[idx].name};
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'pickSpecies failed.');
      return okResult(`Picked species: ${r.value.name}.`);
    }
    case 'pickArchetype': {
      if (evalGame(win, 'gameState').value !== 'create_archetype') return fail('Not on the archetype screen.');
      const isCustom = action.custom === true || action.id === 'custom';
      const isRandom = action.id === 'random';
      const ref = action.id != null ? action.id : (action.index != null ? action.index : null);
      const r = evalGame(win, `
        (function(){
          if (${isCustom}) { archetypeChoice('0'); return {ok:true, name:'Custom (free-form point-buy)'}; }
          if (${isRandom}) { archetypeChoice('9'); return {ok:true, name:'Random'}; }
          let idx = (typeof ${JSON.stringify(ref)} === 'number') ? ${JSON.stringify(ref)}
            : ARCHETYPES.findIndex(a => a.id === ${JSON.stringify(ref)} || a.name.toLowerCase() === String(${JSON.stringify(ref)}).toLowerCase());
          if (idx < 0 || !ARCHETYPES[idx]) return {ok:false, reason:'archetype not found -- use {custom:true} for free-form instead'};
          archetypeChoice(String.fromCharCode(97+idx));
          return {ok:true, name: ARCHETYPES[idx].name};
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'pickArchetype failed.');
      return okResult(`Picked path: ${r.value.name}.`);
    }
    case 'allocateStat': {
      if (evalGame(win, 'gameState').value !== 'create_stats') return fail('Not on the stats screen.');
      if (!action.stat) return fail('allocateStat needs a "stat" (str|dex|int|con|wil|cha).');
      const idx = ['str','dex','int','con','wil','cha'].indexOf(action.stat);
      if (idx < 0) return fail('Unknown stat -- use str, dex, int, con, wil, or cha.');
      const before = evalGame(win, `creationDraft.statAdds[${JSON.stringify(action.stat)}]`).value;
      key(win, String(idx + 1));
      const after = evalGame(win, `creationDraft.statAdds[${JSON.stringify(action.stat)}]`).value;
      if (after === before) return fail(`Could not add to ${action.stat} -- out of points, or already at the +${before} creation cap (see state().creation.maxPerStat).`);
      return okResult(`${action.stat.toUpperCase()} now +${after}.`);
    }
    case 'setAbilityCategory': {
      if (evalGame(win, 'gameState').value !== 'create_abilities') return fail('Not on the abilities screen.');
      const idx = ['spells','techniques','mutations','cyber'].indexOf(action.category);
      if (idx < 0) return fail('Unknown category -- use spells, techniques, mutations, or cyber.');
      key(win, String(idx + 1));
      return okResult(`Switched to ${action.category}.`);
    }
    case 'pageAbilities': case 'pageItems': {
      const wantAbilities = type === 'pageAbilities';
      const gs = evalGame(win, 'gameState').value;
      if (wantAbilities && gs !== 'create_abilities') return fail('Not on the abilities screen.');
      if (!wantAbilities && gs !== 'create_final') return fail('Not on the items screen.');
      key(win, action.dir === 'prev' ? '[' : ']');
      return okResult(`Paged ${action.dir === 'prev' ? 'back' : 'forward'}.`);
    }
    case 'toggleAbility': {
      if (evalGame(win, 'gameState').value !== 'create_abilities') return fail('Not on the abilities screen.');
      if (!action.id) return fail('toggleAbility needs an "id" (see state().creation.pool, or any spell/technique/mutation/cyber id).');
      const r = evalGame(win, `
        (function(){
          const d = creationDraft;
          let foundCat = null, ability = null;
          for (const cat of CREATION_ABILITY_CATS) {
            const found = cat.pool().find(a => a.id === ${JSON.stringify(action.id)});
            if (found) { foundCat = cat; ability = found; break; }
          }
          if (!ability) return { ok:false, reason:'unknown ability id -- check state().creation.pool across categories' };
          d.abilityCat = foundCat.key;
          const cost = foundCat.costFn(ability);
          if (d.abilities.includes(ability.id)) { d.abilities = d.abilities.filter(x=>x!==ability.id); d.points += cost; return {ok:true, action:'removed', name:ability.name}; }
          if (foundCat.key === 'cyber') {
            const chosen = d.abilities.filter(id => CYBERNETICS.some(c=>c.id===id)).length;
            if (chosen >= CREATION_MAX_STARTING_CYBER) return { ok:false, reason:'starting cyber slots full (see CREATION_MAX_STARTING_CYBER)' };
          }
          if (d.points < cost) return { ok:false, reason:'not enough points' };
          d.points -= cost; d.abilities.push(ability.id);
          return { ok:true, action:'added', name:ability.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'toggleAbility failed.');
      return okResult(`${r.value.action === 'added' ? 'Learned' : 'Removed'} ${r.value.name}.`);
    }
    case 'toggleItem': {
      if (evalGame(win, 'gameState').value !== 'create_final') return fail('Not on the starting-items screen.');
      if (!action.id) return fail('toggleItem needs an "id" (see state().creation.pool).');
      const r = evalGame(win, `
        (function(){
          const d = creationDraft;
          const b = CREATION_STARTING_ITEM_POOL.find(x => x.id === ${JSON.stringify(action.id)});
          if (!b) return { ok:false, reason:'unknown item id' };
          if (d.points < 3) return { ok:false, reason:'not enough points (items cost 3)' };
          d.points -= 3; d.items.push(b.id);
          return { ok:true, name: b.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'toggleItem failed.');
      return okResult(`Added starting item: ${r.value.name}.`);
    }
    case 'convertPointToGold': {
      if (evalGame(win, 'gameState').value !== 'create_final') return fail('Not on the starting-gold/items screen.');
      const before = evalGame(win, 'creationDraft.points').value;
      key(win, 'g');
      const after = evalGame(win, 'creationDraft.points').value;
      if (after === before) return fail('No points left to convert.');
      return okResult(`Converted 1 point to gold.`);
    }
    case 'pickScenario': {
      if (evalGame(win, 'gameState').value !== 'start') return fail('Not on the starting-scenario screen.');
      const ref = action.id != null ? action.id : action.index;
      const r = evalGame(win, `
        (function(){
          let idx = (typeof ${JSON.stringify(ref)} === 'number') ? ${JSON.stringify(ref)}
            : START_SCENARIOS.findIndex(s => s.id === ${JSON.stringify(ref)});
          if (idx < 0 || !START_SCENARIOS[idx]) return {ok:false, reason:'scenario not found'};
          beginScenario(String.fromCharCode(97+idx));
          return {ok:true, name: START_SCENARIOS[idx].name};
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'pickScenario failed.');
      return okResult(`Began as: ${r.value.name}.`);
    }
    case 'finishStep': {
      // Advances from create_stats -> create_abilities -> create_final -> playing, exactly
      // like a human pressing Enter at any of those screens (createStatsKey/
      // createAbilitiesKey/createFinalKey all bind Enter to "move on").
      key(win, 'Enter');
      return okResult('Advanced to the next creation step.');
    }
    case 'backStep': {
      key(win, '<');
      return okResult('Went back one creation step.');
    }

    // ---- POST-CREATION SCREENS: inventory, item actions, containers, gifts, sockets,
    // quickslots, leveling-time stat/talent spending, crafting, training, cybernetics, digging,
    // and simple yes/no confirmations. Most of these resolve by id/uid directly against the
    // real underlying function (openItemAction, craftRecipe, buyTalentById, etc.) rather than
    // replaying a letter/page-position, the same pattern used throughout SECTION 8 already --
    // see state().screen for the exact ids/options available at whatever screen you're on.
    case 'selectItem': {
      if (evalGame(win, 'gameState').value !== 'inventory') return fail('Not on the inventory screen (state().screen.kind === "inventory").');
      if (!action.id) return fail('selectItem needs an "id" (uid, item id, or name substring).');
      const r = evalGame(win, `
        (function(){
          const it = ${itemMatchExpr('filteredInventory()', action.id)};
          if (!it) return { ok:false, reason:'no matching item (check state().screen.items, or switch filter/page)' };
          const slot = SLOT_ORDER.find(s => player.equipment[s] === it) || null;
          openItemAction(it, slot);
          return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'selectItem failed.');
      return okResult(`Opened item actions for ${r.value.name}.`);
    }
    case 'dropItem': case 'reforgeItem': case 'salvageItem': {
      const fnMap = { dropItem: 'dropItem', reforgeItem: 'reforgeItem', salvageItem: 'salvageItem' };
      if (evalGame(win, 'gameState').value !== 'itemaction') return fail('Not on an item-action screen -- selectItem first.');
      const r = evalGame(win, `
        (function(){
          const it = invSelected, slot = invSelectedSlot;
          if (!it) return { ok:false, reason:'no item selected' };
          ${type === 'salvageItem' ? "if (!salvageYieldFor(it)) return { ok:false, reason:'not salvageable' };" : ''}
          ${type === 'reforgeItem' ? "if (!(canReforge(it) && salvageYieldFor(it))) return { ok:false, reason:'not reforgeable right now' };" : ''}
          ${fnMap[type]}(it${type === 'salvageItem' ? ', slot' : ''});
          gameState = 'playing'; closeModal();
          return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || `${type} failed.`);
      const pastTense = { dropItem: 'Dropped', reforgeItem: 'Reforged', salvageItem: 'Salvaged' }[type];
      return okResult(`${pastTense} ${r.value.name}.`);
    }
    case 'throwItem': {
      if (evalGame(win, 'gameState').value !== 'itemaction') return fail('Not on an item-action screen -- selectItem first.');
      const r = evalGame(win, `
        (function(){
          const it = invSelected, slot = invSelectedSlot;
          if (!it || !canThrowItem(it)) return { ok:false, reason:'not throwable' };
          closeModal(); beginThrowTargeting(it, slot);
          return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'throwItem failed.');
      // beginThrowTargeting enters gameState 'tiletarget' just like a damage spell -- resolve
      // it the exact same way castSpell's tiletarget branch does.
      if (evalGame(win, 'gameState').value === 'tiletarget') {
        if (action.targetUid) {
          const t = evalGame(win, `(function(){ for(let dy=-8;dy<=8;dy++) for(let dx=-8;dx<=8;dx++){ const e=entityAt(player.x+dx,player.y+dy); if(e && e.uid===${JSON.stringify(action.targetUid)}) return {x:player.x+dx,y:player.y+dy}; } return null; })()`);
          if (t.ok && t.value) evalGame(win, `confirmTileTarget(${t.value.x}, ${t.value.y})`);
          else { evalGame(win, 'cancelTileTargeting()'); return fail(`targetUid "${action.targetUid}" not found nearby.`); }
        } else key(win, action.targetKey || 'Enter');
      }
      return okResult(`Threw ${r.value.name}.`);
    }
    case 'socketRune': case 'unsocketRune': {
      if (evalGame(win, 'gameState').value !== 'socketpick' && evalGame(win, 'gameState').value !== 'unsocketpick') return fail('Not on a socket/unsocket screen -- selectItem then choose the socket/unsocket option first.');
      if (!action.id && action.index == null) return fail(`${type} needs an "id" or "index" (see state().screen.options).`);
      const r = evalGame(win, `
        (function(){
          if (${type === 'socketRune'}) {
            const runes = openSocketableRunesFor(invSelected);
            const rune = ${action.id != null ? `runes.find(r=>r.id===${JSON.stringify(action.id)})` : `runes[${Number(action.index)}]`};
            if (!rune) return { ok:false, reason:'rune not found' };
            socketRune(invSelected, rune); gameState='playing'; closeModal();
            return { ok:true, name: rune.name };
          } else {
            const idx = ${action.index != null ? Number(action.index) : `(invSelected.socketedRunes||[]).findIndex(r=>r.id===${JSON.stringify(action.id)})`};
            const rune = (invSelected.socketedRunes||[])[idx];
            if (!rune) return { ok:false, reason:'rune not found' };
            unsocketRune(invSelected, idx); gameState='playing'; closeModal();
            return { ok:true, name: rune.name };
          }
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || `${type} failed.`);
      return okResult(`${type === 'socketRune' ? 'Socketed' : 'Removed'} ${r.value.name}.`);
    }
    case 'assignQuickslot': {
      if (evalGame(win, 'gameState').value !== 'quickslotassign') return fail('Not on the quickslot-assign screen -- selectItem then choose the quickslot option first.');
      if (action.slot == null) return fail('assignQuickslot needs a "slot" (1-4).');
      const r = evalGame(win, `
        (function(){
          const it = invSelected;
          assignQuickslot(${Number(action.slot) - 1}, it);
          gameState = 'inventory'; renderInventory();
          return { ok:true, name: it ? it.name : null };
        })()
      `);
      return okResult(`Assigned ${r.value && r.value.name} to quickslot ${action.slot}.`);
    }
    case 'giveGift': {
      if (evalGame(win, 'gameState').value !== 'giftpick') return fail('Not on the gift screen (state().screen.kind === "giftpick").');
      if (!action.id) return fail('giveGift needs an "id" (see state().screen.options).');
      const r = evalGame(win, `
        (function(){
          const it = ${itemMatchExpr('giftList', action.id)};
          if (!it) return { ok:false, reason:'no matching item in gift list' };
          giveGift(dialogueNPC, it);
          return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'giveGift failed.');
      return okResult(`Gave ${r.value.name}.`);
    }
    case 'takeFromContainer': case 'storeInContainer': {
      if (evalGame(win, 'gameState').value !== 'container') return fail('Not at a container.');
      if (!action.id) return fail(`${type} needs an "id".`);
      const wantTake = type === 'takeFromContainer';
      const listExpr = wantTake ? 'containerTarget.contents' : "player.inventory.filter(i=>i.type!=='corpse')";
      const r = evalGame(win, `
        (function(){
          containerMode = ${wantTake ? "'take'" : "'store'"};
          const list = ${listExpr};
          const it = ${itemMatchExpr('list', action.id)};
          if (!it) return { ok:false, reason:'no matching item' };
          const idx = list.indexOf(it);
          containerPage = Math.floor(idx / PAGE_SIZE);
          containerTransact(String.fromCharCode(97 + (idx % PAGE_SIZE)));
          return { ok:true, name: it.name };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || `${type} failed.`);
      return okResult(`${wantTake ? 'Took' : 'Stored'} ${r.value.name}.`);
    }
    case 'takeAllFromContainer': {
      if (evalGame(win, 'gameState').value !== 'container') return fail('Not at a container.');
      evalGame(win, "containerMode='take'; containerTakeAll();");
      return okResult('Took everything from the container.');
    }
    case 'craftRecipe': {
      if (evalGame(win, 'gameState').value !== 'craft') return fail('Not on the crafting screen.');
      if (!action.id) return fail('craftRecipe needs a recipe "id" (see state().screen.recipes).');
      if (!evalGame(win, `(player.knownRecipes||[]).includes(${JSON.stringify(action.id)})`).value) return fail('Recipe not known.');
      evalGame(win, `craftRecipe(${JSON.stringify(action.id)}); renderCraft();`);
      return okResult(`Crafted (or attempted) ${action.id}.`);
    }
    case 'buyTalent': {
      if (evalGame(win, 'gameState').value !== 'talents') return fail('Not on the talents screen.');
      if (!action.id) return fail('buyTalent needs a talent "id" (see state().screen.options).');
      // BUG FIX: player.talents is a plain object keyed by id ({toughness:true, ...}), not an
      // array -- an earlier version of this check used (player.talents||[]).length, which is
      // always undefined on a plain object, so it silently reported failure on every SUCCESSFUL
      // purchase too (confirmed via direct testing: talentPoints correctly dropped and
      // player.talents.toughness was correctly set to true, but this check still said ok:false).
      // Checking the specific key directly is correct regardless of how many talents exist.
      if (evalGame(win, `!!(player.talents && player.talents[${JSON.stringify(action.id)}])`).value) return fail('Already have that talent.');
      evalGame(win, `buyTalentById(${JSON.stringify(action.id)})`);
      const got = evalGame(win, `!!(player.talents && player.talents[${JSON.stringify(action.id)}])`).value;
      if (!got) return fail('Talent not purchased -- check id, or not enough talent points.');
      return okResult(`Bought talent: ${action.id}.`);
    }
    case 'trainSkill': {
      if (evalGame(win, 'gameState').value !== 'train') return fail('Not on the training screen.');
      if (!action.id) return fail('trainSkill needs an "id" (see state().screen.options).');
      const r = evalGame(win, `
        (function(){
          const idx = (trainEntries||[]).findIndex(e => e.id === ${JSON.stringify(action.id)});
          if (idx < 0) return { ok:false, reason:'unknown training option id' };
          const goldBefore = player.gold;
          trainLearn(String.fromCharCode(97 + idx));
          return { ok: player.gold < goldBefore, goldSpent: goldBefore - player.gold };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail("Couldn't afford it, or already known.");
      return okResult(`Learned it (${r.value.goldSpent}g).`);
    }
    case 'toggleCyber': {
      if (evalGame(win, 'gameState').value !== 'cyber') return fail('Not on the cybernetics screen.');
      if (!action.id) return fail('toggleCyber needs a cybernetic "id" (see state().screen.options).');
      const r = evalGame(win, `
        (function(){
          const idx = (cyberListCache.entries||[]).findIndex(e => e.id === ${JSON.stringify(action.id)});
          if (idx < 0) return { ok:false, reason:'unknown cybernetic id' };
          const wasInstalled = player.installedCyber.includes(${JSON.stringify(action.id)});
          toggleCyber(String.fromCharCode(97 + idx));
          renderCybernetics();
          return { ok:true, action: wasInstalled ? 'removed' : 'installed' };
        })()
      `);
      if (!r.ok || !r.value.ok) return fail((r.value && r.value.reason) || 'toggleCyber failed.');
      return okResult(`Cybernetic ${r.value.action}: ${action.id}.`);
    }
    case 'performRitual': {
      if (evalGame(win, 'gameState').value !== 'eldritch') return fail('Not on the eldritch/ritual screen.');
      const hpBefore = evalGame(win, 'player.hp').value;
      evalGame(win, 'performRitual();');
      const hpAfter = evalGame(win, 'player.hp').value;
      if (hpAfter >= hpBefore) return fail('Too weak to perform the ritual (costs 15 HP -- heal up first).');
      return okResult(`Performed the ritual (${hpBefore - hpAfter} HP spent; check state for corruption/mutation changes -- outcomes are randomized, matching the real game).`);
    }
    case 'spendStatPoint': {
      if (evalGame(win, 'gameState').value !== 'character') return fail('Not on the character sheet (post-creation stat spending needs an earned statPoint from leveling -- see state().screen.statPointsAvailable).');
      const idx = ['str','dex','int','con','wil','cha'].indexOf(action.stat);
      if (idx < 0) return fail('Unknown stat -- use str, dex, int, con, wil, or cha.');
      const before = evalGame(win, `player.${action.stat}`).value;
      evalGame(win, `spendStat(${idx});`);
      const after = evalGame(win, `player.${action.stat}`).value;
      if (after === before) return fail('No stat points available to spend.');
      return okResult(`${action.stat.toUpperCase()} now ${after}.`);
    }
    case 'dig': {
      if (evalGame(win, 'gameState').value !== 'digpick') return fail('Not in dig-targeting mode (press key "D" from playing first -- requires being in a dungeon with a pickaxe-type tool equipped).');
      const d = { n: [0,-1], s: [0,1], w: [-1,0], e: [1,0], nw: [-1,-1], ne: [1,-1], sw: [-1,1], se: [1,1] }[action.dir];
      if (!d) return fail(`Unknown dir "${action.dir}".`);
      // BUG FIX: beginDig() silently no-ops (logs a reason, returns to 'playing') for several
      // real conditions -- nothing solid there, too close to the level edge, it's a door/statue,
      // or a monster is nearby -- and this used to report ok:true regardless, the same class of
      // false-positive already fixed for buyTalent/performRitual above. Digging that actually
      // starts is a multi-turn setInterval process (digState gets set, see the game source), so
      // checking gameState immediately after the call and waiting for it to finish is the
      // correct way to know whether it actually happened.
      evalGame(win, `beginDig(${d[0]}, ${d[1]});`);
      const started = evalGame(win, 'gameState === "playing" && !!digState').value;
      if (!started) return fail("Nothing to dig there (needs a solid, non-edge, non-door/statue wall, and no monster within 6 tiles -- check state()'s recent log via state().screen on a modal, or just try a different direction).");
      await waitForAutoAction(win);
      return okResult(`Finished digging ${action.dir}.`);
    }
    case 'confirm': {
      const gs = evalGame(win, 'gameState').value;
      const yes = action.yes !== false;
      if (gs === 'confirmchasm') { evalGame(win, `confirmChasmJumpChoice(${JSON.stringify(yes ? 'y' : 'n')});`); return okResult(yes ? 'Jumped.' : 'Backed away.'); }
      if (gs === 'confirmdelete') { evalGame(win, `confirmDeleteSaveChoice(${JSON.stringify(yes ? 'y' : 'n')});`); return okResult(yes ? 'Confirmed delete.' : 'Cancelled.'); }
      if (gs === 'salvageall') { if (yes) { evalGame(win, 'confirmSalvageAllJunk();'); return okResult('Salvaged all junk.'); } key(win, 'x'); return okResult('Cancelled.'); }
      return fail(`No yes/no confirmation pending (gameState is "${gs}").`);
    }
    default:
      return fail(`Unknown action type "${type}". Combat/world verbs: move/attack, wait, pickup, rest, explore, travelHome, travelToStairs, descend, ascend, talk, calledShot, castSpell, useItem, equip, unequip, choose, buy, sell, closeMenu, key. Creation verbs: pickSpecies, pickArchetype, allocateStat, setAbilityCategory, toggleAbility, pageAbilities, toggleItem, pageItems, convertPointToGold, pickScenario, finishStep, backStep. Menu/inventory verbs: selectItem, dropItem, throwItem, reforgeItem, salvageItem, socketRune, unsocketRune, assignQuickslot, giveGift, takeFromContainer, storeInContainer, takeAllFromContainer, craftRecipe, buyTalent, trainSkill, toggleCyber, performRitual, spendStatPoint, dig, confirm.`);
  }
}

/** Boot a fresh session for interactive/turn-by-turn control. Returns { state, act, debug,
 * errors, close }. `state()` and `act()` are the two functions a driving loop needs; `debug`
 * is the same SECTION 6 object (for directed scenario setup -- spawn a specific monster, grant
 * a specific build, teleport somewhere -- before or during a session), and `errors` is the
 * attachErrorCapture() handle so a driving loop can check for real engine crashes at any point,
 * exactly like the autonomous bot does. */
async function startInteractiveSession(opts = {}) {
  const dom = await boot(opts.gameHtmlPath);
  const win = dom.window;
  const errHandle = attachErrorCapture(win);
  return {
    state: () => richState(win),
    act: (action) => applyAction(win, action),
    debug,
    errors: errHandle.errors,
    win, // escape hatch for anything not covered above -- evalGame(win, '...') always works
    close: () => { try { win.close(); } catch (e) {} },
  };
}

const INTERACTIVE_HELP = {
  overview: 'One HTTP-controlled game session. GET /state for the current situation (including '
    + 'full character-creation picker data if you\'re still on a creation screen), POST /act '
    + 'with a JSON action body to make exactly one move, GET /debug/list for available debug '
    + 'setup calls, POST /debug to use one. GET /snapshot saves the EXACT current moment to a '
    + 'file (works even mid-fight or at 1 HP); POST /restore with {"file":"..."} returns to it '
    + 'later, in this session or a completely different one -- use this to branch multiple '
    + 'experiments from an identical starting point instead of re-setting-up each one by hand. '
    + 'Nothing here decides anything for you -- you choose '
    + 'every action, including every stat/ability/item during character creation: pickArchetype '
    + '{custom:true} plus allocateStat/toggleAbility gives you completely free-form building, '
    + 'mixing any stats with any spells/techniques/mutations/cyber -- there is no archetype or '
    + '"focus" restriction in the real game, only in the separate autonomous bot (SECTION 5).',
  actions: [
    { type: 'move', fields: 'dir: n|s|e|w|ne|nw|se|sw', note: 'also attacks if that tile has a monster' },
    { type: 'attack', fields: 'dir: same as move', note: 'alias of move' },
    { type: 'wait', fields: '(none)' },
    { type: 'pickup', fields: '(none)', note: 'picks up items on the current tile' },
    { type: 'rest', fields: '(none)', note: 'refuses if bleeding, same as the real game' },
    { type: 'explore', fields: '(none)', note: 'auto-explore toward unseen terrain' },
    { type: 'travelHome', fields: '(none)' },
    { type: 'travelToStairs', fields: '(none)' },
    { type: 'descend', fields: '(none)' }, { type: 'ascend', fields: '(none)' },
    { type: 'talk', fields: '(none)', note: 'if multiple NPCs adjacent, follow with a choose action' },
    { type: 'calledShot', fields: 'bodyPart?: regex string, e.g. "head"' },
    { type: 'castSpell', fields: 'id: spell/technique/cyber/mutation id from state().spells|techniques, targetUid?: attack THIS specific entity instead of nearest, targetTile?: {x,y} for a specific ground tile' },
    { type: 'useItem', fields: 'id: uid | item id | name substring' },
    { type: 'equip', fields: 'id: uid | item id | name substring' },
    { type: 'unequip', fields: 'slot: from state().equipment keys' },
    { type: 'choose', fields: 'index? (from state().menu.options) OR label? (regex substring)' },
    { type: 'buy', fields: 'id: shop item id/name (while state().menu.kind === "trade")' },
    { type: 'sell', fields: 'id: your item uid/id/name' },
    { type: 'closeMenu', fields: '(none)' },
    { type: 'key', fields: 'key: any raw key string', note: 'escape hatch for anything not covered above' },
  ],
  creationActions: [
    { type: 'pickSpecies', fields: 'id | index | "random"', note: 'on the create_species screen' },
    { type: 'pickArchetype', fields: '{custom:true} for free-form point-buy | id | index | "random"', note: 'custom:true is the one that unlocks true build freedom -- no archetype/focus restriction' },
    { type: 'allocateStat', fields: 'stat: str|dex|int|con|wil|cha', note: 'adds ONE point per call, up to state().creation.maxPerStat; no un-spend' },
    { type: 'setAbilityCategory', fields: 'category: spells|techniques|mutations|cyber', note: 'just switches the browsing tab -- toggleAbility works cross-category without this' },
    { type: 'toggleAbility', fields: 'id: any spell/technique/mutation/cyber id', note: 'works from ANY category regardless of current tab -- this is the real "any build" lever' },
    { type: 'pageAbilities', fields: 'dir: next|prev' }, { type: 'pageItems', fields: 'dir: next|prev' },
    { type: 'toggleItem', fields: 'id: starting item id (from state().creation.pool)', note: 'adds only -- no removal, matches the real UI' },
    { type: 'convertPointToGold', fields: '(none)' },
    { type: 'pickScenario', fields: 'id | index', note: 'on the "start" screen -- wanderer/capital/city/town/village/hamlet/shipwreck/forest/etc.' },
    { type: 'finishStep', fields: '(none)', note: 'advance stats -> abilities -> items -> playing' },
    { type: 'backStep', fields: '(none)' },
  ],
  menuActions: [
    { type: 'selectItem', fields: 'id: uid|item id|name', note: 'from the inventory screen -- opens item-action menu for it' },
    { type: 'dropItem', fields: '(none)' }, { type: 'reforgeItem', fields: '(none)' }, { type: 'salvageItem', fields: '(none)' },
    { type: 'throwItem', fields: 'targetUid? | targetTile?', note: 'same targeting as castSpell' },
    { type: 'socketRune', fields: 'id | index (see state().screen.options)' },
    { type: 'unsocketRune', fields: 'id | index', note: 'real game design: INT-scaled chance the rune shatters instead of returning to inventory -- not a bug if it does' },
    { type: 'assignQuickslot', fields: 'slot: 1-4' },
    { type: 'giveGift', fields: 'id: uid|item id|name (while on the giftpick screen)' },
    { type: 'takeFromContainer', fields: 'id' }, { type: 'storeInContainer', fields: 'id' }, { type: 'takeAllFromContainer', fields: '(none)' },
    { type: 'craftRecipe', fields: 'id: recipe id from state().screen.recipes' },
    { type: 'buyTalent', fields: 'id: talent id from state().screen.options' },
    { type: 'trainSkill', fields: 'id: spell/recipe id from state().screen.options' },
    { type: 'toggleCyber', fields: 'id: cybernetic id from state().screen.options', note: 'post-creation install/remove, separate from creation-time toggleAbility' },
    { type: 'performRitual', fields: '(none)', note: 'randomized outcome, same as the real game' },
    { type: 'spendStatPoint', fields: 'stat: str|dex|int|con|wil|cha', note: 'post-creation leveling points, separate from creation-time allocateStat' },
    { type: 'dig', fields: 'dir: same as move' },
    { type: 'confirm', fields: 'yes?: true (default) | false', note: 'answers whatever confirmchasm/confirmdelete/salvageall prompt is pending -- for salvageall, open the inventory screen (key "i") and press "J" from there first, "J" does nothing from playing directly' },
  ],
  debug: 'POST /debug with {"method":"<name>","args":[...]}. GET /debug/list for every method '
    + '(spawnMonster, giveByName, giveById, teleportToDungeonType, addGold, levelUp, setFlags, '
    + 'searchRegistry, etc. -- see SECTION 6 in the source for full docs on each).',
};

/** `node playtest.js --serve [port]` -- boots one session and exposes it over a tiny local
 * HTTP API (no external deps, Node's built-in http module only) so a controlling agent can
 * drive it across many separate process invocations (e.g. a Claude session issuing curl calls
 * from a shell tool, one decision at a time, reading real state back before each next move). */
async function serve(port = 4691) {
  const http = require('http');
  const sess = await startInteractiveSession();
  console.error(`Interactive session booted. Listening on http://localhost:${port}`);
  console.error(`Try: curl http://localhost:${port}/help`);
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    try {
      if (req.method === 'GET' && req.url === '/help') return send(200, { ...INTERACTIVE_HELP, currentState: sess.state() });
      if (req.method === 'GET' && req.url === '/state') return send(200, sess.state());
      if (req.method === 'GET' && req.url === '/errors') return send(200, { errors: sess.errors });
      if (req.method === 'GET' && req.url === '/debug/list') return send(200, { methods: Object.keys(debug) });
      if (req.method === 'GET' && req.url === '/snapshot') {
        // Writes to a file (not just the HTTP response) since save data can be large once a
        // world is well-explored, and a file is trivially reusable across separate `curl`
        // calls / later sessions without re-copying a huge JSON blob through a shell variable.
        const p = path.join(__dirname, `snapshot-${Date.now()}.json`);
        snapshotToFile(sess.win, p);
        return send(200, { ok: true, file: p, note: 'POST {"file":"' + p + '"} to /restore later to return to this exact moment.' });
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          if (req.method === 'POST' && req.url === '/act') {
            return send(200, await sess.act(parsed));
          }
          if (req.method === 'POST' && req.url === '/debug') {
            const fn = debug[parsed.method];
            if (!fn) return send(400, { ok: false, message: `Unknown debug method "${parsed.method}". GET /debug/list for options.` });
            const result = fn(sess.win, ...(parsed.args || []));
            return send(200, { ok: true, result, state: sess.state() });
          }
          if (req.method === 'POST' && req.url === '/restore') {
            const ok = parsed.file ? restoreFromFile(sess.win, parsed.file) : restoreState(sess.win, parsed.snapshot);
            return send(ok ? 200 : 400, { ok, state: sess.state() });
          }
          send(404, { ok: false, message: `No such route: ${req.method} ${req.url}` });
        } catch (e) {
          send(500, { ok: false, message: String(e && e.stack || e) });
        }
      });
    } catch (e) {
      send(500, { ok: false, message: String(e && e.stack || e) });
    }
  });
  server.listen(port);
  return server;
}

// ==========================================================================================
// SECTION 9: STATE SNAPSHOT / RESTORE -- the original open item from this project's very first
// session, finally closed. Lets multiple experiments (e.g. "test this fight with a sword vs. a
// staff", or "try three different builds against the exact same boss") branch from an
// identical starting point instead of each starting a fresh random character and hoping RNG
// lines the scenarios up close enough to compare.
// ==========================================================================================
//
// Reuses the game's OWN real save-game serialization (getSaveData/saveDataReplacer/
// applyLoadedSave -- the exact same functions the in-game Settings > Save/Load menu calls)
// rather than reimplementing world/player serialization from scratch -- the same "ask the
// game, don't re-derive it" rule the rest of this file follows (see gearScore, effectiveCost/
// getPoolValue in the unified ability pool, etc.). A snapshot is a portable JSON string
// containing the FULL real save format: player, every world/dimension chunk that's ever been
// mutated, every dungeon entered (with every depth of it), weather, in-progress world events,
// kingdom relations -- everything a real save file has, because it IS a real save file.
//
// Deliberately bypasses saveGame()'s own guards (it refuses to save a dead/gameover character)
// -- snapshotState() calls getSaveData() directly instead, since a controlling agent may
// deliberately want to snapshot mid-crisis on purpose (e.g. one HP from death, about to try a
// risky spell) specifically BECAUSE a real player couldn't save there, not despite it.

/** Captures the exact current game state as an opaque, portable string. Call this any time --
 * mid-fight, mid-dialogue, at 1 HP, whenever -- there's no "safe to save" requirement here the
 * way there is for the real player-facing Save menu. Pass the returned string to
 * restoreState() later (same process or a completely different one -- it's plain JSON) to
 * return to this EXACT moment. */
function snapshotState(win) {
  const r = evalGame(win, 'JSON.stringify(getSaveData(), saveDataReplacer)');
  if (!r.ok) throw new Error('snapshotState failed: ' + r.error);
  return r.value;
}

/** Restores a snapshot captured by snapshotState() into `win`. Call this on a FRESHLY BOOTED
 * session (no need to createRandomCharacter first -- applyLoadedSave fully replaces the world
 * and player) to branch a new experiment from that exact point. Returns true/false rather than
 * throwing, since a caller re-loading an old/foreign snapshot may reasonably want to check
 * compatibility (see applyLoadedSave's own version-mismatch handling in the game source)
 * before deciding what to do next. */
function restoreState(win, snapshot) {
  const r = evalGame(win, `
    (function(){
      const data = JSON.parse(${JSON.stringify(snapshot)});
      const before = (typeof gameState !== 'undefined') ? gameState : null;
      applyLoadedSave(data);
      return { ok: gameState === 'playing', gsBefore: before, gsAfter: gameState };
    })()
  `);
  return r.ok && r.value && r.value.ok;
}

/** Convenience: snapshotState() + write straight to a file, for persisting an experiment's
 * starting point across separate CLI/script invocations (not just within one live process). */
function snapshotToFile(win, filePath) {
  fs.writeFileSync(filePath, snapshotState(win));
  return filePath;
}

/** Convenience: read a file written by snapshotToFile() and restoreState() it into `win`. */
function restoreFromFile(win, filePath) {
  return restoreState(win, fs.readFileSync(filePath, 'utf8'));
}

// ==========================================================================================
// EXPORTS -- everything needed to drive/inspect a session from another script (see the file
// header's "AS A LIBRARY" section for a usage example). Requiring this file has no side
// effects: main() (the full autonomous CLI batch) only runs below when this file is executed
// directly (`node playtest.js ...`), never when require()'d from elsewhere.
// ==========================================================================================
module.exports = {
  // -- low-level game control (SECTION 1/2) --
  boot, evalGame, key, keyAndWait, waitForAutoAction, attachErrorCapture,
  getState, getInventorySummary, nearbyMonster, directionToAdjacentMonster,
  readPendingChoiceLabels, resolveChoiceMenu, bestRetreatStep,
  // -- character creation (SECTION 4) --
  createRandomCharacter, draftCustomCharacter,
  // -- every individual strategy function, callable one at a time (SECTION 4) --
  strat,
  // -- full autonomous life driver + CLI entrypoint, callable programmatically too (SECTION 5) --
  playOneLife, main,
  GENERIC_CLOSE_STATES,
  // -- behavior tuning ("intelligence"/play-style level, SECTION 0) --
  BOT_PROFILE, PROFILES, applyProfile,
  // -- debug-menu control API (SECTION 6) --
  debug,
  // -- telemetry + deterministic full-content coverage sweep (SECTION 7) --
  snapshotCombatants, diffCombatSnapshots, summarizeCombatLog, runContentSweep,
  simulateCombat, compareAttackOptions, runComparison,
  // -- interactive, turn-by-turn agent-driven session (SECTION 8) --
  richState, applyAction, startInteractiveSession, serve, INTERACTIVE_HELP,
  // -- state snapshot/restore (SECTION 9) --
  snapshotState, restoreState, snapshotToFile, restoreFromFile,
};

if (require.main === module) {
  if (process.argv[2] === '--serve') {
    const port = parseInt(process.argv[3], 10) || 4691;
    serve(port).catch((e) => { console.error('FATAL:', e); process.exit(1); });
  } else {
    main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
  }
}
