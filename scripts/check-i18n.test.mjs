import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkErrorCodes,
  compareMessages,
  extractActionErrorCodes,
  extractPlaceholders,
  findBusinessLiteralsInMessages,
  findHardcodedText,
  findMissingTranslationKeys,
  findBannedThreadWords,
  findThreadOwnership,
  flattenMessages,
} from './check-i18n.mjs'

const messages = {
  'zh-CN': {
    Common: { close: '关闭' },
    Auth: { title: '登录' },
    Issue: { status: { todo: '待办' } },
    Board: { moved: '已移至{status}', threads: '{count, plural, other {# 条讨论}}' },
    Errors: { generic: '出错了', authRequired: '请先登录。' },
  },
  en: {
    Common: { close: 'Close' },
    Auth: { title: 'Sign in' },
    Issue: { status: { todo: 'Todo' } },
    Board: { moved: 'Moved to {status}', threads: '{count, plural, other {# discussions}}' },
    Errors: { generic: 'Something went wrong', authRequired: 'Please sign in first.' },
  },
}

test('flattenMessages turns a nested catalog into dotted keys', () => {
  assert.deepEqual([...flattenMessages({ A: { b: 'x', C: { d: 'y' } } }).keys()], ['A.b', 'A.C.d'])
})

test('extractPlaceholders reads named and plural placeholders', () => {
  assert.deepEqual([...extractPlaceholders('{count, plural, other {# items}} for {name}')], ['count', 'name'])
})

test('compareMessages accepts aligned catalogs', () => {
  assert.deepEqual(compareMessages(messages), [])
})

test('compareMessages reports missing, extra and empty keys', () => {
  const broken = structuredClone(messages)
  delete broken.en.Common.close
  broken.en.Extra = { key: 'x' }
  broken['zh-CN'].Board.moved = ''
  const problems = compareMessages(broken)
  assert.ok(problems.some(problem => problem.includes('missing key "Common.close"')))
  assert.ok(problems.some(problem => problem.includes('extra key "Extra.key"')))
  assert.ok(problems.some(problem => problem.includes('"Board.moved" must be a non-empty string')))
})

test('compareMessages rejects corrupted translation text in either locale', () => {
  for (const locale of ['zh-CN', 'en']) {
    const broken = structuredClone(messages)
    broken[locale].Common.close = 'Broken\uFFFDtext'
    assert.ok(compareMessages(broken).includes(`${locale}: "Common.close" contains a Unicode replacement character`))
  }
})

test('compareMessages reports placeholder mismatches', () => {
  const broken = structuredClone(messages)
  broken.en.Board.moved = 'Moved'
  const problems = compareMessages(broken)
  assert.ok(problems.some(problem => problem.includes('en: "Board.moved" is missing placeholder {status}')))
})

test('extractActionErrorCodes reads quoted entries and fails loudly when absent', () => {
  const source = `const OTHER = ['nope']\nexport const ACTION_ERROR_CODES = [\n  'issueStale',\n  "authRequired",\n] as const\n`
  assert.deepEqual(extractActionErrorCodes(source), ['issueStale', 'authRequired'])
  assert.equal(extractActionErrorCodes('export const NOPE = []'), null)
})

test('checkErrorCodes requires every code in both locales', () => {
  assert.deepEqual(checkErrorCodes(['generic', 'authRequired'], messages), [])
  assert.ok(checkErrorCodes(['missingCode'], messages).some(problem => problem.includes('Errors.missingCode')))
})

test('findHardcodedText catches JSX text and attributes, ignoring comments and console', () => {
  const source = `
    // 这是注释，不应命中
    export function Demo() {
      console.error('服务端日志')
      return <div aria-label="任务">任务</div>
    }
  `
  const problems = findHardcodedText('/tmp/demo.tsx', source)
  assert.equal(problems.length, 2)
  assert.ok(problems.every(problem => problem.includes('hardcoded text "任务"')))
})

test('findHardcodedText honors line and file ignores', () => {
  const source = `/* i18n-ignore-file */\nexport const A = <p>任务</p>`
  assert.deepEqual(findHardcodedText('/tmp/ignored.tsx', source), [])

  const line = `export const A = <p>任务</p>{/* i18n-ignore */}`
  assert.deepEqual(findHardcodedText('/tmp/line.tsx', line), [])
})

test('findHardcodedText catches Chinese in template literals', () => {
  const source = 'export const label = `已移至${status}`'
  assert.equal(findHardcodedText('/tmp/template.ts', source).length, 1)
})

test('findMissingTranslationKeys resolves namespaced and object-form translators', () => {
  const source = `
    import { useTranslations, getTranslations } from '@/lib/intl/i18n-client'
    export async function Demo() {
      const t = useTranslations('Auth')
      const statusT = useTranslations('Issue.status')
      const deviceT = await getTranslations({ locale: 'en', namespace: 'Common' })
      return <p>{t('title')}{statusT('todo')}{deviceT('close')}{t('missing')}</p>
    }
  `
  const reference = flattenMessages(messages['zh-CN'])
  const problems = findMissingTranslationKeys('/tmp/demo.tsx', source, reference)
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('missing translation key "Auth.missing"'))
})

