import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { RegisteredPanel } from '../plugin-api';

export interface PluginPanelsProps {
  panels: readonly RegisteredPanel[];
  /** たたんでいるパネルの id。 */
  collapsed: ReadonlySet<string>;
  onToggle(panelId: string): void;
  /** 項目を押した（クリック、Enter）。index は panel.items の番号。 */
  onActivate(panel: RegisteredPanel, index: number): void;
}

/** 部品が項目がないときの文言を渡さなかったときの文言。 */
const DEFAULT_EMPTY_TEXT = '項目はありません';

/**
 * 左サイドバーの、エクスプローラーの下の「部品のパネル」の節（ADR-005 の R7）。段 2 の部品が送った項目の木を、本体が描く。
 * 部品の文字列（見出し、項目、文言）は、React のテキストとして描く（HTML として解釈しない。dangerouslySetInnerHTML を使わない）。
 * 属性・URL・スタイルは、部品が決めない（深さは整数で、data-depth と CSS の決まった指定になる）。
 * 見出しはボタンで、押すと節をたためる（aria-expanded）。一覧は名前（`<見出し>の項目`）を持ち、項目はボタン。現在の項目は aria-current="location"。
 * キーボード: Tab で一覧に入る（入る項目は 1 つ。現在の項目、なければ先頭）。上下、Home、End で移動し、Enter（または Space）で選ぶ。
 */
export function PluginPanels({ panels, collapsed, onToggle, onActivate }: PluginPanelsProps) {
  if (panels.length === 0) return null;
  return (
    <div className="plugin-panels" data-testid="plugin-panels">
      {panels.map((panel) => (
        <PanelSection key={panel.id} panel={panel} collapsed={collapsed.has(panel.id)} onToggle={onToggle} onActivate={onActivate} />
      ))}
    </div>
  );
}

function PanelSection({
  panel,
  collapsed,
  onToggle,
  onActivate,
}: {
  panel: RegisteredPanel;
  collapsed: boolean;
  onToggle(panelId: string): void;
  onActivate(panel: RegisteredPanel, index: number): void;
}) {
  const uid = useId();
  const bodyId = `${uid}-body`;
  const listRef = useRef<HTMLUListElement>(null);
  // キーボードで最後にいた項目（Tab で戻ってくる項目）。項目が減ったら、末尾に収める。
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const last = panel.items.length - 1;
  const tabIndexOf = Math.min(focusIndex ?? panel.current ?? 0, Math.max(last, 0));

  const move = (to: number) => {
    const target = Math.max(0, Math.min(to, last));
    listRef.current?.querySelectorAll<HTMLElement>('button')[target]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const index = Number((e.target as HTMLElement).dataset.index);
    if (!Number.isInteger(index)) return;
    const to = e.key === 'ArrowDown' ? index + 1 : e.key === 'ArrowUp' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (to === null) return;
    e.preventDefault();
    move(to);
  };

  return (
    <section className="plugin-panel" data-testid="plugin-panel" data-panel-id={panel.id} data-collapsed={collapsed ? 'true' : 'false'} aria-label={panel.title}>
      <h3 className="plugin-panel-heading">
        <button
          type="button"
          className="plugin-panel-toggle"
          data-testid="plugin-panel-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => onToggle(panel.id)}
        >
          <span className="plugin-panel-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          {panel.title}
        </button>
      </h3>
      <div id={bodyId} className="plugin-panel-body" hidden={collapsed}>
        {!panel.loaded ? null : panel.items.length === 0 ? (
          <p className="plugin-panel-empty" data-testid="plugin-panel-empty">
            {panel.empty ?? DEFAULT_EMPTY_TEXT}
          </p>
        ) : (
          <ul ref={listRef} className="plugin-panel-list" data-testid="plugin-panel-list" aria-label={`${panel.title}の項目`} onKeyDown={onKeyDown}>
            {panel.items.map((item, index) => (
              <li key={index}>
                <button
                  type="button"
                  className="plugin-panel-item"
                  data-testid="plugin-panel-item"
                  data-index={index}
                  data-depth={item.depth}
                  tabIndex={index === tabIndexOf ? 0 : -1}
                  aria-current={index === panel.current ? 'location' : undefined}
                  onFocus={() => setFocusIndex(index)}
                  onClick={() => onActivate(panel, index)}
                >
                  {item.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
