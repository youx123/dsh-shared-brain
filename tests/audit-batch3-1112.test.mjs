// 2026-11-12 第三批：SSRF 收紧 + 表情目录路径收紧 + remote-sync 命令 + judgePerDay/maxStates 可达 + 注入预算外露。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sb-batch3-'))
process.env.DSH_HOME = home

const { isPrivateHost, fetchPageText } = await import('../lib/web-learn.js')
const { isUnsafeEmojiPath, isForbiddenEmojiRoot, isInsideDir } = await import('../lib/emoji.js')

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok: Boolean(ok), extra })

// ── 一、SSRF：内网判定本身 ───────────────────────────────────────
for (const host of ['127.0.0.1', 'localhost', '[::1]', '169.254.169.254', '192.168.1.1', '10.0.0.5', '172.20.1.1', '100.64.0.1']) {
  check(`isPrivateHost(${host}) 认得出来`, isPrivateHost(host) === true)
}
check('isPrivateHost(example.com) 不当内网', isPrivateHost('example.com') === false)
check('isPrivateHost(8.8.8.8) 不当内网', isPrivateHost('8.8.8.8') === false)

// ── 二、SSRF：抓取入口的实际行为 ─────────────────────────────────
{
  const local = await fetchPageText('http://127.0.0.1:1/')
  check('抓本机地址被拒', local.ok === false && /不抓内网或本机地址/.test(local.error ?? ''), String(local.error))
}
{
  const meta = await fetchPageText('http://169.254.169.254/latest/meta-data/')
  check('抓云元数据地址被拒', meta.ok === false && /不抓内网/.test(meta.error ?? ''), String(meta.error))
}
{
  // 解析不出来的域名以前是直接放行的（等于把判断交给 fetch 的第二次解析），现在必须拒。
  const bad = await fetchPageText('http://this-domain-should-not-exist.invalid/')
  check(
    '解析不出来的域名不抓（不再放行给 fetch）',
    bad.ok === false && /域名解析不出来/.test(bad.error ?? ''),
    String(bad.error),
  )
}

// ── 三、表情目录路径 ────────────────────────────────────────────
check('UNC 路径照旧拒', isUnsafeEmojiPath('\\\\host\\share') === true)
check('带 .. 的路径拒', isUnsafeEmojiPath('D:\\zh\\..\\Windows') === true)
check('空字节拒', isUnsafeEmojiPath('D:\\zh\\a\0b') === true)
check('正常目录放行', isUnsafeEmojiPath('D:\\zh\\表情包\\共享大脑') === false)

check('系统目录拒', isForbiddenEmojiRoot('C:\\Windows\\System32') === true)
check('Program Files 拒', isForbiddenEmojiRoot('C:\\Program Files\\x') === true)
check('盘根拒', isForbiddenEmojiRoot('D:\\') === true)
check('老大的表情包目录放行', isForbiddenEmojiRoot('D:\\zh\\表情包\\共享大脑') === false)

check('子目录判定：在里面', isInsideDir('D:\\zh\\表情包', 'D:\\zh\\表情包\\共享大脑') === true)
check('子目录判定：不在里面', isInsideDir('D:\\zh\\表情包', 'D:\\zh\\其它') === false)

// ── 四、注入预算：以前只写不读 ───────────────────────────────────
{
  const mod = await import('../lib/index.js')
  const snap = mod.status()
  check('status() 里有 injectTrim 这个键', Object.prototype.hasOwnProperty.call(snap, 'injectTrim'))
}

// ── 五、命令层：remote-sync 与 judgePerDay ──────────────────────
{
  const { registerCommands } = await import('../lib/commands.js')
  let handler = null
  const ctx = {
    commands: {
      register: (def) => {
        if (def && typeof def.handler === 'function') handler = def.handler
      },
    },
    // 宿主把注册包在 effect 里（卸载时回收），这里照着走一遍。
    effect: (fn) => {
      try {
        fn()
      } catch (error) {
        check('effect 回调不抛', false, String(error?.message ?? error))
      }
    },
  }
  try {
    registerCommands(ctx)
  } catch (error) {
    check('注册命令不抛', false, String(error?.message ?? error))
  }
  check('拿到了命令 handler', typeof handler === 'function')
  if (typeof handler === 'function') {
    const unknown = await handler(['这一定不是命令'])
    check(
      '未知参数提示里带 remote-sync',
      /remote-sync/.test(unknown?.text ?? ''),
      String(unknown?.text ?? '').slice(0, 80),
    )
    const rs = await handler(['remote-sync', 'status'])
    check(
      'remote-sync status 能回状态',
      rs?.kind === 'success' && /跨机同步/.test(rs?.text ?? ''),
      String(rs?.text ?? '').slice(0, 80),
    )
    const rsBad = await handler(['remote-sync', '乱写'])
    check('remote-sync 乱写子命令报错', rsBad?.kind === 'error')
    const mc = await handler(['mood-config'])
    check(
      'mood-config 帮助里有 judgePerDay / maxStates',
      /judgePerDay/.test(mc?.text ?? '') && /maxStates/.test(mc?.text ?? ''),
      String(mc?.text ?? '').slice(0, 80),
    )
  }
}

// ── 六、输出 ────────────────────────────────────────────────────
let failed = 0
for (const row of results) {
  if (!row.ok) {
    failed += 1
    console.log(`  FAIL ${row.name}${row.extra ? ` → ${row.extra}` : ''}`)
  }
}
console.log(`audit-batch3-1112: ${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exit(1)
