"use strict";
/* data/latest.json から公開ページ data.html を生成する
 *
 * なぜ生成するのか:
 *   JSONを fetch して JavaScript で描画すると、AIクローラーには数字が見えない。
 *   ai-visible 自身が「本文がHTMLに存在するか」に20点を配点している以上、
 *   自分のデータページがその項目で落ちるわけにいかない。数字はHTMLに焼き込む。
 *
 * 出力するのは分布の数字だけ。個別のサイト名・URLは1つも含めない（制約1）。
 */

const fs = require("fs");

const d = JSON.parse(fs.readFileSync(__dirname + "/../data/latest.json", "utf8"));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = v => (v === null || v === undefined) ? "—" : `${v}%`;

/* AIクローラーを、それが誰のものかと一緒に並べる（遮断率の高い順） */
const OWNER = {
  GPTBot: "OpenAI（学習・検索）", "OAI-SearchBot": "ChatGPT検索", "ChatGPT-User": "ChatGPTの閲覧",
  ClaudeBot: "Anthropic", "anthropic-ai": "Anthropic", "Claude-Web": "Anthropic",
  PerplexityBot: "Perplexity", "Perplexity-User": "Perplexityの閲覧",
  "Google-Extended": "Google（Gemini向け）", "Applebot-Extended": "Apple",
  CCBot: "Common Crawl（多くのAIの学習元）", Amazonbot: "Amazon", "meta-externalagent": "Meta",
};
const bots = Object.entries(d.blockedByBot || {})
  .sort((a, b) => b[1] - a[1])
  .map(([ua, v]) => `<tr><td><code>${esc(ua)}</code></td><td>${esc(OWNER[ua] || "")}</td><td class="n">${pct(v)}</td></tr>`)
  .join("\n      ");

const ld = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "日本の主要サイトのAI可読性 実測データ",
  description: `日本の主要サイト${d.nRobots}件を対象に、AIクローラーの遮断状況とAI可読性を機械的に測定した集計データ。個別のサイト名は公開しない。`,
  temporalCoverage: d.observedAt,
  dateModified: d.observedAt,
  license: "https://opensource.org/licenses/MIT",
  creator: { "@type": "Organization", name: "AIから見えていますか" },
  measurementTechnique: "robots.txt の RFC 9309 準拠パースと、HTMLの静的解析による決定的判定",
  variableMeasured: [
    { "@type": "PropertyValue", name: "AIクローラー遮断率", value: d.blockedAny, unitText: "PERCENT" },
    { "@type": "PropertyValue", name: "AI可読性スコア中央値", value: d.score ? d.score.median : null },
    { "@type": "PropertyValue", name: "llms.txt 設置率", value: d.hasLlmsTxt, unitText: "PERCENT" },
  ],
};

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>日本の主要サイトのAI可読性 実測データ（${esc(d.observedAt)}時点）</title>
<meta name="description" content="日本の主要サイト${d.nRobots}件を実測。AIクローラーの遮断率は${pct(d.blockedAny)}、AI可読性スコアの中央値は${d.score ? d.score.median : "—"}点、llms.txt の設置率は${pct(d.hasLlmsTxt)}。毎週更新の独自調査データ。">
<link rel="canonical" href="https://kakakakakazu.github.io/ai-visible/data.html">
<meta property="og:title" content="日本の主要サイトのAI可読性 実測データ">
<meta property="og:description" content="${d.nRobots}件を実測。AIクローラー遮断率${pct(d.blockedAny)}、スコア中央値${d.score ? d.score.median : "—"}点、llms.txt設置率${pct(d.hasLlmsTxt)}。">
<meta property="og:type" content="article">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
<style>
  :root{--bg:#0f1115;--fg:#e8eaed;--dim:#9aa3ad;--line:#242832;--card:#161922;--ac:#5b9cff}
  @media(prefers-color-scheme:light){:root{--bg:#fff;--fg:#1a1d23;--dim:#5d6772;--line:#e3e6ec;--card:#f7f8fa;--ac:#2563eb}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
  main{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:clamp(24px,4.5vw,34px);line-height:1.3;letter-spacing:-.02em;margin:0 0 8px}
  h2{font-size:19px;margin:40px 0 12px;padding-top:20px;border-top:1px solid var(--line)}
  h3{font-size:15.5px;margin:24px 0 6px}
  .meta{color:var(--dim);font-size:13.5px;margin-bottom:28px}
  .lead{font-size:17px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14.5px;display:block;overflow-x:auto}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--dim);font-weight:600;font-size:13px}
  td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}
  code{background:var(--card);padding:2px 6px;border-radius:5px;font-size:13px}
  .big{font-size:15px}
  .big strong{font-size:26px;font-variant-numeric:tabular-nums}
  p.note{color:var(--dim);font-size:13.5px}
  a{color:var(--ac)}
  footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
