"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseISODate, localISODate, classifyDates, millisecondsToMidnight, createRuntime } =
  require("../js/semester-plan.js");

class Element extends EventTarget {
  constructor(tag, attributes = {}) {
    super();
    this.tagName = tag;
    this.nodeType = 1;
    this.attributes = new Map(Object.entries(attributes));
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.scrollHeight = this.clientHeight = this.scrollWidth = this.clientWidth = 100;
    this.classes = new Set((attributes.class || "").split(" ").filter(Boolean));
    this.classList = {
      contains: name => this.classes.has(name),
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)
    };
  }
  append(...children) {
    children.forEach(child => { child.parentElement = this; this.children.push(child); });
    return this;
  }
  remove() {
    this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  get isConnected() { return this.nodeType === 9 || Boolean(this.parentElement && this.parentElement.isConnected); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    if (selector[0] === ".") return this.classes.has(selector.slice(1));
    if (selector === "tbody tr[data-semester-date]") {
      return this.tagName === "tr" && this.parentElement.tagName === "tbody" &&
        this.getAttribute("data-semester-date") !== null;
    }
    return false;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [ ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function row(date) {
  const result = new Element("tr", { "data-semester-date": date, class: "authored-class" });
  const marker = new Element("span", { class: "semester-plan-current-label" });
  marker.hidden = true;
  const content = new Element("td").append(new Element("strong"), new Element("em"), new Element("a"));
  result.append(new Element("th").append(new Element("time"), marker), content, new Element("td"));
  return result;
}

function plan(dates, today = "auto") {
  const root = new Element("div", { class: "semester-plan", "data-semester-today": today });
  root.body = new Element("tbody").append(...dates.map(row));
  root.append(new Element("table").append(root.body));
  return root;
}

function fixture(...roots) {
  let now = new Date(2026, 9, 20, 12).getTime();
  let key = 0;
  const timers = new Map();
  const document = new Element("document");
  document.nodeType = 9;
  document.readyState = "complete";
  document.hidden = false;
  document.documentElement = new Element("html").append(...roots);
  document.append(document.documentElement);
  const host = new EventTarget();
  const observers = [];
  host.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  };
  host.document = document;
  host.setTimeout = (fn, delay) => { const id = ++key; timers.set(id, { fn, delay }); return id; };
  host.clearTimeout = id => timers.delete(id);
  host.MutationObserver = class {
    constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const runtime = createRuntime(host);
  return {
    host, document, runtime, timers, observers,
    now: () => new Date(now),
    setDate(value) { now = value.getTime(); },
    expire() { const pending = [...timers.values()]; timers.clear(); pending.forEach(item => item.fn()); },
    mutation(...records) { observers[0].fn(records); }
  };
}

const states = root => root.body.children.map(node =>
  ["is-past", "is-current", "is-future"].find(state => node.classes.has(state)) || null);

function inTimeZone(zone, run) {
  const previous = process.env.TZ;
  try { process.env.TZ = zone; run(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("strict Gregorian dates include century leap-year and ISO-width rules", () => {
  ["2026-10-20", "2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"]
    .forEach(value => assert.notEqual(parseISODate(value), null, value));
  ["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00",
    "0000-01-01", "2026-1-1", "20.10.2026", "2026-10-20T00:00:00Z", " 2026-10-20", null]
    .forEach(value => assert.equal(parseISODate(value), null, String(value)));
});

test("the supplied semester plan highlights 19 October between sessions", () => {
  assert.deepEqual(classifyDates(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12",
    "2026-10-19", "2026-11-09"], "2026-10-20"),
  ["is-past", "is-past", "is-past", "is-past", "is-current", "is-future"]);
});

test("today is current; before the semester all are future; after it the final date remains current", () => {
  const dates = ["2026-12-21", "2027-01-11"];
  assert.deepEqual(classifyDates(dates, "2026-12-20"), ["is-future", "is-future"]);
  assert.deepEqual(classifyDates(dates, "2026-12-21"), ["is-current", "is-future"]);
  assert.deepEqual(classifyDates(dates, "2027-01-11"), ["is-past", "is-current"]);
  assert.deepEqual(classifyDates(dates, "2027-09-01"), ["is-past", "is-current"]);
});

test("repeated dates share the current state without sorting rows", () => {
  assert.deepEqual(classifyDates(["2027-01-11", "2026-10-19", "2026-10-05", "2026-10-19"], "2026-10-20"),
    ["is-future", "is-current", "is-past", "is-current"]);
  assert.deepEqual(classifyDates(["bad", "2026-10-19"], "2026-10-20"), [null, "is-current"]);
  assert.deepEqual(classifyDates(["2026-10-19"], "2026-02-29"), [null]);
  assert.deepEqual(classifyDates([], "2026-10-20"), []);
});

test("local day does not accidentally use UTC near midnight", () => {
  assert.equal(localISODate(new Date(2026, 9, 20, 1)), "2026-10-20");
  inTimeZone("Pacific/Honolulu", () => {
    assert.equal(localISODate(new Date("2026-10-20T00:30:00Z")), "2026-10-19");
  });
});

test("midnight scheduling follows 23/25-hour daylight-saving days", () => {
  inTimeZone("Europe/Vienna", () => {
    assert.deepEqual([millisecondsToMidnight(new Date(2026, 2, 29)),
      millisecondsToMidnight(new Date(2026, 9, 25))],
    [23 * 3600000 + 50, 25 * 3600000 + 50]);
  });
});

test("independent fixed and live plans preserve authored formatting and classes", () => {
  const dates = ["2026-10-19", "2026-11-09"];
  const live = plan(dates), fixed = plan(dates, "2026-11-09");
  const cells = live.body.children.map(node => node.children);
  const f = fixture(live, fixed);
  assert.deepEqual(states(live), ["is-current", "is-future"]);
  assert.deepEqual(states(fixed), ["is-past", "is-current"]);
  assert.equal(live.body.children[0].getAttribute("aria-current"), "date");
  assert.equal(live.body.children[1].getAttribute("aria-current"), null);
  assert.equal(live.body.children[0].querySelector(".semester-plan-current-label").hidden, false);
  assert.equal(live.body.children[1].querySelector(".semester-plan-current-label").hidden, true);
  live.body.children.forEach((node, index) => {
    assert.strictEqual(node.children, cells[index]);
    assert.ok(node.classList.contains("authored-class"));
    assert.deepEqual(node.children[1].children.map(child => child.tagName), ["strong", "em", "a"]);
  });
  f.runtime.init();
  f.runtime.init(live);
  assert.equal(f.timers.size, 1);
  assert.equal(f.observers.length, 1);
  assert.deepEqual(states(live), ["is-current", "is-future"]);
  f.runtime.destroy();
});

test("live plans advance at midnight without rebuilding the slides", () => {
  const root = plan(["2026-10-19", "2026-10-21"]);
  const f = fixture(root);
  const timeout = [...f.timers.values()][0];
  assert.equal(timeout.delay, millisecondsToMidnight(f.now()));
  f.setDate(new Date(2026, 9, 21, 0, 0, 1));
  f.expire();
  assert.deepEqual(states(root), ["is-past", "is-current"]);
  assert.equal(root.getAttribute("data-semester-reference-date"), "2026-10-21");
  assert.equal(root.body.children[0].getAttribute("aria-current"), null);
  assert.equal(root.body.children[0].querySelector(".semester-plan-current-label").hidden, true);
  assert.equal(f.timers.size, 1);
  f.runtime.destroy();
});

test("focus, visibility and pageshow recover after sleep or a changed computer date", () => {
  const root = plan(["2026-10-19", "2026-10-21"]);
  const f = fixture(root);
  f.setDate(new Date(2026, 9, 21, 12));
  f.host.dispatchEvent(new Event("focus"));
  assert.deepEqual(states(root), ["is-past", "is-current"]);
  f.setDate(new Date(2026, 9, 18, 12));
  f.document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(states(root), ["is-future", "is-future"]);
  f.host.dispatchEvent(new Event("pagehide"));
  assert.equal(f.timers.size, 0);
  f.setDate(new Date(2026, 9, 20, 12));
  f.host.dispatchEvent(new Event("pageshow"));
  assert.deepEqual(states(root), ["is-current", "is-future"]);
  assert.equal(f.timers.size, 1);
  f.runtime.destroy();
});

test("async slide insertion, changed dates and added rows are discovered", () => {
  const f = fixture();
  assert.equal(f.timers.size, 0);
  const root = plan(["2026-10-19"]);
  f.document.documentElement.append(root);
  f.mutation({ target: f.document.documentElement, addedNodes: [root], removedNodes: [] });
  assert.deepEqual(states(root), ["is-current"]);
  const future = row("2026-11-09");
  root.body.append(future);
  f.mutation({ target: root.body, addedNodes: [future], removedNodes: [] });
  assert.deepEqual(states(root), ["is-current", "is-future"]);
  root.setAttribute("data-semester-today", "2026-11-09");
  f.mutation({ target: root, type: "attributes" });
  assert.deepEqual(states(root), ["is-past", "is-current"]);
  assert.equal(f.timers.size, 0);
  future.setAttribute("data-semester-date", "2026-12-01");
  f.mutation({ target: future, type: "attributes" });
  assert.deepEqual(states(root), ["is-current", "is-future"]);
  f.runtime.destroy();
});

test("malformed manual HTML clears misleading states instead of rolling dates over", () => {
  const root = plan(["2026-02-29", "2026-10-19"]);
  const f = fixture(root);
  assert.deepEqual(states(root), [null, "is-current"]);
  assert.equal(root.body.children[0].getAttribute("data-semester-invalid"), "true");
  root.setAttribute("data-semester-today", "2026-02-29");
  f.runtime.refresh();
  assert.deepEqual(states(root), [null, null]);
  assert.equal(root.getAttribute("data-semester-error"), "invalid-reference-date");
  assert.ok(root.body.children.every(node => node.querySelector(".semester-plan-current-label").hidden));
  root.setAttribute("data-semester-today", "auto");
  f.runtime.refresh();
  assert.equal(root.getAttribute("data-semester-error"), null);
  assert.deepEqual(states(root), [null, "is-current"]);
  f.runtime.destroy();
});

test("focused long plans keep scroll keys; removed plans and destroy release listeners and timers", () => {
  const root = plan(["2026-10-19"]);
  root.scrollHeight = 1000;
  const f = fixture(root);
  let stopped = 0;
  function sendKey() {
    const event = new Event("keydown");
    event.key = "ArrowDown";
    event.stopPropagation = () => { stopped++; };
    root.dispatchEvent(event);
  }
  f.runtime.init(root);
  sendKey();
  assert.equal(stopped, 1);
  root.remove();
  f.mutation({ target: f.document.documentElement, addedNodes: [], removedNodes: [root] });
  assert.equal(f.timers.size, 0);
  sendKey();
  assert.equal(stopped, 1);
  f.runtime.destroy();
  assert.equal(f.observers[0].disconnected, true);
  f.host.dispatchEvent(new Event("focus"));
  assert.equal(f.timers.size, 0);
});
