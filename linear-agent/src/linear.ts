// Linear GraphQL calls made with the app's OAuth token. Field and argument names
// were checked against Linear's published schema (packages/sdk/src/schema.graphql).

export const GRAPHQL_URL = 'https://api.linear.app/graphql'
export const AUTO_CLAUDE_LABEL = 'auto-claude'

export class LinearError extends Error {}

type GraphQLReply<T> = { data?: T; errors?: Array<{ message?: string }> }

// One GraphQL request. Errors carry Linear's message, never the token.
export async function gql<T>(accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  })
  const text = await res.text()
  let reply: GraphQLReply<T>
  try {
    reply = JSON.parse(text) as GraphQLReply<T>
  } catch {
    throw new LinearError(`Linear API ${res.status}: not JSON`)
  }
  if (!res.ok || (reply.errors?.length ?? 0) > 0 || reply.data === undefined) {
    const message = reply.errors?.[0]?.message ?? 'no data'
    throw new LinearError(`Linear API ${res.status}: ${message}`)
  }
  return reply.data
}

export type ActivityContent =
  | { type: 'thought' | 'elicitation' | 'response' | 'error'; body: string }
  | { type: 'action'; action: string; parameter: string; result?: string }

export async function createActivity(token: string, sessionId: string, content: ActivityContent, ephemeral?: boolean): Promise<void> {
  const data = await gql<{ agentActivityCreate: { success: boolean } }>(
    token,
    'mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }',
    { input: { agentSessionId: sessionId, content, ...(ephemeral === true ? { ephemeral: true } : {}) } },
  )
  if (!data.agentActivityCreate.success) throw new LinearError('agentActivityCreate was not successful')
}

export type PlanEntry = { content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }

async function updateSession(token: string, sessionId: string, input: Record<string, unknown>): Promise<void> {
  const data = await gql<{ agentSessionUpdate: { success: boolean } }>(
    token,
    'mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }',
    { id: sessionId, input },
  )
  if (!data.agentSessionUpdate.success) throw new LinearError('agentSessionUpdate was not successful')
}

// The plan is replaced whole; null clears it.
export function updatePlan(token: string, sessionId: string, plan: PlanEntry[] | null): Promise<void> {
  return updateSession(token, sessionId, { plan })
}

export function addExternalUrl(token: string, sessionId: string, label: string, url: string): Promise<void> {
  return updateSession(token, sessionId, { addedExternalUrls: [{ label, url }] })
}

// The issue's project id, or null when it has none.
export async function issueProject(token: string, issueId: string): Promise<string | null> {
  const data = await gql<{ issue: { project: { id: string } | null } }>(token, 'query ($id: String!) { issue(id: $id) { project { id } } }', { id: issueId })
  return data.issue.project?.id ?? null
}

export async function viewer(token: string): Promise<{ id: string; organizationId: string }> {
  const data = await gql<{ viewer: { id: string; organization: { id: string } } }>(token, 'query { viewer { id organization { id } } }')
  return { id: data.viewer.id, organizationId: data.viewer.organization.id }
}

// The team for a key such as AGT, with its auto-claude label when the team has one.
export async function teamByKey(token: string, key: string): Promise<{ id: string; labelId?: string } | undefined> {
  const data = await gql<{ teams: { nodes: Array<{ id: string; labels: { nodes: Array<{ id: string }> } }> } }>(
    token,
    'query ($key: String!, $label: String!) { teams(filter: { key: { eq: $key } }) { nodes { id labels(filter: { name: { eq: $label } }) { nodes { id } } } } }',
    { key, label: AUTO_CLAUDE_LABEL },
  )
  const team = data.teams.nodes[0]
  if (team === undefined) return undefined
  const labelId = team.labels.nodes[0]?.id
  return labelId === undefined ? { id: team.id } : { id: team.id, labelId }
}

export type IssueInput = {
  teamId: string
  title: string
  description?: string
  parentId?: string
  projectId?: string
  delegateId?: string
  labelIds?: string[]
}

export async function createIssue(token: string, input: IssueInput): Promise<{ id: string; identifier: string; url: string }> {
  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
    token,
    'mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
    { input },
  )
  if (!data.issueCreate.success || data.issueCreate.issue === null) throw new LinearError('issueCreate was not successful')
  return data.issueCreate.issue
}
