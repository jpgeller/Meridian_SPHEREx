// Keyboard -> commands. The key map is built from each command's `keys` metadata, so
// there is one source of truth (and a help overlay can list it with commands.list()).

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

// Inputs where keys do not type text (checkboxes, radios, colour pickers...): shortcuts still work there.
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file']);

function isTyping(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' && NOT_TEXT.has(el.type)) return false;
  return TYPING.has(el.tagName) || el.isContentEditable;
}

// Enter and Space must keep working on focused buttons and links; only use them
// as shortcuts when nothing interactive has focus.
function isInteractive(el) {
  return el && el.closest?.('button, a[href], [role="button"], [role="slider"], summary, select, input[type="checkbox"], input[type="radio"]');
}

export function startKeyboard(commands, { target = window } = {}) {
  const onKey = (e) => {
    // Leave browser and OS shortcuts (Cmd+L, Ctrl+F...) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTyping(e.target)) {
      // In a text field only Escape is ours (to leave the field).
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && isInteractive(e.target)) return;

    const cmd = commands.list().find((c) => c.keys?.includes(e.key));
    if (!cmd) return;
    e.preventDefault();
    commands.run(cmd.name, {}, 'keyboard');
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
