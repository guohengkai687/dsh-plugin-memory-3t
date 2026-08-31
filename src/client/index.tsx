/**
 * dsh-plugin-memory-3t 客户端 bundle（v0.5 新增）。
 *
 * 通过 package.json `dsh.client` 声明 + `exports["./client"]` 被 web shell 发现，
 * 加载为浏览器 cordis 客户端插件（built by tsdown，`window.__ModuleLoader__.load`
 * 工厂产物；externals 仅 react / react/jsx-runtime，其余全部内联）。
 *
 * 贡献（v0.5.3 起去重为单一设置面）：
 * - `settings.section`：「记忆管理」独立设置页（打开面板入口 + 库状态 + 完整表单）。
 *   —— 插件参数的唯一编辑面。v0.5.0–0.5.2 曾同时注册 `settings.plugin.item`
 *   卡片（插件配置选项卡内），与独立页功能重复、参数两处可见，v0.5.3 起删除
 *   卡片槽位，只保留独立页，避免设置面分裂。
 *
 * 数据面：ctx.settingsScope.bind({ namespace: 'dev-memory' }) 读写 Host 设置文档；
 * 面板状态经同源 fetch 读取只读端点 /dev-memory/api/status。
 */

// 类型仅取 runtime 的 SettingsScope 契约（结构兼容各 rc 版本；bundle 运行时零依赖）。
import type { SettingsScope, SettingsScopeSpec } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentType } from 'react'

import { DEV_MEMORY_SETTINGS_NS } from '../shared.ts'
import { DevMemorySection } from './section.tsx'
import { en, zh } from './locales.ts'
import type { LocaleKey } from './locales.ts'

/** 浏览器侧插件上下文的最小结构形状（运行时由 cordis 提供；局部类型避免跨版本依赖合并）。 */
export interface BrowserPluginContext {
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: ComponentType<Record<string, never>>): () => void
  }
  locale: {
    register(ns: string, dict: Record<string, unknown>): unknown
    bind(ns: string): (key: string) => string
  }
  settingsScope: {
    bind<T = Record<string, unknown>>(spec: SettingsScopeSpec<T>): SettingsScope<T>
  }
  effect(fn: () => unknown, label?: string): unknown
}

/** 本客户端插件的完整 id（与包名一致，用于 dsh.client 发现与 __ModuleLoader__ id）。 */
const PLUGIN_ID = 'dsh-plugin-memory-3t'
/** settings.section 导航顺序：默认 General/Models 之后、插件市场(40)之后。 */
const SECTION_ORDER = 46

export const name = PLUGIN_ID

export const inject = ['slots', 'locale', 'settingsScope']

export function apply(ctx: BrowserPluginContext): void {
  const NS = DEV_MEMORY_SETTINGS_NS
  const t = ctx.locale.bind(NS) as (key: LocaleKey) => string

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN_ID}: settings dictionaries`)

  const scope = ctx.settingsScope.bind<Record<string, unknown>>({ namespace: NS })

  // 独立设置页 = 插件参数唯一编辑面（v0.5.3 起不再注册 settings.plugin.item 卡片，
  // 避免与独立页功能重复、参数两处可见）
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: PLUGIN_ID,
    order: SECTION_ORDER,
    label: () => t('nav'),
    locale: NS,
  }, (() => <DevMemorySection t={t} scope={scope} />) as ComponentType<Record<string, never>>))
}