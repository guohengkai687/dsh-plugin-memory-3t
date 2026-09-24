/**
 * 「记忆管理」独立设置页（settings.section 槽位，v0.5；v0.5.4 起为纯参数编辑面）。
 *
 * 页面结构（刻意保持最小，避免与只读面板 /dev-memory/ 功能/外观重复）：
 * - 顶部：打开只读面板入口 + 提示（状态、检索、诊断汇总均在该面板查看）；
 * - 下方：完整可编辑表单（DevMemoryForm + SECTION_FIELDS）——插件参数的唯一编辑面。
 *
 * v0.5.3 移除了「插件配置」选项卡内的重复卡片（settings.plugin.item）；
 * v0.5.4 移除本页顶部的「记忆库状态」卡——其状态行（版本回溯/检索/诊断）
 * 与表单开关主题重合，造成"参数重复"观感；库状态信息回归只读面板。
 * v0.7.1：数据面从 ctx.settingsScope（0.1.1）迁移到 ctx.configForms（0.1.7）。
 */

import type { ConfigForm } from './contract.ts'
import { DevMemoryForm, SECTION_FIELDS } from './form.tsx'
import type { LocaleKey } from './locales.ts'

export interface DevMemorySectionProps {
  t: (key: LocaleKey) => string
  /** 宿主条目表单（ctx.configForms.get(条目 id)），与「记忆管理」页一一对应。 */
  form: ConfigForm<Record<string, unknown>>
}

const style = {
  wrap: { display: 'flex', flexDirection: 'column' as const, gap: 14 },
  linkRow: { display: 'flex', alignItems: 'center' as const, gap: 10, flexWrap: 'wrap' as const },
  link: {
    display: 'inline-flex', alignItems: 'center' as const, gap: 6,
    background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
    textDecoration: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 500,
  },
  hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
} as const

export function DevMemorySection({ t, form }: DevMemorySectionProps) {
  return (
    <div style={style.wrap}>
      <div style={style.linkRow}>
        <a href="/dev-memory/" target="_blank" rel="noreferrer" style={style.link}>{t('openPanel')}</a>
        <span style={style.hint}>{t('openPanelHint')}</span>
      </div>
      <DevMemoryForm form={form} t={t} fields={SECTION_FIELDS} />
    </div>
  )
}