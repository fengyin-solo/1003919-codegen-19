import {
  listRows,
  readFeedbackPackages,
  saveRows,
  writeFeedbackPackages,
} from './local-store'
import type {
  EntryRow,
  FeedbackPackageInfo,
  FeedbackRecord,
  MergeFailure,
  MergeResult,
} from './types'

// 考核回传包：平台先按培训主题/对象导出签到表，外部讲师补录授课记录、参训人数与考核结果后整包回传。
// 冲突取舍（平台决定）：
//   1. 课程计划侧字段（培训主题、培训对象、培训日期）以平台课程计划为准，回传值只做核对、不覆盖；
//      回传日期与计划日期不一致时登记冲突提示，平台保留计划日期。
//   2. 授课执行侧字段（实际授课人、授课记录、实际参训人数、考核结果、考核通过率）以回传包为准合并。
// 其余规则：同一包只合并一次（内容指纹去重）；任一记录失败整包退回、不写任何数据；已归档培训不可覆盖；
//           旧培训缺考核通过率时按空值兼容；合并成功后为防灾宣传页生成后续宣讲事项。

const ARCHIVED_STATUS = '已归档'
const EXAMINED_STATUS = '已考核'
const FOLLOW_UP_STATUS = '待开展'

const PLAN_HEADERS = [
  '培训编号',
  '培训主题',
  '培训对象',
  '培训日期',
  '计划授课人',
  '计划参训人数',
  '实际授课人',
  '授课记录',
  '实际参训人数',
  '考核结果(合格人数)',
  '考核通过率(%)',
]

type ParsedPackage = {
  records: FeedbackRecord[]
  fingerprint: string
}

/** 支持引号包裹与转义双引号的 CSV 解析，返回去掉表头后的单元格二维数组。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i += 1) {
    const char = src[i]
    if (inQuotes) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      field = ''
      row = []
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, '')
}

/** 回传包列名做别名归一：表头允许带括号说明或百分号后缀。 */
function resolveColumn(header: string): keyof FeedbackRecord | null {
  const key = normalizeHeader(header)
  if (key === '培训编号') return '培训编号'
  if (key === '培训主题') return '培训主题'
  if (key === '培训对象') return '培训对象'
  if (key === '培训日期') return '培训日期'
  if (key === '实际授课人' || key === '授课人') return '授课人'
  if (key === '授课记录') return '授课记录'
  if (key === '实际参训人数' || key === '参训人数') return '参训人数'
  if (key.startsWith('考核结果')) return '考核结果'
  if (key.startsWith('考核通过率')) return '考核通过率'
  return null
}

/** djb2 内容指纹：内容完全相同的回传包视为同一包。 */
function fingerprintOf(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  let hash = 5381
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function parseFeedbackFile(text: string): ParsedPackage {
  const table = parseCsv(text).filter((cells) => cells.some((cell) => cell.trim() !== ''))
  if (table.length < 2) {
    throw new Error('回传包没有可合并的数据行，请使用平台导出的签到表补录后回传')
  }
  const headerMap = new Map<keyof FeedbackRecord, number>()
  table[0].forEach((header, index) => {
    const column = resolveColumn(header)
    if (column && !headerMap.has(column)) {
      headerMap.set(column, index)
    }
  })
  const requiredColumns: (keyof FeedbackRecord)[] = ['培训编号', '培训主题', '培训对象']
  for (const column of requiredColumns) {
    if (!headerMap.has(column)) {
      throw new Error(`回传包缺少「${column}」列，请使用平台导出的签到表模板`)
    }
  }
  const records: FeedbackRecord[] = []
  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r]
    const pick = (column: keyof FeedbackRecord): string => {
      const index = headerMap.get(column)
      return index === undefined ? '' : (cells[index] ?? '').trim()
    }
    records.push({
      培训编号: pick('培训编号'),
      培训主题: pick('培训主题'),
      培训对象: pick('培训对象'),
      培训日期: pick('培训日期'),
      授课人: pick('授课人'),
      参训人数: pick('参训人数'),
      授课记录: pick('授课记录'),
      考核结果: pick('考核结果'),
      考核通过率: pick('考核通过率'),
    })
  }
  return { records, fingerprint: fingerprintOf(text) }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null
  }
  return Number(value.trim())
}

/** 考核通过率允许为空（旧培训空值兼容），填了就必须是 0~100 的数。 */
function parsePassRate(value: string): number | null {
  const text = value.trim().replace(/%$/, '')
  if (text === '') {
    return null
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return Number.NaN
  }
  const rate = Number(text)
  return rate >= 0 && rate <= 100 ? rate : Number.NaN
}

