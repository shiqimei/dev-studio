import { useRef, useEffect, useCallback } from "react";

export function useAutoScroll<T extends HTMLElement>(...deps: unknown[]) {
  const ref = useRef<T>(null);
  const autoScroll = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScroll.current = gap < 40;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && autoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  return { ref, onScroll };
}
