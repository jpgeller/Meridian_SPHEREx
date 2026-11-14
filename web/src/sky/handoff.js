// Offers the time-lapse once the user has zoomed in. It never opens it automatically:
// a surprise view change is disorienting.
import { FIELD_OPEN_MAX_FOV } from '../core/defaultCommands.js';

export function createHandoff(root, { store, commands }) {
  root.innerHTML = `
    <button type="button" id="open-field" class="handoff" hidden>
      Open time-lapse here <kbd>Enter</kbd>
    </button>`;
  const btn = root.querySelector('#open-field');
  btn.addEventListener('click', () => commands.run('open_field', {}, 'ui'));

  const render = (state) => {
    btn.hidden = !(state.view === 'sky' && state.fov < FIELD_OPEN_MAX_FOV);
  };
  store.subscribe(render);
  render(store.get());
}
