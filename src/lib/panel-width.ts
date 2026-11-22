// The side panel's user-set width — a per-device preference (localStorage,
// never synced). One width for every panel surface (board panel + card
// drawer); drag the left edge to resize. Wide screens only: on narrow
// viewports the panel is already full-width and stays that way.
import { createSignal, onSettled } from 'solid-js';

const KEY = 'fd-panel-width';
const MIN = 384; // 24rem
const MAX = 768; // 48rem

const readStored = (): number | null => {
  const raw = Number(localStorage.getItem(KEY));
  return Number.isFinite(raw) && raw >= MIN && raw <= MAX ? raw : null;
};

export function createPanelWidth() {
  // null = untouched → each surface keeps its own default width.
  const [width, setWidth] = createSignal<number | null>(null);
  const [dragging, setDragging] = createSignal(false);

  onSettled(() => {
    try {
      setWidth(readStored());
    } catch {
      // storage unavailable — defaults apply
    }
  });

  const startDrag = (event: MouseEvent) => {
    if (window.innerWidth < 768) return; // mobile: full-width, no handle
    event.preventDefault();
    setDragging(true);
    const apply = (e: MouseEvent) => {
      const next = Math.min(MAX, Math.max(MIN, window.innerWidth - e.clientX));
      setWidth(next);
    };
    const finish = () => {
      setDragging(false);
      document.removeEventListener('mousemove', apply);
      document.removeEventListener('mouseup', finish);
      try {
        const current = width();
        if (current !== null) localStorage.setItem(KEY, String(Math.round(current)));
      } catch {
        // best effort
      }
    };
    document.addEventListener('mousemove', apply);
    document.addEventListener('mouseup', finish);
  };

  return { width, dragging, startDrag };
}
