export const BLOCK_WIDTH_PX = 260
export const BLOCK_HEIGHT_PX = 116
export const BLOCK_GAP_PX = 16

export function columnsForWidth(containerWidth: number): number {
  const per = BLOCK_WIDTH_PX + BLOCK_GAP_PX
  return Math.max(1, Math.floor((containerWidth + BLOCK_GAP_PX) / per))
}

export function gridSlot(index: number, columns: number) {
  const col = index % columns
  const row = Math.floor(index / columns)
  return { x: col * (BLOCK_WIDTH_PX + BLOCK_GAP_PX), y: row * (BLOCK_HEIGHT_PX + BLOCK_GAP_PX) }
}

export function clampPosition(pos: { x: number; y: number }, containerWidth: number) {
  const maxX = Math.max(0, containerWidth - BLOCK_WIDTH_PX)
  return { x: Math.min(Math.max(0, pos.x), maxX), y: Math.max(0, pos.y) }
}

export function canvasHeight(count: number, columns: number, positions: Record<string, { x: number; y: number }>): number {
  const rows = Math.ceil(count / columns)
  const gridHeight = rows * (BLOCK_HEIGHT_PX + BLOCK_GAP_PX)

  const positionValues = Object.values(positions)
  if (positionValues.length === 0) {
    return gridHeight
  }

  const maxCustomHeight = Math.max(
    ...positionValues.map(pos => pos.y + BLOCK_HEIGHT_PX + BLOCK_GAP_PX)
  )

  return Math.max(gridHeight, maxCustomHeight)
}
