#!/usr/bin/env python3

import argparse
import base64
import json
import os
import socket
import struct
import time


def handshake(sock, host, port, path):
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode())

    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = sock.recv(1)
        if not chunk:
            raise RuntimeError("websocket handshake closed while reading headers")
        headers += chunk
        if len(headers) > 1024:
            raise RuntimeError("invalid websocket handshake response")

    status_line = headers.split(b"\r\n", 1)[0]
    if b"101" not in status_line:
        raise RuntimeError(f"handshake failed: {status_line.decode(errors='ignore')}")


def encode_text_frame(text):
    payload = text.encode()
    header = bytearray([0x81])
    if len(payload) <= 125:
        header.append(0x80 | (len(payload) & 0x7F))
    elif len(payload) <= 0xFFFF:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", len(payload)))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", len(payload)))

    mask = os.urandom(4)
    header.extend(mask)
    masked = bytearray(payload)
    for i in range(len(masked)):
        masked[i] ^= mask[i % 4]
    return bytes(header) + bytes(masked)


def parse_frames(buffer):
    if len(buffer) < 2:
        return None, buffer

    b1, b2 = buffer[0], buffer[1]
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F
    idx = 2

    if length == 126:
        if len(buffer) < idx + 2:
            return None, buffer
        length = struct.unpack("!H", buffer[idx : idx + 2])[0]
        idx += 2
    elif length == 127:
        if len(buffer) < idx + 8:
            return None, buffer
        length = struct.unpack("!Q", buffer[idx : idx + 8])[0]
        idx += 8

    if masked:
        if len(buffer) < idx + 4:
            return None, buffer
        mask = buffer[idx : idx + 4]
        idx += 4
    else:
        mask = b""

    if len(buffer) < idx + length:
        return None, buffer

    payload = bytes(buffer[idx : idx + length])
    idx += length

    if masked:
        payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

    return (opcode, payload), buffer[idx:]


def recv_messages(sock, timeout, limit):
    sock.settimeout(timeout)
    messages = []
    buffer = b""
    start = time.time()

    while len(messages) < limit and time.time() - start < timeout:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            break

        if not chunk:
            break

        buffer += chunk
        while True:
            parsed, buffer = parse_frames(buffer)
            if not parsed:
                break

            opcode, payload = parsed
            if opcode == 0x8:
                return messages
            if opcode == 0x9:
                # reply to ping
                hdr = bytearray([0x8A, len(payload)])
                sock.sendall(bytes(hdr) + payload)
                continue
            if opcode != 0x1:
                continue

            text = payload.decode("utf-8", errors="ignore")
            try:
                messages.append(json.loads(text))
            except Exception:
                messages.append({"raw": text})

    return messages


def main():
    parser = argparse.ArgumentParser(description="Smoke check for arcade signaling path.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--path", default="/ws")
    parser.add_argument("--timeout", type=int, default=8)
    args = parser.parse_args()

    try:
        with socket.create_connection((args.host, args.port), timeout=5) as sock:
            handshake(sock, args.host, args.port, args.path)
            initial = recv_messages(sock, timeout=args.timeout, limit=4)
            print(f"initial_messages={len(initial)}")

            games = None
            for msg in initial:
                if msg.get("id") == "games":
                    games = json.loads(msg.get("data", "{}"))
                    break

            if not games:
                raise RuntimeError("signal didn't return games payload")

            worker_id = next(iter(games.keys()))
            sock.sendall(
                encode_text_frame(
                    json.dumps({"id": "joinRoom", "sessionID": worker_id})
                )
            )
            sock.sendall(
                encode_text_frame(
                    json.dumps({"id": "initwebrtc", "sessionID": worker_id})
                )
            )

            followup = recv_messages(sock, timeout=args.timeout, limit=20)
            offer = any(msg.get("id") == "offer" for msg in followup)
            print(f"offer_seen={offer}")

            if not offer:
                raise RuntimeError("no offer from worker after initwebrtc")

    except Exception as exc:
        print(f"[error] {exc}")
        return 1

    print("smoke_check=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
