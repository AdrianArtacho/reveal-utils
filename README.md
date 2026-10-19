# reveal-utils

Shared local dependencies and presentation helpers for Adrián Artacho's Reveal slides.

## Live MIDI keyboard

The `\midikeyboard` macro in [ltx_snippets](https://github.com/AdrianArtacho/ltx_snippets/blob/main/ltx/reveal/midikeyboard.tex)
is converted by [format-exchange](https://github.com/AdrianArtacho/format-exchange) into a
25-key piano display, **C3–C5, MIDI notes 48–72**. This uses scientific pitch notation:
middle C is **C4 = 60**. Hardware and DAW octave labels may differ; the MIDI note numbers
are what determine which keys light up.

In the LaTeX source, write `\midikeyboard` inside a `slide` block. It is a live Reveal
aid and is omitted from scriptum and handout output. The converter's template loads
the files below from this repository's checkout at `reveal/`, next to the
generated `index.html`:

```html
<link rel="stylesheet" href="./reveal/css/midi-keyboard.css">
<script src="./reveal/js/midi-keyboard.js" defer></script>
```

The generated slide contains:

```html
<div class="midi-keyboard" data-midi-start="48" data-midi-keys="25"></div>
```

Connect your MIDI keyboard, open the slides, click **Enable MIDI**, and allow MIDI
access when prompted. This uses the browser's [Web MIDI API](https://www.w3.org/TR/webmidi/).
Serve the slides over **HTTPS** (including GitHub Pages) or **http://localhost**;
ordinary HTTP on a network address is insufficient. Use a browser with Web MIDI
support, such as desktop Chrome or Edge. Unsupported browsers and denied permissions
show an explanation while retaining the static piano layout. If you embed the slides
in another site, that site must also permit MIDI access for the frame.

All connected MIDI inputs and all 16 channels contribute to the display. Chords light
simultaneously; Note Off and velocity-zero Note On release keys. The display follows
**physically held keys**, so sustain-pedal messages do not keep released keys lit.
**Reset lights** clears the display after a missed release; it sends no MIDI messages.
Notes outside C3–C5 are reported below the keyboard without folding them into another
octave. There is no audio playback, MIDI output, or SysEx request.

One shared input manager serves every keyboard on every slide. Held notes remain in
sync as you navigate, disconnecting an input clears its notes, and reconnecting works
without another permission request. Existing MIDI handlers, including those used by
reveal4live, are preserved. Widgets initialize on page load and when slide HTML is
inserted later; no Reveal plugin registration is needed. For manual initialization,
call `window.RevealMIDIKeyboard.init(container)`.

Keep `reveal-utils` updated together with `format-exchange`; the CSS and JavaScript
must exist in the copy used by the presentation. Both assets work locally without
additional online dependencies.

The [standalone example](examples/midi-keyboard.html) uses the same assets without
Reveal and can be served locally to check your MIDI setup.

### Tests

With Node.js 18 or newer, run:

```sh
node --test tests/midi-keyboard.test.js
```

These tests use mocked MIDI ports to check polyphony, channel/device isolation,
release messages, sustain behavior, hotplug, permission states, reset, and coexistence
with other MIDI handlers. A physical MIDI keyboard and browser permission prompt
remain part of a live classroom check.
