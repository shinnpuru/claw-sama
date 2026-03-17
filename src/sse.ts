/**
 * SSE client registry and typed broadcast for Claw Sama.
 */
import type { ServerResponse } from "node:http";

const sseClients = new Set<ServerResponse>();

export function addSseClient(res: ServerResponse) {
  sseClients.add(res);
}

export function removeSseClient(res: ServerResponse) {
  sseClients.delete(res);
}

export function getSseClientCount(): number {
  return sseClients.size;
}

export type VrmBroadcastPayload = {
  text?: string;
  emotion?: string;
  emotionIntensity?: number;
  audioUrl?: string;
  audioIndex?: number;
  audioTotal?: number;
  streaming?: boolean;
  clearText?: boolean;
  imageUrl?: string;
  moodDelta?: number;   // mood change amount (±1 to ±3)
  moodIndex?: number;   // new mood value (0–100) after change
};

export function broadcastToVrm(payload: VrmBroadcastPayload) {
  if (sseClients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}
