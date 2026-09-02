import { useLibrary } from '../../store/library'
import { blockKey } from '../../store/overview'
import { isSessionRemoved } from '../../sessionList'
import { useSessions } from '../../store/sessions'
import { SettingCard } from './SettingCard'
import { SettingRow } from './SettingRow'

// 项目与会话分区：两份既有数据的"一次看全"入口，不是它们的第一个 UI 入口——
// 隐藏项目已经能在 HomePage.tsx 的右键菜单撤销（hideProject 的可撤销轻提示，
// 见 HomePage.tsx:140 附近），移除会话已经能在 Sidebar.tsx 的右键菜单恢复
// （Sidebar.tsx:356 附近，同一惯例）。这里直接调同样的 store action
// （unhideProject / restoreSession），不重新实现那两处的判断——两处既有调用点都
// 只是"调 store action"这一步、没有额外副作用（不像 hideProject/removeSession
// 那样会顺带 useHint.getState().show(...) 弹一条可撤销提示——那条提示属于
// 隐藏/移除动作本身，不属于撤销/恢复动作），所以这里同样只调 store action，
// 不额外补 hint。
//
// 已移除会话的展示名：优先用 aliases[key]（用户改过的名字），没有别名才展示 key
// 本身——不在这里调 displayTitle，那需要 thread 对象，这里没有。
//
// v3-2c 只改呈现（换成 SettingCard/SettingRow，两张卡片、条目变成一行一行）——
// 下面这段过期过滤逻辑（activityByKey / removedKeys 的计算）一行都没有改动，
// 逐字照抄自改造前的版本，评审时可以直接 diff 确认。
export function ProjectsSection() {
  const hiddenProjects = useLibrary((s) => s.hiddenProjects)
  const removedSessions = useLibrary((s) => s.removedSessions)
  const aliases = useLibrary((s) => s.aliases)
  const unhideProject = useLibrary((s) => s.unhideProject)
  const restoreSession = useLibrary((s) => s.restoreSession)
  const projects = useSessions((s) => s.projects)

  const hiddenDirNames = Object.keys(hiddenProjects)

  // 终审 I3：removedSessions 的值是"移除时刻的毫秒时间戳"，不是布尔集合——移除是
  // 可过期的（sessionList.ts 的 isSessionRemoved：移除后只要又有新活动，
  // lastActivityMs > removedAtMs，就自动重新出现在侧栏）。这里必须用与侧栏
  // （Sidebar.tsx:43）完全相同的判定谓词过滤，否则"移除后又被 resume、或项目里
  // 又有新活动"的会话会在侧栏正常显示的同时，仍然停留在这份"已移除的会话"名单里，
  // 用户点"恢复"没有任何可观察效果，名单也会随时间单调膨胀。
  //
  // 数据源与 Sidebar.tsx 相同：useSessions().projects 里每个 project 的
  // threads[].lastActivityMs，键与 Sidebar 同一套 blockKey(dirName, rootKey)。
  const activityByKey = new Map<string, number>()
  for (const p of projects) {
    for (const t of p.threads) {
      activityByKey.set(blockKey(p.dirName, t.rootKey), t.lastActivityMs)
    }
  }
  // 决策点：removedSessions 里的某个 key 在当前 projects 数据里找不到对应会话时
  // （比如项目目录被整个删掉、或转录文件被清理），该显示还是该隐藏？
  //
  // 选择：显示（保守地当作"仍处于移除状态"）。理由两条：
  // 1) isSessionRemoved 的语义是"只有拿到新活动的证据（lastActivityMs > removedAtMs）
  //    才能证明移除已过期"，默认是"移除仍然有效"。找不到对应会话时我们连
  //    lastActivityMs 都拿不到，没有任何证据支持"已过期"，按同一语义应当默认保持
  //    移除、继续显示，而不是在没有证据时擅自判它过期。
  // 2) restoreSession 是这份名单里"恢复"按钮唯一能触发的动作，效果只是删掉
  //    localStorage 里的这个 key。如果这里选择隐藏找不到对应会话的条目，
  //    用户就永远没有 UI 入口去清掉一条指向已经整个消失的项目/会话的陈旧记录，
  //    它会永远留在 localStorage 里；选择显示，则"恢复"顺带成了清理陈旧记录的
  //    手动入口。
  // 也顺带避开一个时序假象：projects 是异步刷新的，若选择隐藏，挂载瞬间
  // （projects 还是空数组）所有条目都会先被判定为"找不到"而消失、待 refresh()
  // 落地后再重新出现，造成一次没有意义的整屏闪烁。
  const removedKeys = Object.keys(removedSessions).filter((key) => {
    const lastActivityMs = activityByKey.get(key)
    if (lastActivityMs === undefined) return true
    return isSessionRemoved(removedSessions[key], lastActivityMs)
  })

  return (
    <div className="projects-section">
      <SettingCard title="隐藏的项目">
        {hiddenDirNames.length === 0 ? (
          <div className="setting-card-empty">没有隐藏的项目</div>
        ) : (
          hiddenDirNames.map((dirName) => (
            <SettingRow
              key={dirName}
              label={<span className="projects-section-name">{dirName}</span>}
              control={
                <button
                  type="button"
                  className="projects-section-action"
                  aria-label={`取消隐藏 ${dirName}`}
                  onClick={() => unhideProject(dirName)}
                >
                  取消隐藏
                </button>
              }
            />
          ))
        )}
      </SettingCard>
      <SettingCard title="已移除的会话">
        {removedKeys.length === 0 ? (
          <div className="setting-card-empty">没有移除的会话</div>
        ) : (
          removedKeys.map((key) => (
            <SettingRow
              key={key}
              label={<span className="projects-section-name">{aliases[key] ?? key}</span>}
              control={
                <button
                  type="button"
                  className="projects-section-action"
                  aria-label={`恢复 ${key}`}
                  onClick={() => restoreSession(key)}
                >
                  恢复
                </button>
              }
            />
          ))
        )}
      </SettingCard>
    </div>
  )
}
