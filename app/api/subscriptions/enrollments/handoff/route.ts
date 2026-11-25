import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { enrollmentHandoffHTTP, enrollmentHandoffPage } from '@/lib/subscription-enrollment-handoff'
import { EnrollmentClient } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const maxDuration = 120
const enabled = () => byosEnrollmentEnabled()
const handleHandoff = enrollmentHandoffHTTP({ enabled, client: () => new EnrollmentClient(enrollmentConfiguration()) })
const POSTBody = defineRoute(
  { auth: 'public', origin: 'same-origin-or-desktop', workspace: 'none' },
  ({ request }) => handleHandoff(request),
)
export const GET = defineRoute(
  { auth: 'public', origin: 'any', workspace: 'none' },
  ({ request }) => enrollmentHandoffPage(request, enabled()),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