</style>
</head>
<body>
<main>
<article>

  <h1>日本の主要サイトのAI可読性 実測データ</h1>
  <p class="meta">最終更新 <time datetime="${esc(d.observedAt)}">${esc(d.observedAt)}</time>｜対象 ${d.nRobots}サイト｜毎週自動更新</p>

  <p class="lead">日本の主要サイト <strong>${d.nRobots}件</strong> を機械的に測定したところ、
  <strong>${pct(d.blockedAny)}</strong> が何らかのAIクローラーを robots.txt で遮断しており、
  AI可読性スコアの中央値は <strong>${d.score ? d.score.median : "—"}点</strong>（100点満点）でした。
  <strong>llms.txt を設置していたサイトは ${pct(d.hasLlmsTxt)}</strong> です。</p>

  <h2>この調査とは</h2>
  <p>検索した人の多くがサイトを訪れずAIの回答で済ませる時代に、
  「自分のサイトがAIから読めているか」を答えられる公開データが日本語圏に存在しませんでした。
  そこで主要サイトを定点観測し、<strong>分布だけ</strong>を公開しています。
  <strong>個別のサイト名・URL・個別スコアは一切公開しません。</strong>順位をつけることが目的ではないためです。</p>

  <h2>結果</h2>

  <h3>AIクローラーの遮断</h3>
  <p class="big">何らかのAIクローラーを遮断しているサイト … <strong>${pct(d.blockedAny)}</strong>（${d.nRobots}件中）</p>
  <table>
    <thead><tr><th>User-agent</th><th>誰のクローラーか</th><th>遮断率</th></tr></thead>
    <tbody>
      ${bots}
    </tbody>
  </table>
  <p class="note">robots.txt を RFC 9309 に従って解析し、<code>Disallow: /</code> による全体禁止のみを遮断と数えています。
  専用の User-agent ブロックがある場合はワイルドカードより優先します。</p>

  <h3>AI可読性スコアの分布</h3>
  <table>
    <thead><tr><th>指標</th><th>値</th></tr></thead>
    <tbody>
      <tr><td>中央値</td><td class="n">${d.score ? d.score.median : "—"}</td></tr>
      <tr><td>第1四分位（下位25%の境界）</td><td class="n">${d.score ? d.score.p25 : "—"}</td></tr>
      <tr><td>第3四分位（上位25%の境界）</td><td class="n">${d.score ? d.score.p75 : "—"}</td></tr>
      <tr><td>最低</td><td class="n">${d.score ? d.score.min : "—"}</td></tr>
      <tr><td>最高</td><td class="n">${d.score ? d.score.max : "—"}</td></tr>
    </tbody>
  </table>

  <h3>項目別の実施率</h3>
  <table>
    <thead><tr><th>項目</th><th>該当率</th></tr></thead>
    <tbody>
      <tr><td><strong>AIには空ページに見える</strong>（本文がHTMLに無い）</td><td class="n">${pct(d.invisibleToAI)}</td></tr>
      <tr><td>構造化データ（JSON-LD）がある</td><td class="n">${pct(d.hasStructuredData)}</td></tr>
      <tr><td>一次情報・公的な出典へリンクしている</td><td class="n">${pct(d.hasAuthoritativeLinks)}</td></tr>
      <tr><td>更新日時が機械可読になっている</td><td class="n">${pct(d.hasMachineReadableDate)}</td></tr>
      <tr><td>sitemap.xml がある</td><td class="n">${pct(d.hasSitemap)}</td></tr>
      <tr><td><strong>llms.txt がある</strong></td><td class="n">${pct(d.hasLlmsTxt)}</td></tr>
      <tr><td>意味を持つHTML要素が不足している</td><td class="n">${pct(d.poorSemantics)}</td></tr>
      <tr><td>外部リンクが1本もない</td><td class="n">${pct(d.noExternalLinks)}</td></tr>
    </tbody>
  </table>
  <p class="note">1ページあたりの数値表現は中央値 ${d.statsPerPage ? d.statsPerPage.median : "—"}箇所、
  HTMLに含まれる本文の長さは中央値 ${d.bodyLength ? d.bodyLength.median.toLocaleString() : "—"}字でした。</p>

  <h2>方法</h2>
  <p>各サイトのトップページ・<code>robots.txt</code>・<code>llms.txt</code>・<code>sitemap.xml</code> を取得し、
  決定的なルールのみで判定しています。<strong>生成AIによる判断は一切使っていません</strong>（再現性のため）。
  判定ロジックは診断ツール本体と同一のファイルを共有しており、同じ入力には必ず同じ点数が出ます。</p>
  <p>巡回は robots.txt を尊重します。全クローラーを拒否しているサイトについては
  <strong>本文を取得せず、robots.txt に書かれた遮断状況のみを集計</strong>しています。
  「AIを拒否しているサイトほど測定から漏れる」という選択バイアスを避けるためです。
  そのため遮断率は ${d.nRobots}件全部から、本文由来の項目は ${d.nFull}件から算出しています。</p>
  <p class="note">今回、取得できなかったサイトが ${d.failed}件ありました（接続失敗またはアクセス拒否）。</p>

  <h2>よくある質問</h2>

  <h3>なぜサイト名を公開しないのですか</h3>
  <p>順位をつけることが目的ではないからです。知りたいのは「どこがダメか」ではなく「全体でどのくらい起きているか」で、
  個別名はその答えに必要ありません。</p>

  <h3>スコアの配点は何を根拠にしていますか</h3>
  <p>出典の明記と統計の記載を重く見ています。これは KDD 2024 で発表された査読論文
  <a href="https://dl.acm.org/doi/10.1145/3637528.3671900">GEO: Generative Engine Optimization</a>（プリンストン大学ほか）の測定結果に基づき、
  出典の明記で生成エンジンでの可視性が約40%、統計の追加で約37%向上したと報告されているためです。</p>

  <h3>llms.txt の設置率が低いのは問題ですか</h3>
  <p>必ずしもそうとは言えません。AIボットの訪問のうち <a href="https://llmstxt.org/">llms.txt</a> が実際に取得されるのは0.1%程度という実測があり、
  主要クローラーはHTMLを直接読む傾向があります。本調査の診断でも llms.txt の配点は100点中1点です。</p>

  <h3>データは自由に使えますか</h3>
  <p>使えます。MITライセンスです。引用の際はこのページへのリンクを添えてください。</p>

  <h2>まとめ</h2>
  <ul>
    <li>日本の主要 ${d.nRobots}サイトのうち <strong>${pct(d.blockedAny)}</strong> がAIクローラーを遮断している</li>
    <li>AI可読性スコアの中央値は <strong>${d.score ? d.score.median : "—"}点</strong>、最低は <strong>${d.score ? d.score.min : "—"}点</strong></li>
    <li><strong>${pct(d.invisibleToAI)}</strong> のサイトは本文がHTMLに無く、AIには空ページに見えている</li>
    <li>llms.txt の設置率は <strong>${pct(d.hasLlmsTxt)}</strong>、構造化データは <strong>${pct(d.hasStructuredData)}</strong></li>
  </ul>

  <footer>
    <p>調査・公開: <a href="./">AIから見えていますか</a>（無料のAI可読性診断ツール）。
    自分のサイトを同じ基準で測れます。データはMITライセンス。</p>
    <p>参照: <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309</a>｜
    <a href="https://schema.org/Dataset">schema.org</a>｜
    <a href="https://dl.acm.org/doi/10.1145/3637528.3671900">GEO (KDD 2024)</a></p>
  </footer>

