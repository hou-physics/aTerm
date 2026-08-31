// Tauri 2 的权限系统（ACL）不是"声明了就默认全给"——`core:default` 只展开成每个
// core 子模块自己的 default_permission，而那份 default 往往只覆盖只读命令（详见
// src-tauri/gen/schemas/acl-manifests.json）。core:window 一个模块就有 78 条
// allow-*，默认只授予 28 条；剩下 50 条用了就必须在 capabilities/*.json 里显式声明，
// 否则调用在打包版里会被 ACL 直接拒绝——而这类拒绝在 vitest/jsdom 里完全测不出来
// （jsdom 里根本没有真实的权限系统），只会在真机上手动触发那条路径时才暴露。
//
// 这个模块是"生产代码用到的 core:* 命令是否都在有效权限集合内"这条检查的纯逻辑部分：
// 不做任何文件 IO，只接受已经读好的 manifest / capabilities 声明 / 源码文本，返回
// 违规列表。真正读文件、决定"生产代码"范围、跑 vitest 断言的部分在
// src/__tests__/tauriAcl.test.ts；纯逻辑本身的单测在 src/aclGuard.test.ts。
//
// 范围只覆盖 core:*（Tauri 内置命令）。自定义命令（invoke('list_projects') 这类，
// 走 generate_handler! 注册）不经过这套 ACL，只要 capabilities 里有 core:default
// 就能调用，天然不在本模块的检查范围内；dialog:*/opener:* 等插件命令同理未覆盖——
// 详见报告里"范围边界"一节。

export interface AclPermissionEntry {
  identifier: string
  description?: string
  commands?: { allow: string[]; deny: string[] }
}

export interface AclModule {
  default_permission?: { identifier: string; description?: string; permissions: string[] } | null
  permissions: Record<string, AclPermissionEntry>
  permission_sets?: Record<string, unknown>
}

/** acl-manifests.json 的顶层结构：模块 key（'core'、'core:window'、'dialog' ...）
 *  到该模块定义的粗粒度类型。 */
export type AclManifests = Record<string, AclModule>

/** kebab-case 命令名转 camelCase，与 @tauri-apps/api 里实际导出的方法名一致：
 *  'set-size' -> 'setSize'，'current-monitor' -> 'currentMonitor'，
 *  无连字符的名字原样返回（'title' -> 'title'）。 */
export function kebabToCamel(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

export interface CoreCommand {
  /** 完整 identifier，如 'core:window:allow-set-size'，capabilities 里就长这样。 */
  identifier: string
  /** 所属模块，如 'core:window'。 */
  module: string
  /** kebab 命令名，如 'set-size'。 */
  command: string
  /** 生产代码里对应会出现的标识符，如 'setSize'。 */
  camelName: string
}

/** 取出 manifest 里每个 core:<mod> 子模块（不含 'core' 本身——它没有自己的
 *  permissions，只是把各子模块的 default 打包成一个总的 core:default）下的全部
 *  allow-<cmd>，忽略同样存在的 deny-<cmd>（deny 不是"要不要授权"的问题，不在本检查
 *  范围内）。 */
export function extractCoreAllowCommands(manifests: AclManifests): CoreCommand[] {
  const result: CoreCommand[] = []
  for (const moduleKey of Object.keys(manifests)) {
    if (moduleKey === 'core' || !moduleKey.startsWith('core:')) continue
    const mod = manifests[moduleKey]
    for (const permKey of Object.keys(mod.permissions ?? {})) {
      if (!permKey.startsWith('allow-')) continue
      const command = permKey.slice('allow-'.length)
      result.push({
        identifier: `${moduleKey}:${permKey}`,
        module: moduleKey,
        command,
        camelName: kebabToCamel(command),
      })
    }
  }
  return result
}

/** 递归展开 capabilities/*.json 里的一条 permissions 声明，展成一组"叶子"
 *  identifier（形如 '<mod>:allow-<cmd>' / '<mod>:deny-<cmd>'）。
 *
 *  - 不以 ':default' 结尾：本身已经是叶子（如 'core:window:allow-set-size'），
 *    原样返回。
 *  - 以 ':default' 结尾：去掉 ':default' 得到模块 key，在 manifest 里查该模块的
 *    default_permission.permissions。这份列表里的每一项分两种写法（在这份 manifest
 *    里实测两层都出现过）：
 *      - 已经带模块前缀、且自己也以 ':default' 结尾（'core' 模块下的 default 就是
 *        这样，列的是 'core:window:default' 这种字符串）——递归展开它自己；
 *      - 裸的 'allow-x'/'deny-x'（子模块，如 'core:window' 自己的 default 下就是
 *        这样）——补上当前模块前缀就是叶子，不用再递归。
 *    用同一个递归调用处理这两种情况，不需要为"展开几层"写死层数。 */
export function expandPermission(manifests: AclManifests, identifier: string): string[] {
  if (!identifier.endsWith(':default')) return [identifier]
  const moduleKey = identifier.slice(0, -':default'.length)
  const perms = manifests[moduleKey]?.default_permission?.permissions ?? []
  const out: string[] = []
  for (const p of perms) {
    out.push(...(p.includes(':') ? expandPermission(manifests, p) : [`${moduleKey}:${p}`]))
  }
  return out
}

/** capabilities/*.json 里全部声明的 permissions（多个文件的数组拼在一起）展开后
 *  的有效叶子权限集合（并集）。 */
export function computeEffectivePermissions(manifests: AclManifests, declaredPermissions: string[]): Set<string> {
  const out = new Set<string>()
  for (const decl of declaredPermissions) {
    for (const leaf of expandPermission(manifests, decl)) out.add(leaf)
  }
  return out
}

export interface IdentifierOccurrence {
  file: string
  line: number
  text: string
}

/** 在一批源码文件里按"整词"搜一个标识符——不会把它当成更长标识符的子串来匹配
 *  （'setSize' 不会命中 'windowSetSize' 里的那段），但没法区分调用对象是不是真的
 *  Tauri 句柄（'obj.setSize()' 与 'win.setSize()' 在纯文本层面看起来一样）——这正是
 *  需要豁免表兜底误报的原因。天然覆盖静态 import 与动态 import 两种写法，因为两者
 *  最终都会在源码文本里留下这个标识符本身。 */
export function findIdentifierOccurrences(
  camelName: string,
  files: Record<string, string>,
): IdentifierOccurrence[] {
  const re = new RegExp(`\\b${camelName}\\b`)
  const occurrences: IdentifierOccurrence[] = []
  for (const [file, content] of Object.entries(files)) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) occurrences.push({ file, line: i + 1, text: lines[i].trim() })
    }
  }
  return occurrences
}

