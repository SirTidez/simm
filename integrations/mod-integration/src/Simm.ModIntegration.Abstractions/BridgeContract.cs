using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

namespace Simm.ModIntegration;

internal enum BridgeOperation
{
    CheckForUpdate,
    RequestUpdate,
    RequestManagement,
}

internal interface IModIntegrationBridge
{
    Task<ModIntegrationResult> SendAsync(
        BridgeOperation operation,
        Assembly callerAssembly,
        CancellationToken cancellationToken);
}

internal static class BridgeRegistration
{
    private static IModIntegrationBridge? _bridge;

    internal static IModIntegrationBridge? Current => Volatile.Read(ref _bridge);

    internal static bool TryRegister(IModIntegrationBridge bridge)
    {
        if (bridge is null)
        {
            throw new ArgumentNullException(nameof(bridge));
        }

        return Interlocked.CompareExchange(ref _bridge, bridge, null) is null;
    }

    internal static void Unregister(IModIntegrationBridge bridge)
    {
        if (bridge is null)
        {
            return;
        }

        Interlocked.CompareExchange(ref _bridge, null, bridge);
    }

    internal static void ResetForTests() => Volatile.Write(ref _bridge, null);
}
