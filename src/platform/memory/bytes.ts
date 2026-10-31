import type { DocumentFormat } from '../../document/format';
import { BridgeError } from '../DocumentBridge';

// crates/docio（format.rs）と同じ規則の TypeScript 版。e2e 用のメモリ実装だけが使う。
// 実際のアプリは Rust の docio を使う。規則の正本は Rust 側。

const BOM = [0xef, 0xbb, 0xbf] as const;

export function decodeBytes(bytes: Uint8Array): { text: string; format: DocumentFormat } {
  const bom = bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b);
  const body = bom ? bytes.subarray(3) : bytes;
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new BridgeError('not-utf8', 'not valid UTF-8');
  }
  let crlf = 0;
  let lf = 0;
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\r' && raw[i + 1] === '\n') {
      crlf++;
      text += '\n';
      i++;
    } else {
      if (c === '\n') lf++;
      text += c;
    }
  }
  return {
    text,
    format: { bom, eol: crlf > lf ? 'crlf' : 'lf', mixedEol: crlf > 0 && lf > 0 },
  };
}

export function encodeText(text: string, format: DocumentFormat): Uint8Array {
  const body = new TextEncoder().encode(format.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text);
  if (!format.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(BOM, 0);
  out.set(body, 3);
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
