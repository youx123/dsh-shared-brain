#!/usr/bin/env node
/**
 * 0.10.1 修复批次 C：心情闸门打通（P0-3）+ 表情提示拆出（P0-4）
 *
 * P0-3（B1/B3，审计实测）：
 *   applyMoodDelta 里 step = round(rawDelta * factor / MOOD_STEP_DIVISOR=3)，
 *   significant = |mood - before| >= sigMood(=3) || dimSignificant。
 *   → 实际门槛是 rawDelta >= 9。
 *   而判定提示词（moodJudgeSystem 规则 1 与规则 10）白纸黑字写着
 *   「日常档 −1~−3」「日常一轮的心情变化通常在 −3 ~ +3」，
 *   模型**按提示词作答就 100% 落在 minor 区** → renderMoodContext 恒返回 ''。
 *   实测：delta −3 → minor true / 渲染空；delta −8 → 有内容；
 *         talk 模式（+1~+4）与 work 模式（−2~+2）数学上不可能过闸。
 *
 *   修法（不改 MOOD_STEP_DIVISOR —— 那是心情波动的平衡设计，改了会让
 *   心情忽上忽下）：让「显著性」看**判定给的原始幅度**（rawDelta），
 *   而不是折算后的 step。提示词说「宁小勿大」，那 ±3 就该算一次
 *   真正的变化，值得播报。
 *
 * P0-4（B2）：index.js 里 `if (!rendered) return ''` 在 proposeEmoji **之前**，
 *   心情文字一空，表情提示也一起躺平 → emoji-affinity.js 的 proposeEmoji
 *   （整个插件里唯一一处「心情真的改变行为」的代码）一次没跑过。
 *   修法：表情提示独立成一块 —— 心情文字是「可选的」，表情不是。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'

function patchText(file, from, to) {
  const p = join(LIB, file)
  const src = readFileSync(p, 'utf8')
  if (!src.includes(from)) {
    throw new Error(`${file}: 找不到锚点 ${JSON.stringify(from.slice(0, 110))}`)
  }
  if (src.split(from).length - 1 !== 1) {
    throw new Error(`${file}: 锚点出现多次（${src.split(from).length - 1} 次），不唯一`)
  }
  writeFileSync(p, src.split(from).join(to), 'utf8')
  console.log(`[ok] ${file}`)
}

/* ------------------------------------------------------------------ */
/* 1. emotion.js —— 显著性看原始幅度                                  */
/* ------------------------------------------------------------------ */
patchText(
  'emotion.js',
  `  const sigMood = Number(options.sigMood) || MOOD_DEFAULTS.sigMood
  const sigDim = Number(options.sigDim) || MOOD_DEFAULTS.sigDim
  const dimSignificant = DIMS.some(([key]) => Math.abs(Number(delta?.dims?.[key]) ?? 0) >= sigDim)
  const significant = Math.abs(state.mood - before) >= sigMood || dimSignificant
  state.minor = !significant`,
  `  const sigMood = Number(options.sigMood) || MOOD_DEFAULTS.sigMood
  const sigDim = Number(options.sigDim) || MOOD_DEFAULTS.sigDim
  const dimSignificant = DIMS.some(([key]) => Math.abs(Number(delta?.dims?.[key]) ?? 0) >= sigDim)
  // 2026-11-04（P0-3，审计 B1/B3）：显著性要看**判定给的原始幅度**，不是折算后的 step。
  //
  // 以前：significant = |mood - before| >= sigMood(=3)。
  // 而 step = round(rawDelta / 3)，所以「 moods 变了 3 点」实际要求 rawDelta >= 9。
  // 判定提示词却写着「日常档 −1~−3」「日常一轮通常在 −3 ~ +3」——
  // 模型越听话，越过不去这道闸 → renderMoodContext 恒返回空。
  //
  // 现在：rawDelta 的绝对值达到 sigMoodRaw（默认 2）就算一次真正的变化。
  // 这样「老大随口说累了」（−2）也能被感知到，而不是被算成「什么都没发生」。
  // MOOD_STEP_DIVISOR 不动 —— 那是心情**数值**的平衡设计（别让心情忽上忽下），
  // 动它会让衰减曲线变形。
  const sigMoodRaw = Number(options.sigMoodRaw) || MOOD_DEFAULTS.sigMoodRaw
  const rawSignificant = Math.abs(rawDelta) >= sigMoodRaw
  const significant = Math.abs(state.mood - before) >= sigMood || rawSignificant || dimSignificant
  state.minor = !significant`,
)

