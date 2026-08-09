"use strict";
/* AI可読 認証 AIV-1 — 判定と発行
 *
 * 認証機関の実体はこのファイルと data/certified.json だけ。審査員を持たず、
 * 判定は engine.js の決定的ルールのみで行う。だから原価がゼロで、個人でも運営できる。
 *
 * 信頼の担保は「権威」ではなく「透明性と再現性」に置く（Common Criteria と同じ構造）。
 *   - 基準はこのファイルに数値で書いてあり、誰でも読める
 *   - 判定コードは公開されていて、誰でも同じ結果を再現できる
 *   - 巡回は毎週自動で走り、基準を割ったサイトは自動的に失効する
 *
 * 制約:
 *   人に順位をつけない（制約1）— 個別スコアは保存も公開もしない。合格の事実と日付だけを持つ。
 *                              一覧はドメイン名順で、成績順に並べない。
 *   不安で売らない（制約2）— 不合格だったサイトは記録も公開もしない。
 *   原価ゼロ（制約9）— 実行時にLLM APIを呼ばない。GitHub Actions と静的配信のみ。
 */

const fs = require("fs");
const path = require("path");
const { inspect } = require("./crawl.cjs");

/* ============ 基準 ============
 * 数値の根拠（2026-08-09 の実測24サイトによる）:
 *   minScore 80 — スコア分布は中央値76・p75=82。80点は上位25%圏にあたり、
 *                 「達成できるが自動的には通らない」水準になる。基準が緩いと認証の意味が消え、
 *                 厳しすぎると誰も取れない。実測分布に置くのが唯一の客観的な決め方。
 *   遮断ゼロ・本文がHTMLにある — engine.js が28点と20点を配している2項目。
 *                 「そもそもAIが中身に到達できるか」であり、ここが欠けたら他が満点でも意味がない。
 *                 スコアだけを条件にすると、この2つが欠けたまま他項目で80点に達しうるため別立てにする。
 */
const STANDARD = {
  id: "AIV-1",
  name: "AI可読 認証",
  minScore: 80,
  established: "2026-08-09",
  requirements: [
    "主要なAIクローラーを robots.txt で全面的に遮断していないこと",
    "ページの本文がHTMLに直接含まれていること（JavaScript実行なしで読めること）",
    "AI可読性スコアが100点満点中80点以上であること",
  ],
};

/* 取得できなかっただけの認証を即座に失効させると、相手側の一時的な障害でバッジが消える。
   逆に無期限に据え置くと「今も満たしている」という認証の中身が失われる。README で公開している
   とおり、判定不能な状態が30日続いた時点で失効させる。 */
const GRACE_DAYS = 30;

/**
 * 認証基準を満たすかを判定する。
 * @param {object} r crawl.cjs の inspect() が返した観測結果
 * @returns {{pass: boolean, undetermined: boolean, reason: string}}
 *   undetermined … 相手側の事情で判定できなかった状態。明確な不合格とは区別し、猶予の対象にする。
 */
function evaluate(r) {
  if (r.skipped) return { pass: false, undetermined: true, reason: "巡回を拒否されているため判定できません" };
  if (r.failed)  return { pass: false, undetermined: true, reason: `ページを取得できません（HTTP ${r.status}）` };
  if (!r.full && !r.robotsOnly) return { pass: false, undetermined: true, reason: "判定に必要な情報を取得できません" };

  // 全クローラー拒否は相手の明示的な意思表示であり、障害ではない。猶予の対象にしない。
  if (r.robotsOnly) return { pass: false, undetermined: false, reason: "全クローラーを拒否しているため本文を判定できません" };

  if (r.blocked.length > 0) return { pass: false, undetermined: false, reason: `${r.blocked.length}種類のAIクローラーを遮断しています` };
  if (r.spa)                return { pass: false, undetermined: false, reason: "本文がHTMLに含まれていません" };
  if (r.score < STANDARD.minScore) return { pass: false, undetermined: false, reason: `スコアが基準（${STANDARD.minScore}点）に達していません` };

  return { pass: true, undetermined: false, reason: "" };
}

