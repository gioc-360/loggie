// The panel opens at the size Gio uses it (2026-10-23, read off his MacBook: 1036 x 961): "the default window size
// should be what i have now". A size he drags to wins; both stay inside a smaller screen's work area.
const PANEL_DEFAULT_WIDTH = 1036;
const PANEL_DEFAULT_HEIGHT = 961;
const PANEL_MIN_HEIGHT = 300;
const PANEL_MIN_WIDTH = 340;

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

// Open a centered workspace at the size the user last dragged to (else the default), kept within the screen.
export function panelBounds(workArea, chosenWidth, chosenHeight) {
  const width = Number.isFinite(chosenWidth) && chosenWidth > 0
    ? clamp(Math.round(chosenWidth), PANEL_MIN_WIDTH, workArea.width)
    : Math.min(PANEL_DEFAULT_WIDTH, workArea.width);
  const height = Number.isFinite(chosenHeight) && chosenHeight > 0
    ? clamp(Math.round(chosenHeight), PANEL_MIN_HEIGHT, workArea.height)
    : Math.min(PANEL_DEFAULT_HEIGHT, workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}
