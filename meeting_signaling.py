import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Dict, Optional

from fastapi import WebSocket, WebSocketDisconnect


@dataclass
class Client:
    id: str
    ws: WebSocket
    display_name: str = "Guest"
    is_host: bool = False


class MeetingSignalingServer:
    """
    Minimal, production-shaped WebSocket signaling server for WebRTC mesh (2–10 peers).
    - Room membership + host assignment
    - SDP/ICE relaying (offer/answer/candidate)
    - Chat + reactions (broadcast)

    Notes:
    - In-memory state: fine for hackathon/MVP. For scale, move to Redis + stateless workers.
    - WebRTC media is NOT relayed here; only signaling messages.
    """

    def __init__(self):
        self._lock = asyncio.Lock()
        self._rooms: Dict[str, Dict[str, Client]] = {}  # room_id -> client_id -> Client

    async def _send(self, ws: WebSocket, message: dict):
        await ws.send_text(json.dumps(message))

    async def _broadcast(self, room_id: str, message: dict, *, exclude: Optional[str] = None):
        room = self._rooms.get(room_id, {})
        coros = []
        for cid, client in room.items():
            if exclude and cid == exclude:
                continue
            coros.append(self._send(client.ws, message))
        if coros:
            await asyncio.gather(*coros, return_exceptions=True)

    async def handle(self, websocket: WebSocket, room_id: str):
        await websocket.accept()

        client_id = uuid.uuid4().hex
        client: Optional[Client] = None

        async with self._lock:
            room = self._rooms.setdefault(room_id, {})
            is_first = len(room) == 0
            client = Client(id=client_id, ws=websocket, is_host=is_first)
            room[client_id] = client

            peers = [
                {"id": c.id, "displayName": c.display_name, "isHost": c.is_host}
                for c in room.values()
                if c.id != client_id
            ]

        logging.info(f"[ROOM] join room={room_id} client={client_id} host={client.is_host}")

        # Initial room state to the new client
        await self._send(
            websocket,
            {
                "type": "room_joined",
                "data": {
                    "roomId": room_id,
                    "self": {"id": client_id, "isHost": client.is_host, "displayName": client.display_name},
                    "peers": peers,
                },
            },
        )

        # Notify others
        await self._broadcast(
            room_id,
            {
                "type": "peer_joined",
                "data": {"peer": {"id": client_id, "displayName": client.display_name, "isHost": client.is_host}},
            },
            exclude=client_id,
        )

        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue

                mtype = msg.get("type")
                data = msg.get("data") or {}

                if mtype == "set_name":
                    name = str(data.get("displayName") or "Guest")[:48]
                    async with self._lock:
                        room = self._rooms.get(room_id, {})
                        if client_id in room:
                            room[client_id].display_name = name
                    await self._broadcast(
                        room_id,
                        {"type": "peer_updated", "data": {"peer": {"id": client_id, "displayName": name}}},
                        exclude=client_id,
                    )

                elif mtype == "signal":
                    # Relay to a specific peer: { to, payload }
                    to_id = data.get("to")
                    payload = data.get("payload")
                    if not to_id or payload is None:
                        continue
                    async with self._lock:
                        room = self._rooms.get(room_id, {})
                        target = room.get(to_id)
                    if target:
                        await self._send(
                            target.ws,
                            {"type": "signal", "data": {"from": client_id, "payload": payload}},
                        )

                elif mtype == "chat":
                    text = str(data.get("text") or "").strip()
                    if not text:
                        continue
                    await self._broadcast(
                        room_id,
                        {
                            "type": "chat",
                            "data": {"from": client_id, "text": text[:2000]},
                        },
                    )

                elif mtype == "reaction":
                    reaction = str(data.get("reaction") or "")[:32]
                    if not reaction:
                        continue
                    await self._broadcast(
                        room_id,
                        {"type": "reaction", "data": {"from": client_id, "reaction": reaction}},
                    )

                elif mtype == "raise_hand":
                    raised = bool(data.get("raised"))
                    await self._broadcast(
                        room_id,
                        {"type": "raise_hand", "data": {"from": client_id, "raised": raised}},
                    )

        except WebSocketDisconnect:
            pass
        finally:
            # Remove client and potentially reassign host
            became_empty = False
            new_host_id: Optional[str] = None
            async with self._lock:
                room = self._rooms.get(room_id, {})
                if client_id in room:
                    del room[client_id]
                if not room:
                    del self._rooms[room_id]
                    became_empty = True
                else:
                    # If host left, promote the oldest remaining client deterministically (first in dict order)
                    if client and client.is_host:
                        new_host_id = next(iter(room.keys()))
                        room[new_host_id].is_host = True

            logging.info(f"[ROOM] leave room={room_id} client={client_id} empty={became_empty}")

            await self._broadcast(room_id, {"type": "peer_left", "data": {"peerId": client_id}})
            if new_host_id:
                await self._broadcast(room_id, {"type": "host_changed", "data": {"hostId": new_host_id}})

