import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { HomeTier, JevState } from '../types'

// 每句 prompt 先問 JEV（bin/jev.py route），把「哪些步驟交給 JEV」的規則附給 Claude，
// 再依 JEV 建議的等級自動切換這一輪的模型；提示框上方畫開關，/jev on|off|status 切換。

// 畫面每次直接問 jev.py；這個值只用來在切換後觸發重畫
const isOn = atom({ plugin: 'jev', key: 'isOn' } as const, true as JevState)
// 主對話上一次呼叫模型送出的 token 數（輸入＋讀快取＋寫快取），重載外掛也留著
const contextTokens = atom({ plugin: 'jev', key: 'contextTokens' } as const, 0)
// 這段對話「黏著」的模型（null = 用 session 本來的模型）；目前只有 sonnet 會黏
const home = atom({ plugin: 'jev', key: 'home' } as const, null as HomeTier)

// 專案自己的規則（可省略）：哪些步驟交給 JEV
const PROJECT_RULES = '.claude/jev_rules.md'

// 自動換模型的門檻
const MIN_CONF = 0.7 // JEV 信心低於這個就不換
const JUDGMENT_HINT = 0.7 // 這句含判斷步驟的機率高於這個，多提醒一句

const TIERS = ['haiku', 'sonnet', 'opus'] as const
type Tier = (typeof TIERS)[number]
const MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}
// 換模型時前面的對話沒有快取，要整段重讀（Claude Code 光系統提示＋工具就約 8 萬 token）
// haiku：單價低到整段重讀也幾乎都省，只在對話極長（單輪只呼叫一次時會虧）才不換
// sonnet：讀快取跟 opus 同價，每輪換來換去只會虧；只在新對話第一句（還沒有快取）換，之後整段黏著 sonnet
const HAIKU_MAX_CONTEXT = 300_000
const tierOf = (model: string): Tier | undefined => TIERS.find(t => model.includes(t))

type Route = { tier: string; tier_conf: number; judgment: number; skill?: string; skill_conf?: number }

// 最近一次 prompt 的判斷（prompt.submit 寫，turn.start 依文字對上這一輪）
let lastRoute: { text: string; route: Route } | undefined
// 這一輪 JEV 建議的等級，與第一次呼叫時決定的實際等級（之後每次呼叫沿用）
const planned = new Map<string, Tier>()
const decided = new Map<string, Tier>()
let lastUsed: Tier | undefined
let lastHint = ''
// 這一輪要不要在結束時記一行通知（人送的 prompt 才記），與這一輪 ask／batch 被呼叫幾次
let notice: { isOn: boolean; route?: Route; failed?: boolean } | undefined
const calls = { ask: 0, batch: 0 }
const JEV_CALL = /jev\.py\b[^\n]*?\s(ask|batch)\b/g

// 每輪結束在對話裡留一行：JEV 有沒有開、這句怎麼判斷、實際用哪個模型、ask／batch 用了幾次
const noticeText = (n: NonNullable<typeof notice>) => {
  if (!n.isOn) return 'JEV：關（這輪沒用到 JEV）'
  const parts = ['JEV：開']
  if (n.route) parts.push(`判斷 ${n.route.tier}（信心 ${n.route.tier_conf.toFixed(2)}）`)
  else if (n.failed) parts.push('判斷失敗')
  if (lastUsed) parts.push(`這輪用 ${lastUsed}`)
  const used = [calls.ask && `ask ×${calls.ask}`, calls.batch && `batch ×${calls.batch}`].filter(Boolean)
  parts.push(used.length ? `呼叫 ${used.join('、')}` : '沒有呼叫 ask／batch')
  return parts.join(' · ')
}

