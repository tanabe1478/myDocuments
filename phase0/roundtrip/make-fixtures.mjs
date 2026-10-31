#!/usr/bin/env node
// Writes the round-trip fixtures to phase0/fixtures/*.md with exact bytes
// (CRLF and BOM are byte-sensitive, so they are generated, not hand-edited).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
mkdirSync(out, { recursive: true });

const lf = `# Plain LF document

First paragraph with *emphasis*, **strong text** and \`inline code\`.

- item one
- item two
  - nested item

1. ordered one
2. ordered two

> a block quote

Last line with trailing newline.
`;

const japanese = `# 日本語の文書

吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。

何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。

- 全角スペース　を含む行
- 半角カナ ｱｲｳｴｵ と絵文字 😀 と結合文字 が゛

「かぎ括弧」と『二重かぎ括弧』、そして——ダッシュ…三点リーダ。

[リンク](https://example.com/日本語/パス) と ![画像](img/猫.png)
`;

const frontmatter = `---
title: "フロントマター付き"
tags: [a, b, c]
date: 2026-10-31
nested:
  key: value
---

# 本文

frontmatter の直後の段落。
`;

const table = `# Table

| 項目 | 値 | 備考 |
|:-----|---:|:----:|
| a    |  1 | left |
| いろは | 22 | 中央 |
| \`code\` | 333 | a \\| b |

after table.
`;

const code = `# Code

\`\`\`ts
function add(a: number, b: number): number {
  return a + b;   // trailing spaces below
}
\`\`\`

    indented code block

~~~python
print("tilde fence")
~~~

\`\`\`
no language
\`\`\`
`;

const linkdefs = `# Link reference definitions

See [the spec][spec] and [another one][Other Ref] and the shortcut [shortcut].

[spec]: https://spec.commonmark.org/ "CommonMark Spec"
[Other Ref]: <https://example.com/a b> 'single quoted title'
[shortcut]: https://example.com/shortcut
`;

const html = `# HTML block

<div class="note" data-x="1">
  <p>raw <b>html</b> block</p>
</div>

<!-- an html comment -->

<details>
<summary>more</summary>

hidden *markdown* inside

</details>

paragraph with inline <span style="color:red">html</span>.
`;

const toCRLF = (s) => s.replace(/\n/g, '\r\n');
const BOM = '﻿';

const files = {
  'lf.md': lf,
  'crlf.md': toCRLF(lf),
  'bom-lf.md': BOM + lf,
  'bom-crlf-japanese.md': BOM + toCRLF(japanese),
  'japanese.md': japanese,
  'frontmatter.md': frontmatter,
  'table.md': table,
  'codeblock.md': code,
  'linkdefs.md': linkdefs,
  'htmlblock.md': html,
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(resolve(out, name), Buffer.from(text, 'utf8'));
}
console.log('wrote', Object.keys(files).length, 'fixtures to', out);
