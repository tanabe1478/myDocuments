import { describe, expect, it, vi } from 'vitest';
import { createLogSwitch } from './control';
import { createLogger } from './logger';

function setup(options: { failOn?: boolean } = {}) {
  const order: string[] = [];
  let release: (() => void) | null = null;
  const bridge = {
    setLogging: vi.fn(async (enabled: boolean) => {
      order.push(`bridge:${enabled}`);
      if (options.failOn && enabled) throw new Error('native failed');
      if (release === null && hold) await new Promise<void>((r) => (release = r));
    }),
  };
  let hold = false;
  const logger = createLogger({ append: async () => {} });
  logger.onEnabledChange((e) => order.push(`logger:${e}`));
  const onEnabled = vi.fn((initial: boolean) => void order.push(`enabled:${initial}`));
  const sw = createLogSwitch(() => bridge, logger, onEnabled);
  return {
    sw,
    bridge,
    logger,
    order,
    onEnabled,
    holdNext: () => {
      hold = true;
      release = null;
    },
    release: () => release?.(),
  };
}

describe('createLogSwitch', () => {
  it('enables the native side first, then the logger (so entries are not dropped by the native side), then calls onEnabled with initial=true for the first apply', async () => {
    const h = setup();
    await h.sw.apply(true);
    expect(h.order).toEqual(['bridge:true', 'logger:true', 'enabled:true']);
    expect(h.logger.enabled).toBe(true);
  });

  it('disabling stops the logger at once, then tells the native side', async () => {
    const h = setup();
    await h.sw.apply(true);
    h.order.length = 0;
    const done = h.sw.apply(false);
    expect(h.logger.enabled).toBe(false);
    await done;
    expect(h.order).toEqual(['logger:false', 'bridge:false']);
  });

  it('does nothing for the same value twice; a later enable is not initial', async () => {
    const h = setup();
    await h.sw.apply(false);
    await h.sw.apply(false);
    expect(h.bridge.setLogging).toHaveBeenCalledTimes(1);
    await h.sw.apply(true);
    await h.sw.apply(true);
    expect(h.bridge.setLogging).toHaveBeenCalledTimes(2);
    expect(h.onEnabled).toHaveBeenCalledTimes(1);
    expect(h.onEnabled).toHaveBeenLastCalledWith(false);
  });

  it('leaves the logger disabled and does not throw when the native side fails', async () => {
    const h = setup({ failOn: true });
    await expect(h.sw.apply(true)).resolves.toBeUndefined();
    expect(h.logger.enabled).toBe(false);
    expect(h.onEnabled).not.toHaveBeenCalled();
  });

  it('a quick off while the enable is in flight ends disabled (the logger never turns on afterwards)', async () => {
    const h = setup();
    h.holdNext();
    const enabling = h.sw.apply(true);
    const disabling = h.sw.apply(false);
    // 有効にする呼び出し（ネイティブ側）が始まって、待っている状態にしてから、解放する。
    await new Promise((r) => setTimeout(r, 0));
    h.release();
    await Promise.all([enabling, disabling]);
    expect(h.logger.enabled).toBe(false);
    expect(h.order.at(-1)).toBe('bridge:false');
    expect(h.order).not.toContain('logger:true');
  });

  it('does nothing without a bridge', async () => {
    const logger = createLogger({ append: async () => {} });
    const sw = createLogSwitch(() => null, logger);
    await sw.apply(true);
    expect(logger.enabled).toBe(false);
  });
});
