import { useEffect, useRef } from "react";

export function useCloseOnOutsidePicker(open: boolean, onClose: () => void): void {
  const latestOnClose = useRef(onClose);

  useEffect(() => {
    latestOnClose.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    // `mousedown` closes before the chip's `onClick` could re-open the picker.
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // Chip handlers own toggle / swap / pick interactions inside this wrapper.
      if (target?.closest(".ref-source-chip-wrap")) return;
      latestOnClose.current();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);
}
