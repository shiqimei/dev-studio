import { useRef, useState, useLayoutEffect, useCallback } from "react";

export function useAutoScroll<T extends HTMLElement>(...deps: unknown[]) {
  const ref = useRef<T>(null);
  const autoScroll = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScroll.current = gap < 40;
    setIsAtBottom(gap < 200);
  }, []);

  // useLayoutEffect fires synchronously after DOM mutations, before paint —
  // correct timing for scroll manipulation (no visual flicker).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && autoScroll.current) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, deps);

  const scrollToBottom = useCallback(() => {
    autoScroll.current = true;
    setIsAtBottom(true);
    const el = ref.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      // Follow-up scroll after the browser paints — catches layout shifts
      // from lazy content (images, fonts, etc.) that make the initial
      // scrollHeight slightly short of the true bottom.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, []);

  return { ref, onScroll, scrollToBottom, isAtBottom };
}
