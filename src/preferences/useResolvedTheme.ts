import { useEffect, useState } from 'react';
import type { ThemeMode } from '../canvas/gradients';
import { resolveTheme } from './apply';
import type { ThemeSetting } from './preferences';

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** theme の設定を、いま表示する light / dark に解決する（system は OS の変更に追従する）。 */
export function useResolvedTheme(theme: ThemeSetting): ThemeMode {
  const [dark, setDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  return resolveTheme(theme, dark);
}
