/**
 * Phase 0 in-browser harness. Drives MDE's real EditorManager (CodeMirror 6),
 * MilkdownManager (Crepe), fileOps.saveFile and @tauri-apps/plugin-fs JS code.
 * Only the Rust side of the Tauri IPC is replaced by a byte pass-through stub
 * (verified against tauri-plugin-fs 2.4.5 src/commands.rs: read returns raw
 * bytes, write does write_all of the raw body).
 */

// --- Tauri IPC stub: must exist before @tauri-apps/api/core is first used. ---
const vfs = new Map<string, Uint8Array>();
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 0,
  invoke: async (cmd: string, args: any, options: any) => {
    if (cmd === 'plugin:fs|read_text_file') {
      const b = vfs.get(args.path);
      if (!b) throw new Error('ENOENT ' + args.path);
      return b.slice().buffer; // ArrayBuffer, same shape as tauri::ipc::Response
    }
    if (cmd === 'plugin:fs|write_text_file') {
      const path = decodeURIComponent(options.headers.path);
      vfs.set(path, new Uint8Array(args));
      return null;
    }
    throw new Error('stub: unsupported ' + cmd);
  },
};

import { readTextFile } from '@tauri-apps/plugin-fs';
import { saveFile } from '../vendor/MDE/src/fileOps';
import { EditorManager } from '../vendor/MDE/src/editor/EditorManager';
import { MilkdownManager } from '../vendor/MDE/src/editor/MilkdownManager';

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const afterPaint = async () => {
  await nextFrame();
  await new Promise<void>((r) => setTimeout(r, 0));
};

const settings = { wordWrap: true, fontSize: 14, showOutline: false, autoSave: false };

function mkCm() {
  const mgr = new EditorManager();
  const el = document.getElementById('cm')!;
  el.innerHTML = '';
  mgr.setSettings(settings);
  mgr.attach(el);
  return mgr;
}
function mkMd() {
  const mgr = new MilkdownManager();
  const el = document.getElementById('md')!;
  el.innerHTML = '';
  mgr.attach(el);
  return mgr;
}
const show = (id: 'cm' | 'md' | 'plain') => {
  for (const k of ['cm', 'md', 'plain'] as const) {
    document.getElementById(k)!.style.display = k === id ? 'block' : 'none';
  }
};

