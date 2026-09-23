using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Simm.ModIntegration.Bridge;

internal sealed class SimmBridgeProvider : IModIntegrationBridge
{
    private const int MaximumResponseBytes = 64 * 1024;
    private readonly string _configurationPath;
    private readonly TimeSpan _connectTimeout;
    private readonly TimeSpan _responseTimeout;

    internal SimmBridgeProvider(
        string configurationPath,
        TimeSpan? connectTimeout = null,
        TimeSpan? responseTimeout = null)
    {
        _configurationPath = configurationPath;
        _connectTimeout = connectTimeout ?? TimeSpan.FromSeconds(2);
        _responseTimeout = responseTimeout ?? TimeSpan.FromSeconds(15);
    }

    public async Task<ModIntegrationResult> SendAsync(
        BridgeOperation operation,
        Assembly callerAssembly,
        CancellationToken cancellationToken)
    {
        if (callerAssembly is null)
        {
            return new ModIntegrationResult(
                ModIntegrationStatus.Invalid,
                "The calling mod assembly could not be identified.");
        }

        string assemblyPath;
        try
        {
            assemblyPath = Path.GetFullPath(callerAssembly.Location);
        }
        catch (Exception exception) when (
            exception is NotSupportedException
                or ArgumentException
                or IOException)
        {
            return new ModIntegrationResult(
                ModIntegrationStatus.NotManagedBySimm,
                "The calling mod does not have a verifiable assembly path.");
        }

        if (string.IsNullOrWhiteSpace(assemblyPath))
        {
            return new ModIntegrationResult(
                ModIntegrationStatus.NotManagedBySimm,
                "The calling mod does not have a verifiable assembly path.");
        }

        BridgeConfiguration configuration;
        try
        {
            configuration = BridgeConfiguration.Load(_configurationPath);
        }
        catch (BridgeConfigurationException exception)
        {
            return new ModIntegrationResult(exception.Status, exception.Message);
        }

        var request = new WireRequest
        {
            ProtocolVersion = BridgeConfiguration.SupportedProtocolVersion,
            RequestId = Guid.NewGuid().ToString("N"),
            CapabilityToken = configuration.CapabilityToken,
            EnvironmentId = configuration.EnvironmentId,
            Operation = operation switch
            {
                BridgeOperation.CheckForUpdate => "checkForUpdate",
                BridgeOperation.RequestUpdate => "requestUpdate",
                BridgeOperation.RequestManagement => "requestManagement",
                _ => throw new ArgumentOutOfRangeException(nameof(operation), operation, null),
            },
            ModIdentity = new WireModIdentity { AssemblyPath = assemblyPath },
        };

        try
        {
            return await SendWireRequestAsync(configuration, request, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return ModIntegrationResult.Unavailable(
                "SIMM did not respond before the local request timed out.");
        }
        catch (Exception exception) when (
            exception is SocketException
                or IOException
                or UnauthorizedAccessException
                or System.Runtime.Serialization.SerializationException)
        {
            return ModIntegrationResult.Unavailable(
                $"SIMM is not available for local mod integration ({exception.GetType().Name}).");
        }
    }

    private async Task<ModIntegrationResult> SendWireRequestAsync(
        BridgeConfiguration configuration,
        WireRequest request,
        CancellationToken cancellationToken)
    {
        var port = configuration.GetPort();
        var address = System.Net.IPAddress.Loopback;
        using var client = new TcpClient(address.AddressFamily);
        await WithTimeout(
                client.ConnectAsync(address, port),
                _connectTimeout,
                cancellationToken)
            .ConfigureAwait(false);

        using var stream = client.GetStream();
        using var ioTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        ioTimeout.CancelAfter(_responseTimeout);
        // Mono's NetworkStream can ignore cancellation after a read starts.
        // Closing the client makes the pending operation fail on every runtime.
        using var abortRegistration = ioTimeout.Token.Register(
            static state => ((TcpClient)state!).Close(),
            client);
        var serializer = new DataContractJsonSerializer(typeof(WireRequest));
        try
        {
            using (var buffer = new MemoryStream())
            {
                serializer.WriteObject(buffer, request);
                buffer.WriteByte((byte)'\n');
                var payload = buffer.ToArray();
                await stream.WriteAsync(payload, 0, payload.Length, ioTimeout.Token)
                    .ConfigureAwait(false);
                await stream.FlushAsync(ioTimeout.Token).ConfigureAwait(false);
            }

            var responseBytes = await ReadLineAsync(
                    stream,
                    MaximumResponseBytes,
                    ioTimeout.Token)
                .ConfigureAwait(false);
            using var responseStream = new MemoryStream(responseBytes, writable: false);
            var responseSerializer = new DataContractJsonSerializer(typeof(WireResponse));
            var response = responseSerializer.ReadObject(responseStream) as WireResponse
                ?? throw new IOException("SIMM returned an empty response.");

            if (response.ProtocolVersion != BridgeConfiguration.SupportedProtocolVersion)
            {
                return ModIntegrationResult.Unavailable(
                    $"SIMM returned unsupported protocol v{response.ProtocolVersion}.");
            }

            if (!string.Equals(response.RequestId, request.RequestId, StringComparison.Ordinal))
            {
                return new ModIntegrationResult(
                    ModIntegrationStatus.Invalid,
                    "SIMM returned a response for a different request.");
            }

            var status = ParseStatus(response.Status);
            return new ModIntegrationResult(
                status,
                response.Message,
                response.CurrentVersion,
                response.TargetVersion,
                response.Source,
                response.QueuedRequestId);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException) when (ioTimeout.IsCancellationRequested)
        {
            throw new OperationCanceledException("The local SIMM connection timed out.");
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (ObjectDisposedException) when (ioTimeout.IsCancellationRequested)
        {
            throw new OperationCanceledException("The local SIMM connection timed out.");
        }
        catch (IOException) when (cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (IOException) when (ioTimeout.IsCancellationRequested)
        {
            throw new OperationCanceledException("The local SIMM connection timed out.");
        }
    }

    internal static ModIntegrationStatus ParseStatus(string status) => status switch
    {
        "update-available" => ModIntegrationStatus.UpdateAvailable,
        "up-to-date" => ModIntegrationStatus.UpToDate,
        "queued" => ModIntegrationStatus.Queued,
        "awaiting-user-approval" => ModIntegrationStatus.AwaitingUserApproval,
        "awaiting-user-source" => ModIntegrationStatus.AwaitingUserSource,
        "already-managed" => ModIntegrationStatus.AlreadyManaged,
        "managed" => ModIntegrationStatus.Managed,
        "denied" => ModIntegrationStatus.Denied,
        "update-not-available" => ModIntegrationStatus.UpdateNotAvailable,
        "not-managed-by-simm" => ModIntegrationStatus.NotManagedBySimm,
        "integration-disabled" => ModIntegrationStatus.IntegrationDisabled,
        "simm-unavailable" => ModIntegrationStatus.SimmUnavailable,
        "invalid" => ModIntegrationStatus.Invalid,
        "failed" => ModIntegrationStatus.Failed,
        _ => ModIntegrationStatus.Invalid,
    };

    private static async Task<byte[]> ReadLineAsync(
        NetworkStream stream,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var oneByte = new byte[1];
        while (buffer.Length <= maximumBytes)
        {
            var read = await stream.ReadAsync(oneByte, 0, 1, cancellationToken)
                .ConfigureAwait(false);
            if (read == 0 || oneByte[0] == (byte)'\n')
            {
                break;
            }

            buffer.WriteByte(oneByte[0]);
        }

        if (buffer.Length == 0)
        {
            throw new IOException("SIMM closed the connection without a response.");
        }

        if (buffer.Length > maximumBytes)
        {
            throw new IOException("SIMM returned a response larger than 64 KiB.");
        }

        return buffer.ToArray();
    }

    private static async Task WithTimeout(
        Task operation,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var delay = Task.Delay(timeout, timeoutSource.Token);
        var completed = await Task.WhenAny(operation, delay).ConfigureAwait(false);
        if (completed != operation)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw new OperationCanceledException("The local SIMM connection timed out.");
        }

        timeoutSource.Cancel();
        await operation.ConfigureAwait(false);
    }
}
