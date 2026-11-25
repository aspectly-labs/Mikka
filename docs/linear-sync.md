# Linear two-way sync retirement

Mikka retired two-way task and comment synchronization on November 24, 2026. The production and staging sync workers were removed. The application no longer mirrors edits, deletions or archive requests between Mikka and Linear.

Historical links, publications, detachments and delivery records remain available for existing data. The retirement migration removes the issue and document queue triggers. Changing a task's scope continues to enforce local access controls.

Signed Linear webhooks can still trigger automations and process OAuth revocations. The automation editor can connect a new account or reconnect one whose credentials Linear rejected. The system browser opens the account-bound connect URL and completes a PKCE grant with the `read` scope. The editor reloads team choices on return. A provider outage leaves the existing connection in place.

Deployments that use Linear event triggers need a provider webhook configured to deliver signed events to `/api/webhooks/linear`. Retiring the sync workers does not configure that external endpoint. The legacy sync status endpoint returns `enabled: false`, and older clients receive `linearSyncDisabled` when requesting a sync or retry.
