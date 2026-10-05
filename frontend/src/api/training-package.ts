import { parseCsv, toCsv } from './csv'
import { listRows, readJson, saveRows, writeJson } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 群测群防培训「考核回传包」：平台按主题+对象导出签到表，外部讲师补录授课与考核结果后回传。
//
// 与课程计划冲突时的取舍（本模块统一决定，页面不做业务判断）：
// - 身份/计划字段（培训编号、培训主题、培训对象、培训日期）以平台课程计划为准；
//   回传值对不上的记录视为串包/错包，判失败并整包退回，不静默改计划。
// - 实施/考核字段（授课人、参训人数、授课记录、考核结果、通过率）以回传包为准，
//   覆盖平台旧值；旧培训缺考核通过率等历史空值按 null 兼容。

const TRAINING_KEY = 'training'
const PROPAGANDA_KEY = 'propaganda'
const LEDGER_NAME = 'training-return-ledger'

const ASSESSED_STATUS = '已考核'
const ARCHIVED_STATUS = '已归档'
const META_TAG = '考核回传包'

// 结业建议：回传的「结业建议」列由平台生成，导入时忽略讲师填了什么。
export const PACKAGE_HEADERS = [
  '培训编号',
  '培训主题',
  '培训对象',
  '培训日期',
  '授课人',
  '参训人数',
  '授课记录',
  '考核结果',
  '考核合格人数',
  '考核通过率',
  '结业建议',
] as const

export type PackageRowError = {
  line: number
  培训编号: string
  reason: string
}

export type ImportReport =
  | {
      ok: true
      packageNo: string
      mergedCount: number
      trainingNos: string[]
      followUpNos: string[]
      importedAt: string
    }
  | {
      ok: false
      returned: true
      packageNo: string
      message: string
      errors: PackageRowError[]
    }

export type LedgerEntry = {
  packageNo: string
  fingerprint: string
  importedAt: string
  mergedCount: number
  trainingNos: string[]
  followUpNos: string[]
}

export function listReturnLedger(): LedgerEntry[] {
  return readJson<LedgerEntry[]>(LEDGER_NAME, [])
}

function shortHash(text: string, length = 8): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, length).toUpperCase()
}

