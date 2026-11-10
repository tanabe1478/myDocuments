import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_API_VERSION, createPluginRegistry, type Plugin, type PluginContext, type PluginPerf } from '.';

// R16: ctx.perf。段 3 の部品にだけ、本体が貸す計測の口をそのまま渡す。口がない環境では、何も数えない（enabled は false）。

const perf = (): PluginPerf => ({ enabled: true, span: vi.fn(() => () => {}), measure: vi.fn((_n: string, fn: () => unknown) => fn()) as PluginPerf['measure'], record: vi.fn() });

function pluginCapturing(): { plugin: Plugin; ctx: () => PluginContext } {
  let captured: PluginContext | null = null;
  return {
    plugin: {
      manifest: { id: 'probe', name: 'probe', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
      activate(ctx) {
        captured = ctx;
      },
    },
    ctx: () => captured!,
  };
}

describe('ctx.perf', () => {
  it('is the measurement the host lent (PluginRegistryOptions.perf), usable from activate', () => {
    const p = perf();
    const probe = pluginCapturing();
    createPluginRegistry([probe.plugin], { perf: p });
    expect(probe.ctx().perf).toBe(p);
    expect(probe.ctx().perf.enabled).toBe(true);
    probe.ctx().perf.span('probe.work')();
    expect(p.span).toHaveBeenCalledWith('probe.work');
  });

  it('without the option, it never counts: enabled is false, span returns a function, measure returns the value, record does nothing', () => {
    const probe = pluginCapturing();
    createPluginRegistry([probe.plugin]);
    const lent = probe.ctx().perf;
    expect(lent.enabled).toBe(false);
    expect(() => lent.span('a.b')()).not.toThrow();
    expect(lent.measure('a.b', () => 5)).toBe(5);
    expect(() => lent.record('a.b', 1)).not.toThrow();
  });

  it('is the same measurement for every editor-tier plugin (names are chosen by the plugin; the host caps the number of names)', () => {
    const a = pluginCapturing();
    const b = pluginCapturing();
    const bPlugin: Plugin = { ...b.plugin, manifest: { ...b.plugin.manifest, id: 'probe-two' } };
    const p = perf();
    createPluginRegistry([a.plugin, bPlugin], { perf: p });
    expect(a.ctx().perf).toBe(p);
    expect(b.ctx().perf).toBe(p);
  });
});
