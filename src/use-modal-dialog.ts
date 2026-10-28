import { useEffect, useRef, type RefObject } from "react";

/**
 * Modal behaviour for a portal-rendered `.sheet-backdrop > dialog`: traps Tab inside
 * the dialog, closes on Escape, locks page scroll, makes the rest of the page inert
 * while open, and restores focus to the opener on close.
 */
export function useModalDialog(
  dialog: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  restoreFocus: () => void,
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const node = dialog.current!;
    const backdrop = node.parentElement!;
    const background = [...document.body.children]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.focus();

    const keepFocus = (event: FocusEvent) => {
      if (!node.contains(event.target as Node)) node.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const focusable = [...node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        )].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) {
          event.preventDefault();
          node.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", keepFocus);
      for (const { element, inert } of background) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      queueMicrotask(restoreFocus);
    };
  }, [dialog, restoreFocus]);
}
