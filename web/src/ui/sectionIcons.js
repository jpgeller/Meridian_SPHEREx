// Small line icons for the titled sections of the 2D view (stroke = currentColor; styled by .fsec-icon).
export const SECTION_ICONS = {
  zoom: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  detector: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 21 8 12 13 3 8Z"/><path d="M3 12.5 12 17.5 21 12.5"/><path d="M3 16.5 12 21.5 21 16.5"/></svg>',
  view: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5Z"/></svg>',
  dates: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  playback: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5Z"/></svg>',
  measure: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M4 17c3-9 5-12 8-6s5 3 8-6"/></svg>',
};

/** A section title: icon + text. `hint` is the section's explanation (ui/hints.js puts its star there). */
export const sectionTitle = (id, icon, text, hint) =>
  `<h3 class="fsec-title" id="${id}" data-hint-section="${hint.replace(/"/g, '&quot;')}"><span class="fsec-icon">${SECTION_ICONS[icon]}</span><span class="fsec-text">${text}</span></h3>`;
