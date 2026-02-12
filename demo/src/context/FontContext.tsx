import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export type FontId = "jetbrains-mono" | "inter";

export interface FontMeta {
  id: FontId;
  label: string;
  family: string;
}

export const FONTS: FontMeta[] = [
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace" },
  { id: "inter", label: "Inter", family: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif" },
];

const STORAGE_KEY = "acp:font";
const DEFAULT_FONT: FontId = "jetbrains-mono";

function applyFont(id: FontId) {
  const meta = FONTS.find((f) => f.id === id);
  if (meta) {
    document.documentElement.style.setProperty("--font-chat", meta.family);
  }
}

function loadFont(): FontId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && FONTS.some((f) => f.id === stored)) return stored as FontId;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_FONT;
}

interface FontContextValue {
  font: FontId;
  setFont: (id: FontId) => void;
}

const FontContext = createContext<FontContextValue>({
  font: DEFAULT_FONT,
  setFont: () => {},
});

export function useFont() {
  return useContext(FontContext);
}

export function FontProvider({ children }: { children: ReactNode }) {
  const [font, setFontState] = useState<FontId>(() => {
    const f = loadFont();
    applyFont(f);
    return f;
  });

  const setFont = useCallback((id: FontId) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* localStorage unavailable */
    }
    applyFont(id);
    setFontState(id);
  }, []);

  useEffect(() => {
    applyFont(font);
  }, []);

  return (
    <FontContext.Provider value={{ font, setFont }}>
      {children}
    </FontContext.Provider>
  );
}
