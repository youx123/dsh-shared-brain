const fs = require('fs')
const p = 'C:/Users/13176/Documents/dsh-shared-brain-patches/FIXES.md'
let s = fs.readFileSync(p, 'utf8')

const OLD_INTEGRITY = 'sha512-DC5X4PBP6gMvrxMIXPrxeFwR/Qwx+C57zM+boHi6A9Za+dEoodIGAL7AmC+D9ASl0ZMDy45g6XRA2oUsnffbg=='
const NEW_INTEGRITY = 'sha512-bCW410iikHBK6wgm8no0VnBzbcFE1ZKVS+0AXN19H2FmfRZZ2MWSw+ZDVLNDnwnwsd4gqck6m5B30DGrddjG/A=='

const section = `
## 2026-10-30 补充 2：自动互动间隔随机化 + duplicate 死循环修复

### 老大提的问题
「自动互动开了，没有按照间隔时间进行互动，将这个间隔时间改为随机的，不要定死了」

### 根因（三条叠加）
1. **固定间隔**：\`proactive.js\` 旧 \`timer = setInterval(tick, intervalMs)\` —— 死板周期，永远同一个点触发。
2. **\`duplicate\` 判定让定时器白跑（这才是「没互动」的直接原因）**：
   \`buildProactivePrompt()\` 的内容只依赖 cwd → 每次生成的提示词**完全相同** →
   \`nudgeAgent\` 里「和上次一样就跳过」的判定命中 \`SKIP_REASON.duplicate\`，
   **第一次成功之后的每一次 tick 都被挡掉**。
   运行时证据：\`proactive.runtime = {fired:1, skipped:6, lastSkipReason:"duplicate"}\` —— 定时器在跑，但永远发不出第二条。
3. **看门狗对账**（\`index.js\` \`syncProactive\`，每 30 秒一次）：原来比较 \`status.intervalMs === interval\`。
   改成随机间隔后**必须**只比「基准间隔」，否则每 30 秒都会重启定时器，随机间隔被钉死在第一次的值。

### 改了什么
#### \`lib/proactive.js\`
- 新增 \`export const PROACTIVE_INTERVAL_JITTER = 0.5\`（基准 ±50%）
- 新增 \`export function randomizeInterval(baseMs, rand = randomFn)\`：
  \`base × (1 - JITTER + rand() × 2×JITTER)\`，取整到整秒，再夹到 \`[MIN_PROACTIVE_INTERVAL_MS, MAX_PROACTIVE_INTERVAL_MS]\`
- 新增模块状态：\`lastIntervalMs\` / \`nextIntervalMs\` / \`nextFireAt\`
- \`buildProactivePrompt(context)\` 新增 \`nonce\` 参数，提示词末尾拼 \`（本次检查编号：\${nonce}）\` → **修掉 duplicate 死循环**
- \`nudgeAgent\` 里调用改为 \`buildProactivePrompt({ cwd, nonce: options.nonce ?? now })\`
- \`startProactiveLoop\` 从 \`setInterval\` 改为**自调度 setTimeout 链**：
  每次 tick 后重新算一个随机间隔再排下一次（\`setInterval\` 做不到「每次间隔都不一样」）
- \`stopProactiveLoop\` 改 \`clearTimeout(timer)\`
- \`proactiveStatus()\` 新增 \`lastIntervalMs\` / \`nextIntervalMs\` / \`nextFireAt\` / \`jitter\`
- \`clearProactiveState()\` 清掉这三个新字段

#### \`lib/index.js\`
- import 补 \`PROACTIVE_INTERVAL_JITTER\`
- \`syncProactive\` 保持只比**基准间隔**，并加注释说明为什么不能比实际间隔
- 启动日志改为「基准间隔 X 分钟（实际每次在 X*0.5~X*1.5 分钟之间随机）」

#### \`lib/commands.js\` / \`lib/bridge.js\`
- 状态与成功文案改成体现随机范围（例如「基准每 16 分钟问一次（实际在 8~24 分钟之间随机）」）
- import 补 \`PROACTIVE_INTERVAL_JITTER\`

#### \`lib/client.js\`
- 设置页新增提示行 \`proactiveIntervalHint\`：「这是基准间隔，实际每次触发会在 {min}~{max} 分钟之间随机浮动」
- 状态栏新增 \`proactiveNextFire\`（下次触发时间）
- 中英文案都加了

### 验证
- \`node --check\`：proactive.js / index.js / commands.js / bridge.js / client.js 全部 OK
- 功能测试 **31 passed / 0 failed**（\`aclr-rand/functest.mjs\`）：
  - \`randomizeInterval\` 2000 次采样不越上下界、有分散度、取整到秒
  - 注入 \`rand=0\` / \`rand≈1\` 命中上下界；基准 0 / 超大都能夹住
  - **关键回归**：同一 agent 连发 3 次（cooldown=0）全部成功，3 条内容互不相同、3 个 message id 互不相同
  - 冷却期内被 \`cooldown\` 挡掉（不是 duplicate）；相同 nonce 仍会被 \`duplicate\` 挡掉（判定保留）
  - \`proactiveStatus()\` 暴露 jitter / nextIntervalMs / nextFireAt / lastIntervalMs
  - \`startProactiveLoop\` 后 running=true、nextFireAt 在未来；\`stopProactiveLoop\` 后 running=false

### 根治（重打 tgz）
- \`vendor/dsh-shared-brain-0.9.7.tgz\` 已用**修好 checksum 的 tar 打包器**重打（25 个文件，119660 字节）
- \`package.json\` → \`"dsh-shared-brain": "file:vendor/dsh-shared-brain-0.9.7.tgz"\`（不变）
- \`pnpm-lock.yaml\` 的 integrity 已同步为
  \`${NEW_INTEGRITY}\`
- 安装目录 \`node_modules/dsh-shared-brain/package.json\` 的 version 也从 0.9.6 改成 0.9.7（否则装出来显示 0.9.6）
- 备份：\`package.json.bak-rand-20261030-170213\` / \`pnpm-lock.yaml.bak-rand-20261030-170213\`
- 真实 pnpm 11.28.5 隔离安装实测：\`+ dsh-shared-brain 0.9.7\`，21 个 lib 齐全，5 个随机间隔标记全中

> **踩坑记录（重要）**：自己用 Node 手写 tar header 时，checksum 算法写错了
> （校验和字段要按 **8 个空格**参与求和，不是 8 个 0），pnpm 会直接报
> \`ERR_PNPM_TARBALL_EXTRACT: Invalid checksum for TAR header at offset 0. Expected 2897, got 3153\`。
> 打包脚本：\`aclr-rand/mktgz2.cjs\`（含正确 checksum + ustar magic + mtime）。

### 补丁源目录已回灌
\`lib/proactive.js\` / \`index.js\` / \`commands.js\` / \`bridge.js\` / \`client.js\` 已同步到本目录，
上一版留存在 \`*.bak-20261030-rand\`。

### 老大还需要手动做的
1. 设置 → 插件 → 把「共享大脑」关掉再打开（宿主才会重新 apply 插件代码）
2. 刷新 Web 页面（改了 client.js）
3. 看设置页「自动互动」卡片：应显示随机范围提示 + 「下次触发」时间
4. 等一个周期看 \`fired\` 计数能否涨到 2 以上、\`lastSkipReason\` 不再是 \`duplicate\`
`

if (!s.includes('## 2026-10-30 补充 2：自动互动间隔随机化')) {
  s = s.trimEnd() + '\n' + section
  fs.writeFileSync(p, s)
  console.log('FIXES.md 已追加新段')
} else {
  console.log('FIXES.md 已有该段，跳过')
}
// 顺带更新旧的 integrity 引用
if (s.includes(OLD_INTEGRITY)) {
  let t = fs.readFileSync(p, 'utf8').split(OLD_INTEGRITY).join(NEW_INTEGRITY)
  fs.writeFileSync(p, t)
  console.log('旧 integrity 引用已更新')
}
console.log('长度:', fs.readFileSync(p, 'utf8').length)
