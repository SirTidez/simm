using System.Reflection;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Simm.ModIntegration;

/// <summary>
/// Requests update information from the SIMM-managed bridge installed with the game.
/// Consumer mods never handle SIMM connection details or provider credentials.
/// </summary>
public static class SimmModIntegration
{
    /// <summary>Checks whether SIMM has a verified update for the calling mod.</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Task<ModIntegrationResult> CheckForUpdateAsync(
        CancellationToken cancellationToken = default)
    {
        var caller = Assembly.GetCallingAssembly();
        return DispatchAsync(BridgeOperation.CheckForUpdate, caller, cancellationToken);
    }

    /// <summary>Asks SIMM to queue or present an update request for the calling mod.</summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Task<ModIntegrationResult> RequestUpdateAsync(
        CancellationToken cancellationToken = default)
    {
        var caller = Assembly.GetCallingAssembly();
        return DispatchAsync(BridgeOperation.RequestUpdate, caller, cancellationToken);
    }

    /// <summary>
    /// Asks SIMM to adopt the calling unmanaged mod into its library. SIMM may require the
    /// user to identify or approve the provider source before management can be completed.
    /// </summary>
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static Task<ModIntegrationResult> RequestManagementAsync(
        CancellationToken cancellationToken = default)
    {
        var caller = Assembly.GetCallingAssembly();
        return DispatchAsync(BridgeOperation.RequestManagement, caller, cancellationToken);
    }

    private static Task<ModIntegrationResult> DispatchAsync(
        BridgeOperation operation,
        Assembly caller,
        CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            return Task.FromCanceled<ModIntegrationResult>(cancellationToken);
        }

        var bridge = BridgeRegistration.Current;
        return bridge is null
            ? Task.FromResult(ModIntegrationResult.Unavailable(
                "The SIMM game bridge is not installed or has not initialized."))
            : bridge.SendAsync(operation, caller, cancellationToken);
    }
}
