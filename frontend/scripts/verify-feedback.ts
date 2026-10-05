// 核心合并逻辑验证脚本：用 tsc 编译到临时目录后在 Node 中跑，window/localStorage 用内存桩替代。
// 运行：node_modules/.bin/tsc scripts/verify-feedback.ts src/data/*.ts --outDir /tmp/fbtest --target ES2020 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --baseUrl . && node /tmp/fbtest/scripts/verify-feedback.js
const memory = new Map<string, string>()
const storageStub = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
}
Object.defineProperty(globalThis, 'localStorage', { value: storageStub })
Object.defineProperty(globalThis, 'window', { value: globalThis })

import { exportSigninSheet, mergeFeedbackPackage, listFeedbackPackages } from '../src/data/training-feedback'
import { allRows, storageKey, feedbackStorageKey } from '../src/data/local-store'

function snapshot() {
  return JSON.parse(JSON.stringify(allRows()))
}
function trainingByCode(code: string) {
  return allRows().training.find((r) => r.培训编号 === code)
}
function assert(cond: boolean, message: string) {
  if (!cond) {
    console.error('FAIL:', message)
    process.exitCode = 1
  } else {
    console.log('PASS:', message)
  }
}

// 1. 导出签到表（按主题+对象筛选）
const sheet = exportSigninSheet({ 培训主题: '滑坡' })
const lines = sheet.content.split('\n')
assert(lines[0].includes('实际授课人') && lines[0].includes('考核通过率'), '签到表含补录列头')
assert(lines.length === 2 && lines[1].startsWith('TRAI-0001'), '按主题筛选只导出 TRAI-0001')
const fullSheet = exportSigninSheet()
assert(fullSheet.content.split('\n').length === 4, '空条件导出 3 条待回传培训（已归档排除）')
assert(!fullSheet.content.includes('TRAI-0004'), '签到表不含已归档培训')

// 2. 正常回传包：TRAI-0001 通过率留空（旧培训空值兼容），TRAI-0002 通过率 95
const goodCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0001,滑坡群测群防识灾报灾,监测员、村干部,2026-09-01,县自然资源局 王磊,32,外聘讲师 刘工,"完成2学时授课,含现场踏勘",30,28,',
  'TRAI-0002,山洪泥石流临灾避险,受威胁群众,2026-09-08,省地质环境监测站 李芳,60,外聘讲师 赵工,完成3学时避险演练,58,55,95',
].join('\n')
const before = snapshot()
const good = mergeFeedbackPackage(goodCsv)
assert(good.ok, '正常回传包合并成功: ' + good.message)
assert(good.mergedCount === 2, '合并 2 条记录')
assert(good.followUpCount === 2, '生成 2 项后续宣讲事项')
assert(listFeedbackPackages().length === 1, '登记 1 个回传包批次')

const t1 = trainingByCode('TRAI-0001')!
const t2 = trainingByCode('TRAI-0002')!
assert(t1.status === '已考核', 'TRAI-0001 状态流转为已考核')
assert(t1.授课人 === '外聘讲师 刘工', '实际授课人以回传为准')
assert(t1.授课记录 === '完成2学时授课,含现场踏勘', '授课记录支持逗号引号')
assert(Number(t1.参训人数) === 30, '实际参训人数以回传为准')
assert(t1.计划参训人数 === 32, '计划参训人数保留课程计划值')
assert(t1.考核通过率 === '', '旧培训缺通过率按空值保存')
assert(Number(t1.考核结果) === 28, '考核合格人数已回写')
assert(String(t1.结业建议).includes('按期结业'), '空通过率按合格人数估算 28/30=93.3% → 按期结业建议: ' + t1.结业建议)
assert(String(t1.回传批次).startsWith('FB-'), '回传批次号已标记')
assert(String(t2.结业建议).includes('按期结业'), 'TRAI-0002 通过率95% → 按期结业建议')

const props = allRows().propaganda
const follow = props.filter((p) => p.来源培训编号)
assert(follow.length === 2, '宣传页新增 2 条后续宣讲事项')
const f1 = follow.find((p) => p.来源培训编号 === 'TRAI-0001')!
assert(f1.活动主题 === undefined && f1.宣传主题 === '滑坡群测群防识灾报灾后续宣讲', '宣讲主题由培训主题派生')
assert(f1.活动日期 === '2026-09-08', '宣讲日期为培训日期+7天')
assert(f1.活动编号 === 'PROP-0004', '宣讲活动编号顺延 PROP-0004')
assert(f1.status === '待开展', '后续宣讲为待开展')

// 3. 同一包重复导入只合并一次
const dup = mergeFeedbackPackage(goodCsv)
assert(!dup.ok && dup.message.includes('只合并一次'), '同一包重复导入被拒绝')
assert(listFeedbackPackages().length === 1, '重复导入不新增批次登记')
assert(allRows().propaganda.filter((p) => p.来源培训编号).length === 2, '重复导入不重复生成宣讲事项')

