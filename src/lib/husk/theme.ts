/**
 * Theme is locked to dark. The export signature is kept stable so existing
 * imports compile — setTheme is a no-op since there is no light mode.
 */

export type Theme = "dark";

export type ThemeControls = {
  readonly theme: Theme;
  readonly setTheme: (next: Theme) => void;
};

export function useTheme(): ThemeControls {
  return { theme: "dark", setTheme: () => undefined };
}
