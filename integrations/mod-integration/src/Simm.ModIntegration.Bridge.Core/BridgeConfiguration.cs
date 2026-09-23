using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;

namespace Simm.ModIntegration.Bridge;

[DataContract]
internal sealed class BridgeConfiguration
{
    internal const int SupportedProtocolVersion = 1;

    [DataMember(Name = "protocolVersion", IsRequired = true)]
    public int ProtocolVersion { get; set; }

    [DataMember(Name = "port", IsRequired = false, EmitDefaultValue = false)]
    public int Port { get; set; }

    [DataMember(Name = "endpoint", IsRequired = false, EmitDefaultValue = false)]
    public string? LegacyEndpoint { get; set; }

    [DataMember(Name = "environmentId", IsRequired = true)]
    public string EnvironmentId { get; set; } = string.Empty;

    [DataMember(Name = "capabilityToken", IsRequired = true)]
    public string CapabilityToken { get; set; } = string.Empty;

    internal static BridgeConfiguration Load(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw BridgeConfigurationException.Unavailable(
                "The bridge configuration path is missing.");
        }

        if (!File.Exists(path))
        {
            throw BridgeConfigurationException.Disabled(
                "SIMM local mod integration is not enabled for this installation.");
        }

        try
        {
            using var stream = File.OpenRead(path);
            var serializer = new DataContractJsonSerializer(typeof(BridgeConfiguration));
            var config = serializer.ReadObject(stream) as BridgeConfiguration
                ?? throw BridgeConfigurationException.Unavailable(
                    "The bridge configuration is empty.");
            config.Validate();
            return config;
        }
        catch (BridgeConfigurationException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is FileNotFoundException or DirectoryNotFoundException)
        {
            throw BridgeConfigurationException.Disabled(
                "SIMM local mod integration is not enabled for this installation.",
                exception);
        }
        catch (Exception exception) when (
            exception is IOException or UnauthorizedAccessException or SerializationException)
        {
            throw BridgeConfigurationException.Unavailable(
                "The SIMM bridge configuration could not be read.", exception);
        }
    }

    internal void Validate()
    {
        if (ProtocolVersion != SupportedProtocolVersion)
        {
            throw BridgeConfigurationException.Unavailable(
                $"SIMM protocol v{ProtocolVersion} is not supported by this bridge.");
        }

        if (string.IsNullOrWhiteSpace(EnvironmentId) || EnvironmentId.Length > 256)
        {
            throw BridgeConfigurationException.Unavailable(
                "The SIMM environment identifier is invalid.");
        }

        if (CapabilityToken.Length is < 32 or > 256)
        {
            throw BridgeConfigurationException.Unavailable(
                "The SIMM capability token is invalid.");
        }

        _ = GetPort();
    }

    internal int GetPort()
    {
        if (Port is >= 1 and <= 65535)
        {
            return Port;
        }

        if (string.IsNullOrWhiteSpace(LegacyEndpoint))
        {
            throw BridgeConfigurationException.Unavailable(
                "The SIMM bridge port must be between 1 and 65535.");
        }

        return ParseLegacyLoopbackEndpoint(LegacyEndpoint);
    }

    internal static int ParseLegacyLoopbackEndpoint(string endpoint)
    {
        var separator = endpoint.LastIndexOf(':');
        if (separator <= 0
            || separator == endpoint.Length - 1
            || !System.Net.IPAddress.TryParse(endpoint.Substring(0, separator), out var address)
            || !int.TryParse(endpoint.Substring(separator + 1), out var port)
            || port is < 1 or > 65535
            || !System.Net.IPAddress.IsLoopback(address))
        {
            throw BridgeConfigurationException.Unavailable(
                "The SIMM endpoint must be a valid loopback address and port.");
        }

        return port;
    }
}

internal sealed class BridgeConfigurationException : Exception
{
    private BridgeConfigurationException(ModIntegrationStatus status, string message)
        : base(message)
    {
        Status = status;
    }

    private BridgeConfigurationException(
        ModIntegrationStatus status,
        string message,
        Exception innerException)
        : base(message, innerException)
    {
        Status = status;
    }

    internal ModIntegrationStatus Status { get; }

    internal static BridgeConfigurationException Disabled(
        string message,
        Exception? innerException = null) => innerException is null
            ? new BridgeConfigurationException(ModIntegrationStatus.IntegrationDisabled, message)
            : new BridgeConfigurationException(
                ModIntegrationStatus.IntegrationDisabled,
                message,
                innerException);

    internal static BridgeConfigurationException Unavailable(
        string message,
        Exception? innerException = null) => innerException is null
            ? new BridgeConfigurationException(ModIntegrationStatus.SimmUnavailable, message)
            : new BridgeConfigurationException(
                ModIntegrationStatus.SimmUnavailable,
                message,
                innerException);
}
