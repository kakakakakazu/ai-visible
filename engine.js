"use strict";
/* ai-visible 判定エンジン
   ブラウザ（index.html）と GitHub Actions の巡回スクリプトが共有する、唯一の判定ロジック。
   二重実装するとブラウザ版と集計版で点数がズレ、公開する統計の信頼性が壊れるため1本にしている。
   Node から使う場合は、呼び出し側で globalThis.DOMParser を用意すること（linkedom 等）。 */

/* ============ AIクローラー一覧 ============
   robots.txt で弾かれていると、そのAIはサイトの中身を読めない。 */
const BOTS = [
  {ua:"GPTBot",             who:"ChatGPT（学習・検索）"},
  {ua:"OAI-SearchBot",      who:"ChatGPT検索"},
  {ua:"ChatGPT-User",       who:"ChatGPTのブラウズ"},
  {ua:"ClaudeBot",          who:"Claude"},
  {ua:"anthropic-ai",       who:"Claude（旧表記）"},
  {ua:"Claude-Web",         who:"Claude（旧表記）"},
  {ua:"PerplexityBot",      who:"Perplexity"},
  {ua:"Perplexity-User",    who:"Perplexityの閲覧"},
  {ua:"Google-Extended",    who:"Gemini"},
  {ua:"Applebot-Extended",  who:"Apple Intelligence"},
  {ua:"CCBot",              who:"Common Crawl（多くのAIの供給源）"},
  {ua:"Amazonbot",          who:"Amazon"},
  {ua:"meta-externalagent", who:"Meta AI"}
];

/* ============ robots.txt 解析 ============
   User-agent ブロックごとに Disallow を集め、対象UAが「/」を禁止されているか判定する。
   * ブロックの指定は、そのUA専用ブロックが無い場合にのみ適用される（RFC 9309 の最長一致に準拠）。 */
