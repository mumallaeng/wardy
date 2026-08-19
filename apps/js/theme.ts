export type ColorTheme = "light" | "dark";

const STORAGE_KEY = "wardy-theme";

export function parseColorTheme(value: string | null | undefined): ColorTheme {
  return value === "dark" ? "dark" : "light";
}

export function nextColorTheme(theme: ColorTheme): ColorTheme {
  return theme === "light" ? "dark" : "light";
}

export class ColorThemeController {
  constructor(
    private readonly storage: Storage,
    private readonly document: Document,
  ) {}

  applyCurrent(): ColorTheme {
    const theme = parseColorTheme(this.document.documentElement.dataset.theme);
    this.apply(theme);
    return theme;
  }

  toggle(): ColorTheme {
    const current = parseColorTheme(this.document.documentElement.dataset.theme);
    const theme = nextColorTheme(current);
    this.apply(theme);
    try {
      this.storage.setItem(STORAGE_KEY, theme);
    } catch {
      // The current page can still switch theme when storage is unavailable.
    }
    return theme;
  }

  private apply(theme: ColorTheme): void {
    const isDark = theme === "dark";
    this.document.documentElement.dataset.theme = theme;
    const toggle = this.document.querySelector<HTMLButtonElement>("#theme-toggle");
    if (toggle) {
      const label = isDark ? "라이트 모드로 전환" : "다크 모드로 전환";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("aria-pressed", String(isDark));
      toggle.title = label;
    }
    const themeColor = this.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute("content", isDark ? "#101914" : "#18352a");
  }
}
