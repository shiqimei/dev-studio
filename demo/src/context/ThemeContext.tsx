import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export type ThemeId = "dusk" | "midnight" | "overcast" | "dawn" | "horizon" | "github-light";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  /** Representative color swatch for the preview dot */
  swatch: string;
}

export const THEMES: ThemeMeta[] = [
  { id: "dusk", label: "Dusk", description: "Soft dark, warm tones", swatch: "#1a1a2e" },
  { id: "midnight", label: "Midnight", description: "High-contrast terminal", swatch: "#0a0a0a" },
  { id: "overcast", label: "Overcast", description: "Cool slate dark", swatch: "#1e1e2e" },
  { id: "horizon", label: "Horizon", description: "Warm medium dark", swatch: "#292524" },
  { id: "dawn", label: "Dawn", description: "Light, easy on the eyes", swatch: "#faf8f5" },
  { id: "github-light", label: "GitHub Light", description: "Clean, familiar light", swatch: "#ffffff" },
];

const STORAGE_KEY = "acp:theme";
const DEFAULT_THEME: ThemeId = "dusk";

function applyTheme(id: ThemeId) {
  if (id === DEFAULT_THEME) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", id);
  }
}

function loadTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((t) => t.id === stored)) return stored as ThemeId;
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_THEME;
}

/** Map a UI theme to the appropriate Shiki syntax-highlighting theme. */
export function getShikiTheme(id: ThemeId): string {
  switch (id) {
    case "dawn":
    case "github-light":
      return "github-light";
    default:
      return "monokai";
  }
}

interface ThemeContextValue {
  theme: ThemeId;
  shikiTheme: string;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  shikiTheme: getShikiTheme(DEFAULT_THEME),
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const t = loadTheme();
    applyTheme(t);
    return t;
  });

  const setTheme = useCallback((id: ThemeId) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* localStorage unavailable */
    }
    applyTheme(id);
    setThemeState(id);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, shikiTheme: getShikiTheme(theme), setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
