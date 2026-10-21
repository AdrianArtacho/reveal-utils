"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ExcerptPlayer, RevealMedia, excerptProgress, formatTime, ensureYouTubeAPI,
  interactiveTarget, keepWidgetKeys } = require("../js/youtube-media.js");

function clock() {
  let id = 0;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    intervals, timeouts,
    setInterval(fn) { const key = ++id; intervals.set(key, fn); return key; },
    clearInterval(key) { intervals.delete(key); },
    setTimeout(fn) { const key = ++id; timeouts.set(key, fn); return key; },
    clearTimeout(key) { timeouts.delete(key); },
    tick() { [...intervals.values()].forEach(fn => fn()); },
    expire() { const pending = [...timeouts.values()]; timeouts.clear(); pending.forEach(fn => fn()); }
  };
}

function setup(options = {}) {
  const timing = clock();
  let active = true;
  const changes = [];
  const state = new ExcerptPlayer({ videoId: "M7lc1UVf-VE", start: 20, end: 84,
    clock: timing, active: () => active, changed: value => changes.push(value), ...options });
  const calls = [];
  const player = {
    time: 20, duration: 180,
    cueVideoById(value) { calls.push(["cue", value]); this.time = value.startSeconds; },
    playVideo() { calls.push(["play"]); },
    pauseVideo() { calls.push(["pause"]); },
    unMute() { calls.push(["unmute"]); },
    getCurrentTime() { return this.time; },
    getDuration() { return this.duration; },
    seekTo(value) { calls.push(["seek", value]); this.time = value; },
    destroy() { calls.push(["destroy"]); }
  };
  return { state, player, calls, timing, changes, setActive(value) { active = value; } };
}

function playing(fixture) {
  fixture.state.onReady(fixture.player);
  fixture.state.requestPlay();
  fixture.state.onStateChange({ data: 1 });
}

test("timeline maps the excerpt rather than the source duration, including fractional time", () => {
  const result = excerptProgress(20, 84, 180, 52, false);
  assert.deepEqual(result, { end: 84, length: 64, elapsed: 32, fraction: 0.5 });
  assert.equal(excerptProgress(20, 84, 180, 10, false).fraction, 0);
  assert.equal(excerptProgress(20, 84, 180, 100, false).fraction, 1);
  assert.equal(excerptProgress(20, 84, 180, 20, true).fraction, 1);
  assert.equal(excerptProgress(1.5, 3.5, 10, 2.5, false).fraction, 0.5);
  assert.equal(formatTime(3605), "1:00:05");
});

test("unbounded excerpts learn their length from YouTube; oversized end bounds are clipped", () => {
  assert.equal(excerptProgress(20, null, 0, 20, false).length, null);
  assert.equal(excerptProgress(20, null, 180, 100, false).length, 160);
  assert.equal(excerptProgress(20, 999, 180, 100, false).length, 160);
  const f = setup({ end: null });
  f.state.onReady(f.player);
  assert.deepEqual(f.calls[0], ["cue", { videoId: "M7lc1UVf-VE", startSeconds: 20 }]);
  assert.equal(f.state.snapshot().length, 160);
});

test("first play can arrive before IFrame readiness and cues the correct interval", () => {
  const f = setup();
  f.state.requestPlay();
  assert.equal(f.state.status, "loading");
  assert.equal(f.calls.length, 0);
  f.state.onReady(f.player);
  assert.deepEqual(f.calls, [["cue", { videoId: "M7lc1UVf-VE", startSeconds: 20, endSeconds: 84 }],
    ["unmute"], ["play"]]);
  f.state.onStateChange({ data: 1 });
  assert.equal(f.state.status, "playing");
  assert.equal(f.timing.timeouts.size, 0);
  assert.equal(f.timing.intervals.size, 1);
});

test("own endpoint enforcement stops after seeking, even if YouTube discards endSeconds", () => {
  const f = setup();
  playing(f);
  f.state.seek(32);
  assert.deepEqual(f.calls.at(-1), ["seek", 52]);
  assert.equal(f.state.snapshot().fraction, 0.5);
  f.player.time = 83.9;
  f.timing.tick();
  assert.equal(f.state.finished, false);
  f.player.time = 84.1;
  f.timing.tick();
  assert.equal(f.state.finished, true);
  assert.equal(f.state.status, "finished");
  assert.equal(f.state.snapshot().fraction, 1);
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  assert.equal(f.timing.intervals.size, 0);
  assert.equal(f.state.consumesNext(), false);
});