/** 判定不能だった認証を、猶予期間内として据え置いてよいか */
function withinGrace(entry, today) {
  const days = (Date.parse(today) - Date.parse(entry.lastVerified)) / 86400000;
  return Number.isFinite(days) && days <= GRACE_DAYS;
}

/* 申請URLは第三者が出してくる値であり、そのまま認証ページの <a href> に出る。
   HTMLエスケープだけでは防げない: javascript:alert(1) は & < > " を1つも含まないため
   esc() を素通りし、認証ページのオリジンでスクリプトが動く（格納型XSS）。
   スキームとホスト名を検証して、http/https の実在しうるURLだけを通す。
   @returns {string|null} 正規化したURL。安全でなければ null */
function safeOrigin(u) {
  let p;
  try {
    p = new URL(String(u).trim());
  } catch (e) {
    return null;                                  // URLとして解釈できない
  }
  if (p.protocol !== "https:" && p.protocol !== "http:") return null;   // javascript: data: file: を排除
  if (!p.hostname || !p.hostname.includes(".")) return null;            // ホスト名の体を成さないもの
  if (p.username || p.password) return null;                            // https://user:pass@evil の偽装
  const path = p.pathname.replace(/\/+$/, "");
  return p.origin + path;
}

/* ============ 発行 ============ */

const ROOT = path.join(__dirname, "..");
const LIST = path.join(ROOT, "data", "certified.json");

function loadPrevious() {
  try {
    return JSON.parse(fs.readFileSync(LIST, "utf8"));
  } catch (e) {
    // 初回は存在しない。それ以外の読み取り失敗も、空から作り直せば実害がないので同じ扱いにする。
    if (e.code !== "ENOENT") console.warn(`既存の認証リストを読めませんでした（${e.message}）。空から作り直します。`);
    return { standard: STANDARD.id, certified: [] };
  }
}

async function main() {
  const applicants = JSON.parse(fs.readFileSync(path.join(__dirname, "applicants.json"), "utf8"));

  // 申請は第三者が出してくる。巡回にかける前に、安全なURLだけに絞る
  const origins = [];
  for (const raw of applicants.origins) {
    const s = safeOrigin(raw);
    if (s) origins.push(s);
    else console.log(`SKIP  ${raw} — URLとして安全でないため除外しました`);
  }

  const prev = loadPrevious();
  const prevBy = new Map((prev.certified || []).map(c => [c.origin, c]));
  const today = new Date().toISOString().slice(0, 10);

  const certified = [];
  const revoked = [];

  for (const origin of origins) {
    let v;
    try {
      v = evaluate(await inspect(origin));
    } catch (e) {
      v = { pass: false, undetermined: true, reason: `巡回中にエラーが発生しました（${e.message}）` };
    }

    const before = prevBy.get(origin);

    if (v.pass) {
      certified.push({
        origin,
        since: before ? before.since : today,     // 初回認証日は引き継ぐ
        lastVerified: today,                      // 「今も満たしている」ことの証跡
      });
      console.log(`PASS  ${origin}${before ? "" : "  ← 新規"}`);
      continue;
    }

    // 判定できなかっただけなら、猶予期間内は前回の認証を据え置く。lastVerified は更新しない
    // （更新すると確認していない日を確認したことにしてしまい、猶予が無限に伸びる）。
    if (v.undetermined && before) {
      if (withinGrace(before, today)) {
        certified.push(before);
        console.log(`HOLD  ${origin} — ${v.reason}（最終確認 ${before.lastVerified}、猶予${GRACE_DAYS}日以内のため据え置き）`);
      } else {
        revoked.push({ origin, reason: `${GRACE_DAYS}日以上確認できませんでした（最終確認 ${before.lastVerified}）` });
        console.log(`LOST  ${origin} — ${GRACE_DAYS}日以上確認できず失効`);
      }
      continue;
    }

    if (before) revoked.push({ origin, reason: v.reason });
    console.log(`--    ${origin} — ${v.reason}`);
  }

  // 制約1: 成績順に並べない。ドメイン名順で、順位が生まれない並びにする。
  certified.sort((a, b) => a.origin.localeCompare(b.origin));

  const out = {
    standard: STANDARD.id,
    standardName: STANDARD.name,
    minScore: STANDARD.minScore,
    updatedAt: today,
    count: certified.length,
    note: "個別のスコアは保存も公開もしていません。順位をつけることが目的ではないためです。",
    certified,
  };
  fs.mkdirSync(path.dirname(LIST), { recursive: true });
  fs.writeFileSync(LIST, JSON.stringify(out, null, 2) + "\n");

  renderPage(out);

  if (revoked.length) {
    console.log("\n失効:");
    revoked.forEach(r => console.log(`  ${r.origin} — ${r.reason}`));
  }
  console.log(`\n認証 ${certified.length}件 / 申請 ${origins.length}件（除外 ${applicants.origins.length - origins.length}件） → data/certified.json, certified.html`);
  return out;
}

