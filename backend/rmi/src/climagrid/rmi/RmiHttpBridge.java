package climagrid.rmi;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.rmi.registry.LocateRegistry;
import java.rmi.registry.Registry;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class RmiHttpBridge {
    private static final Pattern READINGS_PATH =
            Pattern.compile("^/api/v1/stations/([A-Za-z0-9-]{1,32})/readings$");

    private RmiHttpBridge() {}

    static HttpServer start(String host, int port, int registryPort) throws IOException {
        Registry registry = LocateRegistry.getRegistry(host, registryPort);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.createContext("/api/v1/stations/", exchange -> handle(exchange, registry));
        server.start();
        return server;
    }

    private static void handle(HttpExchange exchange, Registry registry) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            send(exchange, 405, "{\"error\":{\"code\":\"METHOD_NOT_ALLOWED\",\"message\":\"GET required\"}}");
            return;
        }
        Matcher path = READINGS_PATH.matcher(exchange.getRequestURI().getPath());
        if (!path.matches()) {
            send(exchange, 404, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"Unknown RMI bridge endpoint\"}}");
            return;
        }

        try {
            String from = queryParameter(exchange.getRequestURI().getRawQuery(), "from");
            String to = queryParameter(exchange.getRequestURI().getRawQuery(), "to");
            ReadingsService service = (ReadingsService) registry.lookup("ClimaGridReadings");
            String body = service.getReadings(path.group(1), from, to);
            send(exchange, 200, body);
        } catch (Exception error) {
            String message = error.getMessage() == null ? "RMI call failed" : error.getMessage();
            String body = "{\"error\":{\"code\":\"RMI_UNAVAILABLE\",\"message\":\""
                    + jsonEscape(message) + "\"}}";
            send(exchange, 502, body);
        }
    }

    private static String queryParameter(String query, String name) {
        if (query == null || query.isEmpty()) return "";
        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            if (URLDecoder.decode(parts[0], StandardCharsets.UTF_8).equals(name)) {
                return parts.length == 2 ? URLDecoder.decode(parts[1], StandardCharsets.UTF_8) : "";
            }
        }
        return "";
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\r", "\\r").replace("\n", "\\n");
    }

    private static void send(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }
}
