# Installed mod metadata fixtures

These small, authored .NET assemblies verify metadata inspection without MelonLoader, a game, .NET hosting, or dependency resolution at test time. Attribute constructors deliberately throw if executed. The attribute dependency is not stored beside the fixture DLLs.

- Modern: external MelonInfo, Unicode, prerelease/build version distinct from AssemblyVersion 9.8.7.6.
- Numeric: locally defined MelonInfo constructor (MethodDef), numeric prerelease overload.
- NumericStable: external numeric overload without a prerelease identifier.
- Legacy: external legacy plugin declaration.
- Fallback: unrelated MelonInfo namespace and decoy version string; only its own AssemblyVersion 3.4.5.6 is authoritative.

Rebuild with .NET 10 SDK using `./build.ps1`. Build intermediates stay under the repository's ignored target directory. Rust tests read the committed DLL bytes and do not require the SDK.
