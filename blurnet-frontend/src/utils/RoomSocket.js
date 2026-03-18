import { WebSocketClient } from './WebSocketClient';

export class RoomSocket {
  constructor({ baseUrl, roomId, onMessage }) {
    const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(roomId)}`;
    this.client = new WebSocketClient(url, onMessage);
  }

  async connect() {
    await this.client.connect();
  }

  disconnect() {
    this.client.disconnect();
  }

  send(type, data) {
    this.client.send(type, data);
  }

  get isConnected() {
    return this.client.isConnected;
  }
}