</article>
</main>
</body>
</html>
`;

fs.writeFileSync(__dirname + "/../data.html", html);
console.log(`data.html を生成しました（${d.observedAt} 時点、${d.nRobots}サイト）`);

/* ============ X への投稿文を生成する ============
 *
 * 拡散は raffy 本人が手で投稿する（制約5、2026-08-10 復活）。
 * X API は 2026-02-06 に無料枠が廃止され、リンク付き投稿は1件 $0.20 かかるため使わない。
 *
 * ここでの責務は「考えずにコピペできる完成形を渡すこと」。毎週データが変わるので、
 * 毎週新しい数字で投稿できる。文面を人間が組み立て直す必要がない状態にする。
 *
 * 文字数: X は全角を2、URLを一律23としてカウントし、上限は280。つまり日本語なら
 * 実質128文字＋URLが上限になる。生成時に実測して、超えていれば警告する。
 */
function xLength(s) {
  // URL は実際の長さに関わらず23文字として数えられる
  const withoutUrls = s.replace(/https?:\/\/\S+/g, "");
  const urlCount = (s.match(/https?:\/\/\S+/g) || []).length;
  let n = 0;
  for (const ch of withoutUrls) n += /[\x00-\x7F｡-ﾟ]/.test(ch) ? 1 : 2;
  return n + urlCount * 23;
}

const SITE = "https://kakakakakazu.github.io/ai-visible/";
const DATA = "https://kakakakakazu.github.io/ai-visible/data.html";
const CERT = "https://kakakakakazu.github.io/ai-visible/certified.html";
const MAIL = "https://kakakakakazu.github.io/mail-visible/";

const posts = [
  {
    label: "実測データ（毎週数字が変わるので使い回せます）",
    text: `日本の主要${d.nRobots}サイトのAI可読性を実測しました。

