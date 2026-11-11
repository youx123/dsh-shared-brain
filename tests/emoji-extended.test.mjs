/**
 * 表情包扩充 + 灵动化 的单测（2026-11-11）
 *
 * 覆盖：
 *   - 内置包 35 个扩展 key 都有文件、都有中文名、都有用途说明
 *   - proposeEmoji 在 extended=false 时绝不吐扩展 key（外部包渲染不了）
 *   - extended=true 时日常场景能挑到日常图（收到/好的/干饭/下班/晚安…）
 *   - 时段（早上/深夜/饭点）参与挑图
 *   - 正事（报错/部署/合同）里不给日常表情，且 limit 压到 1
 *   - 禁忌仍然生效（低落时不给庆祝）
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..', 'lib')

const { proposeEmoji, cueKeysOf, partOfDay, timeKeysOf, emojiUsageOf, isExtendedKey, EXTRA_EMOJI_KEYS } =
  await import(`file:///${LIB}/emoji-affinity.js`.replace(/\\/g, '/'))
const { BUILTIN_EXTRA_KEY_FILES, BUILTIN_EXTRA_KEY_LABELS, builtinLabelOf, builtinAssetDir, resolveBuiltinAsset } =
  await import(`file:///${LIB}/emoji-builtin.js`.replace(/\\/g, '/'))

let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const cfg = { enabled: true, mode: 'auto' }
const at = (hour) => {
  const d = new Date(2026, 10, 11, hour, 30, 0)
  return d.getTime()
}

console.log('【1】扩展 key 的完整度')
const extraKeys = Object.keys(BUILTIN_EXTRA_KEY_FILES)
ok('扩展 key 数量是 35', extraKeys.length === 35, String(extraKeys.length))
ok('每个扩展 key 都有中文名', extraKeys.every((k) => BUILTIN_EXTRA_KEY_LABELS[k]))
ok('每个扩展 key 都有用途', extraKeys.every((k) => emojiUsageOf(k)))
ok('EXTRA_EMOJI_KEYS 与文件名表一一对应', EXTRA_EMOJI_KEYS.length === extraKeys.length)
const missing = extraKeys.filter((k) => !existsSync(join(builtinAssetDir(), BUILTIN_EXTRA_KEY_FILES[k])))
ok('扩展 key 指向的 GIF 都存在', missing.length === 0, missing.join(','))
ok('文件解析能认出扩展 key', Boolean(resolveBuiltinAsset('slacking')))
ok('builtinLabelOf 认扩展 key', builtinLabelOf('slacking') === '摸鱼中')

console.log('【2】extended=false 时不吐扩展 key')
for (const text of ['收到', '我去摸鱼了', '晚安', '干饭', '生日快乐']) {
  const p = proposeEmoji({ text, config: cfg, extended: false })
  ok(`「${text}」不含扩展 key`, p.keys.every((k) => !isExtendedKey(k)), p.keys.join(','))
}

console.log('【3】extended=true 时日常场景挑得到日常图')
const cases = [
  ['收到，这就办', 'received'],
  ['好的没问题', 'sure'],
  ['晚安，先睡了', 'night'],
  ['我在摸鱼，别找我', 'slacking'],
  ['今天干饭人上线', 'eating'],
  ['提前祝你生日快乐', 'birthday'],
]
for (const [text, expect] of cases) {
  const p = proposeEmoji({ text, config: cfg, extended: true })
  ok(`「${text}」→ 候选含 ${expect}`, p.keys.includes(expect), p.keys.join(','))
}

console.log('【4】时段参与挑图')
ok('partOfDay 早上', partOfDay(at(7)) === 'early')
ok('partOfDay 深夜', partOfDay(at(1)) === 'late')
ok('partOfDay 中午', partOfDay(at(12)) === 'noon')
const nightPool = timeKeysOf(at(2))
ok('深夜池子含 night', nightPool.includes('night'))
const noonPool = timeKeysOf(at(12))
ok('饭点池子含 eating', noonPool.includes('eating'))
const afternoonP = proposeEmoji({ text: '嗯', config: cfg, extended: true, now: at(14) })
ok('下午闲聊能拿到时段候选', afternoonP.keys.some((k) => ['coffee', 'rush', 'eating'].includes(k)), afternoonP.keys.join(','))
ok('返回 part 字段', afternoonP.part === 'afternoon', String(afternoonP.part))

console.log('【5】正事里不给日常表情')
const formal = proposeEmoji({ text: '部署失败了，日志在挂载目录，配置也要改', config: cfg, extended: true, now: at(12) })
ok('正事 limit 压到 1', formal.limit <= 1, String(formal.limit))
ok('正事候选里没有时段日常图', !formal.keys.some((k) => timeKeysOf(at(12)).includes(k)), formal.keys.join(','))
ok('正事候选里没有干饭人', !formal.keys.includes('eating'), formal.keys.join(','))

console.log('【6】禁忌仍然生效')
const sad = proposeEmoji({
  text: '心里挺难受的',
  config: cfg,
  extended: true,
  signal: { mood: 30, band: 'sad', level: 'low', dims: { sad: 3 } },
})
ok('低落时不给庆祝', !sad.keys.includes('celebrate'), sad.keys.join(','))
ok('低落时 limit 是 1', sad.limit === 1, String(sad.limit))

console.log('【7】cue 表能命中扩展线索')
const cues = cueKeysOf('我太难了，救命')
ok('「我太难了」命中 too-hard', cues.includes('too-hard'), cues.join(','))
ok('「救命」命中 sos', cues.includes('sos'), cues.join(','))

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