test('findMissingTranslationKeys skips dynamic and ambiguous keys', () => {
  const source = `
    import { useTranslations } from '@/lib/intl/i18n-client'
    export function Demo({ kind }: { kind: string }) {
      const t = useTranslations('Auth')
      return <p>{t(\`status.\${kind}\`)}{t('title')}</p>
    }
    export function Other() {
      const t = useTranslations('Common')
      return <p>{t('close')}</p>
    }
  `
  const reference = flattenMessages(messages['zh-CN'])
  assert.deepEqual(findMissingTranslationKeys('/tmp/demo.tsx', source, reference), [])
})

test('copy never says a bot owns or runs a thread', () => {
  const bad = {
    'zh-CN': { a: '所属 Bot', b: 'Coordinator 的线程', c: '{agent} 的线程', d: '3 个 Bot、它们的线程', e: '{agent} 派出的线程' },
    en: { a: "the bot's threads", b: '{agent} thread', c: 'bots, their threads and computers', d: 'Thread {agent} dispatched' },
  }
  assert.equal(findThreadOwnership(bad).length, 9)
  const good = {
    'zh-CN': { a: 'Coordinator 派出的线程', b: '{bot} 派出的线程', c: '{name} 的线程', d: '所属项目', e: '派出线程', f: 'Coordinator 线程' },
    en: { a: 'Thread {bot} dispatched', b: "{name}'s thread", c: 'the threads they dispatched' },
  }
  assert.deepEqual(findThreadOwnership(good), [])
})

test('Chinese copy calls a thread 线程, never 执行线程 or 运行链', () => {
  assert.equal(findBannedThreadWords({ 'zh-CN': { a: '打开执行线程', b: { c: '运行链已停止' } } }).length, 2)
  assert.deepEqual(findBannedThreadWords({ 'zh-CN': { a: '打开线程', b: '登录会话已失效', c: 'Bot 线程' } }), [])
})

test('Chinese copy never says 对话 for a thread or chat; 对话框 (a dialog box) stays', () => {
  const problems = findBannedThreadWords({ 'zh-CN': { a: '新建对话', b: { c: 'Bot 对话' }, d: '与 Coordinator 的对话框外的对话', e: '关闭对话框' }, en: { a: '对话' } })
  assert.deepEqual(problems.map(problem => problem.split('"')[1]), ['a', 'b.c', 'd'])
  assert.deepEqual(findBannedThreadWords({ 'zh-CN': { a: '关闭对话框', b: '线程', c: '打开对话框后继续' } }), [])
})

test('G2 findBusinessLiteralsInMessages rejects hardcoded currency, rates, machine SKUs, and credit conversions', () => {
  const bad = {
    en: {
      Billing: {
        proPrice: '$20/mo',
        cny: '¥100',
        cnyCode: '100 CNY',
        eur: '€19.99',
        eurCode: '19.99 EUR',
        gbp: '£5',
        gbpCode: '5 GBP',
        usdPrefix: 'US$1.00',
        usdSuffix: '25 USD',
        creditRate: '100 credits = US$1.00',
        creditRatePartial: '100 credits = {amount}',
        pointsRate: '100 points = {amount}',
        machineDefault: 'Mikka standard (2 vCPU · 8 GiB · $0.20/hr)',
        machineSpecOnly: 'Runs on 4 vCPU · 16 GiB',
        plainRate: '0.20/hr',
        weeklyRate: '10/wk',
        weekRate: '$10/week',
        yearlyRate: '199/yr',
        yearRate: '$199/year',
        allowance: 'Nothing is charged; verifying adds $1 of free <model><mark></mark> Mikka Default</model> use',
      },
    },
    'zh-CN': {
      Billing: {
        proPrice: '$20/月 · 每月 $20 Mikka 额度',
        creditRate: '100 额度 = US$1.00',
        pointsRateZh: '100 点数 = {amount}',
        machineDefault: 'Mikka 标准规格（默认，2 vCPU · 8 GiB · $0.20/小时）',
        allowance: '不扣款；验证后可免费使用 1 美元的 <model><mark></mark> Mikka 默认模型</model>',
        rmb: '每次充值最低 10 人民币',
        yuanSpaced: '单次充值 10 元',
        yuanCompact: '满100元立减',
        plainRateZh: '按 20/月 计费',
        weeklyRateZh: '按 20/周 计费',
        yearlyRateZh: '按 199/年 计费',
        currencyYearlyZh: '¥199/年',
      },
    },
  }
  const problems = findBusinessLiteralsInMessages(bad)
  assert.equal(problems.length, 32)

  const allowanceProblem = problems.find(item => item.includes('en: "Billing.allowance"'))
  assert.ok(allowanceProblem, 'expected en Billing.allowance to be flagged')
  assert.ok(allowanceProblem.includes('currency amount'))
  assert.ok(!allowanceProblem.includes('hardcoded rate'), 'closing </model> tag must not trigger hardcoded rate')

  const zhAllowanceProblem = problems.find(item => item.includes('zh-CN: "Billing.allowance"'))
  assert.ok(zhAllowanceProblem, 'expected zh-CN Billing.allowance (1 美元) to be flagged')
  assert.ok(zhAllowanceProblem.includes('currency amount'))

  const pointsEn = problems.find(item => item.includes('en: "Billing.pointsRate"'))
  assert.ok(pointsEn?.includes('credit conversion rate'))
  const pointsZh = problems.find(item => item.includes('zh-CN: "Billing.pointsRateZh"'))
  assert.ok(pointsZh?.includes('credit conversion rate'))

  const weeklyEn = problems.find(item => item.includes('en: "Billing.weeklyRate"'))
  assert.ok(weeklyEn?.includes('hardcoded rate'))
  const yearlyZh = problems.find(item => item.includes('zh-CN: "Billing.yearlyRateZh"'))
  assert.ok(yearlyZh?.includes('hardcoded rate'))

  const yuanSpaced = problems.find(item => item.includes('zh-CN: "Billing.yuanSpaced"'))
  assert.ok(yuanSpaced?.includes('currency amount'))
  const yuanCompact = problems.find(item => item.includes('zh-CN: "Billing.yuanCompact"'))
  assert.ok(yuanCompact?.includes('currency amount'))
})

