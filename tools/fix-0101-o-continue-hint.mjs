#!/usr/bin/env node
/**
 * 续接标记的提示词（否则接线等于没接）。
 *
 * 模型不知道有这个标记，就永远不会写它 —— 那 shouldContinueTurn 还是死代码，
 * 只是从「没人调用」变成「调用了但条件永远不成立」。
 *
 * 只在 agentive.enabled 且 selfContinue 不为 false 时才说这一句，
 * 免得关掉的功能还在提示词里占位置。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB = process.env.SB_LIB || 'C:/Users/13176/.dsh/profiles/desktop/node_modules/dsh-shared-brain/lib'
const p = join(LIB, 'weighted-recall.js')
let src = readFileSync(p, 'utf8')

// 在「自动互动」两条正常分支之后、`} else {` 之前插入续接说明
const FROM = `    } else {
      lines.push(\`【自动互动】已开启主观能动性：可以主动提出建议、主动检查未完成的事、主动提醒风险，不必每一步都等用户下令。\${windowNote}\`)
    }
  } else {`

if (src.split(FROM).length - 1 !== 1) throw new Error('锚点不唯一')

const TO = `    } else {
      lines.push(\`【自动互动】已开启主观能动性：可以主动提出建议、主动检查未完成的事、主动提醒风险，不必每一步都等用户下令。\${windowNote}\`)
    }
    // 续接轮次（2026-11-04）：让模型自己声明「这轮还没做完」。
    // 用 HTML 注释，渲染出来看不见，不会污染回复正文。
    if (agentive.selfContinue !== false) {
      lines.push('【续接】如果这一轮的事情你还没做完、需要马上接着做（而不是等用户再催一句），就在回复最后单独写一行：<!-- 继续：一句话说明接下来要做什么 -->。只在你确实还有下一步要做的时候写；已经做完、或者该等用户回答的，别写。同一件事最多续接 3 轮。')
    }
  } else {`

src = src.replace(FROM, TO)
writeFileSync(p, src, 'utf8')
console.log('[ok] weighted-recall.js：加了续接标记说明')
