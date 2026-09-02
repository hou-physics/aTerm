// 把标签拖出窗口时，新窗口要接管这个 PTY 的终端——但滚屏内容（含 SGR 颜色等转义）仍
// 停留在旧窗口那个 xterm 实例（SerializeAddon）里，旧窗口必须先把它取出来，才能在 Task 4
// 里交给新窗口写回去。App.tsx／窗口交接逻辑不持有任何 Terminal / SerializeAddon 实例
// （那是 TerminalView.tsx 里的局部变量），所以需要这样一个小注册表：TerminalView 在自己
// 的 effect 里把 `() => serializeAddon.serialize()` 注册进来，调用方只按 ptyId 查表调用，
// 两边不必互相引用对方。写法照抄 terminalPaste.ts 的 registerPaste/pasteTo——模块级 Map
// + 返回一个注销函数。
const serializers = new Map<string, () => string>()

/** 注册某个 PTY 对应终端的序列化入口，返回注销函数。 */
export function registerSerializer(ptyId: string, serialize: () => string): () => void {
  serializers.set(ptyId, serialize)
  return () => { serializers.delete(ptyId) }
}

/** 取出该终端当前的滚屏序列化内容。终端未注册时返回 null。 */
export function serializeTerm(ptyId: string): string | null {
  const serialize = serializers.get(ptyId)
  if (!serialize) return null
  return serialize()
}
