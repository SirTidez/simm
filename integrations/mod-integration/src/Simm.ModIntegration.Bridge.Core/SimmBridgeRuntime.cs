namespace Simm.ModIntegration.Bridge;

internal sealed class SimmBridgeRuntime : IDisposable
{
    private readonly SimmBridgeProvider _provider;
    private bool _registered;

    private SimmBridgeRuntime(SimmBridgeProvider provider)
    {
        _provider = provider;
        _registered = BridgeRegistration.TryRegister(provider);
    }

    /// <summary>Whether this runtime owns the single process-wide bridge registration.</summary>
    public bool IsRegistered => _registered;

    /// <summary>Creates and registers the bridge using SIMM's per-installation configuration.</summary>
    public static SimmBridgeRuntime Start(string configurationPath) =>
        new(new SimmBridgeProvider(configurationPath));

    /// <summary>Unregisters this bridge instance when it owns the registration.</summary>
    public void Dispose()
    {
        if (!_registered)
        {
            return;
        }

        BridgeRegistration.Unregister(_provider);
        _registered = false;
    }
}
