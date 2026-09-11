# Nexus Mods API capability review

Reviewed against the live Nexus Mods API and official documentation on 2026-09-10.

## Recommendation

Use the Nexus GraphQL v2 API for discovery and metadata, and retain SIMM's existing authenticated download flow. GraphQL is the only current Nexus surface that can provide a complete, filtered, sorted, paginated catalog. Download authorization remains account- and user-action-dependent, so catalog access and archive delivery should stay separate in the application.

## Available surfaces

| Surface | Useful capabilities | Authentication | Stability and fit |
| --- | --- | --- | --- |
| GraphQL v2 | Games, paginated mods, filters, sorts, rich mod metadata, files | Public reads work without a token; viewer-specific fields require authentication | Nexus labels this API as work in progress. Best available discovery surface, but SIMM must tolerate missing or changed optional fields. |
| REST v3 | Game metadata, a five-item trending feed, mod/file reads, repacked-download link creation | The trending endpoint is public; consumer mod/file and download operations require a key or bearer token | Actively developed, but several consumer endpoints are marked experimental. It does not currently replace GraphQL for full catalog discovery. |
| REST v1 | Existing OAuth download-link endpoint and established compatibility endpoints | Bearer token/API key depending on endpoint | Legacy, but still required by SIMM's proven download flow today. Isolate it behind the Nexus service so it can be replaced later. |
| `nxm://` handoff | User-confirmed file selection/download handoff from the Nexus website | Nexus login in the browser plus the callback data | Required for free/supporter website-confirmed downloads. Do not bypass it. |

## Catalog capabilities available to SIMM

GraphQL `mods` supports `offset` and `count`, reports `totalCount`, and accepts server-side filtering and sorting. Relevant filters include game, name, author/uploader, category, status, adult content, tags, dates, file size, download/endorsement thresholds, Vortex support, language, and direct-download availability. Relevant sorts include relevance, updated/created date, downloads, endorsements, name, size, random, and last comment.

Useful mod fields include:

- identity, name, summary, full description, version, status, and category;
- author and uploader attribution;
- images, tags, adult-content state, Vortex support, and direct-download state;
- created/updated timestamps, endorsements, and downloads.

Useful file fields include:

- file identity, display name, version, category, primary state, URI, and size;
- upload date, description, detected archive extension, total downloads, and unique downloads.

A live unauthenticated Schedule I query returned 1,228 mods at review time. This is a point-in-time observation, not a fixed product constant.

## Download behavior

SIMM should preserve the current two-path behavior:

1. Premium/direct-download-eligible accounts can request a Nexus download link through the authenticated API and continue into SIMM's existing archive validation, security scan, storage, runtime selection, FOMOD, and installation flow.
2. Free/supporter accounts start a pending manual session, open the Nexus files page, and complete the user-confirmed `nxm://` callback before SIMM redeems and downloads the selected file.

The REST v3 `download-repacked` operation is worth monitoring, but it is experimental and is not a reason to replace the established flow yet.

## Policy and operational requirements

- Register any public-facing build with Nexus Mods and send accurate `Application-Name` and `Application-Version` headers.
- Never ship or proxy a developer's personal API key, scrape Nexus pages, or rehost Nexus files.
- Keep user credentials/tokens local, revocable, encrypted at rest, and used only in response to a user action.
- Respect rate-limit headers. Nexus currently documents a 20,000-request rolling daily allowance followed by 500 requests per hour; limits can change, so the headers remain authoritative.
- Cache catalog and metadata reads, deduplicate concurrent requests, bound page sizes, and handle optional/changed GraphQL fields gracefully.
- Keep the canonical archive filename independent from the GraphQL display name when download response metadata supplies a better filename.

## SIMM implementation status

The beta branch now provides a typed, paginated catalog command with a page size capped at 100, total-result reporting, server-side sort selection, richer mod metadata, and richer file metadata. The Mod Library loads 50 results at a time and can append subsequent pages without duplicating mod IDs.

Existing OAuth, Premium direct-download, free/supporter website confirmation, dependency resolution, security scanning, FOMOD handling, and library installation behavior are intentionally unchanged.

Follow-up hardening should stream large archives to a temporary file instead of buffering the complete response in memory, and should add a migration path if Nexus promotes the v3 download contract from experimental status.

## Official references

- [Nexus Mods API v3 documentation](https://api-docs.nexusmods.com/)
- [Nexus Mods GraphQL v2 documentation](https://graphql.nexusmods.com/)
- [API acceptable-use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy)
- [API rate-limit guidance](https://help.nexusmods.com/article/105-i-have-reached-a-daily-or-hourly-limit-api-requests-have-been-consumed-rate-limit-exceeded-what-does-this-mean)
- [Nexus API v3 OpenAPI schema](https://github.com/Nexus-Mods/Vortex/blob/master/packages/nexus-api-v3/schema/openapi.yaml)