const switchSvg = (on: boolean) => {
  const track = on ? '#34C759' : '#3A3A3C'
  const knobX = on ? 38 : 18
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="32" viewBox="0 0 56 32">
<rect x="1" y="1" width="54" height="30" rx="15" fill="${track}" stroke="#8E8E93" stroke-width="1.5"/>
<circle cx="${knobX}" cy="16" r="12" fill="#FFFFFF"/>
</svg>`
}

const jev = async ($: EngineInterface, args: string[], timeoutMs = 30_000) =>
  $.process.run(['python3', `${$.plugin.root}/bin/jev.py`, '--project', await $.session.root(), ...args], {
    timeoutMs,
  })

const current = async ($: EngineInterface): Promise<boolean> => {
  const { stdout } = await jev($, ['state'], 10_000)
  return stdout.trim() !== 'off'
}

const refresh = async ($: EngineInterface) => {
  const value = await current($)
  await update($, isOn, () => value)
  const used = value && lastUsed ? ` · 這輪 ${lastUsed}` : ''
  $.ui.status(`JEV ${value ? '開' : '關'}${value ? lastHint : ''}${used}`)
}

const rulesFor = async ($: EngineInterface) => {
  const cli = `python3 ${$.plugin.root}/bin/jev.py`
  const base = `[JEV 開關：開] 流程中「只是分類、打分、是非判斷」的步驟交給 JEV，不要自己判斷：
- 單筆：\`${cli} ask --state '{"x":"..."}' --q '{"q":{"type":"noul","instructions":"..."}}'\`（可加 --image 圖）
- 一批（CSV 每列做同一個判斷，結果加成新欄位）：\`${cli} batch <檔案.csv> --column <欄位> --q '{...}' --out <輸出.csv>\`
- 題型：noul 是非（0–1）、choice 選擇（criteria 給選項說明）、score 打分（criteria 給由低到高的等級）；細節看 \`${cli} --help\``
  const root = await $.session.root()
  const own = (await $.fs.exists(`${root}/${PROJECT_RULES}`))
    ? (await $.fs.read(`${root}/${PROJECT_RULES}`)).trim()
    : ''
  const tail = 'JEV 判斷完，只有被標出來、或信心低於 0.6 的項目才需要你細看。'
  return [base, own, tail].filter(Boolean).join('\n')
}

const readRoute = (text: string): Tier | undefined => {
  if (!lastRoute || lastRoute.text !== text.trim()) return undefined
  const r = lastRoute.route
  return r.tier_conf >= MIN_CONF ? TIERS.find(t => t === r.tier) : undefined
}

// 這一輪用哪個等級：JEV 建議 × 黏著的模型 × 對話長度
const decide = async ($: EngineInterface, turnId: string, session: Tier): Promise<Tier> => {
  const base = (await read($, home)) ?? session
  const want = planned.get(turnId)
  if (!want || want === base) return base
  const rank = (t: Tier) => TIERS.indexOf(t)
  if (rank(want) > rank(base)) {
    // 升級：之後的對話黏在升上去的模型（回到 session 本來的就清掉）
    await update($, home, () => (want === session ? null : want))
    return want
  }
  const tokens = await read($, contextTokens)
  if (want === 'haiku') return tokens <= HAIKU_MAX_CONTEXT ? 'haiku' : base
  if (want === 'sonnet' && tokens === 0) {
    await update($, home, () => 'sonnet')
    return 'sonnet'
  }
  return base
}

