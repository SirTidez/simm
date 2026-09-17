# SIMM Mod Integration SDK and Game Bridge

This directory contains the game-side portion of SIMM's local mod integration API:

- `Simm.ModIntegration.Abstractions` is the small, token-free assembly mod developers reference. It captures the calling assembly at the public API boundary and exposes update-check, update-request, and management-request results.
- `Simm.ModIntegration.Bridge.Core` is SIMM-owned transport code. It validates the per-installation configuration, restricts connections to loopback, adds the verified calling assembly path, and maps protocol responses into the public result model.
- `Simm.ModIntegration.Bridge.MelonLoader` is a plugin loaded before mods. It registers the bridge for either Schedule I runtime and unregisters it during shutdown.

## Consumer usage

Reference the `Simm.ModIntegration` package and call the API directly from the mod assembly:

```csharp
using Simm.ModIntegration;

var check = await SimmModIntegration.CheckForUpdateAsync();
if (check.IsUpdateAvailable)
{
    var request = await SimmModIntegration.RequestUpdateAsync();
    // queued: SIMM will recheck and install after the game exits.
    // awaiting-user-approval: the request is visible in SIMM.
}

// An unmanaged mod can ask SIMM to adopt its calling assembly. The user remains
// in control of identifying and approving the source inside SIMM.
var management = await SimmModIntegration.RequestManagementAsync();
if (management.RequiresUserAction)
{
    // awaiting-user-source or awaiting-user-approval: continue in SIMM.
}
```

There is deliberately no overload that accepts an assembly path, environment identifier, endpoint, or token. `RequestManagementAsync` can only nominate its actual calling assembly; it cannot adopt another mod. If the bridge or SIMM is absent, outdated, disabled, or unreachable, the call returns `SimmUnavailable` or another explicit protocol status instead of throwing for ordinary availability failures. Caller cancellation is still propagated as `OperationCanceledException`.

The management operation is sent as `requestManagement`. SIMM can respond with `awaiting-user-source` when the unmanaged assembly has been recorded but needs a provider/source choice, or `awaiting-user-approval` when a candidate is ready for user confirmation. Both set `WasAccepted` and `RequiresUserAction` on the result. Completed adoption returns `managed`; an already managed caller returns `already-managed`. Both set `IsManaged`.

## Build and package

Build and test the portable API and transport:

```powershell
dotnet test integrations/mod-integration/Simm.ModIntegration.sln -c Release
dotnet pack integrations/mod-integration/src/Simm.ModIntegration.Abstractions/Simm.ModIntegration.Abstractions.csproj -c Release -o integrations/mod-integration/artifacts/packages
```

The MelonLoader plugin has runtime-specific builds because Schedule I Mono uses MelonLoader's `net35` assembly while IL2CPP uses its `net6` assembly. Point the build at a matching, read-only MelonLoader reference:

```powershell
dotnet build integrations/mod-integration/src/Simm.ModIntegration.Bridge.MelonLoader/Simm.ModIntegration.Bridge.MelonLoader.csproj -c Release -p:RuntimeBackend=Mono -p:MelonLoaderAssembly="<mono-install>/MelonLoader/net35/MelonLoader.dll"
dotnet build integrations/mod-integration/src/Simm.ModIntegration.Bridge.MelonLoader/Simm.ModIntegration.Bridge.MelonLoader.csproj -c Release -p:RuntimeBackend=IL2CPP -p:MelonLoaderAssembly="<il2cpp-install>/MelonLoader/net6/MelonLoader.dll"
```

To validate both variants and create the NuGet package plus deployment-shaped `Plugins` and `UserLibs` staging folders in one pass:

```powershell
integrations/mod-integration/build/Build-Integration.ps1 `
  -MonoMelonLoaderAssembly "<mono-install>/MelonLoader/net35/MelonLoader.dll" `
  -Il2CppMelonLoaderAssembly "<il2cpp-install>/MelonLoader/net6/MelonLoader.dll"
```

SIMM packaging should place the selected bridge plugin under the managed MelonLoader `Plugins` projection and the matching abstraction/core assemblies under `UserLibs`. The existing desktop policy writes `UserData/SIMM/mod-integration.json`; the plugin does not create or mutate that file. SIMM selects and owns the numeric `port`, then synchronizes it into each enabled installation's file. The bridge always connects through the local loopback interface. Existing protocol-v1 files with a loopback `endpoint` remain compatible and are migrated when SIMM next saves them.

## Security boundary

The abstraction does not expose raw IPC or capability material. The bridge reads SIMM's assigned port, hardwires the connection host to loopback, and sends only the caller assembly path; SIMM remains authoritative for verifying that path against its managed library projection. This is a cooperative same-process boundary, not a sandbox: a hostile mod executing in the same game process has the user's filesystem permissions and can use reflection or read local files directly. Provider credentials remain exclusively in the desktop application.
