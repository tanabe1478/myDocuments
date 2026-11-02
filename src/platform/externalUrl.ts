/**
 * 既定のブラウザで開いてよい URL の検査（純関数）。http と https で、ホストのあるものだけ。
 * ネイティブ側（src-tauri/src/external.rs）でも同じ規則で検査する。ここは、開けないリンクを
 * 先に「このリンクは開けません」と知らせるためと、メモリ bridge（e2e）の規則。
 */
export function isOpenableExternalUrl(raw: string): boolean {
  if (raw === '' || raw.trim() !== raw || raw.length > 8192) return false;
  // 解析器は "https:example.com" のような崩れた書き方を補う。書かれたとおりの scheme://host だけを通す。
  const m = /^(https?):\/\/([^/\\?#]+)/i.exec(raw);
  if (!m) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}
