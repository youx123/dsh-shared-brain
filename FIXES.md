# 共享大脑修复说明（2026-10-29）

本次修了两个问题：**自动互动「开了又自己关 / 根本没反应」**、**选择会话时列出一大堆历史会话**。

修复直接落在正在运行的副本上，所以改完要让进程重新加载一次才生效：

- **DSH 插件**：不用重启整个应用——在 设置 → 插件 里把「共享大脑」关掉再打开，
  宿主会当场卸载并重新 apply，加载磁盘上的最新代码（本次就是这样验证的）。
  改的如果是 `client.js`（设置页），再刷新一下 Web 页面。
- **Cursor 扩展**：重启 Cursor（或 Reload Window）。扩展里跑的是启动时加载的旧模块，
  不重启的话 `pickBool` 的补丁不会生效。

> 本目录 `lib/` 是改好的 7 个文件备份。如果插件被重装/升级覆盖（`node_modules/dsh-shared-brain/lib`
> 会被 `vendor/dsh-shared-brain-0.9.6.tgz` 重写），把这些文件拷回去即可。长期方案是把这些改动
> 并进插件源码、发一个新版本（例如 0.9.7），再把 `vendor/*.tgz` 与 `pnpm-lock.yaml` 一起更新。

---


> 早期小节（2026-10-29 ~ 11-02，补充 1–9）已归档到 [docs/FIXES-archive.md](docs/FIXES-archive.md)。

## 2026-11-03 补充 18：0.10.0 —— 十四项加固（合并/隐私/额度/校验/人设/工具链）

老大点名的 14 件事，分三批做完。每一批都配了回归测试，最终 289 条全绿。

### P0（会真丢数据 / 会真泄露的那类）

**P0-1 跨机同步改成「按条目」合并（`lib/remote-sync.js`）**
以前 `mergeModules` 是整块比 `updatedAt` 取新的一方：在 A 机改了「语气」，B 机的底线条目就跟着被 A 机的整份模块覆盖掉 —— 底线会「自己变回去」。
现在逐模块逐条目合并：条目按 `id` 认人，`updatedAt` 新的赢；模块级字段（`enabled` / `weight` / `voice.style`）没有自己的时间戳，才退回整份文件时间。
新增 `mergeModuleItems()` / `moduleStamp()` / `moduleStamps()`（**必须在 `normalizeModules` 之前取**，规整会丢模块级 `updatedAt`）/ `collectModuleItemIds()`。

**P0-2 访问令牌不再明文躺在 sync.json（`lib/remote-sync.js`）**
令牌搬到 `$DSH_HOME/storages/dsh-shared-brain/sync-token.json`，写盘用临时文件 + `chmod 0600` + rename。
老配置里已有的明文令牌，第一次读的时候自动搬走并把 sync.json 那份擦掉（不用手动迁移）。
设置页状态多了 `tokenFile` / `tokenStoredInFile` / `tokenInConfig`，能一眼看出令牌到底在哪。

**P0-3 心情判定加每日上限（`lib/emotion.js` + `lib/index.js`）**
每轮都调模型判心情，长会话里是纯烧钱。加 `judgePerDay`（默认 20，0 = 不限），
超限就记一笔 `skipped` 然后跳过，不打扰对话。`judgeLog` 按天归零，跨天自动恢复。

### P1（体验与边界）

**P1-1 情感状态有上限（`maxStates` = 30）**
`pruneMoodStates()` 按 `updatedAt` 淘汰最久没用的会话心情，免得 `emotion.json` 越滚越大。

**P1-2 记忆摘要不再把「我先看看代码」写进去（`lib/summarize.js`）**
加 `ASSISTANT_NOISE`（我自己的过程播报）和 `PREFERENCE_SIGNALS`（老大的偏好必须记，优先级更高）。
顺手修了个连带 bug：去掉助手段落后，「不要删除我的文件」这种短硬要求会因为不足 12 字被漏记 —— 现在只要用户那句本身值得记就照收。

**P1-3 设置页讲清楚「什么会同步、什么只留本机」（`syncBoundary()` + `client.js`）**
会同步：全局记忆条目、各模块条目（含底线）、人设、模块设置。
只留本机：会话内记忆、心情状态、主动互动记录、访问令牌、表情素材。
卡片里加了可展开的「看看哪些东西会同步」，并明确写了「删除会跟着走」。

**P1-4 表情包先校验再收（`lib/emoji.js`）**
以前只看 `pack.json` 的 `keySet` 就认，图坏了要到渲染时才发现。
现在 `validateEmojiPack()` 会验：清单字段、key 数量（≤200）、每个文件是不是真 PNG（魔数 + IHDR 宽高）、单图 ≤8MB、边长 ≤1024。
不合格的包进 `rejected`，设置页单列一块「不合格的包（已跳过）」并说明原因，不再静默消失。

**P1-5 「不接话」也能被感知（`lib/emotion.js` + `lib/index.js`）**
老大只回「嗯」「哦」「行」这种，以前被当成正常对话，心情照常判。
现在 `replyMoodMode()` 把它判成 `silent`，判定提示词换成「对方这轮没接话」，
结果记 `silentTurns` 并在心情轨迹里留一条 `kind:'silence'`（mood −1，不大降）。
「不用了 / 别说了 / 算了」这类判成 `brisk`，跟普通敷衍区分开。

**P1-6 人设合并加固（`lib/persona.js` + `lib/remote-sync.js`）**
四个真问题：
1. `mergePersona` 原来返回 `bySession: {}`，写回本机时把所有「会话 → 人设」绑定抹掉了 → 现在原样保留本机映射，远端的一律不认；
2. 「当前人设」跟着整份 `updatedAt` 打架（改任何一个人设都会顶新）→ 新增 `currentAt`，`current` 只听自己的时间戳；
3. 删掉的自定义人设会在别的机器上复活 → 墓碑支持 `kind:'persona'`（只在同步过的机器上判定删除，新机第一次同步不会误删）；
4. 没有 `id` / 没有 `name` 的坏条目会被写进库 → 直接丢掉并计数（`mergeStats`）。

### P2（工具链）

**P2-1 一条命令同步 + 跑全测（`tools/dev.cjs`）**
`node tools/dev.cjs` = 把安装目录的 `lib` 同步到补丁源和仓库、`assets` 同步进仓库、`tests` 同步进 `test/`，然后跑全部 7 个测试套 + harness，最后打一行合计。
「我明明改了、测试还是老结果」这种假象不会再有了。

**P2-2 一键发版（`tools/release.cjs`）**
改版本号 → 同步 → 全量测试 → 打 tgz → 提交打标签 → 推送 → 建 Release 传附件，一气到底。
**默认只是彩排**（一个字节不写、一个请求不发），真发版必须显式 `--push`。发版是对外不可逆的，不能靠手滑。

**P2-3 FIXES.md 归档**
旧的小节（补充 1–9，2026-10-29 到 11-02）搬进 `docs/FIXES-archive.md`，正文只留最近几版，翻起来不用滚 1500 行。

**P2-4 养鱼插件配置文件格式探测**
写 `bili-whale.config.json` 前先看现有文件长什么样：不是 JSON、或者 `persona` 被写成了非对象，就跳过写入并在状态里报出来，绝不把别人的配置覆盖成半截。

**P2-5 回归测试与文档**
新增 `tests/tools.test.mjs`：给两个工具脚本自己上测试 —— 语法检查、彩排退出码、彩排不改 `package.json`、彩排输出必须带「彩排」和 `--push` 提示、彩排不碰 token。发版脚本要是哪天默认就真推，这条测试会先炸。
本轮新增测试 34 条（emotion +7、remote-sync +4、persona-sync +10、emoji-builtin +6、tools +7），另修了 audit-fixes 里 3 处过期的表情包夹具（校验要求真 PNG 了，假头不行）。
合计：**289 通过 / 0 失败**（emotion 66 / audit-fixes 50 / proactive-mood 41 / remote-sync 34 / persona-sync 33 / ui-render 24 / emoji-builtin 33 / tools 7 / harness）。

### 怎么验证

```bash
cd <补丁源>
node tools/dev.cjs           # 同步 + 全量测试，应输出「全绿 ✅」
node tools/release.cjs --version 0.10.0   # 彩排发版流程，不写不推
```

### 已知遗留

