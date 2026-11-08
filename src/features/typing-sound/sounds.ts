// 打鍵音の素材。音色ごとに、Vite が dist/assets に出し、本体と同じオリジンから fetch する。
// - keyboard: 10 個（Unicae Games の Keyboard Soundpack #1、CC0。出典と元のファイルは sounds/README.md）。
// - typewriter: 8 個（Cassie-OrbitGames の Typewriter Sounds、CC0 を、scripts/make-typewriter-sounds.mjs で柔らかく加工したもの。
//   出典と加工は sounds/typewriter/README.md）。元の録音（sounds/typewriter/original/）は、アプリでは import しないので dist に入らない。
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
import typewriter1 from './sounds/typewriter/typewriter-1.wav?url';
import typewriter2 from './sounds/typewriter/typewriter-2.wav?url';
import typewriter3 from './sounds/typewriter/typewriter-3.wav?url';
import typewriter4 from './sounds/typewriter/typewriter-4.wav?url';
import typewriter5 from './sounds/typewriter/typewriter-5.wav?url';
import typewriter6 from './sounds/typewriter/typewriter-6.wav?url';
import typewriter7 from './sounds/typewriter/typewriter-7.wav?url';
import typewriter8 from './sounds/typewriter/typewriter-8.wav?url';

export const SOUND_URLS: Readonly<Record<'keyboard' | 'typewriter', readonly string[]>> = {
  keyboard: [keypress001, keypress003, keypress007, keypress008, keypress010, keypress011, keypress013, keypress015, keypress019, keypress028],
  typewriter: [typewriter1, typewriter2, typewriter3, typewriter4, typewriter5, typewriter6, typewriter7, typewriter8],
};