test('G2 findBusinessLiteralsInMessages allows properly parameterized ICU templates, non-SKU limits, and non-currency Chinese words (元素/单元)', () => {
  const good = {
    en: {
      Specs: {
        machineTemplate: '{vcpu} vCPU · {gib} GiB · {hourlyRate}',
        machinePriceTemplate: '{vcpu} vCPU · {gib} GiB · ${price}/hr',
        cloudflareCost: 'This task’s Cloudflare machine is paid from Mikka credits at ${price}/hour',
        subscriptionSummary: '{price}/{interval} · {credits} of Mikka credits every month',
        weeklyParam: '{price}/week or {price}/wk',
        yearlyParam: '{price}/year or {price}/yr',
        creditConversion: '{points} credits = {amount}',
        pointsConversion: '{points} points = {amount}',
        pointsRemaining: '100 points remaining',
        uploadLimit: 'Up to 2 MB',
        allowanceParam: 'Nothing is charged; verifying adds {amount} of free <model><mark></mark> Mikka Default</model> use',
        hourlyAwake: '${price} / h while awake',
      },
    },
    'zh-CN': {
      Specs: {
        machinePriceTemplate: '{vcpu} vCPU · {gib} GiB · ${price}/小时',
        cloudflareCost: '此任务的 Cloudflare 机器按 ${price}/小时从 Mikka 额度扣除',
        weeklyYearlyParam: '{price}/周 或 {price}/年',
        creditConversion: '{points} 额度 = {amount}',
        pointsConversion: '{points} 点数 = {amount}',
        uploadLimit: '最大 2 MB',
        elementsCount: '包含 3 元素（共 5 个元素）',
        elementsCompact: '最多显示3元素',
        unitsCount: '共 4 单元，第 2 单元已完成',
        allowanceParam: '不扣款；验证后可免费使用 {amount} 的 <model><mark></mark> Mikka 默认模型</model>',
        hourlyAwake: '醒着时 ${price} / 小时',
      },
    },
  }
  assert.deepEqual(findBusinessLiteralsInMessages(good), [])
})

test('G2 findBusinessLiteralsInMessages honors optional baseline and fails on unlisted keys or malformed JSON', () => {
  const sample = {
    en: {
      Billing: {
        legacy: '$20/mo',
        added: '$50/mo',
      },
    },
    'zh-CN': {
      Billing: {
        legacy: '$20/月',
      },
    },
  }

  // Without baseline: strict zero tolerance
  assert.equal(findBusinessLiteralsInMessages(sample).length, 3)

  // With baseline covering only legacy entries: added key still fails immediately
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mikka-i18n-baseline-'))
  try {
    const baselinePath = path.join(dir, 'i18n-business-literals.json')
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ 'en:Billing.legacy': 1, 'zh-CN:Billing.legacy': 1 }),
    )
    const remaining = findBusinessLiteralsInMessages(sample, { baselinePath })
    assert.equal(remaining.length, 1)
    assert.ok(remaining[0].includes('en: "Billing.added"'))

    // Malformed baseline fails closed
    fs.writeFileSync(baselinePath, '{bad json')
    const failedClosed = findBusinessLiteralsInMessages(sample, { baselinePath })
    assert.ok(failedClosed.some(item => item.includes('Invalid baseline JSON')))
    assert.ok(failedClosed.length >= 4)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