test("native end events finish the excerpt and explicit replay recues from its start", () => {
  const f = setup({ end: null });
  playing(f);
  f.player.time = 180;
  f.state.onStateChange({ data: 0 });
  assert.equal(f.state.snapshot().elapsed, 160);
  assert.equal(f.state.status, "finished");
  f.state.requestPlay();
  assert.equal(f.state.finished, false);
  assert.equal(f.player.time, 20);
  assert.equal(f.calls.filter(call => call[0] === "cue").length, 2);
  assert.deepEqual(f.calls.at(-1), ["play"]);
});

test("leaving cancels queued autoplay; a delayed PLAYING event on an inactive slide is paused", () => {
  const f = setup();
  f.state.requestPlay();
  f.setActive(false);
  f.state.leave();
  f.state.onReady(f.player);
  assert.equal(f.calls.some(call => call[0] === "play"), false);
  f.state.onStateChange({ data: 1 });
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  assert.equal(f.timing.intervals.size, 0);
  f.setActive(true);
  f.state.reset();
  assert.equal(f.state.status, "ready");
  assert.equal(f.state.snapshot().elapsed, 0);
});

test("pause resumes the same position and seeking never escapes either excerpt boundary", () => {
  const f = setup();
  playing(f);
  f.player.time = 40;
  f.state.pause();
  assert.equal(f.state.status, "paused");
  assert.equal(f.state.consumesNext(), true);
  f.state.requestPlay();
  assert.equal(f.player.time, 40);
  f.state.seek(-30);
  assert.equal(f.player.time, 20);
  f.state.seek(1000);
  assert.equal(f.player.time, 84);
  assert.equal(f.state.finished, true);
  f.state.seek(10);
  assert.equal(f.player.time, 30);
  assert.equal(f.state.finished, false);
  assert.equal(f.state.status, "paused");
});

test("autoplay denial and playback errors never trap next-slide navigation", () => {
  const f = setup();
  f.state.onReady(f.player);
  f.state.requestPlay();
  f.timing.expire();
  assert.equal(f.state.status, "blocked");
  assert.equal(f.state.consumesNext(), false);
  assert.match(f.state.error, /Press Play/);
  f.state.requestPlay();
  f.state.onStateChange({ data: 1 });
  assert.equal(f.state.error, "");
  f.state.onError({ data: 153 });
  assert.match(f.state.error, /localhost or HTTPS/);
  assert.equal(f.state.consumesNext(), false);
  assert.equal(f.timing.intervals.size, 0);
});

test("invalid ranges and ranges beyond source duration fail without navigation loops", () => {
  const badRange = setup({ start: 84, end: 20 });
  assert.match(badRange.state.error, /invalid/);
  assert.equal(badRange.state.consumesNext(), false);
  const pastEnd = setup({ start: 200, end: 220 });
  pastEnd.state.onReady(pastEnd.player);
  assert.match(pastEnd.state.error, /starts after/);
  assert.deepEqual(pastEnd.calls.at(-1), ["pause"]);
});

test("destroy removes every timer and tears down the owned player", () => {
  const f = setup();
  playing(f);
  f.state.destroy();
  assert.equal(f.timing.intervals.size, 0);
  assert.equal(f.timing.timeouts.size, 0);
  assert.deepEqual(f.calls.at(-1), ["destroy"]);
  const count = f.changes.length;
  f.state.onStateChange({ data: 1 });
  assert.equal(f.changes.length, count);
});

test("a queued PAUSED event cannot make pending playback consume another Next", () => {
  const f = setup();
  f.state.onReady(f.player);
  f.state.reset();
  f.state.requestPlay();
  f.state.onStateChange({ data: 2 });
  assert.equal(f.state.pendingPlay, true);
  assert.equal(f.state.status, "buffering");
  assert.equal(f.state.consumesNext(), false);
});

test("an asynchronous cue cannot end replay using a stale previous endpoint", () => {
  const f = setup();
  playing(f);
  f.player.time = 84;
  f.state.finish();
  f.player.cueVideoById = value => f.calls.push(["cue", value]);
  f.state.requestPlay();
  f.state.onStateChange({ data: 1 });
  assert.equal(f.state.finished, false);
  assert.equal(f.state.snapshot().elapsed, 0);
  f.player.time = 20.2;
  f.timing.tick();
  assert.ok(f.state.snapshot().elapsed < 1);
  f.player.time = 84.1;
  f.timing.tick();
  assert.equal(f.state.finished, true);
});

