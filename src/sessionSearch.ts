// 会话/项目搜索的共享纯函数：子串匹配（不区分大小写）+ 按项目分组过滤。
// PanePicker.tsx（⌘D 窗格选择器"全部项目"段）与 HomePage.tsx（主页搜索框，见
// docs/superpowers 里本次改动的说明）本是同一件事——"输入框过滤会话/项目列表"，
// 只是渲染密度/上下文不同，此前只有 PanePicker.tsx 里有一份实现；这里把它提出来
// 单独成一个模块（同 paneDrop.ts/paneLayout.ts 的既有做法：不依赖 DOM/React/
// Zustand 的纯函数集合，便于单独测试、供多处共用），PanePicker.tsx 改为导入这里的
// 实现，不再各自维护一份可能悄悄不一致的匹配规则。
import type { ProjectInfo } from './ipc'
import { basename } from './time'

// query 为空串时视为全部匹配（未输入过滤词时不做任何过滤）；否则只要命中任一候选
// 文本的子串（大小写不敏感）就算匹配。
export function matchesQuery(query: string, ...candidates: string[]): boolean {
  if (!query) return true
  return candidates.some((c) => c.toLowerCase().includes(query))
}

export type ProjectSearchMatch = ProjectInfo & { projectMatches: boolean }

// 按项目分组过滤：项目名（basename(cwd)）本身命中时保留该项目下全部会话；否则只保留
// 会话标题命中的那些；一个会话都没命中、项目名也没命中的项目整个隐去。
// rawQuery 未经 trim/toLowerCase——这里统一处理一次，调用方不需要各自处理。
export function filterProjectsByQuery(projects: ProjectInfo[], rawQuery: string): ProjectSearchMatch[] {
  const q = rawQuery.trim().toLowerCase()
  return projects
    .map((p) => {
      const projectMatches = matchesQuery(q, basename(p.cwd))
      const threads = projectMatches ? p.threads : p.threads.filter((t) => matchesQuery(q, t.title))
      return { ...p, threads, projectMatches }
    })
    .filter((p) => p.projectMatches || p.threads.length > 0)
}
