/*
 * 仲介のコード（ADR-005 の案 2a）。Worker のホストのページ（host.html）の、iframe の主の文脈で動く。
 * 配信するファイルそのもの（vite を通さない）。Tauri 版は plug:、ブラウザ版は同じオリジンから返す。
 *
 * 役割: 本体（window.parent）から部品のコードの文字列を受け取り、blob の Worker にして動かす。本体と Worker の
 * メッセージを、決めた種類と形だけ通す。形の違うメッセージ、例外、script のエラーを出した Worker は terminate する。
 *
 * してはいけないこと: 部品のコードを評価しない。文字列からの関数の生成も、script 要素の挿入もしない。
 * 部品のコードは Blob にして Worker に渡すだけで、この文脈では実行されない。
 * ネイティブへの入口（IPC）には触れない。この文脈にあるのは、このファイルのコードと postMessage だけ。
 *
 * R6: 部品が本体の機能（クリップボード、開いている文書のパス）を使う呼び出し（call）と、ツリーの右クリックの項目（menu）を、
 * 決めた形だけ通す。権限を使ってよいかの判断は、ここではしない（本体が、呼び出しのたびに決める）。この文脈は、形と上限と、
 * 番号の対応（要求していない結果を Worker に通さない）だけを見る。
 */
(function () {
  'use strict';

  var VERSION = 0;
  var MAX_COMMANDS = 32;
  var MAX_ID = 64;
  var MAX_TITLE = 200;
  var MAX_SHORTCUT = 32;
  var MAX_REASON = 300;
  var MAX_SOURCE = 1048576;
  var MAX_MENU_ITEMS = 8;
  var MAX_PENDING_CALLS = 16;
  var MAX_CLIPBOARD_TEXT = 100000;
  var MAX_PATH = 4096;
  var ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

  var main = window.parent;
  /** 部品の id → { worker, url, ready, commands, menus, pending（実行の番号）, calls（結果待ちの呼び出しの番号）, stopped } */
  var plugins = new Map();

  function toMain(message) {
    message.v = VERSION;
    main.postMessage(message, '*');
  }

  function hasExactKeys(object, required, optional) {
    var keys = Object.keys(object);
    for (var i = 0; i < required.length; i++) if (keys.indexOf(required[i]) < 0) return false;
    for (var j = 0; j < keys.length; j++) if (required.indexOf(keys[j]) < 0 && optional.indexOf(keys[j]) < 0) return false;
    return true;
  }

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isString(value, max) {
    return typeof value === 'string' && value.length >= 1 && value.length <= max;
  }

  /** Worker の中で動く前置き（Function.prototype.toString で文字列にして、部品のコードの前に置く）。この文脈では呼ばない。 */
  function workerPrelude() {
    'use strict';
    var send = self.postMessage.bind(self);
    var commands = new Map();
    var menus = new Map();
    var calls = new Map();
    var nextCall = 1;
    var started = false;
    function checkId(id, what) {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 64) throw new TypeError(what + 'の id は、小文字の英数字とハイフンで 64 文字までにしてください');
    }
    function checkTitle(title, what) {
      if (typeof title !== 'string' || title === '' || title.length > 200) throw new TypeError(what + 'の title は、1 文字以上 200 文字までの文字列にしてください');
    }
    /** 本体の機能を呼ぶ。結果は、本体から result で届く（成功は値、失敗は reject）。 */
    function call(message) {
      if (calls.size >= 16) return Promise.reject(new Error('結果待ちの呼び出しが多すぎます（16 まで）'));
      return new Promise(function (resolve, reject) {
        var number = nextCall++;
        calls.set(number, { resolve: resolve, reject: reject });
        message.kind = 'call';
        message.call = number;
        send(message);
      });
    }
    var api = {
      registerCommand: function (registration) {
        if (started) throw new Error('registerCommand は、部品のコードの最初の実行の間だけ呼べます');
        if (typeof registration !== 'object' || registration === null) throw new TypeError('registerCommand には、オブジェクトを渡してください');
        var id = registration.id;
        var title = registration.title;
        var run = registration.run;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 64) throw new TypeError('コマンドの id は、小文字の英数字とハイフンで 64 文字までにしてください');
        if (typeof title !== 'string' || title === '' || title.length > 200) throw new TypeError('コマンドの title は、1 文字以上 200 文字までの文字列にしてください');
        if (typeof run !== 'function') throw new TypeError('コマンドの run は関数にしてください');
        if (commands.has(id)) throw new Error('コマンド「' + id + '」は登録済みです');
        var message = { kind: 'command', id: id, title: title };
        if (registration.shortcut !== undefined) message.shortcut = registration.shortcut;
        if (registration.ignoreInTextEntry !== undefined) message.ignoreInTextEntry = registration.ignoreInTextEntry;
        commands.set(id, run);
        send(message);
      },
    };
    // R6 の API。api の列挙できる項目は registerCommand だけのまま（R5 の形）で、次の 3 つは列挙されない。どれも、権限（manifest.permissions）が要る:
    // registerContextMenuItem と api.document.currentPath は paths.read、api.clipboard.writeText は clipboard.write。権限の判断は本体が呼び出しのたびに決め、
    // 宣言がない、利用者が拒否した、確認の画面を閉じた、のどれでも、呼び出しの Promise が reject される。
    Object.defineProperty(api, 'registerContextMenuItem', {
      value: function (registration) {
        if (started) throw new Error('registerContextMenuItem は、部品のコードの最初の実行の間だけ呼べます');
        if (typeof registration !== 'object' || registration === null) throw new TypeError('registerContextMenuItem には、オブジェクトを渡してください');
        checkId(registration.id, 'メニューの項目');
        checkTitle(registration.title, 'メニューの項目');
        if (registration.where !== 'tree') throw new TypeError("メニューの項目の where は 'tree' にしてください");
        if (typeof registration.run !== 'function') throw new TypeError('メニューの項目の run は関数にしてください');
        if (menus.has(registration.id)) throw new Error('メニューの項目「' + registration.id + '」は登録済みです');
        if (menus.size >= 8) throw new Error('メニューの項目が多すぎます（8 まで）');
        menus.set(registration.id, registration.run);
        send({ kind: 'menu', id: registration.id, title: registration.title, where: 'tree' });
      },
    });
    Object.defineProperty(api, 'clipboard', {
      value: Object.freeze({
        writeText: function (text) {
          if (typeof text !== 'string' || text === '' || text.length > 100000) return Promise.reject(new TypeError('writeText には、1 文字以上 100000 文字までの文字列を渡してください'));
          return call({ method: 'clipboardWriteText', text: text });
        },
      }),
    });
    Object.defineProperty(api, 'document', {
      value: Object.freeze({
        currentPath: function () {
          return call({ method: 'currentPath' });
        },
      }),
    });
    Object.freeze(api);
    Object.defineProperty(self, 'api', { value: api, enumerable: true });
    self.onmessage = function (event) {
      var message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.kind === 'init') {
        // 部品のコードの最初の実行が終わってから、メッセージが届く（イベントループの順序）。
        started = true;
        send({ kind: 'ready' });
      } else if (message.kind === 'result') {
        var pending = calls.get(message.call);
        if (!pending) return;
        calls.delete(message.call);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(String(message.reason)));
      } else if (message.kind === 'run' || message.kind === 'runMenu') {
        var req = message.req;
        var run = message.kind === 'run' ? commands.get(message.command) : menus.get(message.item);
        var target = message.kind === 'runMenu' ? { path: message.path, kind: message.target } : undefined;
        Promise.resolve()
          .then(function () {
            if (typeof run !== 'function') throw new Error('登録されていないコマンドです');
            return target === undefined ? run() : run(target);
          })
          .then(
            function () {
              send({ kind: 'done', req: req });
            },
            function (error) {
              var reason = String((error && error.message) || error);
              send({ kind: 'failed', req: req, reason: reason.slice(0, 300) || 'error' });
            },
          );
      }
    };
  }

  var PRELUDE = '(' + workerPrelude.toString() + ')();\n';

  /** Worker を止める。以降、その部品のメッセージは何も通さない。 */
  function terminate(id, record) {
    if (record.stopped) return;
    record.stopped = true;
    record.pending.clear();
    record.calls.clear();
    try {
      record.worker.terminate();
    } catch (error) {
      // 止められなかった場合も、以降は何も通さない。
    }
    try {
      URL.revokeObjectURL(record.url);
    } catch (error) {
      // 無視。
    }
  }

  /** 中継を止めたことを本体に知らせる（本体はその部品の登録を外す）。 */
  function stopWithReason(id, record, reason) {
    if (record.stopped) return;
    terminate(id, record);
    toMain({ kind: 'stopped', plugin: id, reason: String(reason).slice(0, MAX_REASON) });
  }

  /** Worker からのメッセージの形の検査。問題があれば理由（文字列）、なければ null。状態も進める。 */
  function check(record, data) {
    if (!isPlainObject(data)) return 'メッセージがオブジェクトではありません';
    switch (data.kind) {
      case 'command': {
        if (record.ready) return '部品のコードの最初の実行のあとに、コマンドを登録しようとしました';
        if (!hasExactKeys(data, ['kind', 'id', 'title'], ['shortcut', 'ignoreInTextEntry'])) return 'command の項目が違います';
        if (!isString(data.id, MAX_ID) || !ID_PATTERN.test(data.id)) return 'command の id が不正です';
        if (!isString(data.title, MAX_TITLE)) return 'command の title が不正です';
        if (data.shortcut !== undefined && !isString(data.shortcut, MAX_SHORTCUT)) return 'command の shortcut が不正です';
        if (data.ignoreInTextEntry !== undefined && typeof data.ignoreInTextEntry !== 'boolean') return 'command の ignoreInTextEntry が不正です';
        if (record.commands.size >= MAX_COMMANDS) return 'コマンドが多すぎます（' + MAX_COMMANDS + ' まで）';
        if (record.commands.has(data.id)) return 'command の id が重なっています';
        record.commands.add(data.id);
        return null;
      }
      case 'menu': {
        if (record.ready) return '部品のコードの最初の実行のあとに、メニューの項目を登録しようとしました';
        if (!hasExactKeys(data, ['kind', 'id', 'title', 'where'], [])) return 'menu の項目が違います';
        if (!isString(data.id, MAX_ID) || !ID_PATTERN.test(data.id)) return 'menu の id が不正です';
        if (!isString(data.title, MAX_TITLE)) return 'menu の title が不正です';
        if (data.where !== 'tree') return 'menu の where が不正です';
        if (record.menus.size >= MAX_MENU_ITEMS) return 'メニューの項目が多すぎます（' + MAX_MENU_ITEMS + ' まで）';
        if (record.menus.has(data.id)) return 'menu の id が重なっています';
        record.menus.add(data.id);
        return null;
      }
      case 'call': {
        if (!Number.isSafeInteger(data.call) || data.call < 1) return 'call の番号が不正です';
        if (data.method === 'clipboardWriteText') {
          if (!hasExactKeys(data, ['kind', 'call', 'method', 'text'], [])) return 'call の項目が違います';
          if (!isString(data.text, MAX_CLIPBOARD_TEXT)) return 'call の text が不正です';
        } else if (data.method === 'currentPath') {
          if (!hasExactKeys(data, ['kind', 'call', 'method'], [])) return 'call の項目が違います';
        } else {
          return 'call の method が決めたものではありません';
        }
        if (record.calls.has(data.call)) return 'call の番号が結果待ちのものと重なっています';
        if (record.calls.size >= MAX_PENDING_CALLS) return '結果待ちの呼び出しが多すぎます（' + MAX_PENDING_CALLS + ' まで）';
        record.calls.add(data.call);
        return null;
      }
      case 'ready':
        if (!hasExactKeys(data, ['kind'], [])) return 'ready の項目が違います';
        if (record.ready) return 'ready を 2 回送りました';
        record.ready = true;
        return null;
      case 'done':
        if (!hasExactKeys(data, ['kind', 'req'], [])) return 'done の項目が違います';
        if (!record.pending.has(data.req)) return '要求していない番号の done です';
        record.pending.delete(data.req);
        return null;
      case 'failed':
        if (!hasExactKeys(data, ['kind', 'req', 'reason'], [])) return 'failed の項目が違います';
        if (!record.pending.has(data.req)) return '要求していない番号の failed です';
        if (!isString(data.reason, MAX_REASON)) return 'failed の reason が不正です';
        record.pending.delete(data.req);
        return null;
      default:
        return '決めていない種類のメッセージです';
    }
  }

  function fromWorker(id, record, data) {
    if (record.stopped) return;
    var problem = check(record, data);
    if (problem !== null) {
      stopWithReason(id, record, '不正なメッセージ: ' + problem);
      return;
    }
    switch (data.kind) {
      case 'command': {
        var out = { kind: 'command', plugin: id, id: data.id, title: data.title };
        if (data.shortcut !== undefined) out.shortcut = data.shortcut;
        if (data.ignoreInTextEntry !== undefined) out.ignoreInTextEntry = data.ignoreInTextEntry;
        toMain(out);
        break;
      }
      case 'menu':
        toMain({ kind: 'menu', plugin: id, id: data.id, title: data.title, where: data.where });
        break;
      case 'call': {
        var out2 = { kind: 'call', plugin: id, call: data.call, method: data.method };
        if (data.method === 'clipboardWriteText') out2.text = data.text;
        toMain(out2);
        break;
      }
      case 'ready':
        toMain({ kind: 'ready', plugin: id });
        break;
      case 'done':
        toMain({ kind: 'done', plugin: id, req: data.req });
        break;
      case 'failed':
        toMain({ kind: 'failed', plugin: id, req: data.req, reason: data.reason });
        break;
    }
  }

  function start(id, source) {
    if (plugins.has(id)) return;
    var record = { worker: null, url: '', ready: false, commands: new Set(), menus: new Set(), pending: new Set(), calls: new Set(), stopped: false };
    plugins.set(id, record);
    try {
      record.url = URL.createObjectURL(new Blob([PRELUDE, source, '\n'], { type: 'text/javascript' }));
      record.worker = new Worker(record.url);
    } catch (error) {
      record.worker = { terminate: function () {} };
      stopWithReason(id, record, 'Worker を作れませんでした: ' + (error && error.message));
      return;
    }
    record.worker.onmessage = function (event) {
      fromWorker(id, record, event.data);
    };
    record.worker.onmessageerror = function () {
      stopWithReason(id, record, '読めないメッセージを受け取りました');
    };
    record.worker.onerror = function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      stopWithReason(id, record, '部品のコードで例外が出ました: ' + ((event && event.message) || 'error'));
    };
    // 部品のコードの最初の実行が終わったあとに処理される（先に届いたメッセージは待たされる）。
    record.worker.postMessage({ kind: 'init' });
  }

  function run(id, req, command) {
    var record = plugins.get(id);
    if (!record || record.stopped || !record.ready || !record.commands.has(command)) return;
    record.pending.add(req);
    record.worker.postMessage({ kind: 'run', req: req, command: command });
  }

  function runMenu(id, req, item, path, targetKind) {
    var record = plugins.get(id);
    if (!record || record.stopped || !record.ready || !record.menus.has(item)) return;
    record.pending.add(req);
    record.worker.postMessage({ kind: 'runMenu', req: req, item: item, path: path, target: targetKind });
  }

  /** 呼び出しの結果を Worker に返す。要求していない番号の結果は通さない。 */
  function result(id, data) {
    var record = plugins.get(id);
    if (!record || record.stopped || !record.calls.has(data.call)) return;
    record.calls.delete(data.call);
    var out = { kind: 'result', call: data.call, ok: data.ok };
    if (data.ok) out.value = data.value;
    else out.reason = data.reason;
    record.worker.postMessage(out);
  }

  /** 本体からのメッセージの形の検査と処理。本体（window.parent）からのものだけを受ける。 */
  function fromMain(data) {
    if (!isPlainObject(data) || data.v !== VERSION) return;
    if (data.kind === 'start') {
      if (!hasExactKeys(data, ['v', 'kind', 'plugin', 'source'], [])) return;
      if (!isString(data.plugin, MAX_ID) || !ID_PATTERN.test(data.plugin) || typeof data.source !== 'string' || data.source.length > MAX_SOURCE) return;
      start(data.plugin, data.source);
    } else if (data.kind === 'run') {
      if (!hasExactKeys(data, ['v', 'kind', 'plugin', 'req', 'command'], [])) return;
      if (!isString(data.plugin, MAX_ID) || !Number.isSafeInteger(data.req) || data.req < 1 || !isString(data.command, MAX_ID)) return;
      run(data.plugin, data.req, data.command);
    } else if (data.kind === 'runMenu') {
      if (!hasExactKeys(data, ['v', 'kind', 'plugin', 'req', 'item', 'path', 'targetKind'], [])) return;
      if (!isString(data.plugin, MAX_ID) || !Number.isSafeInteger(data.req) || data.req < 1 || !isString(data.item, MAX_ID)) return;
      if (!isString(data.path, MAX_PATH) || (data.targetKind !== 'file' && data.targetKind !== 'folder')) return;
      runMenu(data.plugin, data.req, data.item, data.path, data.targetKind);
    } else if (data.kind === 'result') {
      if (!hasExactKeys(data, ['v', 'kind', 'plugin', 'call', 'ok'], ['value', 'reason'])) return;
      if (!isString(data.plugin, MAX_ID) || !Number.isSafeInteger(data.call) || data.call < 1 || typeof data.ok !== 'boolean') return;
      if (data.ok) {
        if (!('value' in data) || 'reason' in data) return;
        if (data.value !== null && !isString(data.value, MAX_PATH)) return;
      } else if ('value' in data || !isString(data.reason, MAX_REASON)) {
        return;
      }
      result(data.plugin, data);
    } else if (data.kind === 'stop') {
      if (!hasExactKeys(data, ['v', 'kind', 'plugin'], [])) return;
      var record = plugins.get(data.plugin);
      if (record) terminate(data.plugin, record);
    }
  }

  window.addEventListener('message', function (event) {
    // 送り元が本体の窓であることを確かめる（origin は不透明で、判定に使えない）。
    if (event.source !== main) return;
    fromMain(event.data);
  });

  toMain({ kind: 'hello' });
})();
