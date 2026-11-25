package climagrid.rmi;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.rmi.RemoteException;
import java.rmi.server.UnicastRemoteObject;
import java.time.Duration;
import java.time.Instant;

public final class ReadingsServiceImpl extends UnicastRemoteObject implements ReadingsService {
    private static final long serialVersionUID = 1L;

    private final HttpClient httpClient;
    private final String apiBase;
    private final String token;

    public ReadingsServiceImpl(int objectPort, String apiBase, String token, String bindHost) throws RemoteException {
        super(objectPort, null, new RmiServerSocketFactory(bindHost));
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
        this.apiBase = apiBase.replaceAll("/+$", "");
        this.token = token;
    }

    @Override
    public String getReadings(String stationId, String from, String to) throws RemoteException {
        if (stationId == null || !stationId.matches("[A-Za-z0-9-]{1,32}")) {
            throw new RemoteException("stationId must contain 1-32 letters, digits, or hyphens");
        }
        validateTimestamp(from);
        validateTimestamp(to);

        StringBuilder endpoint = new StringBuilder(apiBase)
                .append("/api/v1/stations/")
                .append(URLEncoder.encode(stationId, StandardCharsets.UTF_8))
                .append("/readings");
        boolean hasQuery = false;
        if (from != null && !from.isBlank()) {
            endpoint.append("?from=").append(encode(from));
            hasQuery = true;
        }
        if (to != null && !to.isBlank()) {
            endpoint.append(hasQuery ? "&" : "?").append("to=").append(encode(to));
        }

        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(endpoint.toString()))
                .timeout(Duration.ofSeconds(4))
                .header("Accept", "application/json")
                .GET();
        if (!token.isBlank()) request.header("Authorization", "Bearer " + token);

        try {
            HttpResponse<String> response = httpClient.send(request.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new RemoteException("ClimaGrid REST returned HTTP " + response.statusCode());
            }
            return response.body();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new RemoteException("Request to ClimaGrid REST was interrupted", error);
        } catch (IOException error) {
            throw new RemoteException("Cannot reach ClimaGrid REST at " + apiBase, error);
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static void validateTimestamp(String value) throws RemoteException {
        if (value == null || value.isBlank()) return;
        try {
            Instant.parse(value);
        } catch (RuntimeException error) {
            throw new RemoteException("from/to must be ISO-8601 timestamps", error);
        }
    }
}
