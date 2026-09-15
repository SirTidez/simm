using System.Runtime.Serialization.Json;
using Simm.ModIntegration.Bridge;

namespace Simm.ModIntegration.Tests;

public sealed class ConfigurationTests
{
    [Fact]
    public void ValidConfigurationLoads()
    {
        var path = WriteConfiguration("127.0.0.1:43871", protocolVersion: 1);
        try
        {
            var configuration = BridgeConfiguration.Load(path);

            Assert.Equal("environment", configuration.EnvironmentId);
            Assert.Equal(64, configuration.CapabilityToken.Length);
            Assert.Equal(43871, configuration.GetPort());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void NumericPortConfigurationLoadsWithoutAnAddress()
    {
        var path = WriteConfiguration("ignored", protocolVersion: 1, port: 43872);
        try
        {
            var configuration = BridgeConfiguration.Load(path);

            Assert.Equal(43872, configuration.GetPort());
            Assert.Null(configuration.LegacyEndpoint);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65536)]
    public void InvalidNumericPortIsRejected(int port)
    {
        var path = WriteConfiguration("ignored", protocolVersion: 1, port: port);
        try
        {
            Assert.Throws<BridgeConfigurationException>(() => BridgeConfiguration.Load(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Theory]
    [InlineData("192.168.1.20:43871")]
    [InlineData("example.com:43871")]
    [InlineData("127.0.0.1:0")]
    public void NonLoopbackOrInvalidEndpointIsRejected(string endpoint)
    {
        var path = WriteConfiguration(endpoint, protocolVersion: 1);
        try
        {
            Assert.Throws<BridgeConfigurationException>(() => BridgeConfiguration.Load(path));
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void UnsupportedProtocolIsRejected()
    {
        var path = WriteConfiguration("127.0.0.1:43871", protocolVersion: 2);
        try
        {
            var error = Assert.Throws<BridgeConfigurationException>(
                () => BridgeConfiguration.Load(path));
            Assert.Contains("not supported", error.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            File.Delete(path);
        }
    }

    internal static string WriteConfiguration(string endpoint, int protocolVersion, int? port = null)
    {
        var path = Path.Combine(Path.GetTempPath(), $"simm-bridge-{Guid.NewGuid():N}.json");
        var config = new BridgeConfiguration
        {
            ProtocolVersion = protocolVersion,
            Port = port ?? 0,
            LegacyEndpoint = port.HasValue ? null : endpoint,
            EnvironmentId = "environment",
            CapabilityToken = new string('a', 64),
        };
        using var stream = File.Create(path);
        new DataContractJsonSerializer(typeof(BridgeConfiguration)).WriteObject(stream, config);
        return path;
    }
}
