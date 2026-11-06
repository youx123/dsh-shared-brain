/**
 * 学一个题目：把若干网页交给共享大脑提炼入库。
 *
 * 用法：
 *   node scripts/learn-topic.mjs --topic 泰山 --url https://a.com/x --url https://b.com/y
 *   node scripts/learn-topic.mjs --topic 泰山 --url https://a.com/x --port 60553
 *   node scripts/learn-topic.mjs --topic 苏州园林 --text-file notes.md
 *
 * 为什么搜索不在这里做：
 *   本机实测维基百科证书链失败、百度百科 403、DuckDuckGo 超时，
 *   插件自己搜不到东西。所以搜索这一步交给有联网能力的调用方（就是我），
 *   这个脚本只负责"拿到链接之后的活"：抓 → 提炼 → 去重 → 入库 → 汇总。
 *
 * 默认端口从环境变量 DSH_SHARED_BRAIN_PORT 取，缺省 60553。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = { urls: [], topic: '', port: '', textFile: '', text: '' };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--url') opt.urls.push(argv[++i]);
  else if (a === '--topic') opt.topic = argv[++i];
  else if (a === '--port') opt.port = argv[++i];
  else if (a === '--text-file') opt.textFile = argv[++i];
  else if (a === '--text') opt.text = argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/learn-topic.mjs --topic <题目> (--url <链接> ... | --text-file <文件> | --text <文本>)');
    process.exit(0);
  }
}

const PORT = opt.port || process.env.DSH_SHARED_BRAIN_PORT || '60553';
const BASE = `http://127.0.0.1:${PORT}`;

if (opt.urls.length === 0 && !opt.textFile && !opt.text) {
  console.error('至少给一个 --url，或者用 --text-file / --text 直接给素材。');
  process.exit(1);
}

async function learn(body) {
  const res = await fetch(`${BASE}/api/dsh-shared-brain/learn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    return { ok: false, error: json?.error || `HTTP ${res.status}` };
  }
  return json;
}

const results = [];

for (const url of opt.urls) {
  const r = await learn({ url });
  if (!r.ok) {
    console.log(`✗ ${url}\n  ${r.error}`);
    results.push({ url, ok: false });
    continue;
  }
  const f = r.fetched ?? {};
  console.log(`✓ ${f.title || url}  （${f.host}，${f.chars} 字）`);
  console.log(`  提炼 ${r.extracted} 条 → 入库 ${r.added} 条（跳过 ${r.skipped}）`);
  for (const p of (r.preview ?? []).slice(0, 4)) {
    // preview 是「[知识] 正文」这样的字符串数组，不是对象
    console.log(`    · ${String(p).slice(0, 70)}`);
  }
  results.push({ url, ok: true, added: r.added, extracted: r.extracted });
}

const inline = opt.textFile ? readFileSync(opt.textFile, 'utf8') : opt.text;
if (inline) {
  const r = await learn({ text: inline, source: opt.topic || '手写素材' });
  if (!r.ok) {
    console.log(`✗ 文本素材\n  ${r.error}`);
    results.push({ ok: false });
  } else {
    console.log(`✓ ${r.source || '文本素材'}（${inline.length} 字）`);
    console.log(`  提炼 ${r.extracted} 条 → 入库 ${r.added} 条（跳过 ${r.skipped}）`);
    for (const p of (r.preview ?? []).slice(0, 4)) {
      // preview 是「[知识] 正文」这样的字符串数组，不是对象
    console.log(`    · ${String(p).slice(0, 70)}`);
    }
    results.push({ ok: true, added: r.added, extracted: r.extracted });
  }
}

const added = results.reduce((s, x) => s + (x.added ?? 0), 0);
const okCount = results.filter((x) => x.ok).length;
console.log(`\n合计：${okCount}/${results.length} 个来源成功，入库 ${added} 条。`);
