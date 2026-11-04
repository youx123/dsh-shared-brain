// 校验 0.9.7 tgz（情感模块改动后）：文件清单 + 修复标记 + 情感模块标记
const fs = require('fs')
const zlib = require('zlib')

const TGZ = 'C:/Users/13176/.dsh/profiles/desktop/vendor/dsh-shared-brain-0.9.7.tgz'
const buf = zlib.gunzipSync(fs.readFileSync(TGZ))
let off = 0
const files = {}
while (off + 512 <= buf.length) {
  const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '')
  const sizeStr = buf.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim()
  if (!name) break
  const size = parseInt(sizeStr, 8) || 0
  const typeflag = buf.toString('ascii', off + 156, off + 157)
  off += 512
  if (typeflag === '0' || typeflag === '') files[name] = buf.slice(off, off + size)
  off += Math.ceil(size / 512) * 512
}
console.log('解出文件数:', Object.keys(files).length)
const libFiles = Object.keys(files).filter((f) => f.startsWith('package/lib/'))
console.log('lib 文件数:', libFiles.length)
console.log('lib 清单:', libFiles.map((f) => f.replace('package/lib/', '')).join(', '))

const meta = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/cordis.patch.yml']
console.log('元文件缺失:', meta.filter((f) => !files[f]).join(', ') || '无')

const get = (f) => (files['package/lib/' + f] ? files['package/lib/' + f].toString('utf8') : '')
const has = (f, m) => get(f).includes(m)

console.log('\n--- 旧修复仍在（回归检查）---')
const oldMarks = {
  'proactive.js randomizeInterval': has('proactive.js', 'export function randomizeInterval'),
  'proactive.js JITTER': has('proactive.js', 'PROACTIVE_INTERVAL_JITTER'),
  'proactive.js nonce': has('proactive.js', '本次检查编号'),
  'index.js JITTER import': has('index.js', 'PROACTIVE_INTERVAL_JITTER,'),
  'index.js 看门狗': has('index.js', 'proactiveWatchdog = setInterval(syncProactive, 30_000)'),
  'sessions.js idKey': has('sessions.js', 'idKey'),
  'bridge.js status path': has('bridge.js', '/api/dsh-shared-brain/status'),
  'commands.js 随机文案': has('commands.js', '分钟之间随机'),
  'client.js proactiveNextFire': has('client.js', 'proactiveNextFire'),
}
for (const [k, v] of Object.entries(oldMarks)) console.log(' ', v ? 'OK ' : 'MISS', k)

console.log('\n--- 本次情感模块新增 ---')
const emoMarks = {
  'emotion.js 存在': Boolean(files['package/lib/emotion.js']),
  'emotion.js DIMS': has('emotion.js', "['heartache', '心疼']"),
  'emotion.js SENTIMENTS': has('emotion.js', 'export const SENTIMENTS'),
  'emotion.js normalizeEmotionItem': has('emotion.js', 'export function normalizeEmotionItem'),
  'emotion.js scoreEmotionItem': has('emotion.js', 'export function scoreEmotionItem'),
  'emotion.js emotionItemInScope': has('emotion.js', 'export function emotionItemInScope'),
  'emotion.js applyMoodDelta': has('emotion.js', 'export function applyMoodDelta'),
  'emotion.js decayMood': has('emotion.js', 'export function decayMood'),
  'emotion.js renderMoodContext': has('emotion.js', 'export function renderMoodContext'),
  'emotion.js judgeMood': has('emotion.js', 'export async function judgeMood'),
  'emotion.js parseMoodDelta': has('emotion.js', 'export function parseMoodDelta'),
  'emotion.js moodBand': has('emotion.js', 'export function moodBand'),
  'classify.js 无「我们」误判正则': !/我们\|咱们\|一起\|咱们一起\|咱/.test(get('classify.js')),
  'classify.js isEmotionText': has('classify.js', 'export function isEmotionText'),
  'classify.js 语义字段': has('classify.js', 'sentiment,'),
  'modules.js ITEM_SCOPES 含 session': has('modules.js', "ITEM_SCOPES = ['global', 'workspace', 'session']"),
  'modules.js scopeSession': has('modules.js', 'scopeSession'),
  'modules.js intimacy': has('modules.js', 'intimacy'),
  'store.js scopeSession': has('store.js', 'scopeSession'),
  'store.js intimacy': has('store.js', 'intimacy'),
  'weighted-recall.js scoreEmotionItem': has('weighted-recall.js', 'scoreEmotionItem'),
  'index.js inject 含 llm': /inject\s*=\s*\[[^\]]*'llm'/.test(get('index.js')),
  'index.js MOOD_CONTEXT': has('index.js', "MOOD_CONTEXT = 'shared-brain:mood'"),
  'index.js systemPrompt.context': has('index.js', 'systemPrompt.context'),
  'index.js judgeMoodForTurn': has('index.js', 'judgeMoodForTurn'),
  'bridge.js setMoodConfig': has('bridge.js', 'setMoodConfig'),
  'bridge.js resetMood': has('bridge.js', 'resetMood'),
  'bridge.js snapshot emotion': has('bridge.js', 'emotion: moodStatus('),
  'commands.js mood-config': has('commands.js', 'mood-config'),
  'commands.js mood-reset': has('commands.js', 'mood-reset'),
  'commands.js mood-on': has('commands.js', 'mood-on'),
  'client.js MoodCard': has('client.js', 'function MoodCard'),
  'client.js moodTitle 键': has('client.js', 'moodTitle'),
  'client.js moodSave 键': has('client.js', 'moodSave'),
}
let miss = 0
for (const [k, v] of Object.entries(emoMarks)) {
  if (!v) miss++
  console.log(' ', v ? 'OK ' : 'MISS', k)
}
console.log('\n缺失标记数:', miss)

const pkg = JSON.parse(files['package/package.json'].toString('utf8'))
console.log('package version:', pkg.version)
console.log('pkg main/exports:', pkg.main, JSON.stringify(pkg.exports))
