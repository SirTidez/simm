using MelonLoader;
using MelonLoader.Utils;

[assembly: MelonInfo(
    typeof(Simm.ModIntegration.Bridge.MelonLoader.SimmBridgeMelonPlugin),
    "SIMM Mod Integration Bridge",
    "0.1.0",
    "SIMM contributors")]
[assembly: MelonGame("TVGS", "Schedule I")]

namespace Simm.ModIntegration.Bridge.MelonLoader;

public sealed class SimmBridgeMelonPlugin : MelonPlugin
{
    private SimmBridgeRuntime? _runtime;

    public override void OnPreInitialization()
    {
        var configurationPath = Path.Combine(
            MelonEnvironment.UserDataDirectory,
            "SIMM",
            "mod-integration.json");
        _runtime = SimmBridgeRuntime.Start(configurationPath);
        if (_runtime.IsRegistered)
        {
            LoggerInstance.Msg("SIMM local mod integration bridge initialized.");
        }
        else
        {
            LoggerInstance.Warning(
                "Another SIMM local mod integration bridge is already registered.");
        }
    }

    public override void OnDeinitializeMelon()
    {
        _runtime?.Dispose();
        _runtime = null;
    }
}
