"use strict";
/* ai-visible 巡回スクリプト — GitHub Actions から定期実行する
 *
 * 目的: 「主要サイトのうち◯%がAIクローラーを遮断している」という集計統計を作る。
 *       出力に個別のサイト名・URL・個別スコアは一切残さない（制約1: 人に順位をつけない）。
 * 原価: 実行時にLLM APIを一切呼ばない。判定は engine.js の決定的ルールのみ（制約9）。
 *       public リポジトリの GitHub Actions は runner 無料・分数制限なし（2026-08-07 確認）。
 */

const fs = require("fs");
const { DOMParser } = require("linkedom");
globalThis.DOMParser = DOMParser;              // engine.js はブラウザ前提なので補う

const { analyze, judge, parseRobots, BOTS } = require("../engine.js");

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============ 巡回の礼儀 ============
 *
 * ai-visible は「robots.txt でAIクローラーが弾かれているか」を診断するツールである。
 * その自分が robots.txt を無視して巡回すれば、ツールの主張と自分の行動が矛盾する。
 *
 * ただし単純に「拒否サイトは飛ばす」と決めると統計が壊れる。測れなくなるのは
 * 「AIを拒否しているサイト」＝まさに数えたい対象で、遮断率が構造的に過小評価される
 * （選択バイアス）。
 *
 * 逃げ道: robots.txt 自体の取得を robots.txt で禁止する仕様は存在しない。
 * そこで3段階に分ける。
 *   full        — 通常どおり本文まで取る
 *   robots-only — robots.txt から遮断状況だけ数える。本文は取りに行かない
 *   skip        — 名指しで拒否されている。何も数えない
 * これで遮断率はバイアスなく取れ、本文由来の項目だけ母数が減る。
 */

const CRAWL = {
  // 名乗り。相手のログを見た管理者が「何者で・何のためで・どこに問い合わせるか」辿れる形にする。
  userAgent: "ai-visible-survey/1.0 (+https://kakakakakazu.github.io/ai-visible/)",

  // 同一ホストへの間隔。1サイトにつき最大4回叩くので、2秒なら1サイト最大8秒。
  // 24サイトで約3分。相手に負荷をかけない範囲で、Actions の実行時間にも収まる。
  delayMs: 2000,

  timeoutMs: 15000,
};

/**
 * このサイトをどこまで見てよいかを、相手の robots.txt から判断する。
 *
 * parseRobots(txt) が返すもの（実装を読んで確認済み）:
 *   R.blocked(ua) -> boolean   そのUAが「Disallow: /」で全体を禁止されているか。
 *                              専用ブロックがあれば "*" は無視（RFC 9309 の最長一致）。
 *                              「Allow: /」があれば許可扱い。部分パスは判定しない。
 *   R.hasAny      -> boolean   User-agent グループが1つでも書かれていたか
 *   R.sitemaps    -> string[]  Sitemap: の一覧
 *
 * @param {string} robotsTxt 取得した robots.txt（取得できなければ空文字）
 * @returns {{ mode: "full"|"robots-only"|"skip", reason: string }}
 */
function mayCrawl(robotsTxt) {
  // robots.txt が無い・取れない場合。禁止の意思表示が存在しないので通常どおり扱う。
  if (!robotsTxt.trim()) return { mode: "full", reason: "" };

  const R = parseRobots(robotsTxt);

  // 自分の名前で名指し禁止されていたら、そこで終わり。数えもしない。
  // （UAトークンは "/" より前。慣例どおり、名乗りの製品名部分で照合する）
  const me = CRAWL.userAgent.split("/")[0];
  if (R.blocked(me)) return { mode: "skip", reason: `${me} を名指しで拒否` };

  // "*" が全体を禁止しているサイト。本文は取りに行かないが、
  // robots.txt に書かれた「どのAIを弾いているか」は数える。
  if (R.blocked("*")) return { mode: "robots-only", reason: "全クローラーを拒否（遮断状況のみ計上）" };

  return { mode: "full", reason: "" };
}

