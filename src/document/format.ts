/** 読み込み時に記録するバイト列上の形式。crates/docio の DocumentFormat と同じ形。 */
export type Eol = 'lf' | 'crlf';

export interface DocumentFormat {
  readonly bom: boolean;
  /** 保存時に使う改行コード（混在していた場合は多数派）。 */
  readonly eol: Eol;
  /** 読み込んだファイルに LF と CRLF が混在していたか。 */
  readonly mixedEol: boolean;
}

/** 新規文書の形式: BOM なし、LF。 */
export const DEFAULT_FORMAT: DocumentFormat = { bom: false, eol: 'lf', mixedEol: false };

export function eolLabel(eol: Eol): string {
  return eol === 'crlf' ? 'CRLF' : 'LF';
}
