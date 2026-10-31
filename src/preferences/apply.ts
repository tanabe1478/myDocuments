import type { Preferences } from './preferences';

/** theme: 'system' を、OS の設定で light / dark のどちらかに解決する。 */
export function resolveTheme(theme: Preferences['theme'], systemPrefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return theme;
}

/** Preferences を CSS 変数と data-theme に反映する。戻り値は、system 追従の解除関数。 */
export function applyPreferences(prefs: Preferences, root: HTMLElement = document.documentElement): () => void {
  const style = root.style;
  style.setProperty('--md-font-family', prefs.fontFamily);
  style.setProperty('--md-font-size', `${prefs.fontSizePx}px`);
  style.setProperty('--md-line-height', String(prefs.lineHeight));
  style.setProperty('--md-paragraph-spacing', `${prefs.paragraphSpacing}em`);
  style.setProperty('--md-max-width', `${prefs.maxWidthPx}px`);

  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const update = () => {
    root.dataset.theme = resolveTheme(prefs.theme, media?.matches ?? false);
  };
  update();
  if (prefs.theme !== 'system' || media === null) return () => {};
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}
