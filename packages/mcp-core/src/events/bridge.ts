import { request } from 'node:http';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { EventBridge } from './contract.js';

export function createEventBridge(socketPath: string, owner: string): EventBridge {
  return {
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ owner, method, params });
        const req = request(
          {
            socketPath,
            path: '/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30_000),
          },
          (res) => {
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
              if (Buffer.byteLength(text) > 262_144) res.destroy();
            });
            res.on('error', () =>
              reject(new ProtocolError(-32603, 'Events worker response failed')),
            );
            res.on('end', () => {
              try {
                const value = JSON.parse(text);
                if (value.error)
                  reject(
                    new ProtocolError(value.error.code, value.error.message, value.error.data),
                  );
                else resolve(value.result);
              } catch {
                reject(new ProtocolError(-32603, 'Events worker response failed'));
              }
            });
          },
        );
        req.on('error', () => reject(new ProtocolError(-32603, 'Events worker unavailable')));
        req.end(body);
      }),
  };
}
export function eventBridgeFromConfig(config: Config): EventBridge | undefined {
  const socket = config.MCP_EVENTS_SOCKET;
  const owner = config.MCP_EVENTS_OWNER;
  if (!socket && !owner) return undefined;
  if (!socket?.startsWith('/') || !owner)
    throw new Error('MCP_EVENTS_SOCKET and MCP_EVENTS_OWNER are required together');
  return createEventBridge(socket, owner);
}