const api = {
  /** Round-trip one fixture. Returns result bytes for each path (base64). */
  async roundtrip(b64: string) {
    const src = b64ToBytes(b64);
    vfs.set('/fixture.md', src);
    const out: Record<string, any> = {};

    // (a1) MDE open -> no edit -> explicit save. tab.content is the string from
    // readTextFile (App.tsx openFile path) and handleSave writes tab.content.
    const content = await readTextFile('/fixture.md');
    await saveFile('/fixture.md', content);
    out.a1_noEditSave = bytesToB64(vfs.get('/fixture.md')!);

    // (a2) open in CodeMirror (real EditorManager), no edit: what CM holds.
    show('cm');
    const cm = mkCm();
    cm.activate('t1', content);
    await afterPaint();
    const cmContent = cm.getContent('t1')!;
    vfs.set('/fixture.md', src);
    await saveFile('/fixture.md', cmContent);
    out.a2_cmNoEditContentSave = bytesToB64(vfs.get('/fixture.md')!);
    out.a2_cmContentEqualsReadString = cmContent === content;

    // (a3) one real edit in CM (insert + delete a char at end), then the
    // onChange(doc.toString()) payload that handleContentChange stores.
    let changed: string | null = null;
    cm.setOnChange((_id, doc) => { changed = doc; });
    const view = cm.getActiveView()!;
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: 'X' } });
    view.dispatch({ changes: { from: end, to: end + 1, insert: '' } });
    await new Promise((r) => setTimeout(r, 250));
    vfs.set('/fixture.md', src);
    await saveFile('/fixture.md', changed ?? cmContent);
    out.a3_cmEditRevertSave = bytesToB64(vfs.get('/fixture.md')!);
    out.a3_onChangeFired = changed !== null;
    cm.detach();

    // (b) Milkdown (real MilkdownManager / Crepe config).
    show('md');
    const md = mkMd();
    md.attach(document.getElementById('md')!);
    await md.activate('t1', content);
    await afterPaint();
    await new Promise((r) => setTimeout(r, 300));
    const mdRaw = md.getMarkdown('t1');
    out.b_milkdownSerialized = mdRaw === undefined ? null : bytesToB64(new TextEncoder().encode(mdRaw));
    // What MDE hands back to CodeMirror on visual->raw without a user edit.
    const guarded = md.getContentForRawSync('t1');
    out.b_guardedRawSync = guarded === undefined ? null : bytesToB64(new TextEncoder().encode(guarded));
    md.detach();
    return out;
  },

  /** After a user edit in Milkdown (type X at end of doc), return the markdown. */
  async milkdownPrepareForTyping(b64: string) {
    const content = new TextDecoder().decode(b64ToBytes(b64));
    show('md');
    const md = mkMd();
    (window as any).__md = md;
    await md.activate('t1', content);
    await afterPaint();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  },
  milkdownAfterEdit() {
    const md = (window as any).__md as MilkdownManager;
    const guarded = md.getContentForRawSync('t1');
    const raw = md.getMarkdown('t1');
    return {
      guarded: guarded === undefined ? null : bytesToB64(new TextEncoder().encode(guarded)),
      raw: raw === undefined ? null : bytesToB64(new TextEncoder().encode(raw)),
    };
  },

  // ---------------- benchmark helpers ----------------
  async cmLoad(b64: string) {
    const doc = new TextDecoder().decode(b64ToBytes(b64));
    show('cm');
    const cm = mkCm();
    const t0 = performance.now();
    cm.activate('t1', doc);
    const tCreated = performance.now();
    await afterPaint();
    const t1 = performance.now();
    const res = {
      createMs: tCreated - t0, toPaintMs: t1 - t0,
      docChars: cm.getContent('t1')!.length,
      renderedLines: document.querySelectorAll('#cm .cm-line').length,
    };
    cm.detach();
    return res;
  },
  async mdLoad(b64: string) {
    const doc = new TextDecoder().decode(b64ToBytes(b64));
    show('md');
    const md = mkMd();
    const t0 = performance.now();
    await md.activate('t1', doc);
    const tCreated = performance.now();
    await afterPaint();
    const t1 = performance.now();
    const res = {
      createMs: tCreated - t0, toPaintMs: t1 - t0,
      docChars: (md.getMarkdown('t1') ?? '').length,
      renderedBlocks: document.querySelectorAll('#md .ProseMirror > *').length,
    };
    md.detach();
    return res;
  },

  /** Prepare an editor for keystroke latency measurement; Playwright types. */
  async prepareTyping(engine: 'cm' | 'md' | 'plain', b64: string) {
    const doc = new TextDecoder().decode(b64ToBytes(b64));
    (window as any).__lat = [];
    if (engine === 'cm') {
      show('cm');
      const cm = mkCm();
      (window as any).__cm = cm;
      cm.activate('t1', doc);
      await afterPaint();
      const view = cm.getActiveView()!;
      // Place the caret in the middle of the document so layout work is not trivial.
      const mid = Math.floor(view.state.doc.length / 2);
      const line = view.state.doc.lineAt(mid);
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
      view.focus();
    } else if (engine === 'md') {
      show('md');
      const md = mkMd();
      (window as any).__md = md;
      await md.activate('t1', doc);
      await afterPaint();
      await new Promise((r) => setTimeout(r, 300));
      const pm = document.querySelector<HTMLElement>('#md .ProseMirror')!;
      pm.focus();
      // Move caret to the middle paragraph.
      const paras = pm.querySelectorAll('p');
      const target = paras[Math.floor(paras.length / 2)] ?? pm;
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      (target as HTMLElement).scrollIntoView({ block: 'center' });
    } else {
      show('plain');
      const el = document.getElementById('plain')!;
      el.textContent = doc.slice(0, 20000);
      el.focus();
    }
    await afterPaint();
    (window as any).__len = () => engine === 'cm' ? (window as any).__cm.getContent('t1').length
      : engine === 'md' ? ((window as any).__md.getMarkdown('t1') ?? '').length
      : document.getElementById('plain')!.textContent!.length;
    (window as any).__len0 = (window as any).__len();
    // keydown (capture) -> next frame -> task after paint
    const lat: number[] = (window as any).__lat;
    window.addEventListener('keydown', () => {
      const t0 = performance.now();
      requestAnimationFrame(() => setTimeout(() => lat.push(performance.now() - t0), 0));
    }, true);
    return true;
  },
  typingDelta() {
    return (window as any).__len() - (window as any).__len0;
  },
  collectLatency() {
    return (window as any).__lat as number[];
  },
  teardownTyping() {
    (window as any).__cm?.detach();
    (window as any).__md?.detach();
    (window as any).__cm = undefined;
    (window as any).__md = undefined;
  },

  /** Mode switch, replicating EditorArea.tsx effect (lines 82-109) for a tab. */
  async modeSwitch(b64: string, withEdit: boolean) {
    const doc = new TextDecoder().decode(b64ToBytes(b64));
    const cm = mkCm();
    const md = mkMd();
    show('cm');
    cm.activate('t1', doc);
    await afterPaint();
    const out: Record<string, number> = {};

    // raw -> visual (first activation: creates Crepe)
    let t0 = performance.now();
    let content = cm.getContent('t1') ?? doc;
    show('md');
    await md.activate('t1', content);
    await afterPaint();
    out.rawToVisualFirstMs = performance.now() - t0;

    // visual -> raw
    t0 = performance.now();
    const back = md.getContentForRawSync('t1') ?? doc;
    cm.setContent('t1', back);
    show('cm');
    cm.activate('t1', doc);
    await afterPaint();
    out.visualToRawMs = performance.now() - t0;

    // raw -> visual again (editor exists -> setContent + activate)
    t0 = performance.now();
    content = cm.getContent('t1') ?? doc;
    if (md.getMarkdown('t1') !== undefined) await md.setContent('t1', content);
    show('md');
    await md.activate('t1', content);
    await afterPaint();
    out.rawToVisualSecondMs = performance.now() - t0;
    void withEdit;
    cm.detach();
    md.detach();
    return out;
  },
};

(window as any).__h = api;
(window as any).__ready = true;
