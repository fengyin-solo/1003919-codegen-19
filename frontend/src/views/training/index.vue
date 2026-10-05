<template>
  <section class="page" data-module="training">
    <header class="page-head">
      <div>
        <h2>群测群防培训管理</h2>
        <p class="page-desc">维护培训记录，支持按培训主题、培训对象导出考核签到表，外部讲师补录授课记录、参训人数和考核结果后整包回传，平台逐条合并并生成结业建议。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记培训记录</button>
        <button class="btn" type="button" @click="exportSignin">导出考核签到表</button>
        <button class="btn" type="button" @click="triggerImport">导入考核回传包</button>
        <input
          ref="fileInput"
          type="file"
          accept=".csv,text/csv"
          hidden
          @change="onFilePicked"
        />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div v-if="mergeResult" class="feedback-panel" :class="mergeResult.ok ? 'ok' : 'bad'">
      <div class="feedback-head">
        <strong>{{ mergeResult.ok ? '回传包合并成功' : '回传包未合并' }}</strong>
        <button class="link" type="button" @click="mergeResult = null">关闭</button>
      </div>
      <p>{{ mergeResult.message }}</p>
      <ul v-if="mergeResult.failures.length" class="feedback-list">
        <li v-for="failure in mergeResult.failures" :key="`${failure.row}-${failure.培训编号}`">
          第 {{ failure.row }} 行（{{ failure.培训编号 || '无编号' }}）：{{ failure.reason }}
        </li>
      </ul>
      <ul v-if="mergeResult.conflicts.length" class="feedback-list conflict">
        <li v-for="(conflict, index) in mergeResult.conflicts" :key="index">冲突处理：{{ conflict }}</li>
      </ul>
      <ul v-if="mergeResult.advices.length" class="feedback-list advice">
        <li v-for="advice in mergeResult.advices" :key="advice.id">
          {{ advice.培训编号 }}：{{ advice.结业建议 }}
        </li>
      </ul>
    </div>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无群测群防培训数据，可先登记培训记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条群测群防培训记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadCsv,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { exportSigninSheet, mergeFeedbackPackage } from '@/data/training-feedback'
import type { EntryRow, MergeResult } from '@/data/types'

const meta = moduleMeta('training')
const columns = ["培训编号", "培训主题", "培训对象", "培训日期", "授课人", "参训人数", "授课记录", "考核结果", "考核通过率", "结业建议", "回传批次"]
const actions = ["开始授课", "完成授课", "组织考核"]
const statuses = ["待开展", "授课中", "已完成", "已考核", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const mergeResult = ref<MergeResult | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = ["培训编号", "培训主题", "培训对象"]
const fileInput = ref<HTMLInputElement | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => {
  const year = new Date().getFullYear()
  const yearly = rows.value.filter((row) => String(row.培训日期 ?? '').startsWith(String(year))).length
  const attendees = rows.value.reduce((sum, row) => sum + (Number(row.参训人数) || 0), 0)
  const examined = rows.value.filter((row) => String(row.考核通过率 ?? '') !== '')
  const avgRate = examined.length
    ? Math.round(examined.reduce((sum, row) => sum + (Number(row.考核通过率) || 0), 0) / examined.length)
    : 0
  return [
    { label: `年度培训次数（${year}年）`, value: yearly },
    { label: '累计参训人数', value: attendees },
    { label: '平均考核通过率(%)', value: examined.length ? avgRate : 0 },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportSignin() {
  errorMessage.value = ''
  const { filename, content } = exportSigninSheet({
    培训主题: filters.value.培训主题 ?? '',
    培训对象: filters.value.培训对象 ?? '',
  })
  downloadCsv(filename, content)
}

function triggerImport() {
  errorMessage.value = ''
  fileInput.value?.click()
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  try {
    const text = await file.text()
    mergeResult.value = mergeFeedbackPackage(text)
    errorMessage.value = mergeResult.value.ok ? '' : mergeResult.value.message
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回传包读取失败'
  }
}

function openCreate() {
  errorMessage.value = '培训记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
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

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
}
.feedback-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: #fff;
  font-size: 13px;
}
.feedback-panel.ok {
  border-color: #12b76a;
  background: #ecfdf3;
}
.feedback-panel.bad {
  border-color: #f04438;
  background: #fef3f2;
}
.feedback-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.feedback-list {
  margin: 6px 0 0;
  padding-left: 18px;
}
.feedback-list.conflict li {
  color: #b54708;
}
.feedback-list.advice li {
  color: #027a48;
}
</style>
