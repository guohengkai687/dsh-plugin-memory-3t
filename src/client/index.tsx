/**
 * dsh-plugin-memory-3t 客户端 bundle（v0.5 新增；v0.7.1 迁移到 DSH 0.1.7 设置模型）。
 *
 * 通过 package.json `dsh.client` 声明 + `exports["./client"]` 被 web shell 发现，
 * 加载为浏览器 cordis 客户端插件（built by tsdown，`window.__ModuleLoader__.load`
 * 工厂产物；externals 仅 react / react/jsx-runtime，其余全部内联）。
 *
 * 贡献（v0.5.3 起去重为单一设置面）：
 * - `settings.section`：「记忆管理」独立设置页（打开面板入口 + 完整表单）。
 *   —— 插件参数的唯一编辑面。v0.5.0–0.5.2 曾同时注册 `settings.plugin.item`
 *   卡片（插件配置选项卡内），与独立页功能重复、参数两处可见，v0.5.3 起删除
 *   卡片槽位，只保留独立页，避免设置面分裂。
 *
 * 数据面（0.1.7）：`ctx.configForms.get(DEV_MEMORY_ENTRY_ID)` 读写宿主 profile 条目
 * `dsh-plugin-memory-3t` 的 volatile 字段——旧版 0.1.1 的
 * `ctx.settingsScope.bind({ namespace })` 随旧设置体系一起移除，宿主与客户端现在共用
 * 同一份"条目 id = 命名空间"的模型（服务端见 src/config.ts 的 `Config`）。
 * 页面用 `whileServed` 注册：宿主确实服务该命名空间时才出现，未挂载 / 无设置服务时
 * 不会留下一个永远 unavailable 的空页。
 * 面板状态仍经同源 fetch 读取只读端点 /dev-memory/api/status。
 */

import type { ComponentType } from 'react'

import { DEV_MEMORY_ENTRY_ID, DEV_MEMORY_SETTINGS_NS } from '../shared.ts'
import { DevMemorySection } from './section.tsx'
import { en, zh } from './locales.ts'
import type { LocaleKey } from './locales.ts'
import type { BrowserPluginContext } from './contract.ts'

/** 本客户端插件的完整 id（与包名一致，用于 dsh.client 发现与 __ModuleLoader__ id）。 */
const PLUGIN_ID = 'dsh-plugin-memory-3t'
/** settings.section 导航顺序：默认 General/Models 之后、插件市场(40)之后。 */
const SECTION_ORDER = 46

export const name = PLUGIN_ID

/** 依赖的客户端服务（0.1.7：`configForms` 取代 `settingsScope`）。 */
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: BrowserPluginContext): void {
  const NS = DEV_MEMORY_SETTINGS_NS
  const t = ctx.locale.bind(NS) as (key: LocaleKey) => string

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN_ID}: settings dictionaries`)

  // 宿主条目 id（profile cordis.patch.yml 的 `id:`）同时就是设置表单的命名空间。
  const form = ctx.configForms.get<Record<string, unknown>>(DEV_MEMORY_ENTRY_ID)

  // 独立设置页 = 插件参数唯一编辑面（v0.5.3 起不再注册 settings.plugin.item 卡片，
  // 避免与独立页功能重复、参数两处可见）
  ctx.effect(
    () =>
      ctx.configForms.whileServed([DEV_MEMORY_ENTRY_ID], () =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: PLUGIN_ID,
              order: SECTION_ORDER,
              label: () => t('nav'),
              locale: NS,
            },
            (() => <DevMemorySection t={t} form={form} />) as ComponentType<Record<string, never>>,
          ),
        ),
      ),
    `${PLUGIN_ID}: settings section`,
  )
}
