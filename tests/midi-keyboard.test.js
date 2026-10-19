"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MIDIInputManager, keyboardLayout, noteName } = require("../js/midi-keyboard.js");

class Input extends EventTarget {
  constructor(id) {
    super();
    Object.assign(this, { id, name: "Keyboard " + id, type: "input", state: "connected" });
  }
  send(data) {
    const event = new Event("midimessage");
    event.data = data;
    if (typeof this.onmidimessage === "function") this.onmidimessage(event);
    this.dispatchEvent(event);
  }
}

class Access extends EventTarget {
  constructor(...inputs) {
    super();
    this.inputs = new Map(inputs.map(input => [input.id, input]));
  }
  change(input, connected) {
    input.state = connected ? "connected" : "disconnected";
    if (connected) this.inputs.set(input.id, input);
    else this.inputs.delete(input.id);
    const event = new Event("statechange");
    event.port = input;
    this.dispatchEvent(event);
  }
}

async function setup(...inputs) {
  const access = new Access(...inputs);
  const manager = new MIDIInputManager({ requestMIDIAccess: () => Promise.resolve(access) }, true);
  await manager.enable();
  return { access, manager };
}

const held = manager => [...manager.snapshot().held].sort((a, b) => a - b);

test("25 chromatic keys have 15 white / 10 black keys and C3–C5 labels", () => {
  const layout = keyboardLayout(48, 25);
  assert.equal(layout.length, 25);
  assert.equal(layout.filter(key => key.black).length, 10);
  assert.equal(layout[0].left, 0);
  assert.ok(Math.abs(layout.at(-1).left + layout.at(-1).width - 100) < 0.000001);
  assert.deepEqual([48, 60, 72].map(noteName), ["C3", "C4", "C5"]);
  assert.ok(layout.every(key => key.left >= 0 && key.left + key.width <= 100.000001));
  assert.throws(() => keyboardLayout(120, 25), RangeError);
});

test("request is user-triggered, shared while pending, and excludes SysEx", async () => {
  let calls = 0;
  let resolve;
  const access = new Access(new Input("A"));
  const manager = new MIDIInputManager({ requestMIDIAccess: options => {
    calls++;
    assert.deepEqual(options, { sysex: false });
    return new Promise(done => { resolve = done; });
  } }, true);
  assert.equal(calls, 0);
  const first = manager.enable();
  const second = manager.enable();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().phase, "requesting");
  resolve(access);
  await first;
  await manager.enable();
  assert.equal(calls, 1);
  assert.equal(manager.snapshot().phase, "ready");
});

test("chords, black keys, both endpoints, Note Off and zero-velocity Note On", async () => {
  const input = new Input("A");
  const { manager } = await setup(input);
  [48, 49, 52, 55, 72].forEach(note => input.send([0x90, note, 100]));
  assert.deepEqual(held(manager), [48, 49, 52, 55, 72]);
  input.send([0x80, 49, 64]);
  input.send([0x90, 52, 0]);
  assert.deepEqual(held(manager), [48, 55, 72]);
});

test("same pitch held on different channels or devices survives an unrelated release", async () => {
  const a = new Input("A");
  const b = new Input("B");
  const { manager } = await setup(a, b);
  a.send([0x90, 60, 100]);
  a.send([0x9f, 60, 100]);
  b.send([0x90, 60, 100]);
  a.send([0x80, 60, 0]);
  a.send([0x8f, 60, 0]);
  assert.deepEqual(held(manager), [60]);
  b.send([0x80, 60, 0]);
  assert.deepEqual(held(manager), []);
});

test("sustain and Reset All Controllers do not latch or release physical keys", async () => {
  const input = new Input("A");
  const { manager } = await setup(input);
  input.send([0x90, 60, 100]);
  input.send([0xb0, 64, 127]);
  input.send([0xb0, 121, 0]);
  assert.deepEqual(held(manager), [60]);
  input.send([0x80, 60, 0]);
  assert.deepEqual(held(manager), []);
});

