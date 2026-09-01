# Upstream issue draft — xterm.js

**Repo**: https://github.com/xtermjs/xterm.js
**Title**: First IME-committed character is dropped when `input` fires before `keydown` (macOS)

---

xterm.js 6.0.0 · macOS 26.5 · WKWebView (system WebKit 26.5, via Tauri 2) · macOS Simplified Chinese (Pinyin) input source

## Problem

Typing full-width punctuation (`？`, `！`, `（`) with the macOS Chinese input source drops
the **first** character. Subsequent ones work. Symptom: "the first `？` needs two presses".

## Cause

`_inputEvent` guards on `(!ev.composed || !this._keyDownSeen)`. For a browser-dispatched
`input` event `ev.composed` is always `true`, so the guard is effectively `!this._keyDownSeen`.

`_keyDownSeen` is set in `_keyDown` and cleared in `_keyUp` — which assumes **`input` arrives
after the `keydown` of the same keystroke**. With macOS IME punctuation the order is inverted:
`beforeinput` → `input` → `keydown` (1–4 ms apart). So `_keyDownSeen` still reflects the
*previous* key. These characters require `Shift`, whose `keydown` set the flag and whose
`keyup` hasn't happened yet — so the first one is dropped. Each character's own `keyup` then
clears the flag, which is why the rest get through.

## Evidence

Capture-phase log from a real run; `value` is `textarea.value` at log time. `Shift` held down,
`！` pressed twice:

```
t=56898 keydown     key="Shift" code=16      value=""
t=57158 beforeinput data="！"                value=""
t=57162 input       data="！"                value="！"    ← dropped, no onData
t=57163 keydown     key="！" code=229        value="！"
t=57275 keyup       key="！" code=49         value="！"    ← flag cleared here
t=57651 beforeinput data="！"                value="！"
t=57653 onData      "！"                     value="！！"   ← passes now
t=57654 input       data="！"                value="！！"
```

Also worth noting:

- No `composition*` events fire at all for these characters — `CompositionHelper` is not involved.
- `textarea.value` is never cleared and keeps accumulating.
- Ordinary keys are unaffected: they're handled on the `keydown` path and `_keyPressHandled`
  already prevents the double-send (same log shows `onData " "` at `keydown` time, with the
  following `input` producing nothing).

## Direction

`_keyPressHandled` already covers the double-send for printable characters, so `_keyDownSeen`
looks like a second line of defence whose ordering assumption doesn't hold universally.
Options: clear it when an `insertText` `beforeinput` arrives without an intervening `keydown`;
or scope it to the case where the `keydown` actually produced data.

No PR yet — the right fix depends on which double-send `_keyDownSeen` was added to prevent.
Happy to write one if a maintainer points at a preferred direction.

## Workaround

Capture-phase `beforeinput` on the element *containing* xterm's textarea (ancestor capture runs
before the textarea's own capture listeners, where `_inputEvent` is registered):

```ts
host.addEventListener('beforeinput', (ev: InputEvent) => {
  if (ev.inputType !== 'insertText' || !ev.data) return
  const core = (term as unknown as { _core?: { _keyDownSeen?: boolean } })._core
  if (core && '_keyDownSeen' in core) core._keyDownSeen = false
}, true)
```

Touches a private field, so guard it and pin the assumption with a test.
