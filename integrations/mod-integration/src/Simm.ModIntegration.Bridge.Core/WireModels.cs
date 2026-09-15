using System.Runtime.Serialization;

namespace Simm.ModIntegration.Bridge;

[DataContract]
internal sealed class WireRequest
{
    [DataMember(Name = "protocolVersion", Order = 1)]
    public int ProtocolVersion { get; set; }

    [DataMember(Name = "requestId", Order = 2)]
    public string RequestId { get; set; } = string.Empty;

    [DataMember(Name = "capabilityToken", Order = 3)]
    public string CapabilityToken { get; set; } = string.Empty;

    [DataMember(Name = "environmentId", Order = 4)]
    public string EnvironmentId { get; set; } = string.Empty;

    [DataMember(Name = "operation", Order = 5)]
    public string Operation { get; set; } = string.Empty;

    [DataMember(Name = "modIdentity", Order = 6)]
    public WireModIdentity ModIdentity { get; set; } = new();
}

[DataContract]
internal sealed class WireModIdentity
{
    [DataMember(Name = "assemblyPath", Order = 1)]
    public string AssemblyPath { get; set; } = string.Empty;
}

[DataContract]
internal sealed class WireResponse
{
    [DataMember(Name = "protocolVersion")]
    public int ProtocolVersion { get; set; }

    [DataMember(Name = "requestId")]
    public string RequestId { get; set; } = string.Empty;

    [DataMember(Name = "status")]
    public string Status { get; set; } = string.Empty;

    [DataMember(Name = "message")]
    public string Message { get; set; } = string.Empty;

    [DataMember(Name = "currentVersion")]
    public string? CurrentVersion { get; set; }

    [DataMember(Name = "targetVersion")]
    public string? TargetVersion { get; set; }

    [DataMember(Name = "source")]
    public string? Source { get; set; }

    [DataMember(Name = "queuedRequestId")]
    public string? QueuedRequestId { get; set; }
}
