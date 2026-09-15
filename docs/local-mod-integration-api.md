# SIMM Local Mod Integration API

Protocol version 1 provides a local request boundary for installed Schedule I mods. It supports checking for an update, requesting that SIMM queue an update, and asking the user to adopt a local mod into SIMM management.

## Ownership and security boundary

- The listener always binds to the IPv4 loopback interface. The default port is `43871`; the user may change only the port.
- Provider credentials never leave SIMM.
- Every enabled installation receives a separate 64-character random capability token. SIMM stores only its SHA-256 digest in the database; the token is written to that installation's `UserData/SIMM/mod-integration.json` bridge configuration.
- Each request must include the calling assembly's full path. SIMM resolves that path against the selected installation and rejects assemblies that are not actually installed there. Update operations still reject unmanaged assemblies; the management operation is the explicit, user-controlled path for adopting one.
- A supplied SIMM storage identifier, mod name, or version must agree with the assembly SIMM resolved. It cannot redirect a request to another mod.
- Requests are limited to 30 per installation per minute and 64 KiB each.
- Disabling the integration deletes the bridge configuration, clears the token digest, and denies pending requests.

The game-side bridge must capture the calling assembly itself. A consumer-facing helper must not accept an arbitrary assembly path or expose the capability token to a mod.

Each enabled installation receives a bridge file with a numeric port:

```json
{
  "protocolVersion": 1,
  "port": 43871,
  "environmentId": "3164500-beta-example",
  "capabilityToken": "installation-specific-private-token"
}
```

The port can be changed in SIMM or edited directly in this file. SIMM watches enabled bridge files and reconciles valid changes while it is running. Ports must be between `1` and `65535`; occupied ports are rejected. Legacy version-one files containing a loopback-only `endpoint` remain readable and are migrated to the numeric `port` field the next time SIMM saves the configuration.

## Framing

The API uses one UTF-8 JSON object followed by a newline on each TCP connection. SIMM replies with one UTF-8 JSON object followed by a newline and closes the connection.

Example request:

```json
{
  "protocolVersion": 1,
  "requestId": "a-mod-generated-correlation-id",
  "capabilityToken": "read-by-the-managed-game-bridge",
  "environmentId": "3164500-beta-example",
  "operation": "checkForUpdate",
  "modIdentity": {
    "assemblyPath": "C:\\Games\\Schedule I\\Mods\\Example.dll",
    "simmStorageId": "managed-storage-id",
    "guid": "com.example.mod",
    "name": "Example Mod",
    "version": "1.0.0"
  }
}
```

Example response:

```json
{
  "protocolVersion": 1,
  "requestId": "a-mod-generated-correlation-id",
  "status": "update-available",
  "message": "An update is available through SIMM.",
  "currentVersion": "1.0.0",
  "targetVersion": "1.1.0",
  "source": "thunderstore",
  "queuedRequestId": null
}
```

## Operations

### `checkForUpdate`

SIMM resolves the calling mod, refreshes its provider metadata using the existing hourly cache rules, and returns `update-available` or `up-to-date`. Read-only checks are not retained in request history.

### `requestUpdate`

SIMM rechecks the calling mod before accepting the request.

- `disabled`: returns `integration-disabled`.
- `ask`: stores `awaiting-user-approval` until the user approves or denies it.
- `automatic`: stores `queued` immediately.

Approved and automatic requests remain queued while Schedule I is running from the target installation. After the game exits, SIMM checks the provider again and installs only the then-current verified update. A failed security check or provider/manual-download requirement is recorded as `failed`; SIMM does not bypass existing install safeguards.

### `requestManagement`

An installed local mod can ask the user to let SIMM manage its existing files. This operation never adopts a source automatically, including when the installation policy is `automatic`.

- A local unmanaged caller is stored as `awaiting-user-source` and surfaced in the desktop application.
- SIMM searches supported providers for possible source families, but the user chooses the provider, exact source, installed version, and any additional owned files.
- The current installed files are preserved and imported into Mod Library; requesting management does not replace them with a provider download.
- The request becomes `managed` only after SIMM verifies that the source-link workflow completed. If the caller is already managed, SIMM returns `already-managed` without creating another request.
- Repeated requests for the same installed file reuse the existing pending management request.

## Response states

- `update-available`
- `up-to-date`
- `queued`
- `awaiting-user-approval`
- `awaiting-user-source`
- `already-managed`
- `managed`
- `denied`
- `update-not-available`
- `not-managed-by-simm`
- `integration-disabled`
- `simm-unavailable`
- `invalid`
- `failed`

## Desktop management commands

The Tauri UI uses these internal commands to manage each installation without handling the capability token:

- `get_mod_integration_config`
- `set_mod_integration_policy`
- `set_mod_integration_port`
- `list_mod_integration_requests`
- `resolve_mod_integration_request`

The binary game bridge and consumer SDK are a separate packaging layer over this protocol. They must preserve caller identity, provide a graceful `simm-unavailable` result when the desktop listener is absent, and ship in runtime-compatible variants before the public integration is considered complete.