/* ============ 取得 ============ */

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CRAWL.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": CRAWL.userAgent },
      signal: ctl.signal,
      redirect: "follow",
    });
    const text = res.ok ? await res.text() : "";
    return { ok: res.ok, status: res.status, text, type: res.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, status: 0, text: "", type: "", error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/* 404/403 でHTMLのエラーページを返すサーバーがあるため、
   「200 が返った」だけでは llms.txt / sitemap.xml の存在判定にならない。
   （実サイトテストで実際に踏んだ罠。README の既知バグ①と同じもの） */
function isRealFile(r) {
  return r.ok && r.text.trim() !== "" && !/^\s*</.test(r.text) && !/text\/html/i.test(r.type);
}

/* ============ 1サイトを測る ============ */

async function inspect(origin) {
  const robots = await get(origin + "/robots.txt");
  const robotsTxt = robots.ok ? robots.text : "";
  const gate = mayCrawl(robotsTxt);

  if (gate.mode === "skip") return { skipped: true, reason: gate.reason };

  // 遮断状況は本文を取らなくても数えられる。ここを全サイト共通で先に取ることで、
  // 「拒否サイトほど測れない」という選択バイアスを避ける。
  const R = parseRobots(robotsTxt);
  const blocked = BOTS.filter(b => R.blocked(b.ua)).map(b => b.ua);

  if (gate.mode === "robots-only") return { robotsOnly: true, blocked, reason: gate.reason };

  await sleep(CRAWL.delayMs);
  const page = await get(origin + "/");
  if (!page.ok) return { failed: true, status: page.status, blocked };

  await sleep(CRAWL.delayMs);
  const llms = await get(origin + "/llms.txt");
  await sleep(CRAWL.delayMs);
  const sitemap = await get(origin + "/sitemap.xml");

  const a = analyze(page.text, robotsTxt, isRealFile(llms), isRealFile(sitemap), origin);
  const j = judge(a);

  // 返すのは集計に必要な素性だけ。origin は呼び出し側のログ用で、集計には渡さない。
  return {
    full: true,
    score: j.score,
    blocked,
    spa: a.spa, ld: a.ldTypes.length > 0, ldBroken: a.ldBroken,
    llms: a.hasLlms, sitemap: a.hasSitemap,
    auth: a.authLinks, ext: a.extLinks, stats: a.stats,
    date: a.hasDate, semantic: a.semantic.length, body: a.bodyText.length,
  };
}

/* ============ 集計 ============
 * 個別サイトの情報を捨てる境界。ここから先に origin は一切渡らない（制約1）。
 * 遮断率は robots-only を含む全観測から、本文由来の項目は full のみから計算する。 */

function aggregate(rows) {
  const seen = rows.filter(r => r.blocked !== undefined);   // 遮断状況を観測できたもの
  const full = rows.filter(r => r.full);                    // 本文まで見られたもの
  const base = {
    observedAt: new Date().toISOString().slice(0, 10),
    nRobots: seen.length,
    nFull: full.length,
    skipped: rows.filter(r => r.skipped).length,
    failed: rows.filter(r => r.failed).length,
    method: "robots.txt は全対象から、本文由来の項目は取得を許可されたサイトのみから集計",
  };
  if (seen.length === 0) return base;

  const pctOf = (arr, f) => arr.length ? Math.round((arr.filter(f).length / arr.length) * 1000) / 10 : null;
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  const blockedByBot = {};
  BOTS.forEach(b => { blockedByBot[b.ua] = pctOf(seen, r => r.blocked.includes(b.ua)); });

  const out = {
    ...base,
    blockedAny: pctOf(seen, r => r.blocked.length > 0),
    blockedByBot,
  };
  if (full.length === 0) return out;

  const scores = full.map(r => r.score).sort((a, b) => a - b);
  const at = p => scores[Math.min(scores.length - 1, Math.floor(scores.length * p))];

  return {
    ...out,
    score: { median: at(0.5), p25: at(0.25), p75: at(0.75), min: scores[0], max: scores[scores.length - 1] },
    invisibleToAI: pctOf(full, r => r.spa),               // 本文がHTMLに無い＝AIには空ページ
    hasStructuredData: pctOf(full, r => r.ld),
    brokenStructuredData: pctOf(full, r => r.ldBroken),
    hasLlmsTxt: pctOf(full, r => r.llms),
    hasSitemap: pctOf(full, r => r.sitemap),
    hasAuthoritativeLinks: pctOf(full, r => r.auth > 0),
    noExternalLinks: pctOf(full, r => r.ext === 0),
    hasMachineReadableDate: pctOf(full, r => r.date),
    poorSemantics: pctOf(full, r => r.semantic < 2),
    statsPerPage: { median: median(full.map(r => r.stats)) },
    bodyLength: { median: median(full.map(r => r.body)) },
  };
}

/* ============ main ============ */

async function main() {
  const targets = JSON.parse(fs.readFileSync(__dirname + "/targets.json", "utf8"));
  const rows = [];

  for (const origin of targets.origins) {
    const r = await inspect(origin);
    rows.push(r);
    const label = r.skipped ? "skip" : r.robotsOnly ? "robo" : r.failed ? `f${r.status}` : String(r.score).padStart(4);
    console.log(`${label}  ${origin}${r.reason ? "  — " + r.reason : ""}`);
    await sleep(CRAWL.delayMs);
  }

  const stats = aggregate(rows);
  fs.writeFileSync(__dirname + "/../data/latest.json", JSON.stringify(stats, null, 2) + "\n");
  console.log("\n" + JSON.stringify(stats, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