test("All Notes Off and All Sound Off clear only their input and channel", async () => {
  const a = new Input("A");
  const b = new Input("B");
  const { manager } = await setup(a, b);
  a.send([0x90, 60, 100]);
  a.send([0x91, 61, 100]);
  b.send([0x90, 62, 100]);
  a.send([0xb0, 123, 0]);
  assert.deepEqual(held(manager), [61, 62]);
  a.send([0xb1, 120, 0]);
  assert.deepEqual(held(manager), [62]);
});

test("hotplug clears disconnected notes and ignores a stale port after reconnect", async () => {
  const a = new Input("A");
  const b = new Input("B");
  const { access, manager } = await setup(a, b);
  a.send([0x90, 60, 100]);
  b.send([0x90, 64, 100]);
  access.change(a, false);
  assert.deepEqual(held(manager), [64]);
  assert.deepEqual(manager.snapshot().names, ["Keyboard B"]);
  const replacement = new Input("A");
  access.change(replacement, true);
  a.send([0x90, 65, 100]);
  replacement.send([0x90, 67, 100]);
  assert.deepEqual(held(manager), [64, 67]);
  access.change(b, false);
  access.change(replacement, false);
  assert.deepEqual(held(manager), []);
  assert.equal(manager.snapshot().phase, "ready");
});

test("existing MIDI handlers are preserved and no inputs are closed", async () => {
  const input = new Input("A");
  let messages = 0;
  let closes = 0;
  const otherHandler = () => messages++;
  input.onmidimessage = otherHandler;
  input.close = () => closes++;
  const { access, manager } = await setup(input);
  assert.strictEqual(input.onmidimessage, otherHandler);
  input.send([0x90, 60, 100]);
  assert.equal(messages, 1);
  assert.deepEqual(held(manager), [60]);
  manager.reset();
  access.change(input, false);
  assert.equal(closes, 0);
});

test("subscribers share current notes, including ones already held at subscription time", async () => {
  const input = new Input("A");
  const { manager } = await setup(input);
  input.send([0x90, 60, 100]);
  const updates = [];
  const unsubscribe = manager.subscribe(state => updates.push([...state.held]));
  assert.deepEqual(updates, [[60]]);
  manager.reset();
  assert.deepEqual(updates, [[60], []]);
  unsubscribe();
  input.send([0x90, 62, 100]);
  assert.equal(updates.length, 2);
});

test("insecure and unsupported browsers do not make permission requests", async () => {
  let calls = 0;
  const insecure = new MIDIInputManager({ requestMIDIAccess: () => { calls++; } }, false);
  const unsupported = new MIDIInputManager({}, true);
  await insecure.enable();
  await unsupported.enable();
  assert.equal(calls, 0);
  assert.equal(insecure.snapshot().phase, "insecure");
  assert.equal(unsupported.snapshot().phase, "unsupported");
});

test("permission denial is recoverable by an explicit retry", async () => {
  let calls = 0;
  const manager = new MIDIInputManager({ requestMIDIAccess: () => {
    calls++;
    if (calls === 1) return Promise.reject({ name: "NotAllowedError" });
    return Promise.resolve(new Access());
  } }, true);
  await manager.enable();
  assert.equal(manager.snapshot().phase, "denied");
  await manager.enable();
  assert.equal(manager.snapshot().phase, "ready");
  assert.equal(calls, 2);
});

test("invalid/incomplete data is ignored; MIDI System Reset releases the source", async () => {
  const input = new Input("A");
  const { manager } = await setup(input);
  [[], [0x90], [0x90, 60], [0x90, 128, 100], [0x90, 60, 255], [0xf8], [0xfe], [0xe0, 0, 64]]
    .forEach(data => input.send(data));
  assert.deepEqual(held(manager), []);
  input.send(new Uint8Array([0x90, 60, 100]));
  input.send([0xff]);
  assert.deepEqual(held(manager), []);
});
