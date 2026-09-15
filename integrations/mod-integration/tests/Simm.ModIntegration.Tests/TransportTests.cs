using System.Net;
using System.Net.Sockets;
using System.Runtime.Serialization.Json;
using System.Text;
using Simm.ModIntegration;
using Simm.ModIntegration.Bridge;

namespace Simm.ModIntegration.Tests;

public sealed class TransportTests : IDisposable
{
    public TransportTests() => BridgeRegistration.ResetForTests();

    public void Dispose() => BridgeRegistration.ResetForTests();

    [Theory]
    [InlineData("awaiting-user-source", ModIntegrationStatus.AwaitingUserSource)]
    [InlineData("awaiting-user-approval", ModIntegrationStatus.AwaitingUserApproval)]
    [InlineData("already-managed", ModIntegrationStatus.AlreadyManaged)]
    [InlineData("managed", ModIntegrationStatus.Managed)]
    public void ManagementStatusesMapToPublicResults(
        string wireStatus,
        ModIntegrationStatus expected)
    {
        Assert.Equal(expected, SimmBridgeProvider.ParseStatus(wireStatus));
    }

    [Fact]
    public async Task RequestUsesCapturedAssemblyAndMapsResponse()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var configPath = ConfigurationTests.WriteConfiguration(
            "127.0.0.1:0",
            protocolVersion: 1,
            port: port);
        try
        {
            WireRequest? received = null;
            var server = Task.Run(async () =>
            {
                using var client = await listener.AcceptTcpClientAsync();
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true);
                var line = await reader.ReadLineAsync();
                Assert.NotNull(line);
                using var requestStream = new MemoryStream(Encoding.UTF8.GetBytes(line));
                received = (WireRequest?)new DataContractJsonSerializer(typeof(WireRequest))
                    .ReadObject(requestStream);
                Assert.NotNull(received);

                var response = new WireResponse
                {
                    ProtocolVersion = 1,
                    RequestId = received.RequestId,
                    Status = "update-available",
                    Message = "An update is available through SIMM.",
                    CurrentVersion = "1.0.0",
                    TargetVersion = "1.1.0",
                    Source = "thunderstore",
                };
                using var responseStream = new MemoryStream();
                new DataContractJsonSerializer(typeof(WireResponse))
                    .WriteObject(responseStream, response);
                responseStream.WriteByte((byte)'\n');
                var bytes = responseStream.ToArray();
                await stream.WriteAsync(bytes);
            });

            using var runtime = SimmBridgeRuntime.Start(configPath);
            Assert.True(runtime.IsRegistered);
            var result = await SimmModIntegration.CheckForUpdateAsync();
            await server;

            Assert.Equal(ModIntegrationStatus.UpdateAvailable, result.Status);
            Assert.Equal("1.1.0", result.TargetVersion);
            Assert.Equal("thunderstore", result.Source);
            Assert.NotNull(received);
            Assert.Equal("checkForUpdate", received.Operation);
            Assert.Equal(typeof(TransportTests).Assembly.Location, received.ModIdentity.AssemblyPath);
            Assert.Equal(new string('a', 64), received.CapabilityToken);
        }
        finally
        {
            File.Delete(configPath);
        }
    }

    [Fact]
    public async Task ListenerUnavailableReturnsStatusInsteadOfThrowing()
    {
        using var reserve = new TcpListener(IPAddress.Loopback, 0);
        reserve.Start();
        var port = ((IPEndPoint)reserve.LocalEndpoint).Port;
        reserve.Stop();
        var configPath = ConfigurationTests.WriteConfiguration(
            "127.0.0.1:0",
            protocolVersion: 1,
            port: port);
        try
        {
            using var runtime = SimmBridgeRuntime.Start(configPath);
            var result = await SimmModIntegration.CheckForUpdateAsync();

            Assert.Equal(ModIntegrationStatus.SimmUnavailable, result.Status);
        }
        finally
        {
            File.Delete(configPath);
        }
    }

    [Fact]
    public async Task MissingConfigurationReportsIntegrationDisabled()
    {
        var missingPath = Path.Combine(
            Path.GetTempPath(),
            $"missing-simm-bridge-{Guid.NewGuid():N}.json");
        using var runtime = SimmBridgeRuntime.Start(missingPath);

        var result = await SimmModIntegration.CheckForUpdateAsync();

        Assert.Equal(ModIntegrationStatus.IntegrationDisabled, result.Status);
    }

    [Fact]
    public async Task ManagementRequestMapsAwaitingUserSourceStatus()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var configPath = ConfigurationTests.WriteConfiguration(
            "127.0.0.1:0",
            protocolVersion: 1,
            port: port);
        try
        {
            WireRequest? received = null;
            var server = Task.Run(async () =>
            {
                using var client = await listener.AcceptTcpClientAsync();
                using var stream = client.GetStream();
                using var reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true);
                var line = await reader.ReadLineAsync();
                Assert.NotNull(line);
                using var requestStream = new MemoryStream(Encoding.UTF8.GetBytes(line));
                received = (WireRequest?)new DataContractJsonSerializer(typeof(WireRequest))
                    .ReadObject(requestStream);
                Assert.NotNull(received);

                var response = new WireResponse
                {
                    ProtocolVersion = 1,
                    RequestId = received.RequestId,
                    Status = "awaiting-user-source",
                    Message = "Choose the source SIMM should use to manage this mod.",
                    QueuedRequestId = "management-request",
                };
                using var responseStream = new MemoryStream();
                new DataContractJsonSerializer(typeof(WireResponse))
                    .WriteObject(responseStream, response);
                responseStream.WriteByte((byte)'\n');
                var bytes = responseStream.ToArray();
                await stream.WriteAsync(bytes);
            });

            using var runtime = SimmBridgeRuntime.Start(configPath);
            var result = await SimmModIntegration.RequestManagementAsync();
            await server;

            Assert.Equal(ModIntegrationStatus.AwaitingUserSource, result.Status);
            Assert.True(result.WasAccepted);
            Assert.True(result.RequiresUserAction);
            Assert.Equal("management-request", result.QueuedRequestId);
            Assert.NotNull(received);
            Assert.Equal("requestManagement", received.Operation);
            Assert.Equal(typeof(TransportTests).Assembly.Location, received.ModIdentity.AssemblyPath);
        }
        finally
        {
            File.Delete(configPath);
        }
    }
}