const toggleText = async ($: EngineInterface, cmd: string) => {
  const { exitCode, stdout, stderr } = await jev($, [cmd], 10_000)
  await refresh($)
  return exitCode === 0 ? stdout.trim() : `JEV 執行失敗：${stderr.trim().slice(0, 300)}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'jev',
      description: 'JEV 開關：/jev on 打開、/jev off 關掉、/jev status 看狀態與累計用量',
      argumentHint: 'on | off | status',
    })
    await refresh($)
    return started
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const arg = e.args.trim() || 'status'
    if (!['on', 'off', 'status'].includes(arg)) return { text: '用法：/jev on | off | status' }
    return { text: await toggleText($, arg) }
  })

  // 每句 prompt 先問 JEV，把規則與建議附給 Claude（機器自動送的訊息不問）
  on('prompt.submit', async ($, e, next) => {
    const isPerson = ['composer', 'bridge', 'sdk', 'unclassified'].includes(e.origin.kind)
    const text = e.text.trim()
    lastRoute = undefined
    lastHint = ''
    if (!isPerson || !text || text.startsWith('/jev')) return next(e)
    calls.ask = 0
    calls.batch = 0
    const enabled = await current($)
    notice = { isOn: enabled }
    if (!enabled) return next(e)

    const ctx = [await rulesFor($)]
    const { exitCode, stdout, stderr } = await jev($, ['route', text, '--skills-dir', `${$.plugin.root}/skills`], 12_000)
    if (exitCode === 0) {
      try {
        const r = JSON.parse(stdout) as Route
        lastRoute = { text, route: r }
        notice.route = r
        lastHint = ` · 建議 ${r.tier}（${r.tier_conf.toFixed(2)}）`
        let hint = `JEV 對這句的判斷：建議模型等級 ${r.tier}（信心 ${r.tier_conf.toFixed(2)}）`
        if (r.skill && r.skill !== 'none') {
          hint += `；建議載入 skill \`${r.skill}\`（信心 ${(r.skill_conf ?? 0).toFixed(2)}，信心低就自己判斷）`
        }
        if (r.judgment >= JUDGMENT_HINT) hint += '；這個請求含有分類／判斷步驟，照上面的規則交給 JEV'
        hint += '。JEV 外掛已依此自動切換這一輪的模型（狀態列顯示），不用提醒使用者；你不要自己切換模型。'
        ctx.push(hint)
      } catch {
        lastHint = ' · 判斷失敗'
        notice.failed = true
      }
    } else {
      lastHint = ' · 判斷失敗'
      notice.failed = true
      $.ui.log(`JEV route 失敗：${stderr.trim().slice(0, 200)}`, { to: 'debug' })
    }
    await refresh($)
    return next({ ...e, context: [...(e.context ?? []), ...ctx] })
  }).catch(($, e, next) => next(e)) // JEV 或 python 出錯也照常送出，不卡住 prompt

  on('turn.start', async ($, e, next) => {
    lastUsed = undefined
    const tier = readRoute(e.text)
    if (tier) planned.set(e.turnId, tier)
    return next(e)
  })

  // 主對話每次呼叫模型前，換成決定的等級（子代理不動）
  on('turn.step', async function* ($, e, next) {
    const session = tierOf(e.model)
    if (e.agentId !== undefined || !session) return yield* next(e)
    const target = decided.get(e.turnId) ?? (await decide($, e.turnId, session))
    decided.set(e.turnId, target)
    const step = target !== session ? { ...e, model: MODEL_ID[target] } : e
    if (lastUsed !== target) {
      lastUsed = target
      await refresh($)
    }
    const result = yield* next(step)
    const u = result.usage
    if (u) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, contextTokens, () => total)
    }
    return result
  })

  // 數 Claude 這一輪呼叫了幾次 jev.py ask／batch（子代理也算）
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    for (const m of e.command.matchAll(JEV_CALL)) calls[m[1] as 'ask' | 'batch']++
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    planned.delete(e.turnId)
    decided.delete(e.turnId)
    await refresh($)
    if (notice && e.agentId === undefined) {
      $.ui.log(noticeText(notice))
      notice = undefined
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const value = await read($, isOn)
    if (e.props.hasSurvey || value === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const toggle = async () => {
      const text = await toggleText($, value ? 'off' : 'on')
      if (text.startsWith('JEV 執行失敗')) $.ui.toast(text)
    }

    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text bold>/jev</Text>
          <Svg source={switchSvg(value)} alt={value ? 'JEV 開' : 'JEV 關'} width={42} height={24} />
          <Button key="jev-toggle" label={value ? '關掉' : '打開'} hotkey="j" dimColor onPress={toggle} />
        </Box>
      )
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Text bold>/jev</Text>
        <Text color={value ? 'green' : undefined} dimColor={!value}>{value ? '━━●' : '●━━'}</Text>
        <Button key="jev-toggle" label={value ? '關掉' : '打開'} hotkey="j" dimColor onPress={toggle} />
      </Box>
    )
  })
}
