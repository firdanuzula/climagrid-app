package climagrid.rmi;

import java.rmi.registry.LocateRegistry;

public final class RmiClient {
    private RmiClient() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 3) {
            System.err.println("Usage: RmiClient <station-id> [from-iso8601] [to-iso8601]");
            System.exit(2);
        }
        String host = System.getenv().getOrDefault("CLIMAGRID_RMI_HOST", "127.0.0.1");
        int port = Integer.parseInt(System.getenv().getOrDefault("CLIMAGRID_RMI_PORT", "1099"));
        ReadingsService service = (ReadingsService) LocateRegistry.getRegistry(host, port)
                .lookup("ClimaGridReadings");
        System.out.println(service.getReadings(args[0],
                args.length > 1 ? args[1] : "",
                args.length > 2 ? args[2] : ""));
    }
}
