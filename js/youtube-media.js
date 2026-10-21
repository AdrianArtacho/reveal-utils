/* YouTube excerpts for Reveal: visible video or a compact audio presentation. */
(function (global) {
  "use strict";

  var apiLoads = new WeakMap();
  var decks = new WeakMap();
  var NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", " ", "Spacebar", "PageDown", "n", "N"]);

  function formatTime(value) {
    var seconds = Math.max(0, Math.floor(Number(value) || 0));
    var minutes = Math.floor(seconds / 60);
    return minutes >= 60 ? Math.floor(minutes / 60) + ":" +
      String(minutes % 60).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0") :
      minutes + ":" + String(seconds % 60).padStart(2, "0");
  }

  function excerptProgress(start, end, duration, time, finished) {
    var actualDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
    var effectiveEnd = end === null ? actualDuration :
      actualDuration === null ? end : Math.min(end, actualDuration);
    var length = effectiveEnd === null ? null : Math.max(0, effectiveEnd - start);
    var elapsed = Math.max(0, (Number(time) || 0) - start);
    if (length !== null) elapsed = finished ? length : Math.min(length, elapsed);
    return { end: effectiveEnd, length: length, elapsed: elapsed,
      fraction: length > 0 ? elapsed / length : 0 };
  }

  function ensureYouTubeAPI(environment) {
    if (environment.YT && typeof environment.YT.Player === "function") {
      return Promise.resolve(environment.YT);
    }
    if (apiLoads.has(environment)) return apiLoads.get(environment);
    var promise = new Promise(function (resolve, reject) {
      var document = environment.document;
      var previous = environment.onYouTubeIframeAPIReady;
      var settled = false;
      var owned = false;
      var script = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
      var timeout;
      var poll;
      function complete(error) {
        if (settled) return;
        if (!error && !(environment.YT && typeof environment.YT.Player === "function")) return;
        settled = true;
        environment.clearTimeout(timeout);
        environment.clearInterval(poll);
        if (script) script.removeEventListener("error", failed);
        if (environment.onYouTubeIframeAPIReady === ready) {
          environment.onYouTubeIframeAPIReady = previous;
        }
        if (error) {
          if (owned && script.parentNode) script.parentNode.removeChild(script);
          reject(error);
        } else resolve(environment.YT);
      }
      function failed() { complete(new Error("YouTube could not load. Check your internet connection.")); }
      function ready() {
        try { if (typeof previous === "function") previous(); }
        finally { complete(); }
      }
      environment.onYouTubeIframeAPIReady = ready;
      // Polling also covers another integration replacing the global callback later.
      poll = environment.setInterval(function () { complete(); }, 200);
      timeout = environment.setTimeout(function () {
        complete(new Error("YouTube did not respond. Check your connection or allow the player to load."));
      }, 20000);
      if (!script) {
        script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        owned = true;
        script.addEventListener("error", failed);
        (document.head || document.documentElement).appendChild(script);
      } else script.addEventListener("error", failed);
    });
    apiLoads.set(environment, promise);
    promise.catch(function () { apiLoads.delete(environment); });
    return promise;
  }

  // The same state machine drives the visible YouTube macro and compact audio view.
  class ExcerptPlayer {
    constructor(options) {
      this.videoId = options.videoId;
      this.start = options.start;
      this.end = options.end;
      this.clock = options.clock || global;
      this.active = options.active || function () { return true; };
      this.changed = options.changed || function () {};
      this.player = null;
      this.ready = false;
      this.pendingPlay = false;
      this.finished = false;
      this.status = "idle";
      this.error = "";
      this.time = this.start;
      this.duration = 0;
      this.timer = null;
      this.startTimer = null;
      this.seekPauseTimer = null;
      this.suppressSeekPlay = false;
      this.cuePending = false;
      this.destroyed = false;
      if (!/^[A-Za-z0-9_-]{11}$/.test(this.videoId) ||
          !Number.isFinite(this.start) || this.start < 0 ||
          (this.end !== null && (!Number.isFinite(this.end) || this.end <= this.start))) {
        this.fail("This YouTube excerpt has an invalid ID or time range.");
      }
    }

    snapshot() {
      return Object.assign({ status: this.status, error: this.error, finished: this.finished },
        excerptProgress(this.start, this.end, this.duration, this.time, this.finished));
    }

    emit() { if (!this.destroyed) this.changed(this.snapshot()); }

    cancelTimers() {
      if (this.timer !== null) this.clock.clearInterval(this.timer);
      if (this.startTimer !== null) this.clock.clearTimeout(this.startTimer);
      this.timer = this.startTimer = null;
    }

    cue() {
      this.cuePending = true;
      var request = { videoId: this.videoId, startSeconds: this.start };
      if (this.end !== null) request.endSeconds = this.end;
      this.player.cueVideoById(request);
    }

    onReady(player) {
      if (this.destroyed) return;
      this.player = player;
      this.ready = true;
      try {
        this.cue();
        if (this.pendingPlay && this.active()) this.play();
        else {
          this.pendingPlay = false;
          if (!this.error) this.status = "ready";
          this.update();
        }
      } catch (error) { this.fail("The YouTube player could not initialize."); }
    }

    requestPlay() {
      if (this.destroyed || !this.active()) return false;
      if (this.finished) this.reset();
      this.clearSeekPause();
      this.error = "";
      this.pendingPlay = true;
      this.status = this.ready ? "buffering" : "loading";
      this.emit();
      if (this.ready) this.play();
      return true;
    }

    play() {
      if (!this.ready || this.destroyed || !this.active()) return;
      try {
        this.player.unMute();
        this.player.playVideo();
        if (this.startTimer !== null) this.clock.clearTimeout(this.startTimer);
        this.startTimer = this.clock.setTimeout(() => {
          if (this.pendingPlay) this.blocked();
        }, 10000);
      } catch (error) { this.fail("Playback could not start. Try Play or Show video."); }
    }

    pause() {
      this.pendingPlay = false;
      this.cancelTimers();
      if (this.ready) this.player.pauseVideo();
      if (!this.finished && !this.error) this.status = "paused";
      this.update();
    }

    reset() {
      this.pendingPlay = false;
      this.finished = false;
      this.cancelTimers();
      this.clearSeekPause();
      this.time = this.start;
      if (this.ready) {
        this.player.pauseVideo();
        this.cue();
      }
      if (!this.error) this.status = this.ready ? "ready" : "idle";
      this.emit();
    }

    leave() {
      this.pendingPlay = false;
      this.cancelTimers();
      this.clearSeekPause();
      if (this.ready) this.player.pauseVideo();
      if (["playing", "buffering", "loading"].includes(this.status)) this.status = "paused";
      this.emit();
    }

    fail(message) {
      this.pendingPlay = false;
      this.cancelTimers();
      this.error = message;
      this.status = "error";
      this.emit();
    }

    blocked() {
      this.fail("Playback needs a click. Press Play, or Show video to interact with YouTube.");
      this.status = "blocked";
      this.emit();
    }

    onError(event) {
      var code = event && event.data;
      this.fail(code === 101 || code === 150 ? "This video cannot play in an embedded player. Open it on YouTube." :
        code === 153 ? "YouTube needs a web address for these slides. Open them through localhost or HTTPS." :
          "YouTube could not play this excerpt" + (code ? " (error " + code + ")" : "") + ". Try Show video or the source link.");
    }

    finish() {
      this.finished = true;
      this.pendingPlay = false;
      this.cancelTimers();
      if (this.ready) this.player.pauseVideo();
      this.status = "finished";
      this.emit();
    }

    onStateChange(event) {
      if (this.destroyed) return;
      var state = event.data;
      if (state === 1 && !this.active()) {
        this.leave();
        return;
      }
      if (state === 1 && this.suppressSeekPlay) {
        this.player.pauseVideo();
        this.status = "paused";
        this.emit();
        return;
      }
      if (state === 1) {
        this.pendingPlay = false;
        this.finished = false;
        this.error = "";
        this.status = "playing";
        if (this.startTimer !== null) this.clock.clearTimeout(this.startTimer);
        this.startTimer = null;
        if (this.timer === null) this.timer = this.clock.setInterval(() => this.update(), 100);
        this.update();
      } else if (state === 0) {
        this.update();
        this.finish();
      } else if (state === 2) {
        if (!this.pendingPlay && !this.finished && !this.error) this.status = "paused";
        // A queued pause from reset must not cancel a newly requested play.
        if (!this.pendingPlay) this.cancelTimers();
        this.update();
      } else if (state === 3) {
        if (!this.finished && !this.error) this.status = "buffering";
        this.emit();
      } else if (state === 5) {
        if (!this.pendingPlay && !this.finished && !this.error) this.status = "ready";
        this.update();
      }
    }

    update() {
      if (this.destroyed) return;
      if (this.ready) {
        var duration = Number(this.player.getDuration());
        if (Number.isFinite(duration) && duration > 0) this.duration = duration;
        var time = Number(this.player.getCurrentTime());
        var end = this.end === null ? (this.duration || null) :
          this.duration > 0 ? Math.min(this.end, this.duration) : this.end;
        // cueVideoById is asynchronous. A stale reading at the previous endpoint
        // must not finish a newly reset excerpt before the new cue takes effect.
        if (Number.isFinite(time) && (!this.cuePending ||
            (time >= this.start && (end === null || time < end)))) {
          this.time = time;
          this.cuePending = false;
        }
        if (this.duration > 0 && this.start >= this.duration) {
          this.player.pauseVideo();
          this.fail("The excerpt starts after the end of this video.");
          return;
        }
      }
      var progress = this.snapshot();
      // seekTo cancels YouTube's endSeconds bound, so always enforce our own endpoint.
      if (!this.finished && progress.end !== null && this.time >= progress.end &&
          ["playing", "buffering"].includes(this.status)) {
        this.finish();
        return;
      }
      this.emit();
    }

    seek(elapsed) {
      var progress = this.snapshot();
      if (!this.ready || !(progress.length > 0)) return;
      var relative = Math.max(0, Math.min(progress.length, Number(elapsed) || 0));
      var playing = ["playing", "buffering"].includes(this.status) || this.pendingPlay;
      this.clearSeekPause();
      if (!playing) {
        // YouTube may start playback when seeking a CUED player. Preserve the
        // user's paused state, including a delayed PLAYING event from that seek.
        this.suppressSeekPlay = true;
        this.seekPauseTimer = this.clock.setTimeout(() => this.clearSeekPause(), 1000);
        this.player.pauseVideo();
      }
      this.time = this.start + relative;
      this.finished = false;
      this.cuePending = false;
      this.player.seekTo(this.time, true);
      if (!playing) this.player.pauseVideo();
      if (relative >= progress.length) this.finish();
      else {
        if (this.status === "finished" || this.status === "ready") this.status = "paused";
        this.emit();
      }
    }

    consumesNext() {
      return !this.finished && !this.error && !this.pendingPlay &&
        !["playing", "buffering", "loading"].includes(this.status);
    }

    clearSeekPause() {
      if (this.seekPauseTimer !== null) this.clock.clearTimeout(this.seekPauseTimer);
      this.seekPauseTimer = null;
      this.suppressSeekPlay = false;
    }

    destroy() {
      this.cancelTimers();
      this.clearSeekPause();
      this.pendingPlay = false;
      this.destroyed = true;
      if (this.player && typeof this.player.destroy === "function") this.player.destroy();
    }
  }

  function interactiveTarget(target) {
    return !!(target && typeof target.closest === "function" && target.closest(
      'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), .midi-keyboard'));
  }

  function keepWidgetKeys(event) {
    if (interactiveTarget(event.target) && (NEXT_KEYS.has(event.key) ||
        ["Enter", "ArrowLeft", "ArrowUp", "Home", "End", "PageUp"].includes(event.key))) {
      event.stopPropagation();
    }
  }

  function createElement(document, tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  class RevealMedia {
    constructor(deck, environment) {
      this.deck = deck;
      this.environment = environment || global;
      this.document = this.environment.document;
      this.entries = new Map();
      this.destroyed = false;
      this.currentSlide = null;
      this.onNavigationKey = (event) => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
            (event.shiftKey && event.key !== "N") ||
            !NEXT_KEYS.has(event.key) || interactiveTarget(event.target)) return;
        if (this.consumeNext()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      this.onNavigationClick = (event) => {
        if (event.defaultPrevented || !event.target.closest) return;
        var control = event.target.closest(".navigate-right, .navigate-down");
        if (!control || !this.deck.getRevealElement().contains(control)) return;
        var suppress = false;
        if (event.type === "touchend") {
          suppress = this.consumedTouch === control;
          this.consumedTouch = null;
        } else if (event.type === "click" && this.consumedClick === control &&
            Date.now() < this.suppressClickUntil) suppress = true;
        else if (this.consumeNext()) {
          suppress = true;
          if (event.type === "touchstart") {
            this.consumedTouch = control;
            this.consumedClick = control;
            this.suppressClickUntil = Date.now() + 800;
          }
        }
        if (suppress) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      this.onSlideChange = () => this.synchronize();
      this.originalNext = deck.next;
      this.wrappedNext = (...args) => {
        if (!this.consumeNext()) return this.originalNext.apply(deck, args);
      };
      deck.next = this.wrappedNext;
      this.document.addEventListener("keydown", this.onNavigationKey, true);
      this.document.addEventListener("click", this.onNavigationClick, true);
      this.document.addEventListener("touchstart", this.onNavigationClick, { capture: true, passive: false });
      this.document.addEventListener("touchend", this.onNavigationClick, { capture: true, passive: false });
      ["ready", "slidechanged", "fragmentshown", "fragmenthidden"].forEach((name) => {
        deck.on(name, this.onSlideChange);
      });
      if (this.environment.MutationObserver) {
        this.observer = new this.environment.MutationObserver((records) => {
          var relevant = records.some(function (record) {
            return Array.from(record.addedNodes).some(function (node) {
              return node.nodeType === 1 && (node.matches(".youtube-audio, .youtube-container") ||
                node.querySelector(".youtube-audio, .youtube-container"));
            }) || Array.from(record.removedNodes).some(function (node) {
              return node.nodeType === 1 && (node.matches(".youtube-audio, .youtube-container") ||
                node.querySelector(".youtube-audio, .youtube-container"));
            });
          });
          if (relevant) this.refresh();
        });
        this.observer.observe(deck.getRevealElement(), { childList: true, subtree: true });
      }
      this.refresh();
    }

    isActive(element) {
      var current = this.deck.getCurrentSlide();
      return !!(current && current.contains(element) && !element.closest(
        ".fragment:not(.visible), .fragment.current-visible:not(.current-fragment), .fragment.fade-out.visible"));
    }

    createAudioView(entry) {
      var document = this.document;
      var element = entry.element;
      // Reveal handles Space even on focused buttons. Keep native button and
      // slider keys inside this widget without cancelling their default action.
      element.addEventListener("keydown", keepWidgetKeys);
      var controls = createElement(document, "div", "youtube-audio__controls");
      var button = createElement(document, "button", "youtube-audio__play", "▶");
      button.type = "button";
      button.setAttribute("aria-label", "Play YouTube excerpt");
      var slider = createElement(document, "input", "youtube-audio__timeline");
      slider.type = "range";
      slider.min = "0";
      slider.max = "1";
      slider.step = "0.1";
      slider.value = "0";
      slider.setAttribute("aria-label", "Seek within YouTube excerpt");
      var time = createElement(document, "output", "youtube-audio__time", "0:00 / —");
      controls.append(button, slider, time);
      element.prepend(controls);
      var caption = createElement(document, "div", "youtube-audio__caption");
      var source = element.querySelector(".youtube-audio-source");
      if (source) caption.appendChild(source);
      var toggle = createElement(document, "button", "youtube-audio__show-video", "Show video");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", "false");
      caption.appendChild(toggle);
      element.appendChild(caption);
      var status = createElement(document, "div", "youtube-audio__status");
      status.setAttribute("role", "status");
      status.hidden = true;
      element.appendChild(status);
      var playerBox = createElement(document, "div", "youtube-audio__player");
      playerBox.setAttribute("aria-hidden", "true");
      var host = createElement(document, "div", "youtube-audio__host");
      playerBox.appendChild(host);
      element.appendChild(playerBox);
      button.addEventListener("click", () => {
        if (["playing", "buffering", "loading"].includes(entry.state.status)) entry.state.pause();
        else this.play(entry);
      });
      slider.addEventListener("input", () => entry.state.seek(slider.value));
      toggle.addEventListener("click", () => {
        var visible = !playerBox.classList.contains("is-visible");
        playerBox.classList.toggle("is-visible", visible);
        playerBox.setAttribute("aria-hidden", String(!visible));
        toggle.setAttribute("aria-expanded", String(visible));
        toggle.textContent = visible ? "Hide video" : "Show video";
        if (entry.iframe) entry.iframe.tabIndex = visible ? 0 : -1;
        if (typeof this.deck.layout === "function") this.deck.layout();
      });
      entry.view = { button: button, slider: slider, time: time, status: status, playerBox: playerBox, host: host };
    }

    render(entry, progress) {
      entry.element.dataset.youtubeState = progress.status;
      if (!entry.view) return;
      var view = entry.view;
      var playing = ["playing", "buffering", "loading"].includes(progress.status);
      view.button.textContent = playing ? "Ⅱ" : "▶";
      view.button.setAttribute("aria-label", playing ? "Pause YouTube excerpt" :
        progress.finished ? "Replay YouTube excerpt" : "Play YouTube excerpt");
      view.button.setAttribute("aria-pressed", String(playing));
      view.slider.disabled = !entry.state.ready || !(progress.length > 0);
      view.slider.max = String(progress.length || 1);
      view.slider.value = String(progress.elapsed);
      view.slider.style.setProperty("--youtube-progress", (progress.fraction * 100) + "%");
      view.slider.setAttribute("aria-valuetext", formatTime(progress.elapsed) + " of " +
        (progress.length === null ? "unknown duration" : formatTime(progress.length)));
      view.time.textContent = formatTime(progress.elapsed) + " / " +
        (progress.length === null ? "—" : formatTime(progress.length));
      view.status.hidden = !progress.error;
      view.status.textContent = progress.error;
    }

    ensurePlayer(entry) {
      if (entry.playerPending || entry.state.player || entry.invalid) return;
      entry.playerPending = ensureYouTubeAPI(this.environment).then((YT) => {
        if (this.destroyed || !this.entries.has(entry.element)) return;
        var events = {
          onReady: (event) => {
            entry.iframe = event.target.getIframe();
            if (entry.audio) {
              entry.iframe.title = "YouTube excerpt player";
              entry.iframe.tabIndex = entry.view.playerBox.classList.contains("is-visible") ? 0 : -1;
            }
            entry.iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
            entry.state.onReady(event.target);
          },
          onStateChange: (event) => entry.state.onStateChange(event),
          onError: (event) => entry.state.onError(event),
          onAutoplayBlocked: () => entry.state.blocked()
        };
        var options = { events: events };
        if (entry.audio) {
          options.width = "320";
          options.height = "200";
          options.videoId = entry.state.videoId;
          options.playerVars = { enablejsapi: 1, controls: 1, playsinline: 1, rel: 0 };
          if (/^https?:$/.test(this.environment.location.protocol)) {
            options.playerVars.origin = this.environment.location.origin;
          }
        }
        entry.state.player = new YT.Player(entry.audio ? entry.view.host : entry.iframe, options);
      }).catch((error) => {
        entry.state.fail(error.message || "YouTube could not load. Try again or open the source link.");
      }).finally(function () { entry.playerPending = null; });
    }

    refresh() {
      if (this.destroyed) return;
      var root = this.deck.getRevealElement();
      this.entries.forEach((entry, element) => {
        if (!root.contains(element)) {
          entry.state.destroy();
          this.entries.delete(element);
        }
      });
      root.querySelectorAll(".youtube-audio, .youtube-container").forEach((element) => {
        if (this.entries.has(element)) return;
        var audio = element.classList.contains("youtube-audio");
        var iframe = audio ? null : element.querySelector("iframe");
        if (!audio && !iframe) return;
        var id = element.dataset.videoId || "";
        if (!audio) {
          try {
            var url = new URL(iframe.src, this.environment.location.href);
            id = url.pathname.split("/").pop();
            url.searchParams.set("enablejsapi", "1");
            if (/^https?:$/.test(this.environment.location.protocol)) {
              url.searchParams.set("origin", this.environment.location.origin);
            }
            iframe.src = url.toString();
          } catch (error) { /* The invalid ID is reported by the state machine. */ }
        }
        var entry = { element: element, audio: audio, iframe: iframe, view: null, active: false };
        entry.state = new ExcerptPlayer({ videoId: id,
          start: Number(element.dataset.start || 0),
          end: element.dataset.end ? Number(element.dataset.end) : null,
          active: () => this.isActive(element), clock: this.environment,
          changed: (progress) => { if (entry.state) this.render(entry, progress); }
        });
        entry.invalid = !!entry.state.error;
        this.entries.set(element, entry);
        if (audio) this.createAudioView(entry);
        entry.state.emit();
        this.ensurePlayer(entry);
      });
      this.synchronize();
    }

    synchronize() {
      var current = this.deck.getCurrentSlide();
      var changed = current !== this.currentSlide;
      this.entries.forEach((entry) => {
        var active = this.isActive(entry.element);
        if (active && (changed || !entry.active)) entry.state.reset();
        else if (!active && entry.active) entry.state.leave();
        entry.active = active;
      });
      this.currentSlide = current;
    }

    play(entry) {
      if (entry.invalid) return false;
      this.entries.forEach(function (other) {
        if (other !== entry && ["playing", "buffering", "loading"].includes(other.state.status)) {
          other.state.pause();
        }
      });
      this.ensurePlayer(entry);
      return entry.state.requestPlay();
    }

    consumeNext() {
      if (this.destroyed || (typeof this.deck.isOverview === "function" && this.deck.isOverview())) return false;
      var active = Array.from(this.entries.values()).filter((entry) => this.isActive(entry.element));
      if (active.some(function (entry) {
        return entry.state.pendingPlay || ["playing", "buffering", "loading"].includes(entry.state.status);
      })) return false;
      var entry = active.find(function (item) { return item.state.consumesNext(); });
      return entry ? this.play(entry) : false;
    }

    destroy() {
      this.destroyed = true;
      this.entries.forEach(function (entry) {
        entry.state.destroy();
        if (entry.audio) entry.element.removeEventListener("keydown", keepWidgetKeys);
      });
      this.entries.clear();
      if (this.observer) this.observer.disconnect();
      this.document.removeEventListener("keydown", this.onNavigationKey, true);
      this.document.removeEventListener("click", this.onNavigationClick, true);
      this.document.removeEventListener("touchstart", this.onNavigationClick, true);
      this.document.removeEventListener("touchend", this.onNavigationClick, true);
      if (typeof this.deck.off === "function") {
        ["ready", "slidechanged", "fragmentshown", "fragmenthidden"].forEach((name) => {
          this.deck.off(name, this.onSlideChange);
        });
      }
      if (this.deck.next === this.wrappedNext) this.deck.next = this.originalNext;
      decks.delete(this.deck);
    }
  }

  function attach(deck) {
    if (!deck || typeof deck.getRevealElement !== "function") throw new TypeError("A Reveal deck is required.");
    if (decks.has(deck)) return decks.get(deck);
    var manager = new RevealMedia(deck, global);
    decks.set(deck, manager);
    return manager;
  }

  var api = { attach: attach, ExcerptPlayer: ExcerptPlayer, RevealMedia: RevealMedia,
    excerptProgress: excerptProgress, formatTime: formatTime, ensureYouTubeAPI: ensureYouTubeAPI,
    interactiveTarget: interactiveTarget, keepWidgetKeys: keepWidgetKeys };
  if (typeof module === "object" && module.exports) module.exports = api;
  else global.RevealYouTubeMedia = api;
})(typeof window === "undefined" ? globalThis : window);