function buildGraduationAdvice(rate: number | null, passed: number, total: number): string {
  let effectiveRate = rate
  if (effectiveRate === null && total > 0) {
    // 旧培训未回填通过率：用合格人数/参训人数兜底估算，但通过率字段仍按空值保存。
    effectiveRate = Math.round((passed / total) * 1000) / 10
  }
  if (effectiveRate === null) {
    return '考核数据不完整，暂缓提出结业建议，待补齐考核结果后复核'
  }
  if (effectiveRate >= 90) {
    return '考核通过率达标，建议按期结业并纳入群测群防骨干名单'
  }
  if (effectiveRate >= 60) {
    return '考核基本合格，建议针对薄弱内容补训后结业'
  }
  return '考核未达合格线，建议重新组织培训与考核，暂不予结业'
}

function nextNumericCode(rows: EntryRow[], field: string, prefix: string): string {
  let max = 0
  for (const row of rows) {
    const match = String(row[field] ?? '').match(new RegExp(`^${prefix}-(\\d+)$`))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function addDays(dateText: string, days: number): string {
  const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return ''
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  date.setDate(date.getDate() + days)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 按培训主题/对象导出签到表（CSV），空条件导出全部待回传培训（已归档、已合并的不再导出）。 */
export function exportSigninSheet(filters: { 培训主题?: string; 培训对象?: string } = {}): {
  filename: string
  content: string
} {
  const theme = filters.培训主题?.trim() ?? ''
  const audience = filters.培训对象?.trim() ?? ''
  const target = listRows('training').filter(
    (row) =>
      String(row.status) !== ARCHIVED_STATUS &&
      !row.回传批次 &&
      (theme === '' || String(row.培训主题 ?? '').includes(theme)) &&
      (audience === '' || String(row.培训对象 ?? '').includes(audience)),
  )
  const lines = [PLAN_HEADERS.join(',')]
  for (const row of target) {
    lines.push(
      [
        row.培训编号 ?? '',
        row.培训主题 ?? '',
        row.培训对象 ?? '',
        row.培训日期 ?? '',
        row.授课人 ?? '',
        row.参训人数 ?? '',
        '',
        '',
        '',
        '',
        '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  const suffix = theme || audience ? `-${theme || audience}` : ''
  return {
    filename: `培训考核签到表${suffix}.csv`,
    content: `﻿${lines.join('\n')}`,
  }
}

/**
 * 合并考核回传包。
 * 任一记录校验失败即整包退回（返回 failures，不写任何数据）；
 * 全部通过才一次性写入培训结果、结业建议、后续宣讲事项，并登记包指纹。
 */
export function mergeFeedbackPackage(text: string): MergeResult {
  let parsed: ParsedPackage
  try {
    parsed = parseFeedbackFile(text)
  } catch (error) {
    return {
      ok: false,
      mergedCount: 0,
      failures: [],
      advices: [],
      followUpCount: 0,
      conflicts: [],
      message: error instanceof Error ? error.message : '回传包解析失败',
    }
  }

  const packages = readFeedbackPackages()
  const duplicated = packages.find((item) => item.fingerprint === parsed.fingerprint)
  if (duplicated) {
    return {
      ok: false,
      packageId: duplicated.packageId,
      mergedCount: 0,
      failures: [],
      advices: [],
      followUpCount: 0,
      conflicts: [],
      message: `该回传包已于 ${duplicated.importedAt} 合并（批次 ${duplicated.packageId}），同一包只合并一次`,
    }
  }

  const trainings = [...listRows('training')]
  const failures: MergeFailure[] = []
  const conflicts: string[] = []
  const seenCodes = new Set<string>()
  const planById = new Map<string, EntryRow>()
  for (const row of trainings) {
    planById.set(String(row.培训编号 ?? ''), row)
  }

  interface PlannedMerge {
    index: number
    row: EntryRow
    record: FeedbackRecord
    actualCount: number
    passedCount: number
    passRate: number | null
    advice: string
  }
  const planned: PlannedMerge[] = []

  parsed.records.forEach((record, offset) => {
    const rowNumber = offset + 2
    const code = record.培训编号
    const fail = (reason: string) => failures.push({ row: rowNumber, 培训编号: code, reason })

    if (code === '') {
      fail('培训编号为空，无法定位课程计划')
      return
    }
    if (seenCodes.has(code)) {
      fail(`培训编号 ${code} 在包内重复出现，一条培训只能对应一条回传记录`)
      return
    }
    seenCodes.add(code)

    const row = planById.get(code)
    if (!row) {
      fail(`平台课程计划中找不到培训编号 ${code}`)
      return
    }
    if (String(row.status) === ARCHIVED_STATUS) {
      fail(`培训 ${code} 已归档，归档培训不能被回传覆盖`)
      return
    }
    if (row.回传批次) {
      fail(`培训 ${code} 已合并过批次 ${row.回传批次} 的回传结果，不能再次合并`)
      return
    }

    // 以下为逐字段校验：同一记录的全部问题一次收集完，整包退回时可一次改完。
    let valid = true
    if (String(row.培训主题 ?? '') !== record.培训主题) {
      fail(`培训主题与平台课程计划不一致（计划：${row.培训主题 ?? '—'}，回传：${record.培训主题 || '空'}）`)
      valid = false
    }
    if (String(row.培训对象 ?? '') !== record.培训对象) {
      fail(`培训对象与平台课程计划不一致（计划：${row.培训对象 ?? '—'}，回传：${record.培训对象 || '空'}）`)
      valid = false
    }
    const planDate = String(row.培训日期 ?? '')
    if (record.培训日期 && planDate && record.培训日期 !== planDate) {
      // 日期冲突：按既定取舍以课程计划为准，仅提示不阻断。
      conflicts.push(
        `培训 ${code} 回传日期 ${record.培训日期} 与计划日期 ${planDate} 不一致，已按课程计划保留 ${planDate}`,
      )
    }
    if (record.授课人 === '') {
      fail('实际授课人为空，外部讲师须补录授课人')
      valid = false
    }
    if (record.授课记录 === '') {
      fail('授课记录为空，外部讲师须补录授课记录')
      valid = false
    }
    const actualCount = parsePositiveInteger(record.参训人数)
    if (actualCount === null) {
      fail(`实际参训人数「${record.参训人数 || '空'}」不是非负整数`)
      valid = false
    }
    const passedCount = parsePositiveInteger(record.考核结果)
    if (passedCount === null) {
      fail(`考核结果（合格人数）「${record.考核结果 || '空'}」不是非负整数`)
      valid = false
    }
    if (
      actualCount !== null &&
      passedCount !== null &&
      passedCount > actualCount
    ) {
      fail(`考核合格人数 ${passedCount} 超过实际参训人数 ${actualCount}`)
      valid = false
    }
    const passRate = parsePassRate(record.考核通过率)
    if (Number.isNaN(passRate)) {
      fail(`考核通过率「${record.考核通过率}」不是 0~100 之间的数值；旧培训无通过率可留空`)
      valid = false
    }
    if (!valid || actualCount === null || passedCount === null) {
      return
    }

    planned.push({
      index: trainings.indexOf(row),
      row,
      record,
      actualCount,
      passedCount,
      passRate,
      advice: buildGraduationAdvice(passRate, passedCount, actualCount),
    })
  })

  if (failures.length > 0) {
    // 整包退回：不修改培训数据、不生成宣讲事项、不登记包指纹。
    return {
      ok: false,
      mergedCount: 0,
      failures,
      advices: [],
      followUpCount: 0,
      conflicts,
      message: `回传包整包退回：${failures.length} 条记录校验未通过，请修正后整包重新回传`,
    }
  }

  // 全部通过，一次性合并培训结果。
  const packageId = `FB-${new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')}-${parsed.fingerprint}`
  const advices: MergeResult['advices'] = []
  for (const item of planned) {
    const updated: EntryRow = {
      ...item.row,
      status: EXAMINED_STATUS,
      pending: true,
      abnormal: false,
      授课人: item.record.授课人,
      参训人数: item.actualCount,
      计划参训人数: item.row.参训人数 ?? '',
      授课记录: item.record.授课记录,
      考核结果: item.passedCount,
      考核通过率: item.passRate === null ? '' : item.passRate,
      结业建议: item.advice,
      回传批次: packageId,
    }
    trainings[item.index] = updated
    advices.push({
      id: Number(updated.id),
      培训编号: String(updated.培训编号 ?? ''),
      结业建议: item.advice,
    })
  }

  // 回传成功后，防灾宣传页生成后续宣讲事项。
  const propaganda = [...listRows('propaganda')]
  for (const item of planned) {
    const planDate = String(item.row.培训日期 ?? '')
    propaganda.push({
      id: nextId(propaganda),
      status: FOLLOW_UP_STATUS,
      pending: true,
      abnormal: false,
      活动编号: nextNumericCode(propaganda, '活动编号', 'PROP'),
      宣传主题: `${item.record.培训主题}后续宣讲`,
      宣传方式: '进村入户宣讲',
      覆盖村组: `按${item.record.培训对象}覆盖村组`,
      活动日期: planDate ? addDays(planDate, 7) : '',
      参与人数: '',
      组织人: '培训管理员',
      活动状态: FOLLOW_UP_STATUS,
      来源培训编号: item.record.培训编号,
      事项说明: `依据培训 ${item.record.培训编号} 结业建议（${item.advice}）安排后续宣讲`,
    })
  }

  saveRows('training', trainings)
  saveRows('propaganda', propaganda)
  const info: FeedbackPackageInfo = {
    packageId,
    fingerprint: parsed.fingerprint,
    importedAt: new Date().toISOString(),
    recordCount: planned.length,
    mergedIds: planned.map((item) => Number(item.row.id)),
  }
  writeFeedbackPackages([...packages, info])

  return {
    ok: true,
    packageId,
    mergedCount: planned.length,
    failures: [],
    advices,
    followUpCount: planned.length,
    conflicts,
    message: `回传包已合并 ${planned.length} 条记录（批次 ${packageId}），并生成 ${planned.length} 项后续宣讲事项`,
  }
}

/** 已合并回传包登记，供页面展示去重依据。 */
export function listFeedbackPackages(): FeedbackPackageInfo[] {
  return readFeedbackPackages()
}
