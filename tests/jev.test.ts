import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]

const ROOT = '/proj'
const BAND = {
  plugin: 'jev',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 }, view: {},
  },
}

type World = {
  isOn: boolean
  route: object
  rules: string | null
  tokens: number
  runs: string[][]
  models: string[]
  contexts: (readonly string[] | undefined)[]
}

// 外掛底下的世界：jev.py、檔案、session、模型呼叫
const setup = (on: On, over: Partial<World> = {}): World => {
  const w: World = {
    isOn: true,
    route: { tier: 'haiku', tier_conf: 0.9, judgment: 0.1, skill: 'none', skill_conf: 0.9 },
    rules: null,
    tokens: 0,
    runs: [],
    models: [],
    contexts: [],
    ...over,
  }
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    const args = e.argv.slice(4) // python3 jev.py --project ROOT ...
    w.runs.push([...args])
    if (args[0] === 'state') return ok(w.isOn ? 'on\n' : 'off\n')
    if (args[0] === 'route') return ok(JSON.stringify(w.route))
    if (args[0] === 'on' || args[0] === 'off') {
      w.isOn = args[0] === 'on'
      return ok(`JEV 開關：${w.isOn ? '開' : '關'}\n`)
    }
    return ok(`JEV 開關：${w.isOn ? '開' : '關'}\n`)
  })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/.claude/jev_rules.md` && w.rules !== null }))
  on('fs.read', () => ({ value: w.rules ?? '' }))
  on('prompt.submit', ($, e) => {
    w.contexts.push(e.context)
    return { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    w.models.push(e.model)
    const usage = { model: e.model, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: w.tokens, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  return w
}

// 一輪對話：送出 prompt → turn.start → 呼叫一次模型
const turn = async ($: Engine, id: string, text = '找 brief.md', model = 'claude-opus-5-5', extra: object = {}) => {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId: id })
  for await (const _ of $.turn.step({ turnId: id, index: 0, model, messageCount: 10, ...extra })) { /* 不看串流 */ }
}

test('每句問 JEV，規則附給 Claude，haiku 信心夠就換', async ($, on) => {
  const w = setup(on, { rules: '- 標題 → `jev.py titles`' })
  await turn($, 't1')
  expect(w.runs.some(r => r[0] === 'route' && r[1] === '找 brief.md')).toBe(true)
  const ctx = w.contexts.at(-1)?.join('\n') ?? ''
  expect(ctx).toContain('[JEV 開關：開]')
  expect(ctx).toContain('jev.py titles')
  expect(ctx).toContain('建議模型等級 haiku')
  expect(w.models).toEqual(['claude-haiku-5-5'])
})

test('關掉、機器送的訊息、/jev 指令 → 不問 JEV、不換', async ($, on) => {
  const w = setup(on, { isOn: false })
  await turn($, 'a')
  w.isOn = true
  await $.prompt.submit({ text: '背景工作完成', wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: '背景工作完成', turnId: 'b' })
  for await (const _ of $.turn.step({ turnId: 'b', index: 0, model: 'claude-opus-5-5', messageCount: 10 })) { /* */ }
  await turn($, 'c', '/jev status')
  expect(w.runs.filter(r => r[0] === 'route')).toEqual([])
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('信心不夠、子代理 → 不換', async ($, on) => {
  const w = setup(on, { route: { tier: 'haiku', tier_conf: 0.5, judgment: 0 } })
  await turn($, 'a')
  w.route = { tier: 'haiku', tier_conf: 0.9, judgment: 0 }
  await turn($, 'b', '找 brief.md', 'claude-opus-5-5', { agentId: 'x' })
  expect(w.models).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('haiku：對話 30 萬 token 內才換', async ($, on) => {
  const w = setup(on)
  w.tokens = 350_000
  await turn($, 'a') // 第一次還不知道長度 → 換
  await turn($, 'b') // 記下 35 萬 → 不換
  expect(w.models).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
})

test('sonnet：新對話第一句就換並黏著，JEV 說 opus 才升回去', async ($, on) => {
  const w = setup(on, { route: { tier: 'sonnet', tier_conf: 0.9, judgment: 0 } })
  const go = async (id: string, route: object) => {
    w.route = route
    await turn($, id)
    w.tokens = 80_000
  }
  await go('a', { tier: 'sonnet', tier_conf: 0.9, judgment: 0 })
  await go('b', { tier: 'haiku', tier_conf: 0.3, judgment: 0 })
  await go('c', { tier: 'haiku', tier_conf: 0.9, judgment: 0 })
  await go('d', { tier: 'opus', tier_conf: 0.9, judgment: 0 })
  await go('e', { tier: 'sonnet', tier_conf: 0.9, judgment: 0 })
  expect(w.models).toEqual([
    'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5',
  ])
})

test('開關按鈕與 /jev 指令', async ($, on) => {
  const w = setup(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    w.isOn = true
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'jev-toggle' })
    expect(w.isOn).toBe(false)
    expect((await ui.find({ key: 'jev-toggle' }))?.text).toBe('打開')
    await ui.press({ key: 'jev-toggle' })
    expect(w.isOn).toBe(true)
    await ui.unmount()
  }
  const r = await $.command.run({ command: 'jev', args: 'off', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  expect(JSON.stringify(r)).toContain('JEV 開關：關')
})
