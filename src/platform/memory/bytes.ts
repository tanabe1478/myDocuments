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

/** crates と同じ規則（先頭バイトで png / jpeg / webp を判定）。メモリ実装だけが使う。正本は src-tauri/src/backgrounds.rs。 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
