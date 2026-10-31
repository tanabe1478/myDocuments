/**
 * 文字数: 空白・改行を除いた文字の数。サロゲートペア（絵文字など）は 1 文字。
 * 空白は、空白・タブ・改行・全角空白など、正規表現の \s に当たるもの。
 * 結合文字や ZWJ 連結の絵文字は、コードポイントごとに数える（書記素クラスタにはしない）。
 */
const WHITESPACE = /\s/;

export function countCharacters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count++;
        i++;
        continue;
      }
    }
    if (c > 0x20 && c < 0x7f) {
      count++; // 速い経路（ASCII の可視文字）
    } else if (!WHITESPACE.test(text[i]!)) {
      count++;
    }
  }
  return count;
}
