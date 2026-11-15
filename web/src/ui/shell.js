// Screen layout: named regions the panels render into. Layout only, no logic.
//   top    search / coordinates
//   left   face panel (U8) above the presets
//   dock   band ribbon (bottom centre)
//   tools  view type, colours, brightness (right column)
// The top-right corner stays empty for the guide pop-up (U4), and the bottom-right corner for
// the Aladin logo. In the field view the whole shell hides (body.field-open).

export function createShell(root) {
  root.innerHTML = `
    <div id="controls" class="shell">
      <header class="shell-top" data-region="top"></header>
      <aside class="shell-left" data-region="left" aria-label="Places"></aside>
      <section class="shell-dock" data-region="dock" aria-label="Infrared band"></section>
      <aside class="shell-tools" data-region="tools" aria-label="Sky tools"></aside>
    </div>`;
  const region = (name) => root.querySelector(`[data-region="${name}"]`);
  return { top: region('top'), left: region('left'), dock: region('dock'), tools: region('tools') };
}
