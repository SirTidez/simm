using System.Reflection;
using Simm.ModIntegration;

namespace Simm.ModIntegration.Tests;

public sealed class AbstractionTests : IDisposable
{
    public AbstractionTests() => BridgeRegistration.ResetForTests();

    public void Dispose() => BridgeRegistration.ResetForTests();

    [Fact]
    public async Task MissingBridgeReturnsGracefulUnavailableResult()
    {
        var result = await SimmModIntegration.CheckForUpdateAsync();

        Assert.Equal(ModIntegrationStatus.SimmUnavailable, result.Status);
        Assert.Contains("not installed", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task PublicApiCapturesConsumerAssemblyWithoutCallerInput()
    {
        var bridge = new RecordingBridge();
        Assert.True(BridgeRegistration.TryRegister(bridge));

        var result = await SimmModIntegration.RequestUpdateAsync();

        Assert.Equal(ModIntegrationStatus.Queued, result.Status);
        Assert.Same(typeof(AbstractionTests).Assembly, bridge.CallerAssembly);
        Assert.Equal(BridgeOperation.RequestUpdate, bridge.Operation);
    }

    [Fact]
    public async Task ManagementApiCapturesConsumerAssemblyWithoutIdentityInput()
    {
        var bridge = new RecordingBridge();
        Assert.True(BridgeRegistration.TryRegister(bridge));

        var result = await SimmModIntegration.RequestManagementAsync();

        Assert.Equal(ModIntegrationStatus.Queued, result.Status);
        Assert.Same(typeof(AbstractionTests).Assembly, bridge.CallerAssembly);
        Assert.Equal(BridgeOperation.RequestManagement, bridge.Operation);
    }

    [Fact]
    public void PublicApiDoesNotExposeIdentityOrTransportInputs()
    {
        var methods = typeof(SimmModIntegration).GetMethods(
            BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);

        Assert.Equal(3, methods.Length);
        Assert.All(methods, method =>
        {
            Assert.All(method.GetParameters(), parameter =>
                Assert.Equal(typeof(CancellationToken), parameter.ParameterType));
            Assert.DoesNotContain("token", method.Name, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("path", method.Name, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("endpoint", method.Name, StringComparison.OrdinalIgnoreCase);
        });
    }

    private sealed class RecordingBridge : IModIntegrationBridge
    {
        public Assembly? CallerAssembly { get; private set; }

        public BridgeOperation? Operation { get; private set; }

        public Task<ModIntegrationResult> SendAsync(
            BridgeOperation operation,
            Assembly callerAssembly,
            CancellationToken cancellationToken)
        {
            Operation = operation;
            CallerAssembly = callerAssembly;
            return Task.FromResult(new ModIntegrationResult(
                ModIntegrationStatus.Queued,
                "queued"));
        }
    }
}
