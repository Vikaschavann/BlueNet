export class WebSocketClient {
    constructor(url, onMessage) {
        this.url = url;
        this.onMessage = onMessage;
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 2000; // 2 seconds
        this.isConnected = false;
        this.isConnecting = false;
        this.manualDisconnect = false;
    }

    connect() {
        if (this.isConnecting || (this.socket && this.socket.readyState === WebSocket.OPEN)) {
            console.log('[WS] Already connecting or connected');
            return Promise.resolve();
        }

        this.isConnecting = true;
        this.manualDisconnect = false;

        return new Promise((resolve, reject) => {
            console.log(`[WS] Connecting to ${this.url}...`);

            try {
                this.socket = new WebSocket(this.url);

                this.socket.onopen = () => {
                    console.log('[WS] Connected successfully');
                    this.isConnected = true;
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    resolve();
                };

                this.socket.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this.onMessage(data);
                    } catch (err) {
                        console.error('[WS] Failed to parse message:', err);
                    }
                };

                this.socket.onclose = (event) => {
                    this.isConnected = false;
                    this.isConnecting = false;

                    if (this.manualDisconnect) {
                        console.log('[WS] Manual disconnect initiated');
                    } else {
                        console.warn(`[WS] Disconnected (Code: ${event.code})`);
                        // Slow down reconnection if it's a server-side error (1011)
                        const delay = event.code === 1011 ? 5000 : 2000;
                        this.attemptReconnect(delay);
                    }
                };

                this.socket.onerror = (error) => {
                    console.error('[WS] Connection error:', error);
                    this.isConnecting = false;
                    this.isConnected = false;
                    // Promise might already be resolved/rejected, but we handle it
                    if (this.reconnectAttempts === 0) reject(error);
                };
            } catch (err) {
                this.isConnecting = false;
                console.error('[WS] Creation error:', err);
                reject(err);
            }
        });
    }

    attemptReconnect(customDelay) {
        if (this.manualDisconnect) return;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = customDelay || (this.reconnectDelay * Math.min(this.reconnectAttempts, 5));
            console.log(`[WS] Reconnecting in ${delay}ms... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        } else {
            console.error('[WS] Max reconnect attempts reached');
        }
    }

    send(type, data) {
        // Strict check: Only send if socket is actually OPEN
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify({ type, data }));
            } catch (err) {
                console.error('[WS] Send failed:', err);
            }
        } else {
            // Log less frequently or use debug to avoid console spamming
            if (this.reconnectAttempts % 5 === 0) {
                console.debug('[WS] Skipping frame: Socket not open');
            }
        }
    }

    disconnect() {
        console.log('[WS] Manual disconnect initiated');
        this.manualDisconnect = true;
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        this.isConnected = false;
        this.isConnecting = false;
    }
}
