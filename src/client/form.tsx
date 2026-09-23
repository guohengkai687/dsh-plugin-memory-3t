/**
 * 「记忆管理」表单核心：在 settings scope 之上做 staged 编辑（草稿 → 保存）。
 *
 * - scope：ctx.settingsScope.bind({ namespace: 'dev-memory' })（Host 文档读写）。
 * - 字段分两类：组字段（值在 snapshot.value[group][key]，保存时整体写回该组对象，
 *   保留同组其它已生效字段）与标量字段（snapshot.value[key]）。
 * - 保存 = 逐草稿 scope.set(fieldOrGroup, value)；丢弃 = 只清草稿不写。
 *   组字段写回的是"解析值"（含 base 层），不会误删用户层以外的继承字段。
 * - 纯注入样式（无 CSS 文件），随设置对话框外壳主题走。
 */

import { useEffect, useMemo, useState } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

import type { LocaleKey } from './locales.js'

/** 布尔开关字段。 */
export interface ToggleField {
  kind: 'toggle'
  /** 组名（无 = 顶层标量）。 */
  group?: string
  /** 组内字段名或标量字段名。 */
  key: string
  label: LocaleKey
  hint?: LocaleKey
}

/** 数字字段（空串 = 不写；min 手动钳制；step<1 时保留小数）。 */
export interface NumberField {
  kind: 'number'
  group?: string
  key: string
  label: LocaleKey
  hint?: LocaleKey
  min?: number
  step?: number
}

/** 枚举字段（v0.6.6）：存字符串，选项值即配置值，标签走 locale 或直接给短标签。 */
export interface SelectField {
  kind: 'select'
  group?: string
  key: string
  label: LocaleKey
  hint?: LocaleKey
  /** 选项：value 写入配置，label 为 locale key 或已本地化文本。 */
  options: Array<{ value: string; label: LocaleKey }>
}

export type Field = ToggleField | NumberField | SelectField

export interface DevMemoryFormProps {
  scope: SettingsScope<Record<string, unknown>>
  /** locale bind：key → 当前语言文案。 */
  t: (key: LocaleKey) => string
  fields: Field[]
  /** 紧凑模式：隐藏分组标题与提示（v0.5.3 卡片槽位移除后仅供兼容保留）。 */
  compact?: boolean
  /** 脏状态回调（供外层头部显示「未保存」徽标等）。 */
  onDirtyChange?: (dirty: boolean) => void
}

const style = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 7 },
  group: { margin: '14px 0 3px', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)' },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '9px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  rowLabel: { display: 'flex', flexDirection: 'column' as const, gap: 2, minWidth: 0 },
  label: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
  hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.35 },
  control: { flex: '0 0 auto', display: 'flex', alignItems: 'center' as const },
  input: {
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '2px 12px', fontSize: 13, width: 110, height: 34, fontFamily: 'inherit', boxSizing: 'border-box' as const,
  },
  check: { width: 16, height: 16, accentColor: 'var(--dsw-alias-brand-primary)', cursor: 'pointer' },
  footer: {
    display: 'flex', alignItems: 'center' as const, gap: 8, marginTop: 10,
    justifyContent: 'flex-end',
  },
  btn: {
    appearance: 'none', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
    border: 0, borderRadius: 8, padding: '5px 14px', fontSize: 13, cursor: 'pointer',
  },
  btnGhost: {
    appearance: 'none', background: '0 0', color: 'var(--dsw-alias-label-secondary)',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    padding: '5px 14px', fontSize: 13, cursor: 'pointer',
  },
  status: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  error: { fontSize: 12, color: 'var(--dsw-alias-label-error)' },
  note: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2, lineHeight: 1.5 },
  disabled: { opacity: 0.4, cursor: 'default' },
} as const

