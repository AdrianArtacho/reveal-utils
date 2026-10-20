/* Date-aware semester plans. Local calendar days; no network or Reveal dependency. */
(function (global) {
  "use strict";

  var STATES = ["is-past", "is-current", "is-future"];

  function parseISODate(value) {
    if (typeof value !== "string") return null;
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
    return year * 10000 + month * 100 + day;
  }

  function localISODate(now) {
    // toISOString() would use UTC and can select the wrong teaching day.
    return String(now.getFullYear()).padStart(4, "0") + "-" +
      String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0");
  }

  function classifyDates(dates, reference) {
    var today = parseISODate(reference);
    var values = dates.map(parseISODate);
    var current = null;
    if (today === null) return dates.map(function () { return null; });
    values.forEach(function (value) {
      if (value !== null && value <= today && (current === null || value > current)) current = value;
    });
    return values.map(function (value) {
      if (value === null) return null;
      if (value === current) return "is-current";
      return value < today ? "is-past" : "is-future";
    });
  }

  function millisecondsToMidnight(now) {
    var midnight = new Date(now.getTime());
    // setHours respects local DST transitions, including 23/25-hour days.
    midnight.setHours(24, 0, 0, 50);
    return Math.max(50, midnight.getTime() - now.getTime());
  }

  function createRuntime(host) {
    var document = host.document;
    var Clock = host.Date || Date;
    var plans = new Map();
    var timer = null;
    var observer = null;
    var started = false;
    var destroyed = false;

    function isAuto(root) {
      var value = (root.getAttribute("data-semester-today") || "auto").trim();
      return value === "auto" || value === "";
    }

    function paint(root, now) {
      var reference = isAuto(root) ? localISODate(now) : root.getAttribute("data-semester-today").trim();
      var rows = Array.from(root.querySelectorAll("tbody tr[data-semester-date]")).filter(function (row) {
        return row.closest(".semester-plan") === root;
      });
      var dates = rows.map(function (row) { return row.getAttribute("data-semester-date"); });
      var states = classifyDates(dates, reference);
      var validReference = parseISODate(reference) !== null;
      if (validReference) {
        root.setAttribute("data-semester-reference-date", reference);
        root.removeAttribute("data-semester-error");
      } else {
        root.removeAttribute("data-semester-reference-date");
        root.setAttribute("data-semester-error", "invalid-reference-date");
      }
      rows.forEach(function (row, index) {
        STATES.forEach(function (state) { row.classList.toggle(state, states[index] === state); });
        var current = states[index] === "is-current";
        if (current) row.setAttribute("aria-current", "date");
        else row.removeAttribute("aria-current");
        if (parseISODate(dates[index]) === null) row.setAttribute("data-semester-invalid", "true");
        else row.removeAttribute("data-semester-invalid");
        var marker = row.querySelector(".semester-plan-current-label");
        if (marker && marker.hidden === current) marker.hidden = !current;
      });
      // Cell contents and their authored formatting are never replaced.
    }

    function cancelTimer() {
      if (timer !== null) host.clearTimeout(timer);
      timer = null;
    }

    function schedule(now) {
      cancelTimer();
      if (!destroyed && Array.from(plans.keys()).some(isAuto)) {
        timer = host.setTimeout(refresh, millisecondsToMidnight(now));
      }
    }

    function removeDisconnected() {
      plans.forEach(function (listener, root) {
        if (!root.isConnected) {
          root.removeEventListener("keydown", listener);
          plans.delete(root);
        }
      });
    }

    function register(root, now) {
      if (!plans.has(root)) {
        var listener = function (event) {
          var vertical = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key);
          var horizontal = ["ArrowLeft", "ArrowRight"].includes(event.key);
          if ((vertical && root.scrollHeight > root.clientHeight) ||
              (horizontal && root.scrollWidth > root.clientWidth)) {
            // Keep native table scrolling when this region has keyboard focus.
            event.stopPropagation();
          }
        };
        root.addEventListener("keydown", listener);
        plans.set(root, listener);
      }
      paint(root, now);
    }

    function init(container) {
      if (destroyed) return;
      var now = new Clock();
      container = container || document;
      if (container.nodeType === 1 && container.matches(".semester-plan")) register(container, now);
      if (container.querySelectorAll) container.querySelectorAll(".semester-plan").forEach(function (root) {
        register(root, now);
      });
      schedule(now);
    }

    function refresh() {
      if (destroyed) return;
      var now = new Clock();
      removeDisconnected();
      plans.forEach(function (_, root) { paint(root, now); });
      schedule(now);
    }

    function onVisible() {
      if (!document.hidden) refresh();
    }

    function start() {
      if (started || destroyed) return;
      started = true;
      init();
      document.addEventListener("visibilitychange", onVisible);
      host.addEventListener("focus", refresh);
      host.addEventListener("pageshow", refresh);
      host.addEventListener("pagehide", cancelTimer);
      if (typeof host.MutationObserver !== "function") return;
      observer = new host.MutationObserver(function (records) {
        var affected = new Set();
        records.forEach(function (record) {
          if (record.target.nodeType === 1) {
            var root = record.target.closest(".semester-plan");
            if (root) affected.add(root);
          }
          if (record.addedNodes) record.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) init(node);
          });
        });
        var now = new Clock();
        removeDisconnected();
        affected.forEach(function (root) { if (root.isConnected) register(root, now); });
        schedule(now);
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["data-semester-today", "data-semester-date"]
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelTimer();
      if (observer) observer.disconnect();
      document.removeEventListener("DOMContentLoaded", start);
      document.removeEventListener("visibilitychange", onVisible);
      host.removeEventListener("focus", refresh);
      host.removeEventListener("pageshow", refresh);
      host.removeEventListener("pagehide", cancelTimer);
      plans.forEach(function (listener, root) { root.removeEventListener("keydown", listener); });
      plans.clear();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    return Object.freeze({ init: init, refresh: refresh, destroy: destroy });
  }

  if (typeof module === "object" && module.exports) {
    module.exports = {
      parseISODate: parseISODate, localISODate: localISODate, classifyDates: classifyDates,
      millisecondsToMidnight: millisecondsToMidnight, createRuntime: createRuntime
    };
    return;
  }
  if (!global.document) return;
  if (global.RevealSemesterPlan) global.RevealSemesterPlan.init();
  else global.RevealSemesterPlan = createRuntime(global);
})(typeof window !== "undefined" ? window : globalThis);