// MOOD_DEFAULTS 加 sigMoodRaw
patchText(
  'emotion.js',
  `  sigMood: 3,
  sigDim: 5,`,
  `  sigMood: 3,
  sigDim: 5,
  /**
   * 「原始幅度」的显著性门槛（2026-11-04，P0-3）。
   *
   * 判定提示词让模型「幅度宁小勿大，日常一轮通常在 −3 ~ +3」，
   * 所以 rawDelta 达到 2 就该算一次真正的变化，值得播报一次。
   * 以前这道判断挂在折算后的 step 上（实际要求 rawDelta >= 9），
   * 于是模型按提示词作答就永远落在 minor 区 —— 心情外显整条路是死的。
   */
  sigMoodRaw: 2,`,
)

// normalizeMoodConfig 也要认这个字段
patchText(
  'emotion.js',
  `  base.sigDim = clamp(Math.round(Number(raw.sigDim) ?? MOOD_DEFAULTS.sigDim), 1, 100, MOOD_DEFAULTS.sigDim)`,
  `  base.sigDim = clamp(Math.round(Number(raw.sigDim) ?? MOOD_DEFAULTS.sigDim), 1, 100, MOOD_DEFAULTS.sigDim)
  base.sigMoodRaw = clamp(Math.round(Number(raw.sigMoodRaw) ?? MOOD_DEFAULTS.sigMoodRaw), 1, 10, MOOD_DEFAULTS.sigMoodRaw)`,
)

// 沉默分支：被晾着也是一次真实的小失落，不该被标成 minor 后永远不注入
patchText(
  'emotion.js',
  `    state.minor = true
    state.silentTurns = (Number(state.silentTurns) || 0) + 1`,
  `    // 2026-11-04（P0-3，审计 B6）：被晾着是**一次真实的反馈**，
    // 不是「什么都没发生」。以前这里 minor=true 且不推进 revision，
    // 于是「被晾着的失落」永远不会被播报 —— 连模型都不知道老大没接话。
    // 现在：当成一次显著的微小变化（rawDelta 尺度上够 1），
    // 推进 revision，让它能被说出去一次。
    state.minor = false
    state.silentTurns = (Number(state.silentTurns) || 0) + 1`,
)

patchText(
  'emotion.js',
  `    noteMood(state, {
      kind: 'silence',
      delta: state.mood - beforeSilence,
      reason: state.lastReason,
      confidence: state.lastConfidence,
      dimsDelta: {},
      now,
    })
    return { state, changed: state.mood !== beforeSilence, minor: true, step: state.mood - beforeSilence, silence: true }`,
  `    noteMood(state, {
      kind: 'silence',
      delta: state.mood - beforeSilence,
      reason: state.lastReason,
      confidence: state.lastConfidence,
      dimsDelta: {},
      now,
    })
    // 推进 revision：这是真的有话要说（「老大这轮没接话」）。
    state.revision = (Number(state.revision) || 0) + 1
    return { state, changed: state.mood !== beforeSilence, minor: false, step: state.mood - beforeSilence, silence: true }`,
)