test("scrubbing a CUED or paused player stays paused, including a delayed PLAYING event", () => {
  const f = setup();
  f.state.onReady(f.player);
  f.state.seek(12);
  assert.deepEqual(f.calls.slice(-3), [["pause"], ["seek", 32], ["pause"]]);
  f.state.onStateChange({ data: 1 });
  assert.equal(f.state.status, "paused");
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  assert.equal(f.timing.intervals.size, 0);
  f.state.requestPlay();
  f.state.onStateChange({ data: 1 });
  assert.equal(f.state.status, "playing");
  assert.equal(f.player.time, 32);
  f.state.destroy();
  assert.equal(f.timing.timeouts.size, 0);
});

function deckFixture() {
  const listeners = new Map();
  const events = new Map();
  const elements = new Set();
  const root = { querySelectorAll: () => [], contains: element => elements.has(element) };
  const slideA = { contains: element => element.slide === slideA };
  const slideB = { contains: element => element.slide === slideB };
  const environment = { ...clock(), document: {
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); }
  } };
  const deck = {
    current: slideA, advances: 0,
    getRevealElement: () => root,
    getCurrentSlide() { return this.current; },
    on(name, fn) { events.set(name, fn); },
    off(name, fn) { if (events.get(name) === fn) events.delete(name); },
    next() { this.advances++; },
    isOverview() { return false; }
  };
  const manager = new RevealMedia(deck, environment);
  function add(fixture, hidden = false) {
    const element = { slide: slideA, hidden,
      closest() { return this.hidden ? {} : null; } };
    const entry = { element, state: fixture.state, playerPending: true, active: true };
    fixture.state.active = () => manager.isActive(element);
    elements.add(element);
    manager.entries.set(element, entry);
    return element;
  }
  return { manager, deck, listeners, events, add, slideA, slideB, elements };
}

test("public Next starts audio, next while playing advances, and revisit resets", () => {
  const f = setup();
  f.state.onReady(f.player);
  const d = deckFixture();
  d.add(f);
  d.deck.next();
  assert.equal(d.deck.advances, 0);
  assert.deepEqual(f.calls.at(-1), ["play"]);
  f.state.onStateChange({ data: 1 });
  d.deck.next();
  assert.equal(d.deck.advances, 1);
  d.deck.current = d.slideB;
  d.events.get("slidechanged")();
  assert.deepEqual(f.calls.at(-1), ["pause"]);
  d.deck.current = d.slideA;
  d.events.get("slidechanged")();
  assert.equal(f.player.time, 20);
  assert.equal(f.state.status, "ready");
  d.manager.destroy();
  d.deck.next();
  assert.equal(d.deck.advances, 2);
  assert.equal(d.listeners.size, 0);
  assert.equal(d.events.size, 0);
});

test("keyboard starts only visible media, leaving forms and MIDI widgets alone", () => {
  const f = setup();
  f.state.onReady(f.player);
  const d = deckFixture();
  const element = d.add(f, true);
  let prevented = 0;
  const event = { key: "ArrowRight", target: { closest: () => null },
    preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 0);
  element.hidden = false;
  event.target.closest = () => ({});
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 0);
  event.target.closest = () => null;
  event.shiftKey = true;
  event.key = " ";
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 0);
  event.shiftKey = false;
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 1);
  assert.deepEqual(f.calls.at(-1), ["play"]);
  assert.equal(interactiveTarget(null), false);
  d.manager.destroy();
});

test("touch navigation starts media once and suppresses its duplicate end/click events", () => {
  const f = setup();
  f.state.onReady(f.player);
  const d = deckFixture();
  d.add(f);
  const control = {};
  d.elements.add(control);
  let prevented = 0;
  const event = { type: "touchstart", target: { closest: () => control },
    preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  d.listeners.get("touchstart")(event);
  assert.equal(prevented, 1);
  assert.equal(f.calls.filter(call => call[0] === "play").length, 1);
  f.state.onStateChange({ data: 1 });
  event.type = "touchend";
  d.listeners.get("touchend")(event);
  event.type = "click";
  d.listeners.get("click")(event);
  assert.equal(prevented, 3);
  assert.equal(d.deck.advances, 0);
  d.manager.destroy();
});

test("Down starts only the current vertical slide's media and releases navigation during playback", () => {
  const first = setup();
  const second = setup();
  first.state.onReady(first.player);
  second.state.onReady(second.player);
  const d = deckFixture();
  d.add(first);
  const secondElement = d.add(second);
  secondElement.slide = d.slideB;
  let prevented = 0;
  const event = { key: "ArrowDown", target: { closest: () => null },
    preventDefault() { prevented++; }, stopImmediatePropagation() {} };
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 1);
  assert.deepEqual(first.calls.at(-1), ["play"]);
  assert.equal(second.calls.some(call => call[0] === "play"), false);
  first.state.onStateChange({ data: 1 });
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 1, "playing media must let the next Down reach Reveal");
  d.deck.current = d.slideB;
  d.events.get("slidechanged")();
  assert.deepEqual(first.calls.at(-1), ["pause"]);
  d.listeners.get("keydown")(event);
  assert.equal(prevented, 2);
  assert.deepEqual(second.calls.at(-1), ["play"]);
  d.manager.destroy();
});

