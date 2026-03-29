/**
 * Theme definitions, CSS injection, and accent color derivation.
 *
 * V1 themes override accent/semantic colors only:
 *   primary, primary-foreground, ring,
 *   destructive, destructive-foreground,
 *   info, info-foreground,
 *   success, success-foreground,
 *   warning, warning-foreground
 *
 * Background/surface tokens stay controlled by the CSS baseline in index.css.
 */

// ── Token types ──────────────────────────────────────────────────

/**
 * The set of CSS custom-property names a theme may override.
 * Uses the unprefixed form (e.g. "primary", not "--color-primary").
 */
export type ThemeToken =
  | "primary"
  | "primary-foreground"
  | "ring"
  | "destructive"
  | "destructive-foreground"
  | "info"
  | "info-foreground"
  | "success"
  | "success-foreground"
  | "warning"
  | "warning-foreground";

export type ThemeTokenMap = Partial<Record<ThemeToken, string>>;

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  light: ThemeTokenMap;
  dark: ThemeTokenMap;
}

// ── Built-in themes ──────────────────────────────────────────────

const T3CODE_THEME: ThemeDefinition = {
  id: "t3code",
  name: "T3Code",
  description: "Default color palette.",
  builtIn: true,
  light: {},
  dark: {},
};

const HIGH_CONTRAST_THEME: ThemeDefinition = {
  id: "high-contrast",
  name: "High Contrast",
  description: "Boosted contrast for WCAG AAA.",
  builtIn: true,
  light: {
    primary: "oklch(0.35 0.25 264)",
    "primary-foreground": "oklch(1 0 0)",
    ring: "oklch(0.35 0.25 264)",
    destructive: "oklch(0.45 0.28 25)",
    "destructive-foreground": "oklch(0.30 0.22 25)",
    info: "oklch(0.45 0.22 250)",
    "info-foreground": "oklch(0.30 0.18 250)",
    success: "oklch(0.42 0.20 155)",
    "success-foreground": "oklch(0.28 0.16 155)",
    warning: "oklch(0.55 0.22 70)",
    "warning-foreground": "oklch(0.38 0.18 70)",
  },
  dark: {
    primary: "oklch(0.75 0.22 264)",
    "primary-foreground": "oklch(0.15 0 0)",
    ring: "oklch(0.75 0.22 264)",
    destructive: "oklch(0.72 0.26 25)",
    "destructive-foreground": "oklch(0.82 0.18 25)",
    info: "oklch(0.72 0.20 250)",
    "info-foreground": "oklch(0.82 0.14 250)",
    success: "oklch(0.72 0.20 155)",
    "success-foreground": "oklch(0.82 0.14 155)",
    warning: "oklch(0.78 0.20 70)",
    "warning-foreground": "oklch(0.86 0.14 70)",
  },
};

const COLOR_BLIND_THEME: ThemeDefinition = {
  id: "color-blind",
  name: "Color Blind",
  description: "Deuteranopia-safe palette.",
  builtIn: true,
  light: {
    success: "oklch(0.65 0.15 195)",
    "success-foreground": "oklch(0.45 0.12 195)",
    warning: "oklch(0.75 0.16 65)",
    "warning-foreground": "oklch(0.50 0.14 65)",
    destructive: "oklch(0.55 0.22 350)",
    "destructive-foreground": "oklch(0.40 0.18 350)",
  },
  dark: {
    success: "oklch(0.70 0.14 195)",
    "success-foreground": "oklch(0.82 0.10 195)",
    warning: "oklch(0.78 0.15 65)",
    "warning-foreground": "oklch(0.86 0.10 65)",
    destructive: "oklch(0.68 0.20 350)",
    "destructive-foreground": "oklch(0.82 0.14 350)",
  },
};

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  T3CODE_THEME,
  HIGH_CONTRAST_THEME,
  COLOR_BLIND_THEME,
];

export const DEFAULT_THEME_ID = "t3code";

// ── Accent presets ───────────────────────────────────────────────

export interface AccentPreset {
  name: string;
  hue: number;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 55 },
  { name: "Yellow", hue: 85 },
  { name: "Green", hue: 145 },
  { name: "Teal", hue: 185 },
  { name: "Blue", hue: 240 },
  { name: "Purple", hue: 290 },
  { name: "Pink", hue: 340 },
];

// ── Lookup ───────────────────────────────────────────────────────

export function findThemeById(id: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((t) => t.id === id);
}

// ── Accent derivation (oklch) ────────────────────────────────────

export function deriveAccentColors(hue: number): { light: ThemeTokenMap; dark: ThemeTokenMap } {
  return {
    light: {
      primary: `oklch(0.488 0.217 ${hue})`,
      "primary-foreground": "oklch(1 0 0)",
      ring: `oklch(0.488 0.217 ${hue})`,
    },
    dark: {
      primary: `oklch(0.588 0.217 ${hue})`,
      "primary-foreground": "oklch(1 0 0)",
      ring: `oklch(0.588 0.217 ${hue})`,
    },
  };
}

// ── CSS injection ────────────────────────────────────────────────

const STYLE_ELEMENT_ID = "t3code-theme-tokens";

function buildCssBlock(selector: string, tokens: ThemeTokenMap): string {
  const entries = Object.entries(tokens) as [ThemeToken, string][];
  if (entries.length === 0) return "";
  // Override the intermediate CSS variables (--primary, --ring, etc.)
  // which feed into Tailwind's --color-* via @theme inline { --color-primary: var(--primary) }.
  const declarations = entries.map(([token, value]) => `  --${token}: ${value};`).join("\n");
  return `${selector} {\n${declarations}\n}`;
}

/**
 * Inject or replace a `<style>` element with theme overrides.
 * When the T3Code default is active with no accent, removes the element entirely.
 */
export function applyThemeTokens(theme: ThemeDefinition, accentHue: number | null): void {
  const accent = accentHue != null ? deriveAccentColors(accentHue) : null;

  const lightTokens: ThemeTokenMap = { ...theme.light, ...accent?.light };
  const darkTokens: ThemeTokenMap = { ...theme.dark, ...accent?.dark };

  const hasOverrides = Object.keys(lightTokens).length > 0 || Object.keys(darkTokens).length > 0;

  if (!hasOverrides) {
    removeThemeTokens();
    return;
  }

  const blocks = [
    buildCssBlock(":root", lightTokens),
    buildCssBlock(":root:is(.dark, .dark *)", darkTokens),
  ]
    .filter(Boolean)
    .join("\n");

  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = blocks;
}

export function removeThemeTokens(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}
