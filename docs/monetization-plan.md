# SIMM Monetization Plan

Status: planning draft only. This plan assumes telemetry remains anonymous, opt-in, and transparent, with no machine identifiers, usernames, absolute paths, stable client IDs, or silent collection.

## Working Thesis

SIMM should not monetize by saying "servers cost money." Users rarely buy infrastructure sympathy. They buy confidence, time saved, fewer broken installs, and better outcomes.

The strongest paid value is a compatibility intelligence layer built from anonymous telemetry:

- Users pay for confidence before installing, updating, or combining mods.
- Developers pay for actionable bug and compatibility signal they cannot get from comments alone.
- The free app remains useful and trustworthy, while paid tiers make SIMM feel smarter, more predictive, and more developer-friendly.

## Basic Market Scan

- Nexus Mods Premium moved to USD $8.99/mo and $89.99/year in June 2024. The value is mostly convenience and platform support: faster downloads, premium ecosystem benefits, and creator/platform sustainability. Source: [Nexus billing update](https://www.nexusmods.com/news/14964).
- Modrinth+ is $4.99/mo, with ad-free browsing, a profile badge, and 50% of the subscription going to creators. Modrinth explicitly says it does not plan to paywall content or creator features. Source: [Modrinth+](https://modrinth.com/plus) and [Modrinth announcement](https://modrinth.com/news/article/design-refresh).
- CurseForge monetizes through ads, premium, and creator payouts. Its author-facing pitch highlights $20.4M paid to authors and a 70/30 creator/platform split. Source: [CurseForge for Mod Authors](https://authors.curseforge.com/welcome/) and [CurseForge app page](https://www.overwolf.com/app/overwolf-curseforge).
- Sentry anchors developer diagnostics much higher than SIMM's proposed developer tier: free solo plan, Team at $26/mo, Business at $80/mo, with error/event/log limits. Source: [Sentry pricing](https://sentry.io/pricing/).
- mod.io frames monetization as marketplace/patronage infrastructure and takes 10% of gross on transactions, while private white-label solutions are request-priced. Source: [mod.io FAQ](https://blog.mod.io/faq-blog-b6c8f0f41669).
- GitHub Sponsors demonstrates a creator-support pattern with user-defined monthly tiers and no fees for personal-account sponsorships. Source: [GitHub Sponsors docs](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors).

Takeaway: $5/mo for power users is plausible if the feature set is clearly more useful than ad removal or badges. $10/mo for mod developers is low compared with general-purpose developer observability, but appropriate for a small modding ecosystem if the product stays focused.

## Pricing Direction

### Free

Purpose: keep SIMM trusted and avoid paywalling basic safety.

- Core mod manager features.
- Local-only telemetry preview and local snapshot history.
- Basic compatibility warnings for severe known breakages, with coarse confidence labels.
- Manual bug report export bundle.
- Public mod health summary when available.
- Opt-in telemetry contribution controls.

Do not paywall:

- Seeing that a mod is known to hard-crash a specific S1/runtime version.
- Disabling telemetry.
- Viewing exactly what data would be uploaded.
- Local logs/config/security workflows already core to SIMM.

### SIMM Supporter - Users - $5/mo

Purpose: "Support SIMM development and make my modded game less fragile."

Positioning:

- Lead with supporting continued SIMM development, infrastructure, and compatibility intelligence.
- Keep the feature value concrete so Supporter feels like both patronage and a practical upgrade.
- Avoid implying that users are paying only to offset server costs.

Core value:

- Full compatibility reports:
  - Mod vs mod compatibility matrix.
  - Mod vs S1 version compatibility.
  - Mod vs runtime compatibility.
  - Confidence score based on sample size, recency, and severity.
- Install planning:
  - "Will this loadout work?" preflight before applying a profile.
  - Recommended versions for a selected S1 branch/runtime.
  - Conflict explanations with likely offending pairs.
- Update readiness:
  - S1 update impact report for current profiles.
  - "Hold this mod" and "safe to update" recommendations.
  - Watchlist alerts when a favorite mod becomes compatible again.
- Profile intelligence:
  - Cloud-synced private profiles.
  - Compatibility badges on saved profiles.
  - One-click rollback notes for a profile after bad telemetry trends.
- Quality-of-life:
  - Priority compatibility report generation.
  - Historical "what changed" summaries per profile.
  - Early access to beta diagnostics features.

Nice later additions:

- Community loadout recipes with compatibility confidence.
- Private notes per mod/profile.
- Shareable compatibility report links.
- Personal mod update digest.

### SIMM Creator - Mod Authors - $10/mo

Purpose: "Tell me what is breaking, for whom, and after which update."

Account model:

- Creator access requires verified mod ownership.
- Verification is handled through the web portal, not directly inside the desktop app at launch.
- Initial verification is human-managed by direct approval.
- Approval terms, acceptable evidence, dispute handling, and transfer rules are TBD.
- A creator can pay only after or alongside a verified claim flow; unverified accounts should not get private mod-specific diagnostics.

Core value:

- Claimed mod dashboard:
  - Active versions observed.
  - S1 versions and runtimes where the mod appears.
  - Error trend by mod version, S1 version, runtime, and dependency context.
- Anonymous live bug reports:
  - Deduplicated error signatures.
  - Sanitized excerpt and stack fingerprint.
  - Affected mod/version combinations.
  - First seen, last seen, trend direction, sample count.
- Compatibility intelligence:
  - Top conflicting mods.
  - "Works with" and "breaks with" matrix.
  - Regression detection after a new mod release or S1 update.
- Release tooling:
  - Pre-release compatibility watch for beta testers.
  - Release health checklist.
  - Auto-generated "known issues" draft.
  - GitHub issue export or webhook.
  - Discord webhook digest.
- Public trust tools:
  - Optional public health badge for a mod page.
  - Public compatibility summary link.
  - Changelog impact summary.

Nice later additions:

- Team seats for multi-author mods.
- API/CSV export.
- Custom alert thresholds.
- Private beta tester cohorts.
- Crash-free version badge.
- Developer response notes attached to known signatures.

### Future Studio/Team Tier - Optional

Only introduce if developers outgrow $10/mo.

Possible price: $20-25/mo.

- Multiple seats.
- Multiple claimed mods.
- Longer history retention.
- More webhook/API volume.
- Private compatibility datasets for closed beta builds.

## Feature Ideas That Justify Paid Tiers

### User-Facing Features

- Compatibility graph explorer: visual map of known-safe and risky mod combinations.
- Profile score: "stable", "watch", "risky", or "unknown" with reasons.
- Version recommendation engine: pick the mod version most likely to work with a selected S1/runtime.
- Update risk forecast: show risk before updating S1 or a mod.
- Personal mod health dashboard: track the user's installed mods, known issues, and fixes.
- Smart troubleshooting assistant: narrows likely culprit mods from recent crashes and installed versions.
- Known-good profile templates: curated starter sets backed by observed compatibility.
- "Safe mode plan": suggest which mods to disable first based on telemetry confidence.

### Developer-Facing Features

- Error inbox grouped by signature, version, S1 build, runtime, and co-installed mods.
- Compatibility regression detector after a new mod release.
- Dependency insight: identify when errors correlate with another mod being installed.
- Release health score over time.
- Webhook alerts for new high-severity signatures.
- Public compatibility badge for mod pages.
- Exportable issue bundle for GitHub/Nexus/Discord.
- Beta channel tracking: compare pre-release builds against public releases.

### Community Features

- Verified compatibility reports with sample thresholds.
- Mod pack/profile health pages.
- Community voting for "need compatibility data on this mod."
- Creator support pool later, funded by a portion of subscriptions.
- Creator revenue sharing or support allocation is directionally desirable, but not a first-priority launch requirement.

## Suggested Paywall Philosophy

Free should protect users from known severe problems. Paid should provide depth, automation, history, prediction, alerts, and developer workflows.

Good free examples:

- "This mod/version is currently known to crash on S1 alternate-beta."
- "Telemetry is off. Here is what would be collected if enabled."
- "Export a local bug report."

Good paid examples:

- "These three mods together are the likely conflict, based on 42 recent anonymous reports."
- "Version 1.4.2 is safer than 1.5.0 on IL2CPP S1 0.4.x."
- "Your saved profile is likely to break after this S1 update."
- "Developer alert: this new error signature started after your 2.1.0 release."

## Server-Side Resources Needed

Minimum viable backend:

- Anonymous telemetry ingestion API.
- Schema validation and payload rejection for path-like strings, emails, oversized excerpts, and unknown identifier fields.
- Snapshot queue for async processing.
- Error signature processor.
- Compatibility aggregation jobs.
- Public mod health API.
- Paid user authentication.
- Creator mod-claim workflow.
- Human-managed creator verification queue and admin review tools.
- Billing integration.
- Admin moderation and abuse tools.

Account and billing direction:

- Billing, account creation, subscription management, and creator verification should route through a web portal at launch.
- The desktop app should link to the portal and later consume account/subscription status from the service.
- In-app account creation and billing can be added later, after the web-first flow is proven.

Recommended data stores:

- Postgres for accounts, claims, subscriptions, mod metadata, aggregates.
- Object storage or cold table for short-lived raw snapshots if retained at all.
- Queue/worker for ingestion normalization.
- Redis or equivalent for rate limiting and cached compatibility results.

Retention:

- Raw snapshots: 14-30 days.
- Error signatures and aggregates: longer retention, provided they cannot reconstruct individual users.
- IP/rate-limit metadata: edge-only or short TTL, not analytical data.

Cost-control levers:

- Reject full logs.
- Cap excerpt length.
- Aggregate early.
- Sample high-volume duplicate signatures.
- Keep public reports cached.
- Do not store stable device/client identifiers.

## Launch Path

### Phase 1 - Trust And Data Quality

- Local snapshot preview.
- Anonymous opt-in collection.
- Basic public compatibility report.
- Manual developer claim flow.
- Free severe-warning compatibility labels.

Goal: prove telemetry quality and privacy story before charging.

### Phase 2 - Paid Beta

- $5/mo SIMM Supporter founder tier.
- $10/mo SIMM Creator founder tier.
- Annual discount after retention and refund flow are settled.
- 14-day trial or limited monthly report credits.
- Web portal for account creation, billing, account linking, and creator verification.

Goal: validate willingness to pay without overbuilding.

### Phase 3 - Network Effects

- Public mod health pages.
- Developer badges.
- Webhooks.
- Profile health sharing.
- Creator support pool or revenue share if subscriptions grow.

Goal: make each additional opt-in user improve the product for everyone.

## Risks

- Trust risk: telemetry and monetization together can feel extractive. Mitigation: preview payloads, opt-in only, no stable identifiers, publish privacy rules plainly.
- Cold-start risk: compatibility reports need enough data. Mitigation: show confidence labels and avoid overclaiming.
- Paywall backlash: users dislike paying for safety. Mitigation: keep severe warnings free and charge for depth/automation.
- Developer skepticism: authors may not pay for noisy reports. Mitigation: dedupe, aggregate, trend, and integrate with their existing GitHub/Discord workflow.
- Legal/platform risk: marketplace-like creator payouts may add obligations. Mitigation: start with SaaS access, defer revenue share until the core service is stable.

## Metrics To Watch

- Telemetry opt-in rate.
- Snapshot acceptance/rejection rate.
- Error signature dedupe ratio.
- Compatibility report confidence coverage.
- User conversion from compatibility preview to Supporter.
- Creator conversion after verified claim flow.
- Churn after first month.
- Support tickets related to privacy or billing.
- Server cost per active paid account.

## Open Questions

1. What exact public copy should distinguish SIMM Supporter as support-first while still making the feature value obvious?
2. Should free users get unlimited severe compatibility warnings, or only warnings for their installed mods?
3. What evidence should be accepted for initial human-managed SIMM Creator verification?
4. What approval terms, claim-transfer rules, and dispute process should govern creator/mod linking?
5. What portion of future revenue should be reserved for creator support once the core service is stable?
6. What is the minimum sample threshold before showing public compatibility claims? Initial quantity is unknown.
7. Should error excerpts be entirely developer-only, or should users also see sanitized excerpts when troubleshooting their own loadout?
8. Should SIMM offer a one-time lifetime/supporter option, or avoid lifetime promises until server costs are proven?
