# reveal-utils

Shared local dependencies and presentation helpers for Adrián Artacho's Reveal slides.

## Vertical slide stacks

The [format-exchange converter](https://github.com/AdrianArtacho/format-exchange#nested-slides--vertical-stacks)
turns a LaTeX `slide` containing direct child slides into a native Reveal vertical
stack. The parent's own content is its first screen; each child is a separate
screen underneath it. With `navigationMode: "default"`, Left/Right moves between
horizontal topics, Up/Down moves within a stack, and Space/Next traverses all
screens. Existing fragments and media playback steps still apply.

No additional plugin is required. Keep this checkout updated with the converter
so both Right and Down can start a YouTube excerpt on the current screen; leaving
that screen pauses its player. Global and local TOC links use Reveal's native
anchors to reach individual child slides. See the
[Reveal documentation](https://revealjs.com/vertical-slides/) for navigation modes.

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

## YouTube excerpt playback

`js/youtube-media.js` is the shared playback handler for the existing
`\youtube[start-end]{VIDEO_ID}` and the compact
`\youtubeaudio[start-end]{VIDEO_ID}` macros. The audio-style presentation shows
a horizontal line, moving playhead, play/pause button and excerpt-relative
time. For `[0:20-1:24]`, the line spans 64 seconds; it does not include the rest
of the source video. Clicking or dragging the line seeks within those bounds.

The matching [LaTeX snippet](https://github.com/AdrianArtacho/ltx_snippets/blob/main/ltx/reveal/youtubeaudio.tex)
and [converter](https://github.com/AdrianArtacho/format-exchange#youtube-audio-excerpts)
provide the source and export integration. The converter's template loads:

```html
<link rel="stylesheet" href="./reveal/css/youtube-audio.css">
<script src="./reveal/js/youtube-media.js"></script>
```

Then attach the handler before starting Reveal:

```js
const deck = new Reveal({ hash: true, plugins });
const youtubeMedia = window.RevealYouTubeMedia.attach(deck);
deck.initialize();
```

The handler loads the YouTube IFrame API once when it finds media. Remove any
older template-specific YouTube player initialization when adopting this
handler; a player should have only one owner. For slides inserted later,
`youtubeMedia.refresh()` discovers them, and `youtubeMedia.destroy()` releases
the handlers and players. The wrapper's `index.html` already handles its
asynchronous slide fetch.

The converter emits a placeholder like this:

```html
<div class="youtube-audio" data-video-id="8cItW8_RMNo"
     data-start="20" data-end="84">
  <a class="youtube-audio-source"
     href="https://www.youtube.com/watch?v=8cItW8_RMNo&amp;t=20s"
     target="_blank" rel="noopener">YouTube audio · 0:20–1:24 (1:04)</a>
</div>
```

Omit `data-end` or leave it empty to use the video's duration. All bounds are
source seconds. The progress display subtracts the selected start and clamps
to the selected end or the video's duration, whichever comes first. The
runtime uses YouTube's reported clock and periodically enforces the endpoint,
including after a seek; it is not suitable for sample-accurate audio cues.

On entering a slide, excerpts are prepared at their start and paused. The first
Next action starts playback: `→`, `↓`, `Space`, `PageDown`, `N`, on-screen right/down
controls, or `deck.next()` (including OSC `/slide/next`). Next during playback
can advance normally. Leaving the slide pauses playback; returning resets the
excerpt. After the excerpt completes, Next advances. Widget buttons, timeline
input, MIDI controls and text fields retain their own keyboard behavior.
Use one excerpt per slide for a straightforward presentation sequence.

### Browser and YouTube behaviour

Serve slides over HTTPS or localhost, with internet access and an embeddable
video. The compact view still loads a normal YouTube video player; it does not
download, extract, or cache an audio file. YouTube's
[developer policies](https://developers.google.com/youtube/terms/developer-policies#i.-additional-prohibitions)
require the player to be visible and prohibit background-player features.
Consequently this hidden view is not an officially supported audio-only
integration. **Show video** reveals the normal player for consent, playback
controls, or diagnostics; use the regular `\youtube` macro for a visible embed.

Browser autoplay policies can require a direct click, particularly when a
remote OSC command starts playback. The widget keeps a play button and source
link available, and blocked/failed playback does not trap slide navigation.
YouTube ads, embedding restrictions, and network delays remain applicable.
The [IFrame API reference](https://developers.google.com/youtube/iframe_api_reference)
documents playback events and timing behaviour.

The [audio excerpt example](examples/youtube-audio.html) uses these same assets.
Run the runtime checks with:

```sh
node --test tests/*.test.js
```

The tests simulate the YouTube API and Reveal lifecycle. Actual YouTube access,
browser playback permission, and the presentation computer's sound output
still need a live check.

## Dated semester plans

The `semesterplan` environment in
[ltx_snippets](https://github.com/AdrianArtacho/ltx_snippets/blob/main/ltx/reveal/semesterplan.tex)
uses one `\semesterrow{YYYY-MM-DD}{topic}{repertoire}` per session.
[format-exchange](https://github.com/AdrianArtacho/format-exchange#dated-semester-plans)
converts it into a table whose dates remain available to the browser.

By default, the latest scheduled date on or before today is the **current session**.
Earlier sessions remain normal, future sessions are mildly muted, and the
current row has a teal accent, pale background, and visible **aktuell** marker.
Authored bold, italics, links, and line breaks remain intact. Before the first
session every row is future; after the last, the last session remains current.
Repeated dates share their state and rows retain their source order.

Set `\begin{semesterplan}[today=auto+7]` to highlight the coming week as well.
The current session stays **aktuell**, and every upcoming row through today
plus seven calendar days gets the same highlight and marker. Day seven is
included; later rows stay muted. On 20 October, rows on 21, 26, and 27 October
are included, while 28 October remains future. Before the first session, rows
within the upcoming window can already be current. `auto+N` accepts a
nonnegative whole number of days; `auto+0` is equivalent to `auto`. Month/year
boundaries, leap years, and daylight-saving changes use calendar-day arithmetic;
the resulting year must remain within 0001–9999.

The converter's template loads:

```html
<link rel="stylesheet" href="./reveal/css/semester-plan.css">
<script src="./reveal/js/semester-plan.js"></script>
```

The wrapper's own `index.html` uses the equivalent `./css/` and `./js/` paths.
Both assets work offline, with no Reveal plugin registration or new library.
Update this checkout along with the converter and LaTeX snippet.

Plans initialize on page load and when slide content is inserted later. The
helper uses the presentation computer's **local calendar day**, updates at
local midnight, and refreshes when the page regains focus or visibility.
All live plans share a single timer. Invalid dates never roll into another month.

An environment option such as `[today=2026-10-20]` emits
`data-semester-today="2026-10-20"` and freezes that plan's reference date.
The default is `data-semester-today="auto"`; `[today=auto+7]` emits
`data-semester-today="auto+7"` and remains live, with the upcoming window
advancing at local midnight or when returning to the page. The converter
provides initial states for the export date; the runtime refreshes automatic
plans on opening. PDFs remain snapshots of the compilation date and Markdown
of the export date, using the same upcoming window when requested.

For manual control, `window.RevealSemesterPlan.init(container)` discovers
plans within a subtree, `.refresh()` updates their states, and `.destroy()`
removes the observers, timer, and event listeners. Tables have a focusable
scroll region; long plans remain readable without shrinking the type.

CSS properties on `.semester-plan` control the accent, background, and future
opacity: `--semester-plan-accent`, `--semester-plan-current-background`, and
`--semester-plan-future-opacity`. The current label adds a cue beyond color.

The [standalone example](examples/semester-plan.html) contains the six-session
Musikanalyse plan and lets you preview another reference date. Run the checks:

```sh
node --test tests/semester-plan.test.js
```

Tests cover calendar/leap-year validation, inclusive upcoming windows, date boundaries, local time and DST,
duplicate dates, independent live/frozen plans, dynamic insertion, preserved
cell content, and cleanup.
