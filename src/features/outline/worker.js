/*
 * 「アウトライン」の、Worker で動くコード（段 2。ADR-005 の R7）。クラシックスクリプトで、?raw で文字列として読み込まれ、
 * 隔離した iframe の中の Worker の中でだけ動く（ホストの空間では評価されない）。Worker のグローバルに、公開 API の `api` がある。
 *
 * 使う権限（manifest.permissions）: document.read（開いている文書の本文とカーソルの位置を受け取る。宣言だけで使える）。
 * やること: Markdown の ATX 見出し（# から ######）を数え、パネルに項目として送る。カーソルのある節を current として示す。
 * 描くのは本体で、この部品は文字列、深さ、本文の中の位置を送るだけ。カーソルは動かせない（項目を押したときの移動は本体が行う）。
 *
 * 数える見出し（CommonMark の ATX 見出しの規則の範囲）:
 * - 行頭の空白は 3 つまで。# は 1〜6 個。# のあとは空白（スペースかタブ）か行末。閉じの # の並び（前に空白がある）は、文字に含めない。
 * - フェンスのコードブロック（``` と ~~~）の中は数えない。先頭の front matter（--- で囲んだ部分）の中も数えない。
 * - 数えないもの: setext 見出し（下線の = と -）、引用やリストの項目の中のコードブロック（コンテナの中のフェンスは追わない）、
 *   中身が空の見出し、見出しの文字の中の強調やリンクの記号の処理（書かれたままの文字で出す）。
 * 項目は先頭から 1000 件まで（上限を超えると本体が部品を止めるので、ここで切る）。本文の位置は、見出しの行の先頭（UTF-16 のオフセット）。
 */
(function () {
  'use strict';

  var MAX_ITEMS = 1000;
  var MAX_TEXT = 200;
  var EMPTY_TEXT = '見出しはありません';
  var FRONT_MATTER_DELIMITER = /^---\s*$/;

  /** 1 行（改行を除く）が ATX 見出しなら { level, text }、そうでなければ null。 */
  function parseAtx(line) {
    var i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    if (line.charCodeAt(i) !== 35) return null;
    var j = i;
    while (line.charCodeAt(j) === 35) j++;
    var level = j - i;
    if (level > 6) return null;
    var after = line.charCodeAt(j);
    if (j < line.length && after !== 32 && after !== 9) return null;
    var content = line.slice(j).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    // 閉じの # の並び: 前に空白がある（または、中身が # だけ）ものは、文字に含めない。
    content = content.replace(/(^|[ \t]+)#+$/, '').replace(/[ \t]+$/, '');
    if (content === '') return null;
    if (content.length > MAX_TEXT) {
      var cut = MAX_TEXT - 1;
      var code = content.charCodeAt(cut - 1);
      // 切る位置がサロゲートペアの間にならないようにする。
      if (code >= 0xd800 && code <= 0xdbff) cut--;
      content = content.slice(0, cut) + '…';
    }
    return { level: level, text: content };
  }

  /** フェンスの開始の行なら { char, length }、そうでなければ null。 */
  function parseFenceOpen(line) {
    var i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    var c = line.charCodeAt(i);
    if (c !== 96 && c !== 126) return null;
    var j = i;
    while (line.charCodeAt(j) === c) j++;
    if (j - i < 3) return null;
    // バッククォートのフェンスの info string には、バッククォートを含められない。
    if (c === 96 && line.indexOf('`', j) >= 0) return null;
    return { char: c, length: j - i };
  }

  /** フェンスの終わりの行か（開始と同じ文字で、同じかそれ以上の長さ。あとは空白だけ）。 */
  function isFenceClose(line, fence) {
    var i = 0;
    while (i < 3 && line.charCodeAt(i) === 32) i++;
    if (line.charCodeAt(i) !== fence.char) return false;
    var j = i;
    while (line.charCodeAt(j) === fence.char) j++;
    if (j - i < fence.length) return false;
    return /^[ \t]*$/.test(line.slice(j));
  }

  /** 次の行の先頭の位置（改行がなければ text.length + 1）。 */
  function nextLineStart(text, from) {
    var nl = text.indexOf('\n', from);
    return nl < 0 ? text.length + 1 : nl + 1;
  }

  function lineAt(text, from) {
    var nl = text.indexOf('\n', from);
    var line = nl < 0 ? text.slice(from) : text.slice(from, nl);
    // CRLF のまま届いても、行末の CR は見出しの文字に含めない。
    return line.charCodeAt(line.length - 1) === 13 ? line.slice(0, line.length - 1) : line;
  }

  /** 本文から見出しの一覧を作る。{ text, depth, offset }（depth は # の数 - 1）。 */
  function extractHeadings(text) {
    var items = [];
    var pos = 0;
    // 先頭の front matter（1 行目の --- から、次の --- まで。閉じがなければ front matter ではない）。
    if (FRONT_MATTER_DELIMITER.test(lineAt(text, 0))) {
      var scan = nextLineStart(text, 0);
      while (scan <= text.length) {
        if (FRONT_MATTER_DELIMITER.test(lineAt(text, scan))) {
          pos = nextLineStart(text, scan);
          break;
        }
        scan = nextLineStart(text, scan);
      }
    }
    var fence = null;
    while (pos <= text.length && items.length < MAX_ITEMS) {
      var line = lineAt(text, pos);
      if (fence !== null) {
        if (isFenceClose(line, fence)) fence = null;
      } else {
        var opened = parseFenceOpen(line);
        if (opened !== null) {
          fence = opened;
        } else {
          var heading = parseAtx(line);
          if (heading !== null) items.push({ text: heading.text, depth: heading.level - 1, offset: pos });
        }
      }
      pos = nextLineStart(text, pos);
    }
    return items;
  }

  /** カーソルのある節: 位置より前（同じ行を含む）にある、最後の見出しの番号。なければ null。 */
  function currentIndex(items, head) {
    var found = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].offset <= head) found = i;
      else break;
    }
    return found;
  }

  function sameItems(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].text !== b[i].text || a[i].depth !== b[i].depth || a[i].offset !== b[i].offset) return false;
    }
    return true;
  }

  var panel = api.registerPanel({ id: 'outline', title: 'アウトライン' });

  var items = [];
  /** 見出しを数えた本文の版。まだ本文を受け取っていないときは null。 */
  var version = null;
  var head = 0;
  var sent = null;
  var timer = null;

  /** 項目と強調の位置を送る。同じ内容は送らない。1 回の変化を、まとめて 1 回で送る。 */
  function flush() {
    timer = null;
    if (version === null) return;
    var current = currentIndex(items, head);
    if (sent !== null && sent.version === version && sent.current === current && sameItems(sent.items, items)) return;
    sent = { version: version, current: current, items: items };
    panel.setItems(items, { version: version, current: current, emptyText: EMPTY_TEXT });
  }

  function schedule() {
    if (timer === null) timer = setTimeout(flush, 0);
  }

  api.document.onDidChange(function (document) {
    // 素のテキストでは、見出しを数えない（項目なし。文言は「見出しはありません」）。
    items = document.kind === 'markdown' ? extractHeadings(document.text) : [];
    version = document.version;
    schedule();
  });

  api.document.onDidChangeSelection(function (selection) {
    head = selection.head;
    schedule();
  });
})();