/* ============ 認証ページの生成 ============
 * data.html と同じ理由で静的に焼き込む。JSONを fetch して描画すると、
 * 自分の配点「本文がHTMLに存在するか」20点で自分が落ちる。
 * このページは認証の正当性を確認する場所なので、AIから読めない状態は矛盾になる。 */
function renderPage(d) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const BADGE = "https://kakakakakazu.github.io/ai-visible/badge.svg";
  const PAGE = "https://kakakakakazu.github.io/ai-visible/certified.html";
  // 申請と削除依頼の窓口。認証を名乗る以上、連絡手段が無いのは筋が通らない
  const ISSUES = "https://github.com/kakakakakazu/ai-visible/issues";

  // 多層防御。発行側で弾いていても、古い certified.json を読んだ場合に備えて出力側でも検証する
  const safe = d.certified.filter(c => safeOrigin(c.origin) === c.origin);
  const rows = safe.length
    ? safe.map(c => `<tr><td><a href="${esc(c.origin)}" rel="nofollow noopener">${esc(c.origin.replace(/^https?:\/\//, ""))}</a></td>` +
        `<td><time datetime="${esc(c.since)}">${esc(c.since)}</time></td>` +
        `<td><time datetime="${esc(c.lastVerified)}">${esc(c.lastVerified)}</time></td></tr>`).join("\n      ")
    : `<tr><td colspan="3">まだ認証されたサイトはありません。</td></tr>`;

  const snippet = `<a href="${PAGE}">\n  <img src="${BADGE}" alt="AI可読 認証 AIV-1" width="168" height="40">\n</a>`;

  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${STANDARD.name} ${STANDARD.id} — 認証済みサイト一覧`,
    description: `AIから中身を読める状態にあることを機械的に検証する認証。${d.count}サイトが基準を満たしている。審査員を持たず、公開された判定コードで毎週自動的に再検証する。`,
    dateModified: d.updatedAt,
    license: "https://opensource.org/licenses/MIT",
    mainEntity: {
      "@type": "Certification",
      name: `${STANDARD.name} ${STANDARD.id}`,
      description: STANDARD.requirements.join(" / "),
      dateCreated: STANDARD.established,
    },
  };

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI可読 認証 AIV-1 — 認証済みサイト一覧</title>
<meta name="description" content="AIから中身が読める状態にあることを機械的に検証する認証です。現在${d.count}サイトが基準を満たしています。審査員を持たず、公開された判定コードで毎週自動的に再検証し、基準を割ったサイトは自動的に失効します。">
<link rel="canonical" href="${PAGE}">
<meta property="og:title" content="AI可読 認証 AIV-1">
<meta property="og:description" content="AIから読める状態であることの証明。現在${d.count}サイトが認証済み。毎週自動で再検証。">
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
  code{background:var(--card);padding:2px 6px;border-radius:5px;font-size:13px;font-family:ui-monospace,Menlo,monospace}
  pre{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto;
    font-size:13px;font-family:ui-monospace,Menlo,monospace;line-height:1.7}
  ol,ul{padding-left:1.3em} li{margin:7px 0}
  p.note{color:var(--dim);font-size:13.5px}
  a{color:var(--ac)}
  footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
</style>
</head>
<body>
<main>
<article>

  <h1>AI可読 認証 ${esc(STANDARD.id)}</h1>
  <p class="meta">最終更新 <time datetime="${esc(d.updatedAt)}">${esc(d.updatedAt)}</time>｜認証済み ${d.count}サイト｜毎週自動で再検証</p>

  <p class="lead"><strong>AIから中身が読める状態にあること</strong>を、機械的に検証する認証です。
  <strong>審査員はいません。</strong>判定は公開されたコードで行われ、誰でも同じ結果を再現できます。
  取得も維持も<strong>無料</strong>で、毎週自動で再検証され、<strong>基準を割ると自動的に失効</strong>します。</p>

  <h2>認証の基準</h2>
  <p>次の3つを<strong>すべて</strong>満たすことが条件です。</p>
  <ol>
    ${STANDARD.requirements.map(r => `<li>${esc(r)}</li>`).join("\n    ")}
  </ol>

  <h3>なぜこの3つなのか</h3>
  <p>1と2は、100点満点の配点でそれぞれ<strong>28点と20点</strong>を占める項目です。
  「そもそもAIがページの中身に到達できるか」を問うもので、<strong>ここが欠けていれば他の項目が満点でも意味がありません。</strong>
  スコアだけを条件にすると、この2つが欠けたまま他の項目で80点に達してしまうため、別の条件として立てています。</p>
  <p>配点そのものの根拠は、KDD 2024 で発表された査読論文
  <a href="https://dl.acm.org/doi/10.1145/3637528.3671900">GEO: Generative Engine Optimization</a>（プリンストン大学ほか）です。
  出典の明記で生成エンジンでの可視性が約40%、統計の追加で約37%向上したという測定結果に基づいて重みを決めています。
  robots.txt の解釈は <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309</a> に準拠しています。</p>
  <p>3の<strong>80点</strong>という数字は、<a href="./data.html">実測した主要24サイトの分布</a>から決めています。
  中央値は76点、上位25%の境界は82点でした。<strong>80点は「達成できるが、放っておいては通らない」水準</strong>にあたります。
  基準が緩ければ認証の意味が消え、厳しすぎれば誰も取れません。実測分布に置くことが、唯一の客観的な決め方だと考えています。</p>

  <h2>認証済みのサイト</h2>
  <table>
    <thead><tr><th>サイト</th><th>初回認証</th><th>最終確認</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
  <p class="note">ドメイン名順に並べています。<strong>成績順ではありません。</strong></p>

  <h2>バッジ</h2>
  <p>認証されたサイトは、次のコードを貼ることでバッジを表示できます。使用は無料です。</p>
  <pre>${esc(snippet)}</pre>
  <p><img src="./badge.svg" alt="AI可読 認証 AIV-1 のバッジ" width="168" height="40"></p>
  <p class="note">バッジはこのページへリンクします。訪問者はいつでも、その認証が現在も有効かを確認できます。</p>

  <h2>よくある質問</h2>

  <h3>なぜ個別のスコアを公開しないのですか</h3>
  <p><strong>順位をつけることが目的ではないからです。</strong>認証は「基準を満たしているか」の二値であって、
  何点で満たしたかは第三者には関係ありません。点数を並べれば序列が生まれ、序列は本来の目的
  ——AIから読める状態を増やすこと——と関係のない競争を作ります。
  自分のスコアは<a href="./">診断ツール</a>でいつでも確認できます。</p>

  <h3>不合格だったサイトは公開されますか</h3>
  <p><strong>されません。</strong>記録も残しません。この認証は「できていることの証明」であって、
  できていないことを指摘するための仕組みではありません。</p>

  <h3>審査員がいないのに、なぜ信頼できるのですか</h3>
  <p>逆です。<strong>審査員がいないからこそ、判定に人の裁量が入りません。</strong>
  判定コード（<code>engine.js</code>）は公開されており、誰でも読めて、誰でも同じ入力から同じ結果を再現できます。
  信頼の根拠を「誰が認めたか」ではなく<strong>「誰でも検証できること」</strong>に置いています。
  これはセキュリティ評価基準の <a href="https://www.iso.org/standard/72891.html">ISO/IEC 15408（Common Criteria）</a> が
  透明性と再現性を信頼の土台に置いているのと同じ考え方です。</p>

  <h3>一度取れば、ずっと有効ですか</h3>
  <p>いいえ。<strong>毎週自動で再検証します。</strong>サイトは変わりますし、AIクローラーの側の事情も変わります。
  基準を割った時点で一覧から外れ、バッジのリンク先で無効であることが分かります。</p>

  <h3>費用はかかりますか</h3>
  <p>かかりません。判定は自動で、運営に人手も設備も要らないためです。</p>

  <h3>申請するには</h3>
  <p><a href="${ISSUES}/new?title=%E8%AA%8D%E8%A8%BC%E3%81%AE%E7%94%B3%E8%AB%8B&amp;body=%E5%AF%BE%E8%B1%A1URL%3A%20">GitHub の Issue でURLをお送りください。</a>
  次回の巡回で自動的に判定されます。費用はかかりません。
  <strong>申請はそのサイトの運営者ご本人がおこなってください。</strong></p>

  <h3>掲載をやめてほしい場合は</h3>
  <p><a href="${ISSUES}/new?title=%E6%8E%B2%E8%BC%89%E3%81%AE%E5%89%8A%E9%99%A4%E4%BE%9D%E9%A0%BC&amp;body=%E5%AF%BE%E8%B1%A1URL%3A%20"><strong>こちらからご連絡いただければ、確認のうえ一覧から削除します。</strong></a>
  第三者が誤って申請した場合や、掲載を望まれない場合が考えられるためです。
  <strong>掲載の継続に同意を要求することはありません。</strong>理由の説明も不要です。</p>

  <h2>まとめ</h2>
  <ul>
    <li>基準は<strong>3つだけ</strong>：AIクローラーを遮断していない／本文がHTMLにある／${STANDARD.minScore}点以上</li>
    <li><strong>80点は実測分布から決めた数字</strong>（中央値76点、上位25%の境界82点）</li>
    <li><strong>審査員なし・費用なし・毎週自動で再検証</strong>。基準を割れば自動失効</li>
    <li><strong>個別スコアも不合格サイトも公開しない。</strong>順位をつけるための仕組みではない</li>
  </ul>

  <footer>
    <p><a href="./">AIから見えていますか</a>（無料のAI可読性診断）｜
    <a href="./data.html">主要サイトの実測データ</a>｜
    <a href="https://kakakakakazu.github.io/mail-visible/">メールは届いていますか</a></p>
    <p>判定コードと基準はMITライセンスで公開しています。
    お問い合わせ・申請・削除依頼は <a href="${ISSUES}">GitHub の Issue</a> で受け付けています。</p>
    <p>参照: <a href="https://dl.acm.org/doi/10.1145/3637528.3671900">GEO: Generative Engine Optimization (KDD 2024)</a>｜
    <a href="https://www.rfc-editor.org/rfc/rfc9309.html">RFC 9309 (robots.txt)</a>｜
    <a href="https://schema.org/Certification">schema.org/Certification</a></p>
  </footer>

</article>
</main>
</body>
</html>
`;
  fs.writeFileSync(path.join(ROOT, "certified.html"), html);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { STANDARD, GRACE_DAYS, evaluate, withinGrace, main, renderPage };