・AIクローラーを遮断 ${pct(d.blockedAny)}
・AIには空ページに見える ${pct(d.invisibleToAI)}
・llms.txt 設置率 ${pct(d.hasLlmsTxt)}
・可読性スコア中央値 ${d.score ? d.score.median : "—"}点（最低${d.score ? d.score.min : "—"}点）

毎週自動更新しています
${DATA}`,
  },
  {
    label: "診断ツールの紹介",
    text: `サイトのHTMLを貼るだけで、ChatGPTやClaudeから中身が読めているかを100点満点で診断するツールを作りました。

サーバーに何も送らず、全部ブラウザ内で処理します。無料・登録不要。
修正用の llms.txt や JSON-LD もその場で生成します。

${SITE}`,
  },
  {
    label: "メール診断ツールの紹介",
    text: `ドメイン名を入れるだけで、SPF / DKIM / DMARC の設定を100点満点で診断するツールを作りました。

2024年2月からGmailとYahooが一括送信者にDMARCを求めています。

サーバーを持たず、ブラウザから直接DNSを引いています。無料・登録不要。
${MAIL}`,
  },
  {
    label: "認証の紹介",
    text: `AIから読める状態にあることを機械的に検証する認証を作りました。無料です。

既存のWeb認証が高額なのは審査員の人件費が原価だからで、機械で判定できる領域ならその原価は出ません。

判定コードは公開。毎週自動で再検証し、基準を割れば失効します。

${CERT}`,
  },
  {
    label: "一番刺さりやすい単発（数字ひとつに絞る）",
    text: `日本の主要サイトを実測したところ、${pct(d.invisibleToAI)}が「AIから見ると本文が空」の状態でした。

JavaScriptで本文を描画していると、多くのAIクローラーは実行しないので何も読めません。検索には出るのに、AIの回答には出てこない状態になります。

${DATA}`,
  },
];

const postFile = posts.map(p => {
  const n = xLength(p.text);
  const warn = n > 280 ? `  ⚠️ ${n - 280}文字オーバー。短くしてください` : `  （${n}/280）`;
  return `── ${p.label}${warn}\n\n${p.text}\n`;
}).join("\n" + "─".repeat(60) + "\n\n");

fs.writeFileSync(__dirname + "/../data/post.txt",
  `X 投稿用の下書き（${d.observedAt} 時点のデータで自動生成）\n` +
  `そのままコピペできます。上から順に使う必要はありません。\n\n` +
  "─".repeat(60) + "\n\n" + postFile);

const over = posts.filter(p => xLength(p.text) > 280).length;
console.log(`data/post.txt を生成しました（${posts.length}本${over ? `、うち${over}本が文字数超過` : "、全て文字数内"}）`);
