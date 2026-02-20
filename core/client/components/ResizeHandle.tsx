import { useRef, useCallback, useEffect } from "react";

interface Props {
  debugPanelRef: React.RefObject<HTMLDivElement | null>;
  collapsed: boolean;
}

export function ResizeHandle({ debugPanelRef, collapsed }: Props) {
  const resizing = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    handleRef.current?.classList.add("active");
    e.preventDefault();
  }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!resizing.current || !debugPanelRef.current) return;
      const newWidth = window.innerWidth - e.clientX;
      debugPanelRef.current.style.width =
        Math.max(200, Math.min(newWidth, window.innerWidth - 300)) + "px";
    }
    function onMouseUp() {
      resizing.current = false;
      handleRef.current?.classList.remove("active");
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [debugPanelRef]);

  if (collapsed) return null;

  return (
    <div
      ref={handleRef}
      id="resize-handle"
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-dim"
      onMouseDown={onMouseDown}
    />
  );
}