function compactDate(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

function compactTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${hh}${mm}${ss}`
}

function randomCode(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return code
}

function parseNonNegativeInt(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null
}

function sanitizeFileName(text: string): string {
  return text.replace(/[\\/:*?"<>|，,]/g, '').slice(0, 20)
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null
  }
  const value = Number(raw)
  return value > 0 ? value : null
}

// 通过率兼容「85」「85%」「85.5」三种写法；空串/非法值由调用方区分处理。
export function parsePercent(raw: string): number | null {
  const text = raw.trim()
  if (text === '' || !/^\d+(\.\d+)?%?$/.test(text)) {
    return null
  }
  const value = Number(text.replace(/%$/, ''))
  return value >= 0 && value <= 100 ? value : null
}

function addDays(yyyyMmDd: string, days: number): string {
  const date = new Date(`${yyyyMmDd}T00:00:00`)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  date.setDate(date.getDate() + days)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// 结业建议：通过率缺失走补测兜底，旧培训空通过率不会卡住合并。
function buildAdvice(rate: number | null): string {
  if (rate === null) {
    return '建议补测后核发结业结论（回传未提供考核通过情况）'
  }
  if (rate >= 90) {
    return '建议准予结业，优先纳入群测群防骨干宣讲员'
  }
  if (rate >= 80) {
    return '建议准予结业'
  }
  if (rate >= 60) {
    return '建议补训薄弱科目后准予结业'
  }
  return '建议不予结业，重新组织培训与考核'
}

export type SignSheet = {
  filename: string
  content: string
  packageNo: string
  matchedCount: number
}

// 按培训主题、培训对象导出签到表（即考核回传包空白模板）；已归档培训不参与回传。
export function exportSignSheet(topic: string, audience: string): SignSheet {
  const keywordTopic = topic.trim()
  const keywordAudience = audience.trim()
  if (!keywordTopic || !keywordAudience) {
    throw new Error('请同时填写培训主题和培训对象后再导出签到表')
  }
  const matched = listRows(TRAINING_KEY).filter(
    (row) =>
      String(row.status) !== ARCHIVED_STATUS &&
      String(row['培训主题'] ?? '').includes(keywordTopic) &&
      String(row['培训对象'] ?? '').includes(keywordAudience),
  )
  if (matched.length === 0) {
    throw new Error('没有匹配该培训主题和对象的未归档培训，无法导出签到表')
  }

  // 包号按导出时刻生成：同主题对象每次导出都是新包；同一文件重复回传由内容指纹兜底拦截。
  const exportedAt = new Date()
  const packageNo = `RC-${compactDate(exportedAt)}-${compactTime(exportedAt)}-${randomCode(4)}`
  const rows: string[][] = [
    [META_TAG, `包号=${packageNo}`, `培训主题=${keywordTopic}`, `培训对象=${keywordAudience}`],
    [...PACKAGE_HEADERS],
    ...matched.map((row) => [
      String(row['培训编号'] ?? ''),
      String(row['培训主题'] ?? ''),
      String(row['培训对象'] ?? ''),
      String(row['培训日期'] ?? ''),
      String(row['授课人'] ?? ''),
      '',
      '',
      '',
      '',
      '',
      '',
    ]),
  ]
  return {
    filename: `培训考核签到表-${sanitizeFileName(keywordTopic)}-${sanitizeFileName(keywordAudience)}.csv`,
    content: toCsv(rows),
    packageNo,
    matchedCount: matched.length,
  }
}

type ParsedPackage = {
  packageNo: string
  fingerprint: string
  dataRows: string[][]
}

function parsePackage(text: string): ParsedPackage {
  const rows = parseCsv(text).map((row) => row.map((cell) => cell.trim()))
  if (rows.length < 3) {
    throw new Error('回传包内容不完整：至少应包含包信息、表头和一条培训记录')
  }
  const [metaRow, headerRow, ...dataRows] = rows
  if (metaRow[0] !== META_TAG) {
    throw new Error('不是本平台导出的考核回传包：缺少「考核回传包」标识行')
  }
  const meta: Record<string, string> = {}
  for (const cell of metaRow.slice(1)) {
    const index = cell.indexOf('=')
    if (index > 0) {
      meta[cell.slice(0, index)] = cell.slice(index + 1)
    }
  }
  if (!meta['包号']) {
    throw new Error('回传包缺少包号，请使用平台导出的签到表原文件回传')
  }
  if (headerRow.join('|') !== PACKAGE_HEADERS.join('|')) {
    throw new Error('回传包表头与签到表模板不一致，请勿增删或调换列')
  }
  if (dataRows.length === 0) {
    throw new Error('回传包没有任何培训记录')
  }
  return {
    packageNo: meta['包号'],
    fingerprint: shortHash(dataRows.map((row) => row.join('|')).join('\n')),
    dataRows,
  }
}

type ValidRecord = {
  line: number
  plan: EntryRow
  lecturer: string
  attendCount: number
  teachingNote: string
  examResult: string
  qualifiedCount: number | null
  rate: number | null
}

// 导入考核回传包：任一记录失败整包退回；同一包只合并一次；已归档培训不能被覆盖。
export function importReturnPackage(text: string): ImportReport {
  let parsed: ParsedPackage
  try {
    parsed = parsePackage(text)
  } catch (error) {
    return {
      ok: false,
      returned: true,
      packageNo: '',
      message: error instanceof Error ? error.message : '回传包解析失败',
      errors: [],
    }
  }
  const { packageNo, fingerprint, dataRows } = parsed

  // 幂等：包号或内容指纹命中已导入台账，都视为同一包，不重复合并。
  const ledger = listReturnLedger()
  const seenNo = ledger.find((entry) => entry.packageNo === packageNo)
  if (seenNo) {
    return {
      ok: false,
      returned: true,
      packageNo,
      message: `回传包 ${packageNo} 已在 ${seenNo.importedAt} 合并过，同一包只合并一次`,
      errors: [],
    }
  }
  const seenFingerprint = ledger.find((entry) => entry.fingerprint === fingerprint)
  if (seenFingerprint) {
    return {
      ok: false,
      returned: true,
      packageNo,
      message: `回传包内容与已合并的 ${seenFingerprint.packageNo} 完全相同，同一包只合并一次`,
      errors: [],
    }
  }

  const trainingRows = listRows(TRAINING_KEY)
  const planByNo = new Map<string, EntryRow>()
  for (const row of trainingRows) {
    planByNo.set(String(row['培训编号'] ?? ''), row)
  }

  const errors: PackageRowError[] = []
  const valid: ValidRecord[] = []
  const seenTrainingNo = new Set<string>()

  dataRows.forEach((cells, index) => {
    const line = index + 3
    const [
      trainingNo = '',
      topic = '',
      audience = '',
      trainingDate = '',
      lecturer = '',
      attendRaw = '',
      teachingNote = '',
      examResult = '',
      qualifiedRaw = '',
      rateRaw = '',
    ] = cells

    const fail = (reason: string) => errors.push({ line, 培训编号: trainingNo, reason })

    if (!trainingNo) {
      fail('培训编号为空')
      return
    }
    if (seenTrainingNo.has(trainingNo)) {
      fail(`培训编号 ${trainingNo} 在包内重复出现`)
      return
    }
    seenTrainingNo.add(trainingNo)

    const plan = planByNo.get(trainingNo)
    if (!plan) {
      fail(`培训编号 ${trainingNo} 在平台课程计划中不存在`)
      return
    }
    if (String(plan.status) === ARCHIVED_STATUS) {
      fail('该培训已归档，归档培训不能被回传覆盖')
      return
    }
    // 身份/计划字段以课程计划为准，对不上即判失败（整包会被退回）。
    if (topic !== String(plan['培训主题'] ?? '').trim()) {
      fail(`培训主题与课程计划不一致（计划：${plan['培训主题'] ?? '空'}）`)
      return
    }
    if (audience !== String(plan['培训对象'] ?? '').trim()) {
      fail(`培训对象与课程计划不一致（计划：${plan['培训对象'] ?? '空'}）`)
      return
    }
    if (trainingDate !== String(plan['培训日期'] ?? '').trim()) {
      fail(`培训日期与课程计划不一致（计划：${plan['培训日期'] ?? '空'}）`)
      return
    }
    if (!teachingNote) {
      fail('授课记录为空，请由外部讲师补录后再回传')
      return
    }
    const attendCount = parsePositiveInt(attendRaw)
    if (attendCount === null) {
      fail('参训人数应为正整数')
      return
    }
    let qualifiedCount: number | null = null
    if (qualifiedRaw.trim() !== '') {
      qualifiedCount = parseNonNegativeInt(qualifiedRaw)
      if (qualifiedCount === null) {
        fail('考核合格人数应为非负整数')
        return
      }
      if (qualifiedCount > attendCount) {
        fail(`考核合格人数 ${qualifiedCount} 超过参训人数 ${attendCount}`)
        return
      }
    }
    let rate: number | null = null
    if (rateRaw.trim() !== '') {
      rate = parsePercent(rateRaw)
      if (rate === null) {
        fail('考核通过率应为 0 到 100 之间的数值（可带 %）')
        return
      }
    }
    if (qualifiedCount !== null && rate === null) {
      rate = Math.round((qualifiedCount / attendCount) * 1000) / 10
    } else if (qualifiedCount !== null && rate !== null) {
      const computed = Math.round((qualifiedCount / attendCount) * 1000) / 10
      if (Math.abs(computed - rate) > 1) {
        fail(`考核通过率 ${rate}% 与合格人数折算的 ${computed}% 不一致`)
        return
      }
    }

    valid.push({
      line,
      plan,
      lecturer,
      attendCount,
      teachingNote,
      examResult,
      qualifiedCount,
      rate,
    })
  })

  // 任一记录失败：整包退回，不写任何数据。
  if (errors.length > 0) {
    return {
      ok: false,
      returned: true,
      packageNo,
      message: `包内 ${errors.length} 条记录校验失败，整包退回，平台数据未做任何修改`,
      errors,
    }
  }

  // 全部通过才开始落库：逐条合并培训结果，并在防灾宣传侧生成后续宣讲事项。
  const propagandaRows = listRows(PROPAGANDA_KEY)
  let followSeq = propagandaRows.reduce((max, row) => {
    const match = /^PROP-FU-(\d+)$/.exec(String(row['活动编号'] ?? ''))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  let nextPropagandaId = propagandaRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)

  const trainingNos: string[] = []
  const followUpNos: string[] = []
  const planIndexByNo = new Map<string, number>()
  trainingRows.forEach((row, index) => planIndexByNo.set(String(row['培训编号'] ?? ''), index))
  const nextTraining = [...trainingRows]
  const nextPropaganda = [...propagandaRows]

  for (const record of valid) {
    const trainingNo = String(record.plan['培训编号'])
    const topic = String(record.plan['培训主题'] ?? '')
    const audience = String(record.plan['培训对象'] ?? '')
    const trainingDate = String(record.plan['培训日期'] ?? '')
    const resultText =
      record.examResult ||
      (record.qualifiedCount !== null
        ? `合格${record.qualifiedCount}人/参训${record.attendCount}人`
        : '')

    const index = planIndexByNo.get(trainingNo)!
    nextTraining[index] = {
      ...nextTraining[index],
      授课人: record.lecturer,
      参训人数: record.attendCount,
      授课记录: record.teachingNote,
      考核结果: resultText,
      考核合格人数: record.qualifiedCount ?? '',
      考核通过率: record.rate ?? '',
      结业建议: buildAdvice(record.rate),
      status: ASSESSED_STATUS,
      pending: false,
      abnormal: false,
    }
    trainingNos.push(trainingNo)

    followSeq += 1
    nextPropagandaId += 1
    const followNo = `PROP-FU-${String(followSeq).padStart(4, '0')}`
    followUpNos.push(followNo)
    nextPropaganda.push({
      id: nextPropagandaId,
      status: '待开展',
      pending: true,
      abnormal: false,
      活动编号: followNo,
      宣传主题: `${topic}后续宣讲`,
      宣传方式: '培训成果宣讲',
      覆盖村组: audience,
      活动日期: addDays(trainingDate, 30),
      参与人数: '',
      组织人: '',
      活动状态: '待开展',
      事项来源: '培训考核回传',
      来源包号: packageNo,
      来源培训编号: trainingNo,
    })
  }

  const importedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const entry: LedgerEntry = {
    packageNo,
    fingerprint,
    importedAt,
    mergedCount: valid.length,
    trainingNos,
    followUpNos,
  }
  saveRows(TRAINING_KEY, nextTraining)
  saveRows(PROPAGANDA_KEY, nextPropaganda)
  writeJson(LEDGER_NAME, [...ledger, entry])

  return {
    ok: true,
    packageNo,
    mergedCount: valid.length,
    trainingNos,
    followUpNos,
    importedAt,
  }
}

// 培训页统计：年度次数按培训日期年份，通过率只统计有值的记录（旧培训空值兼容）。
export function trainingStats(rows: EntryRow[], year: number): {
  yearCount: number
  totalAttendees: number
  averageRate: number | null
} {
  let yearCount = 0
  let totalAttendees = 0
  let rateSum = 0
  let rateCount = 0
  for (const row of rows) {
    const date = String(row['培训日期'] ?? '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) === year) {
      yearCount += 1
    }
    const attendees = parsePositiveInt(String(row['参训人数'] ?? '').trim())
    if (attendees !== null) {
      totalAttendees += attendees
    }
    const rate = parsePercent(String(row['考核通过率'] ?? '').trim())
    if (rate !== null) {
      rateSum += rate
      rateCount += 1
    }
  }
  return {
    yearCount,
    totalAttendees,
    averageRate: rateCount ? Math.round((rateSum / rateCount) * 10) / 10 : null,
  }
}
