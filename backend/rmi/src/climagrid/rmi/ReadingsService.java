package climagrid.rmi;

import java.rmi.Remote;
import java.rmi.RemoteException;

public interface ReadingsService extends Remote {
    String getReadings(String stationId, String from, String to) throws RemoteException;
}
