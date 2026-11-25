import { freshSessionRoute } from '@/lib/fresh-session'
import { defineRoute } from '@/lib/primitives/define-route'
import { enrollmentHTTP, enrollmentOperator, EnrollmentClient } from '@/lib/subscription-enrollment'
import { enrollmentConfiguration } from '@/lib/subscription-enrollment-runtime'
import { byosEnrollmentEnabled } from '@/lib/cloud-computer-flag'

export const maxDuration = 120

// This private operator-controlled receiver creates pending-unbound custody only.
// It never pretends that an operator token is a Mikka account/workspace session.
const handleEnrollment = enrollmentHTTP({
  authorize: async request => byosEnrollmentEnabled()
    ? enrollmentOperator(request, process.env.MIKKA_BYOS_ENROLLMENT_OPERATOR_TOKEN) : null,
  client: () => new EnrollmentClient(enrollmentConfiguration()),
})

const POSTBody = defineRoute(
  { auth: 'public', origin: 'same-origin-or-desktop', workspace: 'none' },
  ({ request }) => handleEnrollment(request),
)

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const POST = freshSessionRoute(POSTBody)
