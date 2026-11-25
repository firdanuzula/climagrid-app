package climagrid.rmi;

import com.sun.net.httpserver.HttpServer;

import java.net.InetSocketAddress;
import java.rmi.registry.LocateRegistry;
import java.rmi.registry.Registry;
import java.rmi.server.UnicastRemoteObject;
import java.util.concurrent.CountDownLatch;

public final class RmiServer {
    private RmiServer() {}

    public static void main(String[] args) throws Exception {
        String host = System.getenv().getOrDefault("CLIMAGRID_RMI_HOST", "127.0.0.1");
        int registryPort = Integer.parseInt(System.getenv().getOrDefault("CLIMAGRID_RMI_PORT", "1099"));
        int objectPort = Integer.parseInt(System.getenv().getOrDefault("CLIMAGRID_RMI_OBJECT_PORT", "1100"));
        int bridgePort = Integer.parseInt(System.getenv().getOrDefault("CLIMAGRID_RMI_BRIDGE_PORT", "8765"));
        String apiBase = System.getenv().getOrDefault("CLIMAGRID_API_URL", "http://127.0.0.1:4173");
        String token = System.getenv().getOrDefault("CLIMAGRID_TOKEN", "");
        System.setProperty("java.rmi.server.hostname", host);

        Registry registry = LocateRegistry.createRegistry(
                registryPort, null, new RmiServerSocketFactory(host));
        ReadingsServiceImpl service = new ReadingsServiceImpl(objectPort, apiBase, token, host);
        registry.rebind("ClimaGridReadings", service);
        HttpServer bridge = RmiHttpBridge.start(host, bridgePort, registryPort);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            bridge.stop(1);
            try {
                registry.unbind("ClimaGridReadings");
            } catch (Exception error) {
                System.err.println("Gagal melepas binding RMI saat shutdown: " + error.getMessage());
            }
            try {
                UnicastRemoteObject.unexportObject(service, true);
            } catch (Exception error) {
                System.err.println("Gagal melepas object RMI saat shutdown: " + error.getMessage());
            }
        }));

        System.out.printf("ClimaGrid RMI registry aktif di %s:%d%n", host, registryPort);
        System.out.printf("RMI object port aktif di %s:%d%n", host, objectPort);
        System.out.printf("HTTP bridge lokal aktif di 127.0.0.1:%d%n", bridgePort);
        System.out.printf("Sumber data kanonis: %s%n", apiBase);
        new CountDownLatch(1).await();
    }
}
