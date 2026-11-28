import { reopenClosedWaiterIfNeeded } from './check-waiting-issues.mjs'

const issue = Number(process.env.ISSUE_NUMBER)
if (!Number.isSafeInteger(issue) || issue <= 0) throw new Error('ISSUE_NUMBER must be a positive integer')
const result = await reopenClosedWaiterIfNeeded(issue)
console.log(JSON.stringify(result))
