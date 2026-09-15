namespace Simm.ModIntegration;

/// <summary>The stable states returned by the SIMM local integration service.</summary>
public enum ModIntegrationStatus
{
    /// <summary>A newer verified version is available.</summary>
    UpdateAvailable,
    /// <summary>The installed version is current.</summary>
    UpToDate,
    /// <summary>The update was accepted and will be installed after the game exits.</summary>
    Queued,
    /// <summary>The update is waiting for approval in SIMM.</summary>
    AwaitingUserApproval,
    /// <summary>SIMM recorded the unmanaged mod and needs the user to identify its source.</summary>
    AwaitingUserSource,
    /// <summary>The calling mod was already managed by SIMM.</summary>
    AlreadyManaged,
    /// <summary>SIMM successfully adopted the calling mod.</summary>
    Managed,
    /// <summary>The user denied the update request.</summary>
    Denied,
    /// <summary>A requested update is no longer available.</summary>
    UpdateNotAvailable,
    /// <summary>The calling assembly is not a SIMM-managed mod.</summary>
    NotManagedBySimm,
    /// <summary>Local integration is disabled for this installation.</summary>
    IntegrationDisabled,
    /// <summary>The bridge or desktop service is not currently reachable or compatible.</summary>
    SimmUnavailable,
    /// <summary>The request or response did not satisfy the protocol.</summary>
    Invalid,
    /// <summary>An accepted update failed during its later installation.</summary>
    Failed,
}

/// <summary>A completed response from SIMM, including graceful unavailable states.</summary>
public sealed class ModIntegrationResult
{
    /// <summary>Creates an immutable integration result.</summary>
    public ModIntegrationResult(
        ModIntegrationStatus status,
        string message,
        string? currentVersion = null,
        string? targetVersion = null,
        string? source = null,
        string? queuedRequestId = null)
    {
        Status = status;
        Message = message ?? string.Empty;
        CurrentVersion = currentVersion;
        TargetVersion = targetVersion;
        Source = source;
        QueuedRequestId = queuedRequestId;
    }

    /// <summary>The machine-readable result state.</summary>
    public ModIntegrationStatus Status { get; }

    /// <summary>A user-facing explanation supplied by the bridge or SIMM.</summary>
    public string Message { get; }

    /// <summary>The installed version SIMM resolved, when available.</summary>
    public string? CurrentVersion { get; }

    /// <summary>The verified remote version SIMM resolved, when available.</summary>
    public string? TargetVersion { get; }

    /// <summary>The provider SIMM associated with the managed mod, when available.</summary>
    public string? Source { get; }

    /// <summary>The persistent SIMM request identifier for an accepted request.</summary>
    public string? QueuedRequestId { get; }

    /// <summary>Whether a check reported a newer version.</summary>
    public bool IsUpdateAvailable => Status == ModIntegrationStatus.UpdateAvailable;

    /// <summary>Whether an update or management request was accepted for further action.</summary>
    public bool WasAccepted => Status is ModIntegrationStatus.Queued
        or ModIntegrationStatus.AwaitingUserApproval
        or ModIntegrationStatus.AwaitingUserSource;

    /// <summary>Whether the request requires the user to choose a source or approve it in SIMM.</summary>
    public bool RequiresUserAction => Status is ModIntegrationStatus.AwaitingUserApproval
        or ModIntegrationStatus.AwaitingUserSource;

    /// <summary>Whether the caller is now, or was already, managed by SIMM.</summary>
    public bool IsManaged => Status is ModIntegrationStatus.Managed
        or ModIntegrationStatus.AlreadyManaged;

    internal static ModIntegrationResult Unavailable(string message) =>
        new(ModIntegrationStatus.SimmUnavailable, message);
}
