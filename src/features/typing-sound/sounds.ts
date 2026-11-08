// 打鍵音の素材 10 個（Unicae Games の Keyboard Soundpack #1、CC0。出典と元のファイルは sounds/README.md）。
// Vite が dist/assets に出し、本体と同じオリジンから fetch する。
import keypress001 from './sounds/keypress-001.wav?url';
import keypress003 from './sounds/keypress-003.wav?url';
import keypress007 from './sounds/keypress-007.wav?url';
import keypress008 from './sounds/keypress-008.wav?url';
import keypress010 from './sounds/keypress-010.wav?url';
import keypress011 from './sounds/keypress-011.wav?url';
import keypress013 from './sounds/keypress-013.wav?url';
import keypress015 from './sounds/keypress-015.wav?url';
import keypress019 from './sounds/keypress-019.wav?url';
import keypress028 from './sounds/keypress-028.wav?url';

export const SOUND_URLS: readonly string[] = [
  keypress001,
  keypress003,
  keypress007,
  keypress008,
  keypress010,
  keypress011,
  keypress013,
  keypress015,
  keypress019,
  keypress028,
];
