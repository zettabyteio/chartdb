import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChartDB } from '@/hooks/use-chartdb';
import { useStorage } from '@/hooks/use-storage';
import { connectBridge } from './bridge-client';
import { MCP_BRIDGE_TOKEN, MCP_BRIDGE_URL } from './bridge-config';
import { createHandlers } from './handlers';
import { createLiveGateway } from './live-gateway';

/** Connects this tab to the local MCP bridge server (dev only; see bridge-config). */
export const useMcpBridge = (): void => {
    const chartdb = useChartDB();
    const storage = useStorage();
    const navigate = useNavigate();

    // Context values change identity on every render; the connection must not.
    const latest = useRef({ chartdb, storage, navigate });
    latest.current = { chartdb, storage, navigate };

    useEffect(() => {
        if (!MCP_BRIDGE_URL) {
            return;
        }

        const gateway = createLiveGateway({
            getCurrent: () => ({
                diagram: latest.current.chartdb.currentDiagram,
                readonly: !!latest.current.chartdb.readonly,
            }),
            storage: {
                listDiagrams: (options) =>
                    latest.current.storage.listDiagrams(options),
                getDiagram: (id, options) =>
                    latest.current.storage.getDiagram(id, options),
                addDiagram: (params) =>
                    latest.current.storage.addDiagram(params),
                deleteDiagram: (id) => latest.current.storage.deleteDiagram(id),
            },
            updateDiagramData: (diagram, options) =>
                latest.current.chartdb.updateDiagramData(diagram, options),
            deleteCurrentDiagram: () => latest.current.chartdb.deleteDiagram(),
            // Leave the route only after the reply has been sent: navigating
            // remounts the page, whose cleanup closes the socket.
            onCurrentDeleted: () => {
                setTimeout(() => latest.current.navigate('/'), 250);
            },
        });

        return connectBridge({
            url: MCP_BRIDGE_URL,
            token: MCP_BRIDGE_TOKEN,
            handlers: createHandlers(gateway),
        });
    }, []);
};
