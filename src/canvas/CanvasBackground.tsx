import type { BackgroundLayer } from './canvas';

/**
 * 本文の背面の背景層。単色・グラデーション・画像（明るさ + オーバーレイ）。
 * 装飾なので、支援技術には見せない。none（背景を表示しない）のときは何も描かない。
 */
export function CanvasBackground({ layer, imageUrl }: { layer: BackgroundLayer; imageUrl: string | null }) {
  if (layer.kind === 'none') return null;
  if (layer.kind === 'color') {
    return <div className="canvas-bg" data-testid="canvas-bg" data-kind="color" aria-hidden="true" style={{ background: layer.color }} />;
  }
  if (layer.kind === 'gradient') {
    return <div className="canvas-bg" data-testid="canvas-bg" data-kind="gradient" aria-hidden="true" style={{ background: layer.css }} />;
  }
  return (
    <div className="canvas-bg" data-testid="canvas-bg" data-kind="image" aria-hidden="true">
      {imageUrl !== null && (
        <img className="canvas-bg-image" data-testid="canvas-bg-image" src={imageUrl} alt="" style={{ filter: `brightness(${layer.brightness})` }} />
      )}
      <div className="canvas-bg-overlay" style={{ background: layer.overlayColor, opacity: layer.overlayOpacity }} />
    </div>
  );
}
