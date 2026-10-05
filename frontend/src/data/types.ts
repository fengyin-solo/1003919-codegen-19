/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 考核回传包：外部讲师在签到表上补录后整包回传，平台逐条合并。 */
export type FeedbackRecord = {
  培训编号: string
  培训主题: string
  培训对象: string
  培训日期: string
  授课人: string
  参训人数: string
  授课记录: string
  考核结果: string
  考核通过率: string
}

/** 已成功合并过的回传包登记：同一包重复导入只合并一次。 */
export type FeedbackPackageInfo = {
  packageId: string
  fingerprint: string
  importedAt: string
  recordCount: number
  mergedIds: number[]
}

export type MergeFailure = {
  row: number
  培训编号: string
  reason: string
}

export type MergeResult = {
  ok: boolean
  packageId?: string
  mergedCount: number
  failures: MergeFailure[]
  advices: { id: number; 培训编号: string; 结业建议: string }[]
  followUpCount: number
  conflicts: string[]
  message: string
}
