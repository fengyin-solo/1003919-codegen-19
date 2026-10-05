<template>
  <section class="page" data-module="training">
    <header class="page-head">
      <div>
        <h2>群测群防培训管理</h2>
        <p class="page-desc">
          按培训主题和对象导出签到表，外部讲师补录授课记录、参训人数和考核结果后回传；平台逐条合并、生成结业建议，并在防灾宣传页生成后续宣讲事项。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出培训清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel">
      <h3>考核回传包</h3>
      <div class="panel-grid">
        <form class="export-form" @submit.prevent="exportSheet">
          <label class="filter-item">
            <span>培训主题</span>
            <input v-model="sheetTopic" placeholder="如：地灾识别与避险" />
          </label>
          <label class="filter-item">
            <span>培训对象</span>
            <input v-model="sheetAudience" placeholder="如：监测员" />
          </label>
          <button class="btn primary" type="submit">导出签到表（回传包模板）</button>
        </form>
        <div class="import-form">
          <label class="btn import-btn">
            导入讲师回传的 CSV
            <input ref="fileInput" type="file" accept=".csv,text/csv" @change="importSheet" />
          </label>
          <span class="hint">任一记录失败整包退回；同一包只合并一次；已归档培训不能被覆盖。</span>
        </div>
      </div>
      <p class="hint">
        冲突取舍：培训编号、主题、对象、日期以课程计划为准，对不上的记录整包退回；授课人、参训人数、授课记录、考核结果、通过率以回传包为准，旧培训缺通过率按空值兼容。
      </p>

      <div v-if="importReport" class="import-result">
        <template v-if="importReport.ok">
          <p class="success-text">
            回传包 {{ importReport.packageNo }} 已合并 {{ importReport.mergedCount }}
            条（{{ importReport.trainingNos.join('、') }}），生成后续宣讲事项
            {{ importReport.followUpNos.join('、') }}，合并时间 {{ importReport.importedAt }}。
          </p>
        </template>
        <template v-else>
          <p class="error-text">整包退回：{{ importReport.message }}</p>
          <table v-if="importReport.errors.length" class="data-table error-table">
            <thead>
              <tr><th>CSV 行号</th><th>培训编号</th><th>失败原因</th></tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) in importReport.errors" :key="index">
                <td>{{ item.line }}</td>
                <td>{{ item.培训编号 || '—' }}</td>
                <td>{{ item.reason }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>

      <details v-if="ledger.length">
        <summary>已合并回传包台账（{{ ledger.length }} 包）</summary>
        <table class="data-table ledger-table">
          <thead>
            <tr><th>包号</th><th>合并时间</th><th>合并条数</th><th>培训编号</th><th>后续宣讲事项</th></tr>
          </thead>
          <tbody>
            <tr v-for="entry in ledger" :key="entry.packageNo">
              <td>{{ entry.packageNo }}</td>
              <td>{{ entry.importedAt }}</td>
              <td>{{ entry.mergedCount }}</td>
              <td>{{ entry.trainingNos.join('、') }}</td>
              <td>{{ entry.followUpNos.join('、') }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column" class="cell-ellipsis" :title="displayCell(row, column)">
            {{ displayCell(row, column) }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无群测群防培训数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条群测群防培训记录</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  exportSignSheet,
  importReturnPackage,
  listReturnLedger,
  trainingStats,
  type ImportReport,
} from '@/api/training-package'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('training')
const columns = ["培训编号", "培训主题", "培训对象", "培训日期", "授课人", "参训人数", "授课记录", "考核结果", "考核通过率", "结业建议"]
const actions = ["开始授课", "完成授课", "组织考核", "归档培训"]
const statuses = ["待开展", "授课中", "已完成", "已考核", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["培训编号", "培训主题", "培训对象"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const summary = trainingStats(rows.value, new Date().getFullYear())
  return [
    { label: '年度培训次数', value: summary.yearCount },
    { label: '累计参训人数', value: summary.totalAttendees },
    {
      label: '平均考核通过率',
      value: summary.averageRate === null ? '—' : `${summary.averageRate}%`,
    },
  ]
})

const sheetTopic = ref('')
const sheetAudience = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const importReport = ref<ImportReport | null>(null)
const ledger = ref(listReturnLedger())

function resetFilters() {
  filters.value = {}
  reload()
}

function clearMessages() {
  errorMessage.value = ''
  successMessage.value = ''
}

function exportRows() {
  downloadEntries(meta.key)
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function exportSheet() {
  clearMessages()
  importReport.value = null
  try {
    const sheet = exportSignSheet(sheetTopic.value, sheetAudience.value)
    download(sheet.filename, sheet.content)
    successMessage.value = `签到表已导出，覆盖 ${sheet.matchedCount} 场培训，包号 ${sheet.packageNo}`
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '签到表导出失败'
  }
}

function importSheet(event: Event) {
  clearMessages()
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const report = importReturnPackage(String(reader.result ?? ''))
    importReport.value = report
    if (report.ok) {
      successMessage.value = `回传包 ${report.packageNo} 合并完成`
      ledger.value = listReturnLedger()
      reload()
    }
    input.value = ''
  }
  reader.onerror = () => {
    errorMessage.value = '回传包文件读取失败'
    input.value = ''
  }
  reader.readAsText(file, 'utf-8')
}

function displayCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (column === '考核通过率' && value !== '' && value !== undefined && value !== null) {
    return `${value}%`
  }
  if (value === '' || value === undefined || value === null) {
    return '—'
  }
  return String(value)
}

function runAction(action: string, row: EntryRow) {
  clearMessages()
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  clearMessages()
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '群测群防培训列表读取失败'
  }
}

onMounted(reload)
</script>
