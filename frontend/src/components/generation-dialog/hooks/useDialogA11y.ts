import { useEffect, useRef, type RefObject } from "react";

interface UseDialogA11yOptions {
  enabled: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  firstFocusRef: RefObject<HTMLTextAreaElement | null>;
  onEscape: () => void;
  onSubmit: () => void;
}

export function useDialogA11y({
  enabled,
  dialogRef,
  firstFocusRef,
  onEscape,
  onSubmit,
}: UseDialogA11yOptions): void {
  const latestEscape = useRef(onEscape);
  const latestSubmit = useRef(onSubmit);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    latestEscape.current = onEscape;
    latestSubmit.current = onSubmit;
  });

  useEffect(() => {
    if (!enabled) {
      if (triggerRef.current instanceof HTMLElement) triggerRef.current.focus();
      return;
    }

    triggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // Focus textarea on open.
    setTimeout(() => firstFocusRef.current?.focus(), 50);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        latestEscape.current();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        latestSubmit.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, firstFocusRef]);

  useEffect(() => {
    if (!enabled) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [enabled, dialogRef]);
}