function parseRobots(txt){
  const groups = [];      // {agents:[], disallow:[], allow:[]}
  const sitemaps = [];    // Sitemap: ディレクティブ（/sitemap.xml 以外に置く例が多い）
  let cur = null, lastWasAgent = false;

  for(let raw of txt.split(/\r?\n/)){
    const line = raw.replace(/#.*$/, "").trim();
    if(!line) continue;
    const i = line.indexOf(":");
    if(i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();

    if(key === "sitemap"){ if(val) sitemaps.push(val); lastWasAgent = false; continue; }

    if(key === "user-agent"){
      if(!cur || !lastWasAgent){ cur = {agents:[], disallow:[], allow:[]}; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    }else if(cur && (key === "disallow" || key === "allow")){
      cur[key].push(val);
      lastWasAgent = false;
    }else{
      lastWasAgent = false;
    }
  }

  // 対象UAがルート配下を全面禁止されているか
  const blocked = ua => {
    const u = ua.toLowerCase();
    const own = groups.filter(g => g.agents.includes(u));
    const star = groups.filter(g => g.agents.includes("*"));
    const use = own.length ? own : star;          // 専用ブロックがあれば * は無視
    if(!use.length) return false;
    for(const g of use){
      // Allow: / が明示されていれば許可扱い
      if(g.allow.some(a => a === "/" )) return false;
      if(g.disallow.some(d => d === "/")) return true;
    }
    return false;
  };
  return {groups, blocked, hasAny: groups.length > 0, sitemaps};
}

/* ============ HTML 解析 ============ */
function analyze(html, robotsTxt, hasLlms, hasSitemap, url){
  const doc = new DOMParser().parseFromString(html, "text/html");
  const R = parseRobots(robotsTxt || "");

  // 本文テキスト量（script/style/noscript を除いた可視テキスト）
  const clone = doc.body ? doc.body.cloneNode(true) : null;
  if(clone) clone.querySelectorAll("script,style,noscript,template").forEach(n => n.remove());
  const bodyText = clone ? clone.textContent.replace(/\s+/g, " ").trim() : "";

  // JSON-LD
  const lds = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try{ lds.push(JSON.parse(s.textContent)); }catch(e){ lds.push({__broken:true}); }
  });
  const ldTypes = [];
  const collect = o => {
    if(!o || typeof o !== "object") return;
    if(Array.isArray(o)){ o.forEach(collect); return; }
    if(typeof o["@type"] === "string") ldTypes.push(o["@type"]);
    else if(Array.isArray(o["@type"])) ldTypes.push(...o["@type"]);
    Object.values(o).forEach(v => { if(v && typeof v === "object") collect(v); });
  };
  lds.forEach(collect);

  const title = (doc.querySelector("title")?.textContent || "").trim();
  const desc  = (doc.querySelector('meta[name="description"]')?.getAttribute("content") || "").trim();
  const h1s   = [...doc.querySelectorAll("h1")].map(h => h.textContent.trim()).filter(Boolean);
  const h2s   = [...doc.querySelectorAll("h2")].map(h => h.textContent.trim()).filter(Boolean);
  const lang  = doc.documentElement.getAttribute("lang") || "";
  const canon = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "";
  const ogT   = doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
  const imgs  = [...doc.querySelectorAll("img")];
  const noAlt = imgs.filter(i => !i.getAttribute("alt")).length;

  // JS依存の判定。本質は「HTMLに本文が無い」ことで、マウント要素は補強材料にすぎない。
  // note.com のようにフレームワーク既定のIDを持たないSPAもあるため、外部scriptの本数も併用する。
  const mount = doc.querySelector("#root,#app,#__next,#__nuxt,#___gatsby,#q-app,#svelte,[data-reactroot],[data-server-rendered]");
  const scriptCount = doc.querySelectorAll("script[src]").length;
  const spa = bodyText.length < 400 && (!!mount || scriptCount >= 3);

  /* --- ここから下は KDD 2024（GEO提唱論文）の実証にもとづく項目 ---
     出典の明記 +約40% / 統計の追加 +約37% / 引用の追加 +約22% という測定結果があるため、
     見出しやメタ情報より、この3つを重く見る。 */

  // 出典: 外部サイトへのリンク（うち一次情報・公的ドメイン）
  const links = [...doc.querySelectorAll("a[href]")];
  const host = (() => { try{ return new URL(url).host; }catch(e){ return ""; } })();
  const extLinks = links.filter(a => {
    const h = a.getAttribute("href") || "";
    if(!/^https?:\/\//i.test(h)) return false;
    try{ return new URL(h).host !== host; }catch(e){ return false; }
  });
  // 一次情報とみなすドメイン。日本の公的機関だけでなく、学会・標準化団体・国際機関も含める
  // （当初は go.jp / ac.jp 中心で、ACM や RFC への出典を取りこぼしていた）。
  const AUTH = /\.(go|ac|lg)\.jp|\.gov\b|\.edu\b|\.ac\.uk\b|e-stat|wikipedia\.org|doi\.org|arxiv\.org|ncbi\.nlm|pubmed|jstor|acm\.org|ieee\.org|nature\.com|science\.org|sciencedirect|springer|rfc-editor\.org|ietf\.org|w3\.org|whatwg\.org|schema\.org|iso\.org|jisc?\.go\.jp|who\.int|oecd\.org|un\.org|worldbank\.org|imf\.org|europa\.eu/i;
  const authLinks = extLinks.filter(a => AUTH.test(a.getAttribute("href") || ""));

  // 統計: 本文中の「数値＋単位」の出現数
  const stats = (bodyText.match(/[0-9０-９][0-9０-９,，.．]*\s*(%|％|円|人|件|社|年|ヶ月|か月|カ月|月|日|時間|分|秒|倍|割|億|万|千|台|個|回|位|点|kg|km|cm|mm|g|m|℃)/g) || []).length;

  // 要約の手がかりになる見出し（LLMはこれを起点に要約する）
  const heads = [...doc.querySelectorAll("h1,h2,h3,h4")].map(h => h.textContent.trim()).filter(Boolean);
  const summaryHeads = heads.filter(t =>
    /まとめ|要約|ポイント|結論|概要|とは|FAQ|よくある(ご)?質問|Q&A|Q＆A|手順|比較|一覧|理由|方法/i.test(t));

  // セマンティック要素（divの海はAIにとってノイズ）
  const semantic = ["main","article","section","header","footer","nav","aside"].filter(t => doc.querySelector(t));
  const divCount = doc.querySelectorAll("div").length;

  // 更新日時（鮮度の手がかり）
  const hasDate = !!(doc.querySelector("time[datetime]")
    || doc.querySelector('meta[property="article:modified_time"],meta[property="article:published_time"],meta[name="last-modified"],meta[name="date"]')
    || /"date(Published|Modified)"/.test(html));

  return {
    R, bodyText, title, desc, h1s, h2s, lang, canon, ogT,
    ldTypes: [...new Set(ldTypes)], ldBroken: lds.some(l => l.__broken),
    imgCount: imgs.length, noAlt, spa, hasLlms, url,
    // sitemap は /sitemap.xml に無くても robots.txt の Sitemap: で示されていれば有る
    hasSitemap: hasSitemap || R.sitemaps.length > 0,
    sitemapViaRobots: !hasSitemap && R.sitemaps.length > 0,
    hasRobots: !!(robotsTxt && robotsTxt.trim()),
    extLinks: extLinks.length, authLinks: authLinks.length,
    stats, summaryHeads, heads: heads.length, semantic, divCount, hasDate
  };
}

/* ============ 採点 ============ */
/* 配点の根拠:
   28+20 は「そもそもAIが中身に到達できるか」。ここが欠けると他は全て無意味になるので最重量。
   出典12・統計11 は KDD 2024 の GEO 論文の測定値（出典の明記 +約40%、統計の追加 +約37%）に対応。
   llms.txt を 1 点まで下げたのは「AIボット訪問の0.1%しか取得されない」という実測があるため。
   h1 の有無は減点対象から外した。実サイト6件中5件が h1 を持たず、減点の根拠が薄いと判断。 */
function judge(a){
  const items = [];
  let score = 0;

  // 1. AIクローラーの許可（28点）— これが閉じていると他は全部無意味
  const blockedBots = BOTS.filter(b => a.R.blocked(b.ua));
  if(!a.hasRobots){
    score += 28;
    items.push({s:"ok", t:"AIクローラーは弾かれていません", m:"robots.txt が無い・取得できない・AI関連の記述が無いいずれかです。遮断はされていません。", w:28});
  }else if(blockedBots.length === 0){
    score += 28;
    items.push({s:"ok", t:"AIクローラーは弾かれていません", m:"robots.txt を解析しましたが、主要なAIクローラーを全面禁止する記述はありません。", w:28});
  }else{
    score += Math.max(0, 28 - blockedBots.length * 4);
    items.push({s:"ng", t:blockedBots.length + "種類のAIから、サイト全体が見えていません",
      m:"robots.txt で全面禁止されています → " + blockedBots.map(b => b.who + "（" + b.ua + "）").join(" / "),
      f:"下の robots.txt 修正案を既存ファイルの先頭に足すと、これらのAIが読めるようになります。", w:28});
  }

  // 2. 本文がHTMLに入っているか（20点）
  if(a.spa){
    items.push({s:"ng", t:"AIには、ほぼ空のページに見えています",
      m:"HTMLに含まれる本文が " + a.bodyText.length + " 字しかありません。中身をJavaScriptで描画しているためで、多くのAIクローラーはJavaScriptを実行しないため、ページは空同然に見えます。",
      f:"サーバー側レンダリング（SSR）か静的書き出しが根本解決です。難しい場合は、主要な情報だけでもHTMLに直接書いてください。", w:20});
  }else if(a.bodyText.length < 300){
    score += 8;
    items.push({s:"warn", t:"本文が短すぎます（" + a.bodyText.length + "字）",
      m:"AIが要約や引用の材料にできる文章が不足しています。", w:20});
  }else{
    score += 20;
    items.push({s:"ok", t:"本文はHTMLに直接入っています（" + a.bodyText.length.toLocaleString() + "字）",
      m:"JavaScriptを実行しないAIクローラーからも中身が読めます。", w:20});
  }

  // 3. 構造化データ（12点）— AIが最も確実に解釈できる形式
  if(a.ldBroken){
    score += 2;
    items.push({s:"ng", t:"構造化データが壊れています",
      m:"JSON-LD がJSONとして解釈できません。書いてあっても丸ごと無視されます。", w:12});
  }else if(a.ldTypes.length === 0){
    items.push({s:"ng", t:"構造化データがありません",
      m:"AIは「これは何の会社か・何の商品か」を文章から推測するしかありません。誤って説明される主因です。",
      f:"下の JSON-LD をコピーして <head> に貼れば解決します。", w:12});
  }else{
    score += 12;
    items.push({s:"ok", t:"構造化データがあります", m:"検出した型：" + a.ldTypes.join(", "), w:12});
  }

  // 4. 出典（12点）— KDD 2024: 出典の明記で可視性 +約40%
  if(a.spa){
    items.push({s:"warn", t:"出典の有無を判定できません", m:"本文がHTMLに含まれていないため、測定できませんでした。", w:0});
  }else if(a.authLinks > 0){
    score += 12;
    items.push({s:"ok", t:"一次情報・公的な出典にリンクしています（" + a.authLinks + "本）",
      m:"出典の明記は、AI検索での可視性を約40%高めるという測定結果があります（KDD 2024）。", w:12});
  }else if(a.extLinks >= 3){
    score += 7;
    items.push({s:"warn", t:"外部リンクはありますが、一次情報への出典がありません（外部 " + a.extLinks + "本）",
      m:"官公庁（go.jp）・学術（ac.jp / doi.org / arXiv）・統計（e-Stat）など、検証可能な出典を1本足すだけで扱いが変わります。", w:12});
  }else{
    items.push({s:"ng", t:"出典がありません（外部リンク " + a.extLinks + "本）",
      m:"AIは裏の取れない記述を避けます。出典の明記は可視性を約40%高めるという測定結果があり（KDD 2024）、今回の項目では最も費用対効果が高い改善です。",
      f:"主張の根拠になる統計や公的資料へのリンクを、本文中に置いてください。", w:12});
  }

  // 5. 統計・数字（11点）— KDD 2024: 統計の追加で +約37%
  if(a.spa){
    items.push({s:"warn", t:"数字の有無を判定できません", m:"本文がHTMLに無いため、統計の含有を測れませんでした。", w:0});
  }else if(a.stats >= 15){
    score += 11;
    items.push({s:"ok", t:"具体的な数字が豊富です（" + a.stats + "箇所）",
      m:"統計や数値の記載は、AI検索での可視性を約37%高めるという測定結果があります（KDD 2024）。", w:11});
  }else if(a.stats >= 5){
    score += 7;
    items.push({s:"warn", t:"数字がやや少なめです（" + a.stats + "箇所）",
      m:"「多くの」「豊富な」といった形容を、実際の件数・年数・割合に置き換えるとAIに拾われやすくなります。", w:11});
  }else{
    items.push({s:"ng", t:"具体的な数字がほとんどありません（" + a.stats + "箇所）",
      m:"AIは検証できる数値を含む記述を優先して引用します。統計の追加で可視性が約37%向上したという測定があります（KDD 2024）。",
      f:"創業年・実績件数・対応エリア数・価格など、持っている数字を本文に書いてください。", w:11});
  }

  // 6. タイトルと説明（7点）
  if(!a.title){
    items.push({s:"ng", t:"タイトルがありません", m:"AIが最初に読む要素です。", w:7});
  }else if(!a.desc){
    score += 4;
    items.push({s:"warn", t:"meta description がありません",
      m:"タイトル「" + a.title + "」は取れましたが、要約文がありません。AIが自前で要約するため、意図と違う説明をされやすくなります。", w:7});
  }else{
    score += 7;
    items.push({s:"ok", t:"タイトルと説明文があります", m:a.title, w:7});
  }

  // 7. 要約の手がかりになる見出し（4点）
  if(a.spa){
    items.push({s:"warn", t:"見出しの構成を判定できません", m:"本文がHTMLに含まれていないため、測定できませんでした。", w:0});
  }else if(a.summaryHeads.length > 0){
    score += 4;
    items.push({s:"ok", t:"AIが要約の起点にできる見出しがあります",
      m:"検出：" + a.summaryHeads.slice(0,4).map(t => "「" + t.slice(0,20) + "」").join(" "), w:4});
  }else if(a.heads > 0){
    score += 2;
    items.push({s:"warn", t:"要約の起点になる見出しがありません（見出しは " + a.heads + " 個）",
      m:"LLMは「まとめ」「ポイント」「よくある質問」「〜とは」といった見出しを手がかりに要約を作ります。この形の見出しを足すと拾われやすくなります。", w:4});
  }else{
    items.push({s:"ng", t:"見出しが1つもありません", m:"文章の構造がAIに伝わりません。", w:4});
  }

  // 8. 更新日時（3点）
  if(a.hasDate){ score += 3; items.push({s:"ok", t:"更新日時が機械可読な形で書かれています", m:"情報の鮮度が判定でき、古い情報として除外されにくくなります。", w:3}); }
  else{ items.push({s:"warn", t:"更新日時が機械可読ではありません",
    m:"AIは鮮度を判定できないと採用を避けます。<time datetime=\"...\"> か構造化データの dateModified を入れてください。", w:3}); }

  // 9. セマンティック構造（2点）
  if(a.semantic.length >= 2){
    score += 2;
    items.push({s:"ok", t:"HTMLの意味構造が保たれています", m:"使用：" + a.semantic.join(", ") + "（div は " + a.divCount + " 個）", w:2});
  }else{
    items.push({s:"warn",
      t: a.semantic.length ? "意味を持つHTML要素が不足しています" : "意味を持つHTML要素が使われていません",
      m: "main / article / section など"
         + (a.semantic.length ? "が「" + a.semantic.join(", ") + "」しか無く" : "が1つも無く")
         + "、AIには本文とナビゲーションの区別がつきません（div は " + a.divCount + " 個）。", w:2});
  }

  // 10. llms.txt（1点）— 実効性が低いという実測があるため軽い
  if(a.hasLlms){ score += 1; items.push({s:"ok", t:"llms.txt があります", m:"Claude・Perplexity・You.com が公式に参照しています。", w:1}); }
  else{ items.push({s:"warn", t:"llms.txt がありません",
    m:"AIボットの訪問のうち取得されるのは0.1%程度という実測があり、効果は限定的です。ただし作成コストがほぼゼロなので、置いて損はありません。",
    f:"下の llms.txt をルートに置くだけです。", w:1}); }

  // 補助（減点なし・情報のみ）
  if(!a.hasSitemap) items.push({s:"warn", t:"sitemap.xml が見つかりません", m:"ページ全体が網羅的に巡回されにくくなります。減点はしていません。", w:0});
  if(a.h1s.length === 0) items.push({s:"warn", t:"h1 見出しがありません",
    m:"主題の特定にはあった方が有利ですが、大手サイトでも省略が一般化しているため減点していません。", w:0});
  if(!a.lang) items.push({s:"warn", t:"lang 属性がありません", m:"言語が判定できず、日本語サイトとして扱われない場合があります。", w:0});
  if(a.imgCount > 0 && a.noAlt === a.imgCount)
    items.push({s:"warn", t:"画像に alt が1つもありません（" + a.imgCount + "枚）", m:"AIは画像の中身を読めないため、alt が唯一の手がかりです。", w:0});

  // 重み順（減点が大きいものを上に）
  const rank = {ng:0, warn:1, ok:2};
  items.sort((x,y) => (rank[x.s] - rank[y.s]) || (y.w - x.w));

  return {score: Math.max(0, Math.min(100, Math.round(score))), items, blockedBots};
}

/* Node から require するためのエクスポート。ブラウザでは module が未定義なので何も起きない。 */
if (typeof module !== "undefined" && module.exports) module.exports = { BOTS, parseRobots, analyze, judge };
