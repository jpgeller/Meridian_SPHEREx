// Screen layout: named regions the panels render into. Layout only, no logic.
//   top     search / coordinates
//   toggle  the side panel's open / close button (always on screen, gaze-sized)
//   left    the side panel: eye control, face, places, view, colours
//   dock    band ribbon (bottom centre)
//   readout view centre RA / Dec and field of view (bottom right)
// One panel on the left keeps the screen simple for eye tracking: one place to look for every
// setting, and one big button that folds it away. The top-right corner stays empty for the guide
// pop-up (U4); the bottom-left corner is the gaze rest zone, so nothing sits there. In the field
// view the whole shell hides (body.field-open).

export function createShell(root) {
  root.innerHTML = `
    <div id="controls" class="shell">
      <header class="shell-top" data-region="top"></header>
      <div class="shell-toggle" data-region="toggle"></div>
      <aside id="side-panel" class="shell-left" data-region="left" aria-label="Controls"></aside>
      <section class="shell-dock" data-region="dock" aria-label="Infrared band"></section>
      <section class="shell-readout" data-region="readout" aria-label="View centre"></section>
    </div>`;
  const region = (name) => root.querySelector(`[data-region="${name}"]`);
  return { top: region('top'), toggle: region('toggle'), left: region('left'), dock: region('dock'), readout: region('readout') };
}
