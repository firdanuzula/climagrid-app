package climagrid.rmi;

import java.io.IOException;
import java.io.Serializable;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.rmi.server.RMIServerSocketFactory;
import java.util.Objects;

final class RmiServerSocketFactory implements RMIServerSocketFactory, Serializable {
    private static final long serialVersionUID = 1L;
    private final String bindHost;

    RmiServerSocketFactory(String bindHost) {
        this.bindHost = bindHost;
    }

    @Override
    public ServerSocket createServerSocket(int port) throws IOException {
        return new ServerSocket(port, 50, InetAddress.getByName(bindHost));
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof RmiServerSocketFactory
                && bindHost.equals(((RmiServerSocketFactory) other).bindHost);
    }

    @Override
    public int hashCode() {
        return Objects.hash(bindHost);
    }
}