function groupOf(snap: SettingsScopeSnapshot<Record<string, unknown>>, group: string): Record<string, unknown> {
  const v = snap.value?.[group]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function groupLabel(group: string): LocaleKey {
  switch (group) {
    case 'webui': return 'groupWebui'
    case 'diag': return 'groupDiag'
    case 'recallNudge': return 'groupNudge'
    case 'vcs': return 'groupVcs'
    case 'embedding': return 'groupEmbedding'
    case 'seed': return 'groupSeed'
    default: return 'groupDigestRecall'
  }
}

export function DevMemoryForm({ scope, t, fields, compact = false, onDirtyChange }: DevMemoryFormProps) {
  const [snap, setSnap] = useState<SettingsScopeSnapshot<Record<string, unknown>>>(() => scope.getSnapshot())
  const [drafts, setDrafts] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  const dirty = Object.keys(drafts).length > 0

  useEffect(() => onDirtyChange?.(dirty), [onDirtyChange, dirty])

  /** 展示态 = 生效值叠加草稿（组草稿是完整组对象，直接覆盖）。 */
  const effective = useMemo(() => {
    const out: Record<string, unknown> = { ...(snap.value ?? {}) }
    for (const [key, value] of Object.entries(drafts)) out[key] = value
    return out
  }, [snap, drafts])

  const fieldValue = (field: Field): unknown => {
    if (field.group !== undefined) {
      const g = effective[field.group]
      return typeof g === 'object' && g !== null ? (g as Record<string, unknown>)[field.key] : undefined
    }
    return effective[field.key]
  }

  const stage = (field: Field, next: unknown): void => {
    setError(null)
    setSaved(false)
    setDrafts((prev) => {
      if (field.group !== undefined) {
        const base = groupOf(snap, field.group)
        const prior = prev[field.group]
        const merged = { ...base, ...(typeof prior === 'object' && prior !== null ? (prior as Record<string, unknown>) : {}), [field.key]: next }
        return { ...prev, [field.group]: merged }
      }
      return { ...prev, [field.key]: next }
    })
  }

  const save = async (): Promise<void> => {
    const entries = Object.entries(drafts)
    if (entries.length === 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      for (const [key, value] of entries) {
        await scope.set(key, value)
      }
      setDrafts({})
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setDrafts({})
    setError(null)
    setSaved(false)
  }

  if (snap.status === 'loading') {
    return <div style={style.status}>{t('loading')}</div>
  }
  if (snap.status !== 'ready') {
    return <div style={style.status}>{t('unavailable')}</div>
  }
  if (!snap.writable) {
    return <div style={style.status}>{t('readOnly')}</div>
  }

  // 渲染序列：非紧凑时在每组首行前插入分组标题。
  // 注意：标题条目只携带 header、不带 field——v0.5.5 修复前把组内首个字段一并
  // 推入标题条目，导致每个分组的第一个参数被渲染两次（用户报"参数显示 2 次"）。
  const rendered: Array<{ header?: LocaleKey; field?: Field }> = []
  let lastGroup: string | undefined
  for (const field of fields) {
    if (!compact && field.group !== undefined && field.group !== lastGroup) {
      rendered.push({ header: groupLabel(field.group) })
    }
    rendered.push({ field })
    lastGroup = field.group
  }

  return (
    <div style={style.wrap}>
      {!compact && <div style={style.note}>{t('restartNote')}</div>}
      {rendered.map(({ header, field }, index) => {
        const rowKey = field !== undefined ? `${field.group ?? 'scalar'}:${field.key}` : `header:${index}`
        return (
          <div key={header !== undefined ? `${rowKey}-header` : rowKey}>
            {header !== undefined && <div style={style.group}>{t(header)}</div>}
            {field !== undefined && (
              <div style={style.row}>
                <div style={style.rowLabel}>
                  <span style={style.label}>{t(field.label)}</span>
                  {!compact && field.hint !== undefined && <span style={style.hint}>{t(field.hint)}</span>}
                </div>
                <div style={style.control}>
                  {field.kind === 'toggle' ? (
                    <input
                    type="checkbox"
                    style={style.check}
                    checked={fieldValue(field) === true}
                    disabled={saving}
                    onChange={(event) => stage(field, event.target.checked)}
                  />
                ) : field.kind === 'select' ? (
                  <select
                    style={{ ...style.input, width: 172, paddingRight: 4 }}
                    value={typeof fieldValue(field) === 'string' ? (fieldValue(field) as string) : ''}
                    disabled={saving}
                    onChange={(event) => stage(field, event.target.value)}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.label)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    style={style.input}
                    value={typeof fieldValue(field) === 'number' ? Number(fieldValue(field)) : ''}
                    min={field.min}
                    step={field.step ?? 1}
                    disabled={saving}
                    onChange={(event) => {
                      const raw = event.target.value.trim()
                      if (raw === '') {
                        stage(field, undefined)
                        return
                      }
                      const n = Number(raw)
                      if (!Number.isFinite(n)) return
                      const clipped = field.min !== undefined && n < field.min ? field.min : n
                      const step = field.step ?? 1
                      const next = step % 1 !== 0 ? Number(clipped.toFixed(4)) : Math.floor(clipped)
                      stage(field, next)
                    }}
                  />
                )}
                </div>
              </div>
            )}
          </div>
        )
      })}
      <div style={style.footer}>
        <button type="button" style={{ ...style.btn, ...(saving || !dirty ? style.disabled : {}) }} disabled={!dirty || saving} onClick={() => void save()}>
          {t(saving ? 'saving' : 'save')}
        </button>
        <button type="button" style={{ ...style.btnGhost, ...(saving || !dirty ? style.disabled : {}) }} disabled={!dirty || saving} onClick={discard}>
          {t('discard')}
        </button>
        {dirty && <span style={style.status}>{t('unsaved')}</span>}
        {saved && <span style={style.status}>{t('saved')}</span>}
        {error !== null && <span style={style.error}>{error}</span>}
      </div>
    </div>
  )
}

/** 独立设置页的完整字段表。 */
export const SECTION_FIELDS: Field[] = [
  { kind: 'toggle', group: 'webui', key: 'enabled', label: 'webuiEnabled', hint: 'webuiEnabledHint' },
  { kind: 'toggle', group: 'diag', key: 'enabled', label: 'diagEnabled', hint: 'diagEnabledHint' },
  { kind: 'number', group: 'diag', key: 'maxEvents', label: 'diagMaxEvents', hint: 'diagMaxEventsHint', min: 0, step: 100 },
  { kind: 'toggle', group: 'recallNudge', key: 'enabled', label: 'nudgeEnabled', hint: 'nudgeEnabledHint' },
  { kind: 'toggle', group: 'vcs', key: 'enabled', label: 'vcsEnabled', hint: 'vcsEnabledHint' },
  { kind: 'toggle', group: 'vcs', key: 'autoCommit', label: 'vcsAutoCommit', hint: 'vcsAutoCommitHint' },
  { kind: 'number', group: 'vcs', key: 'debounceMs', label: 'vcsDebounceMs', min: 0, step: 100 },
  { kind: 'number', group: 'vcs', key: 'batch', label: 'vcsBatch', min: 1 },
  { kind: 'toggle', group: 'embedding', key: 'enabled', label: 'embeddingEnabled', hint: 'embeddingEnabledHint' },
  { kind: 'number', group: 'embedding', key: 'timeoutMs', label: 'embeddingTimeoutMs', min: 0, step: 100 },
  { kind: 'number', group: 'digest', key: 'maxMessages', label: 'digestMaxMessages', min: 0 },
  { kind: 'number', group: 'recall', key: 'minSalience', label: 'recallMinSalience', min: 0, step: 0.05 },
  // v0.6.6：L3 长期事实注入方式（默认不注入，按需 recall）
  {
    kind: 'select',
    key: 'l3Inject',
    label: 'l3Inject',
    hint: 'l3InjectHint',
    options: [
      { value: 'off', label: 'l3InjectOff' },
      { value: 'salience', label: 'l3InjectSalience' },
      { value: 'query', label: 'l3InjectQuery' },
    ],
  },
  // v0.6.5：冷启动 seed（无 LLM 生成项目骨架）
  { kind: 'toggle', group: 'seed', key: 'enabled', label: 'seedEnabled', hint: 'seedEnabledHint' },
  { kind: 'toggle', group: 'seed', key: 'auto', label: 'seedAuto', hint: 'seedAutoHint' },
  { kind: 'number', group: 'seed', key: 'gitCommits', label: 'seedGitCommits', hint: 'seedGitCommitsHint', min: 0, step: 10 },
  { kind: 'number', group: 'seed', key: 'maxEntries', label: 'seedMaxEntries', min: 1, step: 10 },
  { kind: 'number', key: 'maxBootTokens', label: 'maxBootTokens', min: 0, step: 100 },
  { kind: 'number', key: 'maxRuntimeTokens', label: 'maxRuntimeTokens', min: 0, step: 100 },
  { kind: 'number', key: 'maxSpaceTokens', label: 'maxSpaceTokens', min: 0, step: 100 },
  { kind: 'number', key: 'maxViewTokens', label: 'maxViewTokens', hint: 'maxViewTokensHint', min: 0, step: 100 },
]

/** 可配置卡片（Plugins 选项卡）的紧凑字段表。 */
export const CARD_FIELDS: Field[] = [
  { kind: 'toggle', group: 'webui', key: 'enabled', label: 'webuiEnabled' },
  { kind: 'toggle', group: 'diag', key: 'enabled', label: 'diagEnabled' },
  { kind: 'toggle', group: 'recallNudge', key: 'enabled', label: 'nudgeEnabled' },
  { kind: 'toggle', group: 'vcs', key: 'enabled', label: 'vcsEnabled' },
  { kind: 'toggle', group: 'embedding', key: 'enabled', label: 'embeddingEnabled' },
]