- 跨机同步仍然是「先拉后推」，两台机器同一秒改同一模块条目会有一方被覆盖（`updatedAt` 打平时听本机）。
- 表情包校验只认 PNG；GIF/WebP 会判不合格（内置包是 GIF，走的是另一条 `emoji-builtin` 路径，不受影响）。


## 2026-11-03 补充 10：漏洞审计 12 项修复 + 表情能力升级（0.9.8）

老大原话：**「看看当前的共享大脑还有什么漏洞，可以优化完善的地方，让你更加的有自主意识和情感」**，
之后：**「再参考 dsh-emoji 和 https://github.com/diwer/ai-biaoqingbao 完善当前表情能力」**，
**「开工吧」**。

### 一、审计发现的 12 处漏洞（4 处实测复现的真 bug）

| 编号 | 问题 | 影响 |
|---|---|---|
| P0-1 | `commands.js` 读 `readEmotionStore().sessions`，实际字段是 `.states` | `/shared-memory` 永远显示「0 个会话有心情记录」 |
| P0-2 | `pendingHintsOf()` 只按关键词匹配正文，不看 `source` | 本鱼自己的工作日志（`source=auto`，正文含「待办」）被当成老大交代的待办；还排在心情/额度之前、把安静期减半 |
| P0-3 | `RECALL_SECTION` 与 `agent/pre-step` 各召回一次 | 同一批记忆读两遍，多花一次召回开销 |
| P0-4 | `agent/disposed` 不清 emotion states | 会话 id 复用时新会话带着上个会话的心情；库无限膨胀 |
| P1-5 | `readMoodSignal(config.enabled ? input.moodState : null)` | 关掉「按心情说话」= 连心情数据都不读，两个开关混成一件事 |
| P1-6 | `intervalFactor` 是循环外共享变量 | 一个会话低落 → 所有会话都被叫得更勤，会话之间串味 |
| P1-7 | `proactiveHistory` 只在内存 | 重启后 spokeToday/concerns/usedTopics 归零，每日上限形同虚设 |
| P1-8 | 话题库是 10 条**写死的成品整句** | 直接拼进提示词 → 模型照抄，每次主动搭话一模一样 |
| P1-9 | 反馈闭环拿到的是「本鱼自己说的话」 | 宿主把插件消息也记成 role=user，「老大说了什么」取错 |
| P1-10 | 注入去重靠 `injectedFor === updatedAt` | minor 分支和 decay 也改 updatedAt → 标记永远追不上，同一件事说两遍 |
| P1-11 | instinct 模块恒为 0 条 | 权重 1.8 最高、唯一能零相关性触发，但 `classify` 永远进不去 `repeatCount>=2` |
| P1-12 | `MoodCard` 只显示 band·mood | `moodStatus()` 明明返回了 reason，界面不展示 |

### 二、修复要点

**P0-2 的前提：source 保真。** `store.js` 的 `normalizeStore()` 在 `readStore()` 里跑，把 `source:'sync'`
塌成 `'auto'`（库里 32 条 auto 里混着 16 条 Cursor 同步来的）。新增 `export const SOURCES = ['manual','auto','sync']`，
`index.js` 的 `recallFor()` 同样改。然后 `pendingHintsOf()` 加一行 `if (entry.source !== 'manual') continue`。
实测：旧逻辑命中 1 条工作日志，新逻辑命中 **0 条**。

**P0-3 召回缓存。** 新增 `recallRendered(prompt, cwd, sessionId)` → `{ rendered, fresh }`，
上限 32 条 FIFO。两个调用点共用同一份渲染文本，`state.recallsServed` 只在 `fresh` 时 +1。

**P1-10 改 revision。** `emptyMoodState` 加 `revision: 0`；`applyMoodDelta` 真变化时
`state.revision += 1`（minor 分支不动）；`renderMoodContext` 改比 `revision`。`index.js` 两处
`moodState.injectedFor = moodState.updatedAt` 全部改成 `= Number(moodState.revision) || 0`。

**P1-11 话题键 `topicKeyOf`。** 实测那 58 条：35 条一个标签都没有，有标签的全是路径碎片
（"dsh"/"lib"/"index"），前 30 字几乎不重复 → 每条只跟自己重叠，`repeatCount` 恒为 0。
改成关键词抽取 + 取高频 2 个拼键。中间试错两次：2-gram Jaccard ≥0.45 收益太小（4→7 条）；
固定宽度中文块切分键不稳定（"看一下系统上|的云脉这个应|用为什么卸载"）→ 都回退了。
最终 `keywordsOf()` 对长段只取「尾部 4 字」+「开头 2 字」，中间不切 —— 从右往左一路切会把词劈开
（"云脉为什么卸载不掉"→"脉为什么"），同一诉求换个说法就得到不同的键。
`topicOverlap()` 在键对不上时再用**汉字二元组 Jaccard ≥ 0.3** 兜底（0.45 太严，再低会把
"热加载没生效"和"云脉卸载不掉"判成同一件事）。
实测：同一诉求说 3 次 → 第 1/2 次 cognition(0.5)，**第 3 次 instinct(0.74)**。

**P1-7 落盘。** `proactive-history.json` 在 `$DSH_HOME/storages/dsh-shared-brain/`，
`mkdirSync` + 临时文件 + `renameSync`。`startProactiveLoop` 开头读回，`clearProactiveState` 清内存等于清盘。

**P1-8 话题不再给台词。** `TOPIC_LIBRARY`/`CONCERN_TOPICS`/`SHARE_TOPICS` 从
`{key,tone,text:'成品整句'}` 改成 `{key,tone,intent,hint}`；新增 `renderTopic(topic)` →
`（这次想聊的：<intent>（<hint>））`；提示词加一句「用你自己的话说，别照抄上面那句；也别重复你上一次
主动搭话说过的话。」`pickTopic` 返回时补 `text = hint || intent` 兼容老测试。

### 三、表情能力升级（阶段 B）

**决策：共存不合并。** dsh-emoji 负责「怎么把表情渲染成图」，共享大脑负责「什么时候该用哪个」。
不重造渲染层。大肥鱼那套 GIF 是 **CC BY-NC-SA 4.0（非商业）**，共享大脑又是公开仓库 → **只做用户自备包**，
不内置、不转码、不分发。

