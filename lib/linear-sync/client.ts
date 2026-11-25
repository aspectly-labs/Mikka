import 'server-only'
import { linearGraphQL } from './graphql'
interface LinearStateOption { id: string; name: string; type: string; position?: number | null }

export interface LinearTeamOption {
  id: string
  key: string
  name: string
  states: LinearStateOption[]
}

const CONNECTION_PAGE = 50

export async function linearTeams(token: string): Promise<LinearTeamOption[]> {
  const result: LinearTeamOption[] = []
  let after: string | null = null
  do {
    type TeamWire = Omit<LinearTeamOption, 'states'> & { states: { nodes: LinearStateOption[] } }
    type TeamPage = { teams: { nodes: TeamWire[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    const data: TeamPage = await linearGraphQL<TeamPage>(token, `query MikkaLinearTeams($first: Int!, $after: String) {
      teams(first: $first, after: $after) {
        nodes { id key name states(first: 50) { nodes { id name type position } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first: CONNECTION_PAGE, after })
    result.push(...data.teams.nodes.map(({ states, ...team }) => ({ ...team, states: states.nodes })))
    after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null
  } while (after)
  return result
}

export interface LinearLabelOption {
  id: string
  name: string
  teamId: string | null
}

/** Workspace-wide and team-specific issue labels visible to this person's Linear account. */
export async function linearLabelOptions(token: string): Promise<LinearLabelOption[]> {
  type Label = { id: string; name: string; team: { id: string } | null }
  type Page = { issueLabels: { nodes: Label[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
  const result: LinearLabelOption[] = []
  const cursors = new Set<string>()
  let after: string | null = null
  do {
    const data: Page = await linearGraphQL<Page>(token, `query MikkaLinearLabelOptions($first: Int!, $after: String) {
      issueLabels(first: $first, after: $after, filter: { isGroup: { eq: false } }) {
        nodes { id name team { id } } pageInfo { hasNextPage endCursor }
      }
    }`, { first: CONNECTION_PAGE, after })
    result.push(...data.issueLabels.nodes.map(label => ({ id: label.id, name: label.name, teamId: label.team?.id ?? null })))
    if (!data.issueLabels.pageInfo.hasNextPage) break
    after = data.issueLabels.pageInfo.endCursor
    if (!after || cursors.has(after)) throw new Error('Linear returned an invalid label cursor')
    cursors.add(after)
  } while (after)
  return result
}
