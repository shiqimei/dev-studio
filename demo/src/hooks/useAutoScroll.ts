import { useRef, useLayoutEffect, useCallback } from "react";

export function useAutoScroll<T extends HTMLElement>(...deps: unknown[]) {
  const ref = useRef<T>(null);
  const autoScroll = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScroll.current = gap < 40;
  }, []);

  // useLayoutEffect fires synchronously after DOM mutations, before paint —
  // correct timing for scroll manipulation (no visual flicker).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && autoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  return { ref, onScroll };
}
