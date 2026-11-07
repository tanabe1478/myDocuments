/*
 * 隔離の検証用（ADR-005 の R5。feature isolation-probe のビルドだけ）。__mdeIsolationProbe
 * 仲介のページ（host.html と relay.js）と同じ条件の文脈（sandbox="allow-scripts" の srcdoc の iframe。本体の CSP を継承し、同じ meta の CSP）で動き、
 * 「仲介のコードが壊された場合の上限」を確かめる（ADR-005 の R8）。本物の仲介のコードは、この検証では動かさない（部品のコードも動かない）。
 * 結果は本体へ postMessage で返す（自己申告。届いたかの判定は、ネイティブ側の記録と 127.0.0.1 の受け口の記録で行う）。
 * R8: 自分を別の URL へ移す経路と、子の iframe を作る経路（probe-nav）も試す。移った先で動くコード（data: と blob: の本文）は、鍵つきの
 * webkit.messageHandlers.ipc.postMessage を試し、着いたことを top へ知らせる。
 */
(function () {
  'use strict';
  var main = window.parent;
  var R = {};
  var csp = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    csp.push(e.violatedDirective + ':' + String(e.blockedURI).slice(0, 40));
  });

  function t(name, fn) {
    return Promise.race([
      Promise.resolve().then(fn),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('timeout'));
        }, 4000);
      }),
    ]).then(
      function (v) {
        R[name] = String(v).slice(0, 80);
      },
      function (e) {
        R[name] = 'ERR:' + ((e && e.name) || '') + ':' + String((e && e.message) || e).slice(0, 60);
      },
    );
  }

  function ipcFetch(url, who, key) {
    var headers = { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2' };
    if (key) headers['Tauri-Invoke-Key'] = key;
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify({ who: who }) }).then(function (r) {
      return r.text().then(function (b) {
        return r.status + ' ' + (r.headers.get('Tauri-Response') || '-') + ' ' + b.slice(0, 40);
      });
    });
  }
  function ipcXhr(url, who, key) {
    return new Promise(function (resolve, reject) {
      var q = new XMLHttpRequest();
      q.open('POST', url);
      q.setRequestHeader('Content-Type', 'application/json');
      q.setRequestHeader('Tauri-Callback', '1');
      q.setRequestHeader('Tauri-Error', '2');
      if (key) q.setRequestHeader('Tauri-Invoke-Key', key);
      q.onload = function () {
        resolve(q.status + ' ' + q.responseText.slice(0, 40));
      };
      q.onerror = function () {
        reject(new Error('xhr network error'));
      };
      q.send(JSON.stringify({ who: who }));
    });
  }
  function postIpc(who, key) {
    var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc;
    if (!handler) return 'no-handler';
    var message = { cmd: 'isolation_probe_canary', callback: 1, error: 2, options: {}, payload: { who: who } };
    if (key) message.__TAURI_INVOKE_KEY__ = key;
    handler.postMessage(JSON.stringify(message));
    return 'posted';
  }

  function phase1(net) {
    R.globals = {
      TAURI_INTERNALS: typeof window.__TAURI_INTERNALS__,
      TAURI: typeof window.__TAURI__,
      isTauri: typeof window.isTauri,
      ipc: typeof window.ipc,
      webkitIpc: typeof (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc),
      origin: String(self.origin),
    };
    var steps = [
      t('fetchIpc_nokey', function () { return ipcFetch('ipc://localhost/isolation_probe_canary', 'relayctx:fetch-ipc-nokey', null); }),
      t('xhrIpc_nokey', function () { return ipcXhr('ipc://localhost/isolation_probe_canary', 'relayctx:xhr-ipc-nokey', null); }),
      t('fetchIpcHttp_nokey', function () { return ipcFetch('http://ipc.localhost/isolation_probe_canary', 'relayctx:fetch-ipchttp-nokey', null); }),
      t('postMessageIpc_nokey', function () { return postIpc('relayctx:postmessage-nokey', null); }),
      t('parent.document', function () { return typeof main.document + ':' + main.document.title; }),
      t('parent.__TAURI_INTERNALS__', function () { return typeof main.__TAURI_INTERNALS__; }),
      t('top.location', function () { return String(window.top.location.href); }),
      t('net_fetch', function () { return fetch(net + '/fetch?ctx=relayctx-fetch', { mode: 'no-cors' }).then(function () { return 'resolved'; }); }),
      t('net_xhr', function () { return new Promise(function (res, rej) { var q = new XMLHttpRequest(); q.open('GET', net + '/xhr?ctx=relayctx-xhr'); q.onload = function () { res('loaded'); }; q.onerror = function () { rej(new Error('xhr network error')); }; q.send(); }); }),
      t('net_img', function () { return new Promise(function (res) { var i = new Image(); i.onload = function () { res('loaded'); }; i.onerror = function () { res('error'); }; i.src = net + '/img?ctx=relayctx-img'; setTimeout(function () { res('timeout'); }, 1500); }); }),
      t('net_beacon', function () { return navigator.sendBeacon(net + '/beacon?ctx=relayctx-beacon', 'x'); }),
      t('net_ws', function () { return new Promise(function (res) { var w = new WebSocket('ws://' + net.replace('http://', '') + '/ws?ctx=relayctx-ws'); w.onopen = function () { res('open'); w.close(); }; w.onerror = function () { res('error'); }; setTimeout(function () { res('timeout'); }, 1500); }); }),
      t('net_nested_worker', function () {
        return new Promise(function (res) {
          var src = 'fetch(' + JSON.stringify(net + '/fetch?ctx=relayctx-nested-worker-fetch') + ',{mode:"no-cors"}).then(function(){postMessage("resolved")},function(e){postMessage("ERR:"+e.name)})';
          var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          w.onmessage = function (e) { res(e.data); };
          w.onerror = function () { res('worker-error'); };
          setTimeout(function () { res('timeout'); }, 3000);
        });
      }),
    ];
    return Promise.all(steps);
  }

  function phase2(key) {
    var steps = [
      t('fetchIpc_leakedKey', function () { return ipcFetch('ipc://localhost/isolation_probe_canary', 'relayctx:fetch-ipc-key', key); }),
      t('xhrIpc_leakedKey', function () { return ipcXhr('ipc://localhost/isolation_probe_canary', 'relayctx:xhr-ipc-key', key); }),
      t('fetchIpcHttp_leakedKey', function () { return ipcFetch('http://ipc.localhost/isolation_probe_canary', 'relayctx:fetch-ipchttp-key', key); }),
      t('postMessageIpc_leakedKey', function () { return postIpc('relayctx:postmessage-key', key); }),
      t('windowIpc_leakedKey', function () {
        if (!window.ipc) return 'no-window.ipc';
        window.ipc.postMessage(JSON.stringify({ cmd: 'isolation_probe_canary', callback: 1, error: 2, options: {}, payload: { who: 'relayctx:window-ipc-key' }, __TAURI_INVOKE_KEY__: key }));
        return 'posted';
      }),
    ];
    return Promise.all(steps);
  }

  /** 移った先で動くコード。着いたことを top へ知らせ、鍵つきの postMessage を試す（届いたかは canary.log で判定する）。 */
  function payloadHtml(id, key) {
    var code =
      '(function(){var r={href:String(location.href).slice(0,48),origin:String(self.origin)};' +
      'try{var h=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.ipc;' +
      'if(h){h.postMessage(JSON.stringify({cmd:"isolation_probe_canary",callback:1,error:2,options:{},payload:{who:' +
      JSON.stringify(id + ':postmessage-key') +
      '},__TAURI_INVOKE_KEY__:' +
      JSON.stringify(key) +
      '}));r.posted=true}else r.posted="no-handler"}catch(e){r.posted="ERR:"+e.name}' +
      'top.postMessage({kind:"probe-landed",id:' +
      JSON.stringify(id) +
      ',r:r},"*")})();';
    return '<!doctype html><script>' + code + '<' + '/script>';
  }

  /** 移動先の URL。tauri と plug は、攻撃のコードを置けない（本体のファイルか、なくなったプロトコル）ので、URL だけ。 */
  function destinationUrl(dest, id, key, origin) {
    if (dest === 'tauri') return origin + '/';
    if (dest === 'plug') return 'plug://localhost/probe-frame.html';
    var html = payloadHtml(id, key);
    if (dest === 'data') return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  }

  /** probe-nav: mode 'self' は自分の iframe を移す（移れたら、このコードは失われる）、'child' は子の iframe を作る。 */
  function nav(d) {
    var id = 'nav-' + d.mode + '-' + d.dest;
    var url;
    try {
      url = destinationUrl(d.dest, id, d.key, d.origin);
    } catch (e) {
      main.postMessage({ kind: 'probe-nav-report', id: id, error: 'url:' + e.name }, '*');
      return;
    }
    var violations = [];
    document.addEventListener('securitypolicyviolation', function (e) {
      violations.push(e.violatedDirective + ':' + String(e.blockedURI).slice(0, 24));
    });
    var report = function (extra) {
      var out = { kind: 'probe-nav-report', id: id, violations: violations };
      for (var k in extra) out[k] = extra[k];
      main.postMessage(out, '*');
    };
    try {
      if (d.mode === 'self') {
        window.location.href = url;
        // 移れたら、このコードは失われ、ここは動かない。動いたなら、移動は止められた。
        setTimeout(function () {
          report({ stayed: true });
        }, 2500);
      } else {
        var child = document.createElement('iframe');
        child.setAttribute('sandbox', 'allow-scripts');
        var loaded = 0;
        child.addEventListener('load', function () {
          loaded++;
        });
        child.src = url;
        document.body.appendChild(child);
        setTimeout(function () {
          report({ childLoadEvents: loaded });
        }, 2500);
      }
    } catch (e) {
      report({ error: String((e && e.name) || e) });
    }
  }

  var net = '';
  window.addEventListener('message', function (event) {
    if (event.source !== main) return;
    var d = event.data;
    if (!d || typeof d !== 'object') return;
    if (d.kind === 'probe-phase1') {
      net = d.net;
      phase1(net).then(function () {
        main.postMessage({ kind: 'probe-result', phase: 1, results: R, csp: csp }, '*');
      });
    } else if (d.kind === 'probe-nav') {
      nav(d);
    } else if (d.kind === 'probe-phase2') {
      phase2(d.key).then(function () {
        main.postMessage({ kind: 'probe-result', phase: 2, results: R, csp: csp }, '*');
      });
    }
  });
  main.postMessage({ kind: 'probe-hello' }, '*');
})();
