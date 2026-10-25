// The weekly memory scan's banner (launchd runs ~/.claude/bin/memory-gc-scan.py;
// it wrote ~/.claude/memory-gc-report.json). Formerly a SessionStart shell hook
// that put the counts into every session's context; now a toast every session,
// and the model reads them only when the counts changed since it last did.

export type GcReport = {
  generated_at?: string
  broken_links?: number
  oversized_files?: number
  index_near_limit?: number
  archivable_retrospects?: number
  orphaned_retrospects?: number
}

export function gcSummary(report: GcReport): string | undefined {
  const parts = [
    ['인덱스 임박', report.index_near_limit],
    ['과대 파일', report.oversized_files],
    ['깨진 링크', report.broken_links],
    ['고아 라우팅', report.orphaned_retrospects],
    ['아카이브 가능', report.archivable_retrospects],
  ]
    .filter((part): part is [string, number] => typeof part[1] === 'number' && part[1] > 0)
    .map(([label, count]) => `${label} ${count}`)

  return parts.length === 0 ? undefined : `[Memory GC] ${report.generated_at ?? '?'} — ${parts.join(' · ')}`
}

// What decides whether the model has already seen this report.
export function gcSignature(report: GcReport): string {
  return JSON.stringify([
    report.generated_at,
    report.broken_links,
    report.oversized_files,
    report.index_near_limit,
    report.archivable_retrospects,
    report.orphaned_retrospects,
  ])
}

export function parseGcReport(text: string): GcReport | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null ? (value as GcReport) : undefined
  } catch {
    return undefined
  }
}
