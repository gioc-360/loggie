// What a workstream card shows when Loggie read the thread and found no move (cloud-first C3, next-move.js readCardMove).
// Pure, so the tests need neither a DOM nor Electron: the panel draws the line in its quiet style and nothing else.
export const noMoveLine = (top) => (top?.move?.kind === 'none' ? top.move.text : null);
// No Do-it button, and no draft, on a card that has no move.
export const showsDoIt = (top) => top?.move?.kind !== 'none';
