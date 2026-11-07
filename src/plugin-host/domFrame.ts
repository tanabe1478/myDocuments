import type { FrameHandle, WorkerHostOptions } from './workerHost';

/**
 * 仲介の iframe を作る。sandbox は "allow-scripts" だけ（allow-same-origin を付けない。付けると本体と同じ origin になり、
 * 親の DOM と IPC の鍵に届く。K1）。中身は URL ではなく srcdoc（ADR-005 の R8）。送り元の URL が about:srcdoc になり、
 * Tauri は、その送り元からのネイティブへの呼び出しを、鍵があっても、リモートの扱いにして拒否する。
 * 見えない場所に置き、キーボードの移動の対象にしない。
 */
export function createDomFrame(hostHtml: string): FrameHandle {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('title', 'plugin host');
  iframe.dataset.testid = 'plugin-host-frame';
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;top:0;visibility:hidden;pointer-events:none';
  iframe.srcdoc = hostHtml;
  document.body.appendChild(iframe);
  return {
    post: (message) => iframe.contentWindow?.postMessage(message, '*'),
    owns: (source) => source !== null && source !== undefined && source === iframe.contentWindow,
    dispose: () => iframe.remove(),
  };
}

/** 窓の message イベントの受け口。 */
export function listenWindowMessages(handler: Parameters<WorkerHostOptions['listen']>[0]): () => void {
  const onMessage = (event: MessageEvent): void => handler({ source: event.source, data: event.data });
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
