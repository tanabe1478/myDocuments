// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger';
import { createPerf } from './perf';

// 性能の計測（R16）の、実際のブラウザ環境（既定の PerfEnvironment）の部分。操作のリスナーが、ログがオンの間だけ、capture かつ passive で付き、
// オフで外れること。操作のあとだけ requestAnimationFrame が回り、締め切りで止まること。

const ACTIVITY_TYPES = ['keydown', 'compositionstart', 'compositionupdate', 'pointerdown', 'wheel', 'scroll'];

function setup() {
  const logger = createLogger({ append: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {} });
  const perf = createPerf(logger);
  return { logger, perf };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('default environment: operation listeners', () => {
  it('adds no operation listener, timer or rAF while the logger is off (the default)', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    setup();
    document.dispatchEvent(new KeyboardEvent('keydown'));
    expect(add).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  it('while on, listens to key, IME, pointer-down, wheel and scroll on the document, capture and passive; turning off removes the same listeners', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { logger } = setup();
    logger.setEnabled(true);
    const added = add.mock.calls.filter(([type]) => ACTIVITY_TYPES.includes(type));
    expect(added.map(([type]) => type).sort()).toEqual([...ACTIVITY_TYPES].sort());
    for (const [, , options] of added) expect(options).toEqual({ capture: true, passive: true });
    logger.setEnabled(false);
    const removed = remove.mock.calls.filter(([type]) => ACTIVITY_TYPES.includes(type));
    expect(removed.map(([type]) => type).sort()).toEqual([...ACTIVITY_TYPES].sort());
    for (const [, , options] of removed) expect(options).toEqual({ capture: true, passive: true });
    // 外れたあとの操作では、rAF を要求しない。
    const raf = globalThis.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>;
    raf.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown'));
    expect(raf).not.toHaveBeenCalled();
  });

  it('a key press or scroll in a child element (capture) starts the rAF watch; nothing is requested before that; it stops after ACTIVE_WATCH_MS without another operation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal('requestAnimationFrame', (fn: (time: number) => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const now = vi.spyOn(performance, 'now');
    let clock = 5000;
    now.mockImplementation(() => clock);
    const { logger, perf } = setup();
    logger.setEnabled(true);
    expect(frames).toHaveLength(0);

    const child = document.createElement('div');
    document.body.append(child);
    // scroll は伝わらないイベントだが、capture のリスナーで拾える。
    child.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    frames.shift()!(5016); // 基準
    clock = 5500;
    child.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    frames.shift()!(5532);
    expect(frames).toHaveLength(1);
    clock = 6500; // 最後の操作（5500）から 1000 ms
    frames.shift()!(5600);
    expect(frames).toHaveLength(0); // 締め切りで止まった
    perf.flush();
    child.remove();
  });
});