/* ------------------------------------------------------------------ */
/* 2. index.js —— 表情提示拆出闸门                                    */
/* ------------------------------------------------------------------ */
patchText(
  'index.js',
  `            if (!rendered) return ''
            // 说出去之前先记账：这一轮算「已经告诉过它了」（同样按 revision）
            moodState.injectedFor = Number(moodState.revision) || 0
            moodState.saidAt = [...(moodState.saidAt || []), Date.now()].slice(-50)
            saveMoodState(sessionId, moodState)
            state.moodsServed += 1
            // 阶段 B3：同一段心情上下文里带上「这会儿适合什么表情」。
            // 表情提示跟心情绑在一起是有意的 —— 心情低落时甩一个「庆祝」，
            // 比不说话还糟。禁忌由 emoji-affinity.js 的 avoid 表负责。
            // 表情提示**不参与**「一次变化只说一次」的记账：它跟着心情一起说，
            // 心情不变就不再重复说，够了。
            let emojiHint = ''
            try {
              const style = readModules().voice?.style ?? {}
              const proposal = proposeEmoji({
                moodState,
                config: normalizeEmojiAffinity(style.emojiSemantic),
              })
              emojiHint = renderEmojiHint(proposal)
              // 内置表情包：直接给现成的 markdown 图片，模型照抄就能出图，
              // 不依赖 dsh-emoji 插件。拿不到端口（比如宿主没 webServer）就跳过。
              const port = ctx?.get?.('webServer')?.port
              const builtin = renderBuiltinEmojiHint(proposal, port)
              if (builtin) emojiHint = emojiHint ? \`\${emojiHint}\\n\${builtin}\` : builtin
            } catch {
              // 表情提示算附加信息，出错就当没有
            }
            return emojiHint ? \`\${rendered}
\${emojiHint}\` : rendered`,
  `            // 阶段 B3：同一段心情上下文里带上「这会儿适合什么表情」。
            // 表情提示跟心情绑在一起是有意的 —— 心情低落时甩一个「庆祝」，
            // 比不说话还糟。禁忌由 emoji-affinity.js 的 avoid 表负责。
            //
            // 2026-11-04（P0-4，审计 B2）：表情提示**不再挂在心情文字的闸门后面**。
            // 以前这里是 \`if (!rendered) return ''\`，在 proposeEmoji 之前就返回了 ——
            // 心情文字一空（而它因为 P0-3 几乎总是空），表情提示也一起躺平，
            // 于是 proposeEmoji（整个插件里唯一一处「心情真的改变行为」的代码）
            // 一次都没跑过。现在：表情是独立的，文字是可选的。
            let emojiHint = ''
            try {
              const style = readModules().voice?.style ?? {}
              const proposal = proposeEmoji({
                moodState,
                config: normalizeEmojiAffinity(style.emojiSemantic),
              })
              emojiHint = renderEmojiHint(proposal)
              // 内置表情包：直接给现成的 markdown 图片，模型照抄就能出图，
              // 不依赖 dsh-emoji 插件。拿不到端口（比如宿主没 webServer）就跳过。
              const port = ctx?.get?.('webServer')?.port
              const builtin = renderBuiltinEmojiHint(proposal, port)
              if (builtin) emojiHint = emojiHint ? \`\${emojiHint}\\n\${builtin}\` : builtin
            } catch {
              // 表情提示算附加信息，出错就当没有
            }
            if (!rendered) {
              // 心情文字这一轮没什么可说的，但表情提示照样可以给。
              // 表情提示不参与「一次变化只说一次」的记账：它跟着心情一起说，
              // 心情不变就不再重复说，够了。
              return emojiHint
            }
            // 说出去之前先记账：这一轮算「已经告诉过它了」（同样按 revision）
            moodState.injectedFor = Number(moodState.revision) || 0
            moodState.saidAt = [...(moodState.saidAt || []), Date.now()].slice(-50)
            saveMoodState(sessionId, moodState)
            state.moodsServed += 1
            return emojiHint ? \`\${rendered}
\${emojiHint}\` : rendered`,
)

console.log('[done] 批次 C（心情闸门 + 表情拆出）已改')