// 合并后再导出签到表：已合并培训不再出现，只剩 TRAI-0003
const sheetAfter = exportSigninSheet().content
assert(!sheetAfter.includes('TRAI-0001') && !sheetAfter.includes('TRAI-0002'), '已合并培训不再进入签到表')
assert(sheetAfter.includes('TRAI-0003'), '未回传的 TRAI-0003 仍可导出')

// 4. 任一记录失败 → 整包退回（数据完全不动）
const badCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0003,简易监测设备操作,基层监测员,2026-09-20,设备厂商技术员 张强,24,外聘讲师 陈工,完成实操教学,24,20,85',
  'TRAI-9999,不存在的培训,基层监测员,2026-09-21,张三,10,李四,授课,10,9,90',
].join('\n')
const bad = mergeFeedbackPackage(badCsv)
assert(!bad.ok, '含失败记录的包整体失败')
assert(bad.failures.length === 1 && bad.failures[0].row === 3, '定位到第 3 行失败')
assert(bad.failures[0].reason.includes('找不到培训编号'), '失败原因明确: ' + bad.failures[0].reason)
const t3 = trainingByCode('TRAI-0003')!
assert(t3.status === '待开展' && !t3.回传批次, '整包退回：同包内合法记录 TRAI-0003 也未被写入')
assert(allRows().propaganda.filter((p) => p.来源培训编号).length === 2, '整包退回：未生成任何新宣讲事项')
assert(listFeedbackPackages().length === 1, '整包退回：不登记包指纹')

// 5. 已归档培训不能被覆盖
const archivedCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0004,年度地质灾害防治政策宣讲,乡镇分管负责人,2026-03-15,县自然资源局 王磊,40,外部讲师,补录,40,40,100',
].join('\n')
const archived = mergeFeedbackPackage(archivedCsv)
assert(!archived.ok, '已归档培训回传被拒绝')
assert(archived.failures[0].reason.includes('已归档'), '拒绝原因含已归档: ' + archived.failures[0].reason)
const t4 = trainingByCode('TRAI-0004')!
assert(t4.授课人 === '县自然资源局 王磊' && !t4.回传批次, '归档培训数据未被覆盖')

// 6. 字段级校验：合格人数超参训人数、非法通过率
const invalidCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0003,简易监测设备操作,基层监测员,2026-09-20,设备厂商技术员 张强,24,陈工,授课,20,25,120',
].join('\n')
const invalid = mergeFeedbackPackage(invalidCsv)
assert(!invalid.ok, '非法数据整包退回')
const reasons = invalid.failures.map((f) => f.reason).join('; ')
assert(reasons.includes('超过实际参训人数'), '合格人数超限被拦截')
assert(reasons.includes('0~100'), '通过率越界被拦截')

// 7. 主题不一致 → 失败（计划侧为准，强校验）
const mismatchCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0003,被篡改的主题,基层监测员,2026-09-20,张强,24,陈工,授课,24,20,85',
].join('\n')
const mismatch = mergeFeedbackPackage(mismatchCsv)
assert(!mismatch.ok && mismatch.failures[0].reason.includes('培训主题'), '培训主题与计划不一致整包退回')

// 8. 日期冲突不阻断，按课程计划保留并给提示
const dateCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0003,简易监测设备操作,基层监测员,2026-09-25,设备厂商技术员 张强,24,陈工,授课,24,10,40',
].join('\n')
const dateRes = mergeFeedbackPackage(dateCsv)
assert(dateRes.ok, '日期冲突包仍可合并')
assert(dateRes.conflicts.length === 1 && dateRes.conflicts[0].includes('2026-09-20'), '冲突提示保留计划日期')
assert(trainingByCode('TRAI-0003')!.培训日期 === '2026-09-20', '培训日期以课程计划为准')
assert(String(trainingByCode('TRAI-0003')!.结业建议).includes('重新组织'), '通过率40% → 不予结业建议')

// 9. 已合并培训不能再被另一个包覆盖
const againCsv = [
  '培训编号,培训主题,培训对象,培训日期,计划授课人,计划参训人数,实际授课人,授课记录,实际参训人数,考核结果(合格人数),考核通过率(%)',
  'TRAI-0002,山洪泥石流临灾避险,受威胁群众,2026-09-08,省地质环境监测站 李芳,60,其他讲师,再次回传,58,55,95',
].join('\n')
const again = mergeFeedbackPackage(againCsv)
assert(!again.ok && again.failures[0].reason.includes('已合并过'), '已合并培训拒绝二次覆盖')

// 10. 存储键与未污染初始模块
assert(storageKey().includes('entries'), '业务数据存储键正常')
assert(feedbackStorageKey().includes('training-feedback-packages'), '回传包登记有独立存储键')
const seedOnly = ['hazard', 'deformation']
seedOnly.forEach((key) => {
  const untouched = JSON.stringify(before[key]) === JSON.stringify(allRows()[key])
  assert(untouched, `${key} 模块数据未受回传影响`)
})

console.log('\n存储键:', storageKey(), '/', feedbackStorageKey())
console.log('批次:', listFeedbackPackages().map((p) => `${p.packageId}(${p.recordCount}条)`).join(', '))
console.log(process.exitCode ? '\n存在失败用例' : '\n全部用例通过')
