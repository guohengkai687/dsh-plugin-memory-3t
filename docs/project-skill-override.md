# 项目级 SKILL.md 覆盖示例（v0.2 验收项）

插件内置 `dev-memory` 协议（runtime skill）的优先级链由 DSH 决定：

**项目级 `.dsh/skills/dev-memory/SKILL.md` > 插件 runtime skill > 用户级 `~/.agents/skills/`**

想给某个项目定制记忆协议（不同团队/项目有不同的写入纪律），把插件 `skills/dev-memory.md`
复制到项目 `.dsh/skills/dev-memory/SKILL.md` 再改即可；插件升级不会覆盖你的版本。

## 最小步骤

```bash
mkdir -p <项目>/.dsh/skills/dev-memory
cp <插件包>/skills/dev-memory.md <项目>/.dsh/skills/dev-memory/SKILL.md
# 然后按需编辑 SKILL.md
```

> 注意：skill 是**按名字匹配**的（`dev-memory`）。DSH 用编译产物 `dist/skill.js` 里的
> `MEMORY_SKILL_NAME` 注册，覆盖文件必须叫 `SKILL.md` 且放在 `.dsh/skills/dev-memory/` 下。

## 一个真实覆盖示例

下面是一个"想收窄写入纪律"的项目覆盖，只改最后两节，其余照抄内置协议：

```markdown
# dev-memory 长期记忆协议（项目定制版）

（前文与内置协议一致：什么时候查 / 什么时候写 / 会话收尾沉淀 pass / 禁止事项，见插件 skills/dev-memory.md）

## 项目专属写入纪律（覆盖）

- 本项目 L3 只写 `decision` 与 `entity`（架构选型、模块职责、接口约束）；
  `preference` 一律不写——团队偏好走团队文档，不进个人记忆。
- L2 笔记必须带 `tags: [<模块名>]`，检索时按模块过滤；无标签笔记请改写到
  `docs/notes/` 下并补标签。
- 库根固定为绝对路径：`<项目>/.memory`（由插件 settings 的 `storageDir` 配置），
  不要在多个工作目录间漂泊。

## 回溯使用（继承）

（保留内置协议"回溯与恢复"一节：history / diff / restore 的先 dryRun 再执行语义。）
```

保存后，本项目会话里模型看到的协议即覆盖版；插件机制（何时写、预算、git 提交、digest）
不受影响——协议层和机制层就是为此分离的。

## 验证覆盖生效

1. 重启 DSH 会话（或开启新会话）；
2. 让模型自然进入一次需要记忆的场景（如说"记住…"），观察它是否按覆盖版写纪律行动；
3. 或直接问模型"你加载的 dev-memory 协议是什么"，回答应含"项目专属写入纪律"一节。