test("widget keyboard handling preserves native controls without bubbling into Reveal", () => {
  for (const key of [" ", "Enter", "ArrowRight", "ArrowDown", "Home", "End"]) {
    let stopped = 0;
    let prevented = 0;
    keepWidgetKeys({ key, target: { closest: () => ({}) },
      stopPropagation() { stopped++; }, preventDefault() { prevented++; } });
    assert.equal(stopped, 1);
    assert.equal(prevented, 0);
  }
});

test("multiple widgets never start a second excerpt while the first is playing", () => {
  const a = setup();
  const b = setup();
  a.state.onReady(a.player);
  b.state.onReady(b.player);
  const d = deckFixture();
  d.add(a);
  d.add(b);
  d.deck.next();
  a.state.onStateChange({ data: 1 });
  d.deck.next();
  assert.equal(d.deck.advances, 1);
  assert.equal(b.calls.some(call => call[0] === "play"), false);
  a.state.finish();
  d.deck.next();
  assert.deepEqual(b.calls.at(-1), ["play"]);
  assert.equal(d.deck.advances, 1);
  d.manager.destroy();
});

test("explicit Play on another widget pauses the existing excerpt before starting it", () => {
  const a = setup();
  const b = setup();
  a.state.onReady(a.player);
  b.state.onReady(b.player);
  const d = deckFixture();
  d.add(a);
  const other = d.add(b);
  d.deck.next();
  a.state.onStateChange({ data: 1 });
  d.manager.play(d.manager.entries.get(other));
  assert.equal(a.state.status, "paused");
  assert.deepEqual(a.calls.at(-1), ["pause"]);
  assert.deepEqual(b.calls.at(-1), ["play"]);
  d.manager.destroy();
});

function apiEnvironment() {
  const scripts = [];
  const environment = { ...clock() };
  const head = {
    appendChild(script) { scripts.push(script); script.parentNode = this; },
    removeChild(script) { scripts.splice(scripts.indexOf(script), 1); script.parentNode = null; }
  };
  environment.document = {
    head, querySelector: () => scripts[0] || null,
    createElement() { return { listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      removeEventListener(name) { delete this.listeners[name]; } }; }
  };
  return { environment, scripts };
}

test("API loader is shared, preserves existing callback, and handles cached readiness", async () => {
  const { environment, scripts } = apiEnvironment();
  let previousCalls = 0;
  const previous = () => previousCalls++;
  environment.onYouTubeIframeAPIReady = previous;
  const first = ensureYouTubeAPI(environment);
  const second = ensureYouTubeAPI(environment);
  assert.strictEqual(first, second);
  assert.equal(scripts.length, 1);
  environment.YT = { Player() {} };
  environment.onYouTubeIframeAPIReady();
  assert.strictEqual(await first, environment.YT);
  assert.equal(previousCalls, 1);
  assert.strictEqual(environment.onYouTubeIframeAPIReady, previous);
  assert.equal(environment.intervals.size, 0);
  assert.equal(environment.timeouts.size, 0);
  assert.strictEqual(await ensureYouTubeAPI(environment), environment.YT);
});

test("API failure can be retried, and a later callback replacement does not hang readiness", async () => {
  const { environment, scripts } = apiEnvironment();
  const first = ensureYouTubeAPI(environment);
  scripts[0].listeners.error();
  await assert.rejects(first, /could not load/);
  assert.equal(scripts.length, 0);
  const retry = ensureYouTubeAPI(environment);
  environment.onYouTubeIframeAPIReady = () => {};
  environment.YT = { Player() {} };
  environment.tick();
  assert.strictEqual(await retry, environment.YT);
  assert.equal(environment.timeouts.size, 0);
});
