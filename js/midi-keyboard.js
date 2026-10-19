/* Live MIDI input display. No audio, MIDI output, or Reveal dependency. */
(function (global) {
  "use strict";

  var NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  var KEY_OFFSETS = [0, 0.65, 1, 1.65, 2, 3, 3.65, 4, 4.65, 5, 5.65, 6];
  var BLACK_NOTES = new Set([1, 3, 6, 8, 10]);

  function noteName(note) {
    // Scientific pitch notation: middle C is C4, MIDI note 60.
    return NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
  }

  function keyboardLayout(start, count) {
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 ||
        count < 1 || start + count > 128) {
      throw new RangeError("The keyboard range must lie within MIDI notes 0–127.");
    }
    var keys = Array.from({ length: count }, function (_, index) {
      var note = start + index;
      var black = BLACK_NOTES.has(note % 12);
      return {
        note: note,
        black: black,
        left: Math.floor(note / 12) * 7 + KEY_OFFSETS[note % 12],
        width: black ? 0.7 : 1
      };
    });
    var left = Math.min.apply(null, keys.map(function (key) { return key.left; }));
    var right = Math.max.apply(null, keys.map(function (key) { return key.left + key.width; }));
    keys.forEach(function (key) {
      key.left = (key.left - left) / (right - left) * 100;
      key.width = key.width / (right - left) * 100;
    });
    return keys;
  }

  class MIDIInputManager {
    constructor(navigatorObject, secureContext) {
      this.navigator = navigatorObject || {};
      this.phase = secureContext === false ? "insecure" :
        typeof this.navigator.requestMIDIAccess !== "function" ? "unsupported" : "idle";
      this.access = null;
      this.pending = null;
      this.inputs = new Map();
      this.listeners = new Set();
      this.stateListener = this.syncInputs.bind(this);
    }

    snapshot() {
      var held = new Set();
      var names = [];
      this.inputs.forEach(function (entry) {
        names.push(entry.port.name || "MIDI input");
        entry.held.forEach(function (key) { held.add(key % 128); });
      });
      return { phase: this.phase, held: held, names: names };
    }

    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.snapshot());
      return () => this.listeners.delete(listener);
    }

    emit() {
      var snapshot = this.snapshot();
      this.listeners.forEach(function (listener) { listener(snapshot); });
    }

    enable() {
      if (this.pending) return this.pending;
      if (this.access || this.phase === "unsupported" || this.phase === "insecure") {
        return Promise.resolve(this.access);
      }
      this.phase = "requesting";
      this.emit();
      var request;
      try {
        // Called synchronously by the Enable MIDI button, preserving user activation.
        request = this.navigator.requestMIDIAccess({ sysex: false });
      } catch (error) {
        this.fail(error);
        return Promise.resolve(null);
      }
      this.pending = Promise.resolve(request).then((access) => {
        this.access = access;
        this.access.addEventListener("statechange", this.stateListener);
        this.phase = "ready";
        this.syncInputs();
        return access;
      }, (error) => {
        this.fail(error);
        return null;
      }).finally(() => { this.pending = null; });
      return this.pending;
    }

    fail(error) {
      this.phase = error && (error.name === "NotAllowedError" || error.name === "SecurityError") ?
        "denied" : "error";
      this.emit();
    }

    syncInputs() {
      if (!this.access) return;
      var connected = new Map();
      this.access.inputs.forEach(function (port) {
        if (port.state === "connected") connected.set(port.id, port);
      });
      this.inputs.forEach((entry, id) => {
        if (connected.get(id) !== entry.port) {
          entry.port.removeEventListener("midimessage", entry.listener);
          this.inputs.delete(id);
          // Do not close a port: reveal4live or another tool may also be using it.
        }
      });
      connected.forEach((port, id) => {
        if (this.inputs.has(id)) return;
        var entry = { port: port, held: new Set(), listener: null };
        entry.listener = (event) => this.receive(entry, event.data);
        this.inputs.set(id, entry);
        // The Web MIDI API opens inputs implicitly when a listener is attached.
        // addEventListener preserves any existing onmidimessage handler.
        port.addEventListener("midimessage", entry.listener);
      });
      this.emit();
    }

    receive(entry, data) {
      if (this.inputs.get(entry.port.id) !== entry || !data || !data.length) return;
      var status = data[0];
      if (!Number.isInteger(status) || status < 0x80 || status > 0xff) return;
      if (status === 0xff) {
        if (entry.held.size) {
          entry.held.clear();
          this.emit();
        }
        return;
      }
      var kind = status & 0xf0;
      if (kind !== 0x80 && kind !== 0x90 && kind !== 0xb0) return;
      if (data.length < 3 || !Number.isInteger(data[1]) || !Number.isInteger(data[2]) ||
          data[1] < 0 || data[1] > 127 || data[2] < 0 || data[2] > 127) return;
      var channel = status & 0x0f;
      var key = channel * 128 + data[1];
      var changed = false;
      if (kind === 0x90 && data[2] > 0) {
        changed = !entry.held.has(key);
        entry.held.add(key);
      } else if (kind === 0x80 || kind === 0x90) {
        changed = entry.held.delete(key);
      } else if (data[1] === 120 || data[1] >= 123) {
        // All Sound Off / All Notes Off, including channel-mode changes.
        entry.held.forEach(function (heldKey) {
          if (Math.floor(heldKey / 128) === channel) {
            entry.held.delete(heldKey);
            changed = true;
          }
        });
      }
      // Sustain (CC64) is intentionally ignored: the display follows physical keys.
      if (changed) this.emit();
    }

    reset() {
      var changed = false;
      this.inputs.forEach(function (entry) {
        changed = changed || entry.held.size > 0;
        entry.held.clear();
      });
      if (changed) this.emit();
    }
  }

  // Dependency-free Node tests exercise the actual MIDI state manager.
  if (typeof module === "object" && module.exports) {
    module.exports = { MIDIInputManager: MIDIInputManager, keyboardLayout: keyboardLayout, noteName: noteName };
    return;
  }
  if (!global.document) return;
  if (global.RevealMIDIKeyboard) {
    global.RevealMIDIKeyboard.init();
    return;
  }

  var document = global.document;
  var manager = new MIDIInputManager(global.navigator, global.isSecureContext);
  var widgets = new Map();
  var widgetNumber = 0;

  function element(tag, className, text) {
    var result = document.createElement(tag);
    result.className = className;
    if (text) result.textContent = text;
    return result;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function numberAttribute(node, attribute, fallback, min, max) {
    var raw = node.getAttribute(attribute);
    var value = raw === null || raw.trim() === "" ? NaN : Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }

  function connectionText(state) {
    switch (state.phase) {
      case "insecure": return "Open these slides over HTTPS or on localhost to enable MIDI.";
      case "unsupported": return "This browser does not provide Web MIDI.";
      case "requesting": return "Waiting for MIDI permission…";
      case "denied": return "MIDI permission was denied or blocked. Allow MIDI for this site, then retry.";
      case "error": return "Could not enable MIDI. Reconnect your keyboard and try again.";
      case "ready": return state.names.length === 0 ? "MIDI enabled. Connect a MIDI keyboard." :
        state.names.length === 1 ? "Listening: " + state.names[0] :
          "Listening to " + state.names.length + " MIDI inputs.";
      default: return "Enable MIDI to connect your keyboard.";
    }
  }

  function createWidget(root) {
    if (widgets.has(root)) return;
    var start = numberAttribute(root, "data-midi-start", 48, 0, 127);
    var count = numberAttribute(root, "data-midi-keys", Math.min(25, 128 - start), 1, 128 - start);
    var range = noteName(start) + "–" + noteName(start + count - 1);
    var header = element("div", "midi-keyboard__header");
    var label = element("span", "midi-keyboard__range", range + " · " + count + " keys");
    var actions = element("div", "midi-keyboard__actions");
    var enable = element("button", "midi-keyboard__enable", "Enable MIDI");
    var reset = element("button", "midi-keyboard__reset", "Reset lights");
    var board = element("div", "midi-keyboard__keys");
    var footer = element("div", "midi-keyboard__footer");
    var status = element("span", "midi-keyboard__status");
    var notes = element("span", "midi-keyboard__notes", "Play your MIDI keyboard");
    var keyNodes = new Map();

    status.id = "midi-keyboard-status-" + (++widgetNumber);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    board.setAttribute("aria-hidden", "true");
    root.setAttribute("role", "group");
    if (!root.hasAttribute("aria-label")) root.setAttribute("aria-label", "Live MIDI keyboard, " + range);
    root.setAttribute("aria-describedby", status.id);
    label.title = "MIDI notes " + start + "–" + (start + count - 1) + "; middle C = C4 (60)";
    enable.type = reset.type = "button";
    enable.setAttribute("aria-describedby", status.id);
    reset.title = "Clear every keyboard display if a note-off message is missed. Sends no MIDI.";
    [enable, reset].forEach(function (button) {
      button.addEventListener("keydown", function (event) {
        // Keep Reveal from advancing a slide when a focused button is activated.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      });
    });
    enable.addEventListener("click", function (event) {
      event.stopPropagation();
      manager.enable();
    });
    reset.addEventListener("click", function (event) {
      event.stopPropagation();
      manager.reset();
    });

    keyboardLayout(start, count).forEach(function (key) {
      var node = element("span", "midi-key midi-key--" + (key.black ? "black" : "white"));
      node.setAttribute("data-midi-note", String(key.note));
      node.style.left = key.left + "%";
      node.style.width = key.width + "%";
      if (key.note % 12 === 0) node.appendChild(element("span", "midi-key__label", noteName(key.note)));
      keyNodes.set(key.note, node);
      board.appendChild(node);
    });
    actions.append(enable, reset);
    header.append(label, actions);
    footer.append(status, notes);
    root.replaceChildren(header, board, footer);

    var unsubscribe = manager.subscribe(function (state) {
      root.setAttribute("data-midi-state", state.phase);
      var visible = [];
      keyNodes.forEach(function (node, note) {
        var held = state.held.has(note);
        node.classList.toggle("is-held", held);
        if (held) visible.push(noteName(note));
      });
      enable.disabled = ["ready", "requesting", "unsupported", "insecure"].includes(state.phase);
      setText(enable, state.phase === "ready" ? "MIDI enabled" :
        state.phase === "requesting" ? "Connecting…" :
          ["denied", "error"].includes(state.phase) ? "Retry MIDI" : "Enable MIDI");
      reset.disabled = state.held.size === 0;
      setText(status, connectionText(state));
      status.title = state.names.join(" · ");
      setText(notes, visible.length ? visible.join(" · ") :
        state.held.size ? "Notes outside " + range : "Play your MIDI keyboard");
      notes.setAttribute("aria-label", visible.length ? "Held notes: " + visible.join(", ") : notes.textContent);
    });
    widgets.set(root, unsubscribe);
  }

  function init(root) {
    root = root || document;
    if (root.nodeType === 1 && root.matches(".midi-keyboard")) createWidget(root);
    if (root.querySelectorAll) root.querySelectorAll(".midi-keyboard").forEach(createWidget);
  }

  function start() {
    init();
    if (typeof global.MutationObserver !== "function") return;
    var observer = new global.MutationObserver(function (records) {
      var removed = false;
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) init(node);
        });
        record.removedNodes.forEach(function (node) {
          if (node.nodeType === 1) removed = true;
        });
      });
      if (removed) widgets.forEach(function (unsubscribe, root) {
        if (!root.isConnected) {
          unsubscribe();
          widgets.delete(root);
        }
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  global.RevealMIDIKeyboard = Object.freeze({ init: init, reset: function () { manager.reset(); } });
  global.addEventListener("pagehide", function () { manager.reset(); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(typeof window !== "undefined" ? window : globalThis);
