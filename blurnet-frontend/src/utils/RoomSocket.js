import { WebSocketClient } from './WebSocketClient';

export class RoomSocket {
  constructor({ baseUrl, roomId, name, onMessage }) {
    const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(roomId)}?name=${encodeURIComponent(name || 'Guest')}`;
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

