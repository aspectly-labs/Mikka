# Configuration and capability contracts

Generated inventory of Tier-4 remote runtime configuration keys (`lib/runtime-config/schema.ts`) and Tier-3 workspace capability fields (`lib/governance/capabilities.ts`). Verified mechanically by G6 (`pnpm check:config-contracts` and `pnpm docs:check`); regenerate with `pnpm docs:generate`.

<!-- generated:config-contracts -->
Source: `lib/runtime-config/schema.ts` and `lib/governance/capabilities.ts`.

### Runtime configuration contracts

| Key | PostHog flag | Owner | Description |
| --- | --- | --- | --- |
| `announcementBanner` | `mikka-config-announcement-banner` | `platform-ops` | Workspace-wide announcement banner displayed when enabled and inside its active time window. |
| `billingActiveOffer` | `mikka-config-billing-active-offer` | `billing` | Time-bounded introductory billing offer or promotional discount configuration. |
| `operationalCaps` | `mikka-config-operational-caps` | `platform-ops` | Runtime operational safety caps and temporary concurrent-run limit overrides. |
| `planEntitlementOverrides` | `mikka-config-plan-entitlement-overrides` | `governance` | Temporary runtime overrides for plan entitlement limits such as approval templates and hosted concurrency. |

### Workspace capability contracts

| Capability | Owner | Description |
| --- | --- | --- |
| `activeHumanLimit` | `workspace-access` | Maximum active human members permitted in the workspace scope, or null when unlimited. |
| `approvalTemplateLimit` | `governance` | Maximum number of saved governance approval templates allowed for the workspace. |
| `canManageOrgBilling` | `billing` | Whether the workspace can participate in Cloud organization billing designation and management. |
| `canUseApprovalTemplates` | `governance` | Whether workspace admins can create, save, and apply governance approval templates. |
| `canUseEnterpriseGovernance` | `governance` | Whether enterprise-tier organization governance features are enabled for the workspace. |
| `canUseResourcePolicy` | `governance` | Whether organization-wide resource sharing, provider allowlists, retention, and legal hold policies are enabled. |
| `canUseScim` | `enterprise-identity` | Whether enterprise SCIM directory provisioning connections are enabled. |
| `canUseSso` | `enterprise-identity` | Whether SAML/OIDC enterprise SSO identity provider management is enabled. |
| `canUseUsageExport` | `governance` | Whether workspace admins can view daily usage breakdowns and export governance usage reports. |
| `hostedMaxInFlight` | `runtime-quota` | Maximum concurrent hosted model calls admitted per workspace. |
| `isPaidPlan` | `billing` | Whether the workspace currently holds an active paid plan (Pro or Enterprise). |
<!-- /generated:config-contracts -->
