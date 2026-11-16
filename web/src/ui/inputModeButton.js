// The eye-control button (UI plan U9/U10): one real <button>, always on screen, that cycles the
// input mode A (off) -> B (guide only) -> C (full gaze) -> A. It only runs `cycle_input_mode` and
// reads state.input. Sky view: top of the left column (above the face panel). Field view (the shell
// hides): it floats in the time-lapse header, left of "Back to sky". 64 px high, so it is gaze-sized
// and, in full gaze mode, a 0.8 s look at it turns eye control off.
import { MODE_INFO, nextMode } from '../input/inputMode.js';

export function createInputModeButton({ store, commands, doc = document }) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'input-mode';
  btn.id = 'input-mode';
  btn.dataset.guide = 'input-mode';
  btn.innerHTML = `
    <span class="im-eye" aria-hidden="true"></span>
    <span class="im-text"><span class="im-k">Eye control</span><span class="im-v"></span></span>
    <span class="im-next"></span>`;
  btn.setAttribute('aria-keyshortcuts', 'g');
  btn.addEventListener('click', () => {
    if (opensEyePage(store.get().input)) {
      // deployed site: turning eye control on opens /eye.html (camera + gaze engine), same view
      window.location.href = `/eye.html${window.location.search}`;
      return;
    }
    commands.run('cycle_input_mode', {}, 'ui');
  });

  const place = (view) => {
    const left = doc.querySelector('[data-region="left"]');
    const floating = view === 'field' || !left;
    btn.classList.toggle('is-floating', floating);
    if (floating) {
      if (btn.parentElement !== doc.body) doc.body.append(btn);
    } else if (left.firstElementChild !== btn) left.prepend(btn);
  };

  const render = (s) => {
    const info = MODE_INFO[s.input] ?? MODE_INFO.mouse;
    const next = MODE_INFO[nextMode(s.input)];
    btn.dataset.mode = s.input;
    btn.querySelector('.im-eye').textContent = info.letter;
    btn.querySelector('.im-v').textContent = info.label;
    btn.querySelector('.im-next').textContent = `next: ${next.label}`;
    btn.title = `${info.title}. Press to switch to: ${next.label.toLowerCase()} (key G).`;
    // no aria-label: the visible words are the name ("Eye control Off next: Guide only"), so a
    // screen reader, voice control and the gaze layer all name it by what is on screen (U10)
    place(s.view);
  };
  store.subscribe((s, changed) => {
    if (changed.includes('input') || changed.includes('view')) render(s);
  });
  render(store.get());
  return { element: btn };
}

// The plain deployed page has no eye tracker, so "turn eye control on" sends visitors to /eye.html,
// which wraps this same page with the camera and the gaze engine. Unchanged (cycles A -> B -> C) when:
// already inside /eye.html (an iframe), a local tracker is connected (?gaze_ws), eye control is
// already on, or on localhost (local development, tests and meridian_live.py).
function opensEyePage(mode, win = window) {
  if (mode !== 'mouse') return false;
  try {
    if (win.top !== win) return false;
  } catch {
    return false;
  }
  const host = win.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return false;
  return !new URLSearchParams(win.location.search).has('gaze_ws');
}