export interface AclViolation {
  identifier: string
  camelName: string
  occurrences: IdentifierOccurrence[]
}

export interface CheckAclCoverageParams {
  manifests: AclManifests
  /** capabilities/*.json 里全部文件的 permissions 数组拼在一起。 */
  declaredPermissions: string[]
  /** 生产代码文件内容：路径 -> 源码文本。范围过滤（排除测试文件）由调用方负责。 */
  productionFiles: Record<string, string>
  /** 豁免表：完整 identifier -> 豁免理由。命中的直接跳过，不算违规。 */
  exemptions?: Record<string, string>
}

/** 主检查：对 manifest 里每一条 core:<mod>:allow-<cmd>——
 *    生产代码里出现了它的 camelCase 标识符
 *    且它不在豁免表里
 *    且它没有被 capabilities 展开后的有效权限集合覆盖
 *  ——判定为一条违规。 */
export function checkAclCoverage(params: CheckAclCoverageParams): AclViolation[] {
  const { manifests, declaredPermissions, productionFiles, exemptions = {} } = params
  const effective = computeEffectivePermissions(manifests, declaredPermissions)
  const violations: AclViolation[] = []
  for (const cmd of extractCoreAllowCommands(manifests)) {
    if (exemptions[cmd.identifier]) continue
    if (effective.has(cmd.identifier)) continue
    const occurrences = findIdentifierOccurrences(cmd.camelName, productionFiles)
    if (occurrences.length > 0) {
      violations.push({ identifier: cmd.identifier, camelName: cmd.camelName, occurrences })
    }
  }
  return violations
}

/** 把一条违规格式化成人类可读的报错文案，明确指出该往 capabilities/default.json
 *  里加哪一条 identifier。 */
export function formatViolation(v: AclViolation): string {
  const shown = v.occurrences.slice(0, 5)
  const rest = v.occurrences.length - shown.length
  const where = shown.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n')
  const moreLine = rest > 0 ? `\n  ...以及另外 ${rest} 处` : ''
  return (
    `生产代码用到了 \`${v.camelName}\`，但 "${v.identifier}" 不在 capabilities 的有效权限集合内。\n` +
    `请把 "${v.identifier}" 加进 src-tauri/capabilities/default.json 的 permissions 数组` +
    `（如果这是误报——命中的其实是另一个同名但无关的标识符——把它连同理由一起加进本检查的豁免表）。\n` +
    `命中位置：\n${where}${moreLine}`
  )
}