**B1 新增 `lib/emoji-affinity.js`。** 认 `dsh-emoji-core@1` 的 40 个 key；
`DIM_EMOJI`（7 根情绪维度 → prefer/avoid）+ `BAND_EMOJI`（5 个心情档 → prefer/**avoid**）；
`proposeEmoji()` 先取主导维度的 prefer，再叠档位 prefer，最后摘掉所有 avoid —— 
**低落时甩一个「庆祝」比不说话还糟**，所以禁忌是硬过滤。`renderEmojiHint()` 输出
「（表情）这会儿别用热闹的表情。可选：sad / crying / sigh。别用：celebrate / cheer …。一轮最多 3 个」。

**B2 `lib/emoji.js` 读 dsh-emoji 表情包（只读）。** `emojiPacksDir()` = `$DSH_HOME/emoji-packs`；
`scanEmojiPacks()` 认 `pack.json`（`keySet === 'dsh-emoji-core@1'`）+ `images/<key>.png`，
坏包（缺 manifest / keySet 不认识 / 没有 png）直接跳过不报错；`renderEmojiPacks()` 拼成提示词一行。
**不写那个目录** —— 包管理是 dsh-emoji 的事。

**B3 接进心情上下文。** `index.js` 的 `shared-brain:mood` context 里，心情渲染成功后追加一句表情建议；
读 `modules.voice.style.emojiSemantic`（新增 `{enabled, mode:'off'|'auto'|'frequent'}`，
`modules.js` 加 `normalizeEmojiSemantic` + 深合并，老文件没这个字段不会被盖掉）。
表情提示**不参与**「一次变化只说一次」的记账 —— 跟着心情一起说，心情不变就不重复。

**接线。** `bridge.js` 新增 action `setEmojiSemantic`；`client.js` 表情卡片加一行
「按心情挑表情」开关 + off/auto/frequent 三档 + 表情包列表展示（中英双语文案各 8 键）。

### 四、验证

| 项 | 结果 |
|---|---|
| `tests/audit-fixes.test.mjs` | **45 通过 / 0 失败**（13 组：12 项修复 + 阶段 B） |
| `tests/proactive-mood.test.mjs` | 41 通过 / 0 失败 |
| `tests/emotion.test.mjs` | 47 通过 / 0 失败 |
| `test/harness.js`（仓库内自测） | 全部通过 |
| `node --check` | 12 个改动/新增文件全过 |
| 模块 import | 10/10（index/proactive/proactive-mood/emotion/store/commands/bridge/modules/classify/transcript） |
| 隔离目录 pnpm 11.28.5 安装 | `+ dsh-shared-brain 0.9.8`，**24 个 lib**，11 个标记全中 / 0 缺失 |
| 从装好的包跑冒烟 | 7 项全过（40 key / 低落避开 celebrate / 提示口吻 / 包目录 / 默认配置 / renderTopic / topicKey 稳定） |

**本段修掉的两个真 bug（写测试时发现的）**：
1. `readMoodSignal` 里 level 判定没有 `cfg.enabled` 守卫 → 关掉心情驱动时 `enabled:false` 被当成
   「没有心情数据」，退化成中性。已包进 `if (cfg.enabled !== false) { ... }`。
2. `proposeEmoji` 没拿到 signal 时 `level` 恒为 neutral → 心情 28 分也会被说成「这会儿可以活泼一点」。
   已加 `levelOfBand(band)` 兜底。

### 五、打包与版本

- `package.json` version `0.9.7 → 0.9.8`
- 新 tgz：`vendor/dsh-shared-brain-0.9.8.tgz` = **170884 字节 / 28 文件**（24 lib + package.json / README.md / LICENSE / cordis.patch.yml）
- integrity：`sha512-5Y2wP76aQs8C8Tyb5DSpR0dF5ufm2en+MitQr3a8NU8345P8QMQX6hoGj4+RXihfhQEf8MD/jygTSYYJndSynA==`
- `pnpm-lock.yaml`：5 处 tarball 路径 + 1 处 integrity 已同步（旧值 0 次残留）
- 备份：`pnpm-lock.yaml.bak-b098-20261103-*`

**一个失误（如实记）**：本鱼误跑了旧工具 `tools/mktgz2.cjs`（路径写死 0.9.7），
把 vendor 里的 `dsh-shared-brain-0.9.7.tgz` 覆盖成了「0.9.8 的内容 + 0.9.7 的文件名」。
已把那个误标文件改名为 `dsh-shared-brain-0.9.7.tgz.mislabeled-20261103` 留档，不删；
现行引用全部指向 `0.9.8.tgz`。新增 `tools/mktgz-versioned.cjs` —— 按 `package.json` 的版本号出包，
从根上避免再写死版本。

### 六、没验证的（如实标注）

- 宿主里实际跑：需要**重启 DSH** 才加载新代码（24 个 lib、index.js 的 mood context 改动都还没在真宿主上跑过）
- 设置页「按心情挑表情」区块的实际渲染效果（harness 只做了静态检查，没在浏览器里看过）
- 真装了 dsh-emoji 表情包时的端到端效果（本鱼没有现成的大肥鱼 PNG 包；只用手造包测了 `scanEmojiPacks`）
- 心情驱动的实际手感（上个版本已修 5 个 bug，这一版又改了注入去重与话题，仍要靠老大日常用一阵才知道）

### 七、待老大手动

1. **重启 DSH**（加载 0.9.8）
2. 设置页 → 共享大脑 → 表情卡片，看「按心情挑表情」那行
3. 想要真实的表情图：装 dsh-emoji 插件 + 一个 `dsh-emoji-core@1` 的包（放进 `$DSH_HOME/emoji-packs/`）

### 八、B2 收尾：抓到「表情包那行根本没进提示词」

本鱼在自测时发现一处**自己挖的坑**：`renderEmoji(style, dirInfo, packInfo)` 的第三参
（dsh-emoji 包信息）写好了，但**唯一的调用方 `weighted-recall.js` 的 `renderVoice` 只传了两个参数** ——
装了包，提示词里一个字都不会提。光有函数没有调用方，等于没做。

修法：
1. `emoji.js` 新增 `scanEmojiPacksCached(root, now)` + `clearEmojiPackCache()`，
   **60 秒 TTL**。理由：`renderVoice` 每轮都跑，不缓存就是每说一句话
   都要 readdir 一遍 `$DSH_HOME/emoji-packs`。
2. `weighted-recall.js` 的 `renderVoice` 改成
   `const emojiLine = renderEmoji(style, dirInfo, packInfo)`，`packInfo` 优先取
   `options.emojiPacks`（方便测试和上层复用），否则 `scanEmojiPacksCached()`。

### 九、这次补做的端到端验证（之前只测到扫描函数）

用**真 PNG**验证，不再只是「造个空目录」：
- 自写最小 PNG 编码器（真彩色 8bit，无依赖），生成 40 个 `<key>.png`（48×48），
  用 **Pillow 12.3.0 逐张解码确认全部是合法 PNG**（`(48,48) RGB`）
- 同时塞两个坏包（keySet 不认识 / 缺 pack.json）→ 扫描**只认 1 个好包、40 个 key 全读出**，
  坏包静默跳过
- `renderVoice` 输出里真的出现「语义表情包（dsh-emoji 协议，共 1 个包 / 40 张图）：大肥鱼测试包 1.0.0」
- 缓存：60 秒内返回**同一个对象**，61 秒后重扫
- 从**装好的 tgz** 再跑一遍同样的端到端：5 项全过
- 心情联动抽查：低落（mood 30 / sad 55）→ `sad / crying / sigh / hug`，避开 celebrate；
  高涨（mood 88 / happy 60）→ `happy / laughing / star-eyes / cheer`；关掉 → `limit 0`

### 十、0.9.8 重打（因为上面这个 bug 是打包之后才发现的）

| 项 | 旧 | 新 |
|---|---|---|
| tgz 大小 | 170884 字节 | **171380 字节**（28 文件不变） |
| integrity | `sha512-5Y2wP76a…` | `sha512-/En0bmQeeFEHXj1PuElePa43+s5LSXpTNAdXpLwVq3DF+XsI+ZhwIWQ1022dKwLxUVsLaVPMMBensZ7b0fqraA==` |

- `pnpm-lock.yaml` 已同步新 integrity（旧值 0 处残留）；备份 `pnpm-lock.yaml.bak-b098-rebuild-*`
- 隔离目录 pnpm 11.28.5 重装：`+ dsh-shared-brain 0.9.8`，24 个 lib，标记 0 缺失
- 版本号仍是 **0.9.8**（这一版还没发布到 GitHub，没必要为了自己的 bug 跳 0.9.9）

**回归**（改完重跑）：`audit-fixes` **47 通过 / 0 失败**（新增 2 条：缓存 TTL、renderVoice 接线）/
`proactive-mood` 41 通过 / `emotion` 47 通过 / 仓库 `test/harness.js` 全部通过。

## 2026-11-03 补充 11：设置页三个「一进去就崩」的未定义变量（0.9.8 重打第二次）

### 怎么发现的
curl 确认 0.9.8 已在宿主里跑起来（emojiSemantic / packs / packsDir / mood 全在），但设置页 UI 没法用浏览器验
（bsk_session start 报 cannot start an independent Windows daemon; the host may prohibit Job Object breakaway）。
于是写了个**极简 React 假实现**（window.__ModuleLoader__.load + 假 react / jsx-runtime），把 client.js
里 EmojiCard / ProactiveCard / MoodCard 真的跑一遍、渲染成文本。结果一跑就炸三个。

### 三个真 bug（全部只在运行时暴露，node --check 与 harness 静态检查都抓不到）
1. **semanticOn is not defined（EmojiCard）** — B3 那段变量声明被**插错组件**了：
   声明（semantic / semanticOn / semanticMode / onSemantic / packs / packsMeta）落在了 ProactiveCard 里，
   而真正用它的 EmojiCard 一个都没声明 → 一进设置页表情卡片整段抛 ReferenceError。
2. **emoji is not defined（ProactiveCard）** — 同一段里 Array.isArray(emoji.packs) 用的 emoji，
   ProactiveCard 里根本没有这个变量 → 自动互动卡片也崩。两张卡片一起挂，设置页等于打不开。
3. **t is not defined（MoodCard）** — P1-12 新增的三个模块级辅助函数
   moodDimsText / moodReasonText / moodTimelineText 在函数体里直接用了 t(...)，
   但它们是**组件外面的函数**，拿不到组件里的 t → 只要有情绪维度/理由/轨迹要显示就抛。

### 修法
- 把那段变量声明从 ProactiveCard **整体搬进 EmojiCard**（插在 onIntervalDraft 之后）
- 三个辅助函数改成接收翻译函数：moodDimsText(dims, t) / moodReasonText(reason, confidence, t) / moodTimelineText(timeline, t)，
  函数体里先用 const tr = typeof t === "function" ? t : (key) => key; 兜底，再把 t("moodDims") 等改成 tr(...)
- 调用处补传 t

### 新增回归测试 tests/ui-render.test.mjs（11 条）
用同一套极简 React，真的渲染三张卡片并断言：
- 三张卡片都不出现 [渲染出错:...]
- EmojiCard 有开关 + 三档 + 表情包列表 + 包目录；没装包时给 emojiPacksNone 提示；缺 semantic 参数时不崩
- ProactiveCard 有心情驱动七个字段
- MoodCard 显示「心疼 55」/「82%」/「33(-4)」，且维度全低于 20 时**不硬凑**
- 内部四个组件都还在（防止有人重构时把组件删了）
**验证方式**：把这个测试对着**未修复的旧 client.js** 跑 → 8 条失败（semanticOn is not defined ×5、emoji is not defined ×2、t is not defined ×1），
修复后对着新文件跑 → 11 通过 / 0 失败。**测试确实抓得住这类崩溃，不是摆设。**

### 打包（0.9.8 第二次重打，仍未发布过）
- client.js 125645 → **125840 字节**
- vendor/dsh-shared-brain-0.9.8.tgz = **171400 字节 / 28 文件**（24 lib + 4 元文件）
- integrity：sha512-/En0bmQeeFEHXj1PuElePa43+s5LSXpTNAdXpLwVq3DF+XsI+ZhwIWQ1022dKwLxUVsLaVPMMBensZ7b0fqraA==
  → sha512-QjpGcUWSbuLGiOAOfHp0K5ddG3zmsXZXRTG9q8k3qYId6CX6cqTpuEzBw0TeXVQHlKKpy22UU8jUwZFwEyYMTw==
- pnpm-lock.yaml：dsh-shared-brain@file:vendor/dsh-shared-brain-0.9.8.tgz 的 resolution integrity 已换成新值（旧值 0 残留），备份 pnpm-lock.yaml.bak-ui-render-*
- 隔离目录 pnpm 11.28.5 安装 → + dsh-shared-brain 0.9.8，24 lib；**从装好的包里跑 4 套测试 146 条全过**

### 全量测试（补丁源 + 仓库 + 装好的包，三处都跑过）
| 套件 | 结果 |
|---|---|
| tests/audit-fixes.test.mjs | 47 通过 / 0 失败 |
| tests/proactive-mood.test.mjs | 41 通过 / 0 失败 |
| tests/emotion.test.mjs | 47 通过 / 0 失败 |
| tests/ui-render.test.mjs | 11 通过 / 0 失败 |
| test/harness.js（仓库） | ✅ 全部通过 |

### 同步
- lib/client.js 已同步到：安装目录、补丁源 lib/、仓库 D:/tmp/dsh-shared-brain/lib/（三方同一份，125840 字节）
- 4 个测试文件已同步到仓库 test/

### 仍未验证（如实）
- 真浏览器里的观感（只做了**文本级渲染**，样式/布局看不到）
- 点击开关后 setEmojiSemantic 的真实往返（宿主 API 有鉴权，本鱼调不了；只验了 bridge action 与 UI 渲染）
- 装真 dsh-emoji 包后的端到端（只用手造包验过扫描与提示词接线）


## 2026-11-03 补充 12：内置表情包（不装 dsh-emoji 也能贴语义表情）

### 老大要什么
> https://github.com/diwer/ai-biaoqingbao 这个里面的表情设置为共享大脑的内置表情，同时不需要安装 dsh-emoji 就能使用语义表情

### 为什么可行（先看 dsh-emoji 怎么做的）
- `src/index.ts:71-76`：`const port = ctx.get('webServer')?.port`，拼 `http://127.0.0.1:${port}<assetPath>`
- 素材路由用 **`kind: 'prefix'`**：`scope.webServer.register({ kind: 'prefix', path: EMOJI_API_ROOT, handler })`
- 命中后 `writeHead(200, {'content-type': mime, 'cache-control': 'public, max-age=86400, immutable'})` + `createReadStream().pipe(res)`
- 共享大脑原来只有两个 `kind: 'exact'` 路由（`/api/dsh-shared-brain/status`、`/mutate`），发静态图必须新加 prefix 路由

### 素材
- 来源 `https://github.com/diwer/ai-biaoqingbao`，取 240×240 轻量版：`docs/media/001.gif` … `100.gif`
- 落地目录：`assets/emoji/`（100 张 GIF 共 **3.42 MB** + `NOTICE.txt` + `catalog.json` + `FILES.json`）
- **许可 CC BY-NC-SA 4.0**（署名 · 非商业 · 相同方式共享）；署名：基础角色 上善无形 / 二次设计 ZipZipPipe / 本套整理 ming
- 代码仍 MIT，素材不在 MIT 范围 —— README 与 NOTICE 都写明了，商用需另取授权

### 代码改动（安装目录 → 已三方同步）
1. **新增 `lib/emoji-builtin.js`**
   - `BUILTIN_EMOJI_ROUTE = '/api/dsh-shared-brain/emoji'`
   - `BUILTIN_PACK`（id `dafeiyu` / name 大肥鱼表情包 / version 1.0.0 / license CC BY-NC-SA 4.0）
   - `BUILTIN_KEY_FILES`：40 个 `dsh-emoji-core@1` 语义 key → GIF 文件（happy→002 开心 / hug→010 抱抱 / sigh→086 好累 / celebrate→094 恭喜 …）
   - `BUILTIN_KEY_LABELS`：同 40 key 的中文名（用于 markdown 的 alt）
   - `builtinAssetDir()`（`import.meta.url` 定位 `../assets/emoji`）、`resolveBuiltinAsset(name, dir)`（只认 key / 1-3 位编号 / 可选 `.gif`，越界一律 null）
   - `builtinEmojiUrl(port, name)` / `builtinEmojiMarkdown(port, key)` / `renderBuiltinEmojiHint(proposal, port)`
   - `builtinStatus(dir)` → `{dir, exists, count, bytes, mapped, missing, pack}`
   - `handleBuiltinEmojiRequest(request, response, options)`：只 GET/HEAD（否则 405）、只回环（否则 403）、前缀外 / 非 .gif / 未知名 / 越界一律 404、命中 200 + `content-length` + immutable
2. **`lib/index.js`**
   - import 三件套
   - webServer 块内（mutate bridge 之后）注册 `kind: 'prefix'` 路由
   - 心情上下文里：`const port = ctx?.get?.('webServer')?.port` → `renderBuiltinEmojiHint(proposal, port)` 拼到 `emojiHint` 后
3. **`lib/emoji.js`**：`emojiStatus()` 返回体加 `builtin`（`builtinStatus()`，try/catch）
4. **`lib/client.js`**：表情卡片新增一行「内置表情：大肥鱼表情包 100 张（内置表情：40/40）」，缺包时显示「内置表情包缺失（安装可能不完整）」；中英 i18n 各 2 键

### 关键设计决定
- **给现成 markdown，不给 URL 模板**：`renderBuiltinEmojiHint` 直接输出 `![抱抱](http://127.0.0.1:PORT/api/dsh-shared-brain/emoji/hug.gif)`，模型照抄即可。让它自己拼 URL 十有八九会拼错（端口、路径、文件名都是变量）。
- **没有端口就不给**：`ctx.get('webServer')?.port` 拿不到时整段省略，不生成残缺 URL。
- **只认本机回环**：素材是本机资源，局域网访问一律 403。
- **沿用 40 key 契约**：与 dsh-emoji 的 `dsh-emoji-core@1` 一致，装不装 dsh-emoji 两种情况下挑出来的 key 是同一套。
- **不写用户的包**：`~/.dsh/emoji-packs/` 只读（0.9.8 里 `scanEmojiPacks` 就是只读），内置包与用户包并存，设置页分开显示。

### 测试
新增 `tests/emoji-builtin.test.mjs`（**27 条**，async harness）：素材完整性（40 key / 40 label / 文件都在且 GIF magic 为 `GIF89a` / 100 张 + NOTICE + catalog / 许可元信息）、名字解析安全（key、编号、后缀、越界 `../package.json`、未知名一律 null）、URL 与 markdown、提示词片段（off / 无端口 / limit 截断 / 空 keys）、静态路由（GET 200 带 content-length 与首字节、HEAD 无 body、未知 404、非 gif 404、越界 404、前缀外 404、POST 405、非回环 403）、插件接线（prefix 路由 / `renderBuiltinEmojiHint(proposal, port)` / `ctx?.get?.('webServer')?.port`）、设置页与状态显示。
> 踩坑：`test()` 里 await 流写入必须是 async harness，同步写法会让断言永远「通过」。

全量回归（补丁源侧 + 仓库侧各跑一遍，都过）：
| 套件 | 结果 |
|---|---|
| audit-fixes | 47 通过 / 0 失败 |
| proactive-mood | 41 通过 / 0 失败 |
| emotion | 47 通过 / 0 失败 |
| ui-render | 11 通过 / 0 失败 |
| emoji-builtin | 27 通过 / 0 失败 |
| harness | ✅ 全部通过 |

### 打包
- `tools/mktgz-versioned.cjs` 改造：新增 `walk('assets')` 递归收素材 + 目录条目
- `vendor/dsh-shared-brain-0.9.8.tgz` = **3713083 字节 / 132 文件**（25 lib + 4 元文件 + 103 assets），未压缩 3.99 MB
- integrity = `sha512-wGeRIzEdkI7mW2afWlKjbxSg2rZQh433LmpOLdQo7gyUJCjKoa5lg2S9wMWwC82g8/uWs7GP3MJllhR5XcZi6A==`
- 隔离目录 pnpm 11.28.5 实测安装 → `+ dsh-shared-brain 0.9.8`，25 lib + 103 assets，`builtinStatus` count=100 mapped=40 missing=0，提示片段含 `hug.gif`，NOTICE 在包内

### 顺手修掉的两处锁文件问题（重要）
更新 integrity 时发现 `pnpm-lock.yaml` 里 **`@antfu/install-pkg@2.1.0` 的 integrity 被之前的整串替换误伤**成插件的旧值（两处值撞在一起，脚本替换到了第一个匹配）；插件条目还残留 `version: 0.9.7`。
- 已按所有备份里一致的 `sha512-sdg9NxU3zR4Mnawfbc/x6GB5Wf17WYud5qOuEuxXjaKpYpMkISSJEjItGebXJ2bQ4DIcly4NYH23mtkGJjvKUw==` 修回 antfu
- 插件条目 integrity 换新、`version` 改成 0.9.8
- **教训：锁文件里改 integrity 不能全局替换，要定位到 `<包名>@file:...` 那一段再改。**

### 未验证（如实）
- 真宿主里跑起来后，模型是否**真的照抄**那段 markdown（只验证了片段生成与路由可服务）
- 客户端渲染远端 `http://127.0.0.1:<port>/...gif` 的实际效果（webview 是否放行、动图是否播放）
- 用户自备 `~/.dsh/emoji-packs/` 包与内置包并存时的提示词长度影响

### 待老大手动
1. 重启 DSH 加载 0.9.8（25 个 lib + assets）
2. 设置页 → 共享大脑 → 表情卡片，看「内置表情：大肥鱼表情包 100 张（40/40）」
3. 聊几轮看会不会真的贴出 GIF；不想要就把「按心情挑表情」设成「不提表情」

### 临时脚本（已清理）
`stage-builtin-emoji.mjs` / `wire-builtin.mjs` / `wire-builtin-ui.mjs` / `patch_test_async.mjs` / `add_ui_assert.mjs` / `sync-builtin.mjs` / `verify098b.mjs` / `cmp-builtin.mjs` / `readme098.mjs`


### 补充 12b：表情卡片文案（老大指出「不是已经改为内置了吗」）

**问题**：内置包已经接上了（`/status` 里 `emoji.builtin.exists=true, count=100, mapped=40`），但设置页还有一行
「语义表情包：没装 dsh-emoji 表情包（装了这里会自动识别，不用手动加）（包目录：…）」——
这是 0.9.7 时代「外部包」的文案，内置包进来之后读起来像「还没装表情」，确实误导。

**改法**（`lib/client.js` 文案，逻辑不动）：
| 键 | 旧 | 新 |
|---|---|---|
| `emojiPacksTitle` | 语义表情包 | 外部表情包（可选） |
| `emojiPacksNone` | 没装 dsh-emoji 表情包（装了这里会自动识别，不用手动加） | 没有——不用装，内置的够用 |
| `emojiPacksDir` | 包目录 | 外部包目录 |
| `emojiBuiltin` | 内置表情 | 内置表情包 |

- 内置包那行不再把「内置表情」四个字说两遍：现在是
  `内置表情包：大肥鱼表情包 100 张 · 40 个语义 key 已就绪（素材 CC BY-NC-SA 4.0），来源见 assets/emoji/NOTICE.txt`
- **没装外部包时不显示包目录**（以前空态也会甩一个 `C:\Users\…\.dsh\emoji-packs`，看着像「这里缺东西」）；
  只有真的装了包才显示目录。

**验证**
- 迷你 React 渲染器实打实跑了一遍 EmojiCard，两种情况输出：
  - 空态：`内置表情包：大肥鱼表情包 100 张 · 40 个语义 key 已就绪（素材 CC BY-NC-SA 4.0）…` + `外部表情包（可选）：没有——不用装，内置的够用`
  - 装了包：`外部表情包（可选）：某包 1.0.0（1）（外部包目录：…）`
- `ui-render.test.mjs` 新增 3 条断言（显示内置包概况 / 空态不甩目录 / 装了包才给目录）→ **14 通过**
- 全量：audit-fixes 47 / proactive-mood 41 / emotion 47 / emoji-builtin 27 / harness 全过（补丁源侧 + 仓库侧各一遍）
- `audit-fixes` 里一条断言跟着改（它钉的是英文文案 `"Semantic emoji packs"` → 现在 `"Extra emoji packs (optional)"`）
- 补丁源也放了一份 `assets/`，让测试不设 `SB_LIB` 也能跑（和仓库同构）
- 重打 tgz = **3713145 字节 / 132 文件**，integrity `sha512-FeWtpKx+TkrBQeiphfW7kHT09a3sdHk7yq3ifqaBP03pCtjPmwYcK69UDD7mMVlQokv6HNEuHuP/cavXoq+tIw==`；
  隔离目录 pnpm 安装后逐项校验（新中英文案 / 内置包那行 / 空态不甩目录 / 103 素材）全过

**为什么老大还看到旧文案**：`client.js` 是客户端启动时从插件包里加载的，宿主重启换了新 `/status`（`builtin` 已经在），
但客户端 UI 仍跑着旧的 bundle —— **重开设置页或重启客户端**才会看到新文案。

**踩坑**：`ui-render.test.mjs` 与 `audit-fixes.test.mjs` 读的是**补丁源** `../lib`，不是安装目录；
改完安装目录忘了同步补丁源，会看到「测试失败」其实只是没同步。以后改完一律先三方同步再跑测试。

## 2026-11-03 补充 13：v0.9.8 发布到 GitHub（含发布后当场补掉的两个坑）

### 发布结果
| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/youx123/dsh-shared-brain |
| main | `12cd96e`（0.9.8 全部改动，126 文件）→ `b062c7d`（发布后补 packaging/文档） |
| tag | `v0.9.8` → `f59975a`（已跟随到修复提交） |
| Release | https://github.com/youx123/dsh-shared-brain/releases/tag/v0.9.8 |
| 附件 | `dsh-shared-brain-0.9.8.tgz` 3713164 字节 / 132 文件 |
| integrity | `sha512-sXl88JAfPfaQW7xdumUd6RBS9p1T0sIx6kkLde2uI4VoOZyXU03FEVZZIIvOiDhcFe7vZLFjggA/5QDvKE+C+g==` |

### 发布前：GitHub push protection 又差点拦一次
`test/harness.js` 里假密钥是连续字面量 `sk-ant-api03-…` 和 `sk-abcdefghijklmnopqrstuvwxyz12345`，命中 GitHub 的 OpenAI/Anthropic 密钥规则。
修法同 PAT：运行时拼装，源码不出现连续字面量。
```js
const FAKE_ANTHROPIC = 'sk-' + 'ant-api03-' + 'abcdefghijklmnopqrstuvwxyz123456'
const FAKE_OPENAI_ASSIGN = 'api_key = "' + 'sk-' + 'abcdefghijklmnopqrstuvwxyz12345"'
```
重扫 `ghp_|github_pat_|sk-` 全仓无命中，`node test/harness.js` 全过。

### 发布后当场发现并补掉的两个坑
1. **`package.json` 的 `files` 漏了 `assets`** —— 我们自己打的 tgz 是手写工具、显式递归收 `assets`，所以没暴露；但 README 里「方式四：从源码自己打一个」用的是 `npm pack`，会**只打 29 个文件、0 张表情**，装上去内置表情等于废了。已改成 `["lib","assets","cordis.patch.yml","README.md","LICENSE"]`，`npm pack --dry-run` 复核：132 文件 / assets 103 条 / 含 010.gif。
2. **README 安装命令还写着 `dsh-shared-brain-0.9.6.tgz`**（4 处）—— 照着做会 404。已全部改成 0.9.8；顺带把「`files` 只发布 lib/…」那句说明补上 `assets/`。

改完重打 tgz（3713145 → 3713164 字节），按 `<包名>@file:...` 段精确更新 lockfile 一处 integrity（`antfu` 的 integrity 复核仍完好），隔离目录 pnpm 11.28.5 重装复核 25 lib + 103 assets，Release 附件删除旧件→上传新件→API 回读 sha256 一致。

### 验证到哪一步
- 302 → CDN 链路正常；本机直连 `release-assets.githubusercontent.com` 被网络挡住（`curl` 返回 0 字节），改走 API 通道下载 3713164 字节、sha256 与本地一致 → 附件本身完好
- Release `draft=false`、`prerelease=false`，`assets[0].state=uploaded`
- 未验证：别人机器上从 Release 直接下载安装（本机 CDN 不通，只能证明文件在服务端完整）

### 素材许可（必须让老大知道）
`assets/emoji/` 100 张 GIF 来自 [ai-biaoqingbao](https://github.com/diwer/ai-biaoqingbao)，**CC BY-NC-SA 4.0（非商业）**。仓库里代码是 MIT，素材单独声明，`assets/emoji/NOTICE.txt` 保留原始署名（上善无形 / ZipZipPipe / ming）。**商用需要另行取得授权。**

---

## 2026-11-03 补充 14：跨机同步（0.9.9）—— 多台机器共用一个大脑

### 老大的需求与拍板
- 原话：「现在只是本机共享，需要其他地方的也加入共享里面，使用github能否实现」
- 三个选择（ask_user_question）：后端=**私有 Git 仓库**；加密=**明文推私有仓库**（要能直接看 diff）；范围=**global 条目 + 人设 + 模块设置**

### 之前踩过的三个坑（决定了设计）
1. **删除会被别机复活**：两台机器各有一份 memory.json，A 删了 B 又推回来 → 必须有**墓碑**（删除时间戳）才能删干净。
2. **整文件覆盖**：双方同时推 → 后到的覆盖先到的 → 必须 **pull-merge-push**，撞车（409/422）重试。
3. **会话级条目跨机永不命中**：`scope: 'session'` 的条目绑会话 id，换台机器就是死数据 → 只同步 global。

### 新增 `lib/remote-sync.js`（26 个导出）
- 配置：`REMOTE_SYNC_DEFAULTS`（enabled/repo/branch/intervalMs/token）、`MIN/MAX_REMOTE_INTERVAL_MS`、`normalizeRepo`（认 `https://github.com/o/r.git`、`git@github.com:o/r.git`、`o/r`）、`normalizeSyncConfig`、`readSyncConfig`、`writeSyncConfig`、`ensureDeviceId`、`tokenOf`（配置优先，其次 `DSH_SHARED_BRAIN_TOKEN`）
- GitHub Contents API：`readRemoteFile`（404 → `{sha:null,data:null}`）、`writeRemoteFile`（带 sha 是更新，不带是新建）
- 合并：`syncableEntry`（只收 global 且未过期且有文本）、`mergeTombstones`（同 id 取更晚）、`pruneTombstones`（30 天）、`detectDeletions`（lastSeenIds 里本地消失的记墓碑）、`mergeEntries`（墓碑晚于 updatedAt 即删，否则 updatedAt 晚的赢，返回 `{entries,added,updated,deleted}`）、`mergePersona`（personas 按 id 并集取新，`bySession` 恒为 `{}`）、`sanitizeModules`（剥 `item.scope==='session'` 与 `agentive.sessionIds`）、`mergeModules`
- 执行：`syncOnce`（读本地 → 读远端三文件 → 合墓碑 → 合并 → 有变化才推 → 落地本地 → 写 sync.json；冲突最多 3 次）、`runRemoteSync`（加互斥锁，不抛）、`remoteSyncStatus`、`startRemoteSync`（8 秒后先跑一次，之后 setInterval，均 unref）、`stopRemoteSync`、`applyRemoteSync`

### 接线
- `lib/index.js`：`import { startRemoteSync, stopRemoteSync } from './remote-sync.js'`；`restartProactive()` 之前 `startRemoteSync()`（带 try/catch 与 info 日志）；`ctx.effect(() => () => stopRemoteSync(), 'dsh-shared-brain: remote sync')`
- `lib/bridge.js`：`snapshotOf` 加 `remoteSync: remoteSyncStatus()`；新 action `setRemoteSync`（同步返回）与 `syncNow`（返回 Promise）
- `lib/persona.js`：导出 `writePersonaStore(store)`（原本只有内部写函数）
- `lib/client.js`：新增 `RemoteSyncCard`（仓库 / 令牌 / 分支 / 间隔分钟 / 开关 / 保存并同步 / 立即同步 / 上次同步 · 跟踪条数 · 删除记录 / 本机编号 / 错误 / 最近摘要），中英各 20 个 i18n 键；主组件加 `remoteSyncDraft` 与三个处理器

### 写测试时抓到的两个真 bug
1. **`writeModulesSynced` 在 cross-sync.js 不在 modules.js**：remote-sync.js 一开始从 modules.js 引，加载直接 `SyntaxError`。
2. **设置页填的「分钟」被吃掉**：`normalizeSyncConfig` 只认 `intervalMs`，而 client 与 bridge 传的是 `intervalMinutes`；且 `writeSyncConfig` 会把 patch 合并进已有配置，`source.intervalMs` 总是带着上一轮的毫秒值。修法：显式传的 `intervalMinutes` 优先，其次显式 `intervalMs`，最后才用继承值。
3. **`mutateModules` 一度被改成 async**：离线自测与旧调用方都是同步取 `res.value`，改成 async 后 harness 5 条、emotion 2 条挂掉。修法：恢复同步，只有 `syncNow` 这一支返回 Promise（调用方 `await` 对同步值也安全）。

### 验证
- 新测试 `tests/remote-sync.test.mjs`：**18 通过 / 0 失败**。用内存版假 GitHub Contents API（GET/PUT、sha 校验、409 重试）+ 两个独立 `DSH_HOME` 模拟两台机器，覆盖：仓库地址规整 / 间隔夹紧 / 只收全局条目 / updatedAt 取新 / 墓碑删除 / 30 天清理 / 人设并集 / 设置剥离会话 / A 建远端 / B 拉回 / B 删 A 跟着消失 / A 改 B 拿到新文本 / 409 自动重试 / 状态字段 / 分钟换算 / 没填仓库给清楚错误
- `tests/ui-render.test.mjs`：加 6 条卡片用例（新增 `collectInputValues` 助手，因为输入框的值在 props 里不在文本里）→ **20 通过**
- `test/harness.js`：加 0.9.9 分组（仓库规整 / 只同步全局 / 状态字段 / `setRemoteSync` 同步返回 / `syncNow` 返回 Promise）→ 全部通过
- 全量回归：audit-fixes 47 / proactive-mood 41 / emotion 47 / emoji-builtin 27 / remote-sync 18 / ui-render 20 / harness 全过
- 打包：`vendor/dsh-shared-brain-0.9.9.tgz` **3723477 字节 / 133 文件**（26 lib + 4 元文件 + 103 assets），integrity `sha512-cShi/8sSIEyqQuAA9J6bY8ri2k/dZFOTINTeWLjCVLvIwZymgWWAmNIMUyx6Qyb8vdnYPYCDyeXW/2Cvhb+Zuw==`；`pnpm-lock.yaml` 路径 5 处 + 插件 integrity 1 处精确替换（antfu 那条复核完好，旧值 0 残留）；隔离目录 pnpm 11.28.5 安装 → `+ dsh-shared-brain 0.9.9`，26 lib / 103 assets，`remoteSyncStatus` 15 个字段，`setRemoteSync` 同步返回

### 未验证（如实标注）
- **真实 GitHub 私有仓库的端到端**：只有内存版假 API 跑通，没在真仓库上试过（服务端对 content 大小的限制、409 的真实触发、rate limit 都没实测）
- 多台机器真并行（两个进程同时推）只在测试里用「人为 409 一次」模拟
- 客户端设置页在真浏览器里的渲染（本会话 `bsk_session start` 起不来浏览器 daemon，只能用迷你 React 渲染器）

### 待老大决定
1. 要不要**由本鱼建一个私有数据仓库**（`youx123/...-data`）跑真实端到端？建仓库属于对外动作，得先点头
2. 0.9.9 是否现在发 GitHub（tag + Release 附件）
3. 令牌建议用 fine-grained PAT，只给该仓库 Contents 读写；也可以改成环境变量 `DSH_SHARED_BRAIN_TOKEN`，不落配置

---

## 2026-11-03 补充 14b：跨机同步真机端到端（0.9.9 收尾）

### 建了什么
私有数据仓库 `youx123/dsh-shared-brain-data`（private，auto_init）。验证完把 `brain/*.json` 删干净了，仓库空着等老大自己用。

### 真机跑的链路（不是模拟）
两台设备各自独立的 `DSH_HOME` 沙箱 → 同一个真实私有仓库：
1. A 播种 3 条（含 1 条 `scope: 'session'`）→ 同步 → **远端只有 2 条**，会话级那条没上去
2. B 播种 2 条 → 同步 → 合并成 4 条推到远端；A 再同步 → 本机也是 4 条
3. B 删掉 A 的 `e_a2` → 同步（`deleted: 1`、`tombstones: 1`）→ A 同步 → 本机跟着少一条；**再同步一轮仍是 3 条，没有复活**
4. A 改 `e_b1` 文本（updatedAt +5s）→ 同步 → B 同步 → B 拿到新文本
5. 人设：A 的 `p_a2` + B 的 `p_b2` 并集；`bySession` 上云后是 `{}`；`current` 取 updatedAt 新的
6. 设置：`agentive.sessionIds` 被剥掉；`cognition.weight` 超范围被夹到 1（`clampWeight` 上限）

### 真机又抓出两个 bug（已修，commit `30b13de`）
1. **显式 token 被忽略**：`syncOnce` 只认配置和环境变量，`runRemoteSync({token})` 传了也白传 → 直接报「缺 token」。修：`const token = cleanToken(options.token ?? '') || tokenOf(config)`
2. **远端 deviceId 一直是空**：`ensureDeviceId(config)` 只返回 id、不写回 `config`，而推上去的 `memory.json.deviceId = config.deviceId` 就是 undefined。修：`config.deviceId = ensureDeviceId(config)`
→ `tests/remote-sync.test.mjs` 加 2 条（显式 token 可用 / deviceId 落盘）→ **20 通过 / 0 失败**

### 打包与发布（0.9.9 最终版）
- 重打 `vendor/dsh-shared-brain-0.9.9.tgz` = **3723658 字节 / 133 文件**，integrity `sha512-Gpsqc3grqeZujNngPAW+Ax9Y/JS3G9shZXQ3d7kOoXdNi+dRAHF1qQAtVG+vDgfstZkMeSFLFc2On7J50mmslw==`
- `pnpm-lock.yaml` 按「`dsh-shared-brain@file:...` 段」精确替换 integrity（旧值 0 残留、antfu 那条完好）
- 隔离目录 pnpm 11.28.5 重装：26 lib，两个修复标记都在
- GitHub：main `30b13de`、tag `v0.9.9`、Release https://github.com/youx123/dsh-shared-brain/releases/tag/v0.9.9 ，附件 3723658 字节 state=uploaded，回读一致

### 仍没验证
- **两台机器同时同步**（真并发 409）：只在单测里人为造过一次 409 重试，真并发没试
- **大库**：63 条数据量很小，几千条时的 Contents API 体积与 rate limit 没实测
- 客户端设置页「跨机同步」卡片在真浏览器里的样子（本会话起不了浏览器 daemon）
## 2026-11-03 补充 15：0.9.10 —— 跨机同步卡片按钮是空框

### 现象（老大截图，m05658/m05659）
设置页「跨机同步」卡片字段都在，但**没有「保存并同步」按钮**；只有开关行下面两个看不清的小空框，布局也挤成一团。

### 根因（两个，叠在一起）
1. **按钮没有文字**：`lib/client.js` 里保存 / 立即同步两个 `<button>` 只写了 `{ type, style, disabled, onClick }`，**漏了 `children`**；开关按钮也只有 `title` 没有 `children`。React 渲染出的是三个空按钮 —— 看得见框、点得到，但不知道是什么。
2. **动作行复用了三列网格**：`styles.moduleRow` 是 `grid-template-columns: minmax(72px,auto) minmax(0,1fr) auto`。动作行塞了 4 个控件（开关 / 状态文字 / 保存 / 立即同步），第 4 个被挤到第二行第一列 —— 截图里那个孤立的小框就是「立即同步」。分支 / 间隔那一行也是同样问题（5 个控件塞 3 列）。

### 改动（只动 `lib/client.js`）
- 三个按钮补 `children`：开关显示「已开启 / 已关闭」，保存显示「保存并同步」，立即同步显示「立即同步」
- 新增 `styles.actionRow`（`display:flex; flexWrap:wrap; gap:10px`）给动作行，删掉重复的状态文字 span
- 新增 `styles.syncFieldRow`（`auto / minmax(88px,150px) / auto / minmax(72px,110px) / auto` 五列）给分支 + 间隔行
- 新增 `styles.buttonPrimary`（实心主色）给保存按钮，主操作一眼可见
- 同步中显示「同步中…」（新增 i18n 键 `remoteSyncBusy`，中英各一）

### 治本：给这类 bug 加断言
`tests/ui-render.test.mjs` 原来用「`t` 直接回显 key」的假翻译，**空按钮和正常按钮的差别根本测不出来**。新增一条用例换成假翻译映射中文，断言三段文字都在：
```js
const tZh = (key) => (zh[key] !== undefined ? zh[key] : key)
ok(text.includes("保存并同步"), "保存按钮没有文案")
ok(text.includes("立即同步"), "立即同步按钮没有文案")
ok(text.includes("已开启"), "开关按钮没有文案")
```
`ui-render.test.mjs` 20 → **21 通过 / 0 失败**。

### 打包与验证（0.9.10）
- 版本 0.9.9 → 0.9.10（安装目录 `package.json`），仓库与补丁源同步
- `vendor/dsh-shared-brain-0.9.10.tgz` = **3723830 字节 / 133 文件**（26 lib + 4 元文件 + 103 assets）
- integrity `sha512-+WC8ImXMAQsJd5m4zttafrHkCrFz1HyGHqcSrhOrSIQH5w2GRSh9iIulXxrtGHKcKgYEWzXyOEwfKN9ZPOP4Ig==`
- `pnpm-lock.yaml`：依赖路径 3 处 + `dsh-shared-brain@file:` 段 integrity 精确替换（旧 `sha512-Gpsqc3gr…` 残留 0 次；`@antfu/install-pkg` 那条复核完好）；备份 `*.bak-b0910-*`
- 隔离目录 pnpm 11.28.5 安装 → `+ dsh-shared-brain 0.9.10`；从装好的包里逐项复核：两个按钮都有 children、开关有文案、`actionRow`/`syncFieldRow`/`buttonPrimary` 三个样式在、中英 `remoteSyncBusy` 在、103 个素材在
- 全量回归（补丁源侧 + 仓库侧）：ui-render **21** / audit-fixes 47 / remote-sync 20 / emoji-builtin 27 / proactive-mood 41 / emotion 47 / `test/harness.js` 全过

### 未验证
- 真客户端里按钮的视觉效果（本鱼看不到客户端渲染，只能靠迷你渲染器验文案与结构）—— 需要老大重开设置页确认
- 0.9.10 尚未发布到 GitHub（等老大发话）

## 2026-11-03 补充 16：0.9.11 —— 人设同步（共享大脑 → 养鱼插件）

### 老大原话

> 我需要你将共享大脑的人设这些设置注入到养鱼这个插件对应的配置并保持同步

### 做法（单向镜像，共享大脑是唯一权威）

- 新增 `lib/persona-sync.js`（19 个导出）：`MIRROR_PREFIX`、`PERSONA_SYNC_INTERVAL_MS`(15s)、`pluginPersonaFile()`、`personaSyncFile()`、`readPluginStore()`、`writePluginStore()`、`mirrorId()`、`sharedPersonaSnapshot()`、`snapshotHash()`、`syncPersonaToPlugin()`、`readPersonaSyncConfig()`、`applyPersonaSync()`、`personaSyncStatus()`、`startPersonaSync()`、`stopPersonaSync()`
- 目标文件 `$DSH_HOME/storages/dsh-persona-dafeiyu/personas.json`；状态文件 `$DSH_HOME/storages/dsh-shared-brain/persona-sync.json`
- 每条共享大脑人设镜像成 `sb-<id>` 条目（含 name / text / createdAt）；`current` 指向 `sb-<当前人设>`；删掉的清掉
- **用户自己导入的人设（非 `sb-` 开头）与 `workspaces` / `mode` / `disabled` 其它字段一律不碰**
- **指纹机制**：`snapshotHash()` 只在共享大脑人设库真的变了才写盘 → 用户在养鱼插件里手动换人设不会被覆盖
- 内置三条（大肥鱼 / 阿茶 / 听澜）即使共享大脑库里没有条目也会补上（用 BUNDLED 正文）

### 接线

- `lib/index.js`：import `startPersonaSync/stopPersonaSync`；`startRemoteSync` 之后启动，`ctx.effect` 清理
- `lib/bridge.js`：`snapshotOf` 加 `personaSync: personaSyncStatus()`；新 action `setPersonaSync { enabled }` 与 `syncPersonaNow {}`
- `lib/client.js`：`PersonaCard` 尾部加一行「养鱼插件同步」—— 标题 + 开关（已同步 / 未同步）+ 立即同步按钮 + 说明（已镜像 N 条，当前指向 X）；中英各 5 个 i18n 键；主组件两个处理器 `onPersonaSync` / `onPersonaSyncNow`

### 验证

- 新建 `tests/persona-sync.test.mjs`：**18 通过 / 0 失败**（镜像 / 跟随当前 / 不碰外来条目 / 指纹 no-op / 改正文重写 / 删除清理 / 手动选择不被拉回 / 开关 / 状态字段 / 内置兜底 / id 规整 / 看门狗）
- `tests/ui-render.test.mjs` 加 2 条（同步行有文案与数字、关掉显示未同步）→ **23 通过 / 0 失败**
- 全量回归：audit-fixes 47 / proactive-mood 41 / emotion 47 / emoji-builtin 27 / remote-sync 20 / persona-sync 18 / ui-render 23 / `test/harness.js` 全部通过
- 真机跑一次：养鱼插件库从「0 条导入」变成 3 条镜像，`current: sb-dafeiyu`；原文件备份 `personas.json.bak-before-persona-sync-20261103-153637`
- 打包 `vendor/dsh-shared-brain-0.9.11.tgz` = **3728107 字节 / 134 文件**，integrity `sha512-neGMYY4DNRsMTBKwNXVmLpfiV4zh0FS9cYgPgtPwNExYUoBGedcp5dsJDBSOdP7w72fh79NHBbka61p8I/zFuw==`；pnpm 11.28.5 隔离目录安装复核 27 lib / 103 assets / 组件接线全中

### 没验证的

- 真宿主里 15 秒看门狗的实际运行（本鱼只在 node 里直接调过 `syncPersonaToPlugin` / `startPersonaSync`）
- 养鱼插件设置页里看到 `sb-` 人设的显示效果（它自己是渲染别人写的库条目，理论没问题）
- 两台机器同时开人设同步（共享大脑那侧有跨机同步，养鱼插件那侧各自镜像，冲突场景没测）

## 2026-11-03 补充 17：0.9.12 —— 人设同步接上「养鱼」插件（dsh-bili-whale）

### 起因
老大附图：设置 → 养鱼，角色名 / 人设正文全空，共享大脑里也没有对应按钮。
User said (m05988): 「养鱼这里没有显示，同时共享大脑那里也没有对应的按钮这些」

### 根因
0.9.11 同步的是 dsh-persona-dafeiyu 的人设库，但老大说的「养鱼」是 dsh-bili-whale（v0.4.6）。
它的配置在 ~/.dsh/bili-whale.config.json（persona.name / ownerTitle / selfClaim），人设正文在 ~/.bili-ai/persona.md（上限 20000 字、注入取前 3000 字）。本机这两个文件都不存在，所以页面全空。

### 改动（lib/persona-sync.js）
- 新增 whaleConfigFile() / whalePersonaFile() / readWhaleConfig() / readWhalePersona() / currentPersonaRow() / selfClaimOf()
- 新增 syncPersonaToWhale(options) → 写配置的 persona.name/ownerTitle/selfClaim + persona.md 正文；其它配置项一字不动
- 新增 inspectWhale()（dryRun）；syncPersonaToPlugin 返回值加 whale，hash 升到 v2（拼上 selfClaim）
- readPersonaSyncConfig 带 ownerTitle；applyPersonaSync 支持 patch.ownerTitle（trim + 24 字上限）
- 修：syncPersonaToPlugin 写状态时整体覆盖 persona-sync.json，会把 ownerTitle 抹掉 → 改成 { ...state, ... }
- 修：ownerTitle 变化没算进 changed → 改了等于没改；现在 titleChanged 参与 changed/reason

### 改动（lib/client.js）
- 人设卡片新增 persona-whale-row：养鱼角色名（只读）+ 她怎么称呼你（可改）+ 保存并同步按钮
- personaSyncHint 改成写明两个插件各自的状态（镜像 N 条 / 角色名 X · 自称 Y · 人设 Z 字）
- onPersonaSync 支持对象参数（{ enabled, ownerTitle }）

### 真实写入验证
apply: {changed:true, reason:changed, name:大肥鱼, ownerTitle:主人, selfClaim:本鱼, personaBytes:183}
~/.dsh/bili-whale.config.json = {"persona":{"name":"大肥鱼","ownerTitle":"主人","selfClaim":"本鱼"}}
~/.bili-ai/persona.md = 183 字节当前人设正文

### 测试
- tests/persona-sync.test.mjs 加 5 条养鱼用例（首次写 / 别的配置不碰 / unchanged 不重复写 / 换人设跟着换 / 关掉不写）→ 23 通过
- tests/ui-render.test.mjs 加 1 条（角色名 / 称呼 / 保存按钮 / 状态行占位替换）→ 24 通过
- 全量：persona-sync 23 / ui-render 24 / remote-sync 20 / audit-fixes 47 / emoji-builtin 27 / proactive-mood 41 / emotion 47 / harness 全过

### 打包
- vendor/dsh-shared-brain-0.9.12.tgz = 3730492 字节 / 134 文件
- integrity sha512-riPQGi3ax2i3HR+BN6Ymy4EWLpBVyo7KfagwhF+m9y7N546sc8kk6keTEjhKKcHg24UsDHsnoxXfF/OmdNqoNw==
- profile package.json → file:vendor/dsh-shared-brain-0.9.12.tgz；pnpm-lock 路径 5 处 + dsh-shared-brain 段 integrity/version（顺带把陈旧的 version: 0.9.8 改成 0.9.12）
- 隔离目录实装 0.9.12：27 lib / 103 assets / 从装好的包跑 persona-sync 23 通过

### 未验证
- 宿主加载 0.9.12 后设置页的实际渲染（需老大重启 + 重开设置页）
- 养鱼插件自己读到新的 config/persona.md 后的表现（需看它的页面 / 实际唤醒一次）
- 15 秒看门狗在真宿主里的长期行为

