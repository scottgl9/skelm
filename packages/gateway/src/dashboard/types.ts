import type { RunStatus } from '@skelm/core'

export interface DashboardGatewaySummary {
  status: 'running'
  uptimeMs: number
  version: string
  startedAt: number
}

export interface DashboardWorkflowsSummary {
  total: number
  withRecentFailures: number
}

export interface DashboardRunsSummary {
  total: number
  byStatus: Record<RunStatus, number>
  avgDurationMs: number | null
  last24h: number
}

export interface DashboardSchedulesSummary {
  total: number
  inflight: number
  withErrors: number
}

export interface DashboardApprovalsSummary {
  pending: number
  oldestPendingAgeMs: number | null
}

export interface DashboardErrorsSummary {
  last24h: number
  recent: ReadonlyArray<{
    runId: string
    pipelineId: string
    message: string
    at: number
  }>
}

export interface DashboardOverview {
  gateway: DashboardGatewaySummary
  workflows: DashboardWorkflowsSummary
  runs: DashboardRunsSummary
  schedules: DashboardSchedulesSummary
  approvals: DashboardApprovalsSummary
  errors: DashboardErrorsSummary
}

export interface DashboardWorkflowStats {
  id: string
  file: string
  totalRuns: number
  lastRunAt: number | null
  lastStatus: RunStatus | null
  successRate: number | null
}

export interface DashboardRunListItem {
  runId: string
  pipelineId: string
  status: RunStatus
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export type AnalyticsMetric = 'runs-per-hour' | 'success-rate' | 'avg-duration'
export type AnalyticsResolution = 'hour' | 'day' | 'week'

export interface AnalyticsPoint {
  bucketStart: number
  value: number
}

export interface DashboardAnalytics {
  metric: AnalyticsMetric
  resolution: AnalyticsResolution
  dateFrom: number
  dateTo: number
  workflowId?: string
  points: ReadonlyArray<AnalyticsPoint>
}

export interface DashboardErrorGroup {
  pipelineId: string
  message: string
  count: number
  lastAt: number
}

export interface DashboardErrors {
  last24h: number
  recent: ReadonlyArray<{
    runId: string
    pipelineId: string
    message: string
    at: number
  }>
  topGroups: ReadonlyArray<DashboardErrorGroup>
}

export interface DashboardScheduleStatus {
  id: string
  kind: string
  workflowId: string
  fired: number
  inflight: boolean
  lastFiredAt: string | null
  lastError: string | null
}

export interface DashboardApprovalsListItem {
  id: string
  createdAt: string
  ageMs: number
  request: unknown
}

export interface DashboardApprovals {
  pendingCount: number
  oldestPendingAgeMs: number | null
  pending: ReadonlyArray<DashboardApprovalsListItem>
}
