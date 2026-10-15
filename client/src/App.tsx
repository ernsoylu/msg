import React, { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import { generateKeyPair, exportPublicKeyBase64 } from './crypto';
import { PeerManager } from './webrtc';
import type { User, Message, PeerStatus } from './types';

const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:3001';

function conversationId(a: string, b: string): string {
  return [a, b].sort().join(':');
}

export default function App() {
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [myKeyPair, setMyKeyPair] = useState<CryptoKeyPair | null>(null);
  const [myId, setMyId] = useState<string>('');
  const [myName, setMyName] = useState<string>('');
  const [users, setUsers] = useState<User[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'connecting' | 'ready' | 'disconnected'>('connecting');

  const myIdRef = useRef(myId);
  const myNameRef = useRef(myName);
  const myKeyPairRef = useRef(myKeyPair);
  const selectedIdRef = useRef(selectedId);
  myIdRef.current = myId;
  myNameRef.current = myName;
  myKeyPairRef.current = myKeyPair;
  selectedIdRef.current = selectedId;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const peerManagerRef = useRef<PeerManager | null>(null);

  useEffect(() => {
    const el = messagesEndRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, selectedId]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const pair = await generateKeyPair();
      if (cancelled) return;
      const pubB64 = await exportPublicKeyBase64(pair.publicKey);
      if (cancelled) return;
      setMyKeyPair(pair);
      myKeyPairRef.current = pair;

      const id = crypto.randomUUID();
      const name = await generateRandomName();
      setMyId(id);
      setMyName(name);
      myIdRef.current = id;
      myNameRef.current = name;

      const socket = new WebSocket(SIGNALING_URL);
      const pm = new PeerManager();
      pm.init(id, name);
      pm.setKeyPair(pair);
      peerManagerRef.current = pm;

      pm.setCallbacks({
        onUserList: (userList) => {
          // Merge public keys from signaling user list
          setUsers(userList);
        },
        onPeerStatus: (id, peerStatus) => {
          setUsers((prev) =>
            prev.map((u) => (u.id === id ? { ...u, status: peerStatus } : u))
          );
        },
        onPeerMessage: (fromId, fromName, text) => {
          const m: Message = {
            id: `p2p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            conversationId: conversationId(id, fromId),
            from: fromId,
            fromName,
            to: id,
            text,
            encrypted: true,
            timestamp: Date.now(),
            mine: false,
            status: 'delivered',
          };
          setMessages((prev) => [...prev, m]);
        },
        onError: (msg) => {
          console.warn(msg);
        },
      });

      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: 'join', id, name, publicKey: pubB64 })
        );
        setStatus('ready');
        setWs(socket);
      };

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'joined':
            if (msg.self) {
              setMyId(msg.id);
              setMyName(msg.name);
              myIdRef.current = msg.id;
              myNameRef.current = msg.name;
            } else {
              // Another user came online
              setUsers((prev) =>
                prev.find((u) => u.id === msg.id) ? prev : [...prev, msg]
              );
            }
            break;

          case 'left':
            setUsers((prev) => prev.filter((u) => u.id !== msg.id));
            if (selectedIdRef.current === msg.id) {
              setMessages([]);
              setSelectedId(null);
              selectedIdRef.current = null;
              pm.closePeer(msg.id);
            }
            break;

          case 'users': {
            const userList = msg.users as User[];
            setUsers(userList);
            userList.forEach((u) => {
              if (u.publicKey) pm.setPeerPublicKey(u.id, u.publicKey);
            });
            break;
          }

          case 'offer': {
            const from = msg.from as string;
            const sdp = msg.payload?.sdp;
            pm.handleOffer(from, sdp);
            break;
          }

          case 'answer': {
            const from = msg.from as string;
            const sdp = msg.payload?.sdp;
            pm.handleAnswer(from, sdp);
            break;
          }

          case 'ice-candidate': {
            const from = msg.from as string;
            const candidate = msg.payload?.candidate;
            pm.addRemoteCandidate(from, candidate);
            break;
          }
        }
      };

      socket.onclose = () => {
        if (!cancelled) setStatus('disconnected');
        setWs(null);
        pm.disconnect();
      };
      socket.onerror = () => {
        if (!cancelled) setStatus('disconnected');
      };
    }

    bootstrap();
    return () => {
      cancelled = true;
      ws?.close();
      peerManagerRef.current?.disconnect();
    };
  }, []);

  // Generate a random blockchain-style name (3-5 words)
  async function generateRandomName(): Promise<string> {
    const WORDS = [
      'satoshi', 'nakamoto', 'bitcoin', 'blockchain', 'wallet', 'ledger', 'seed',
      'phrase', 'private', 'key', 'public', 'address', 'hash', 'nonce', 'block',
      'chain', 'node', 'mining', 'consensus', 'token', 'coin', 'crypto', 'vault',
      'secure', 'cold', 'hot', 'sign', 'verify', 'mint', 'burn', 'stake',
      'delegate', 'validator', 'gas', 'fee', 'wei', 'gwei', 'sat', 'oracle',
      'bridge', 'swap', 'pool', 'liquidity', 'yield', 'farm', 'dao',
    ];
    const shuffled = [...WORDS].sort(() => 0.5 - Math.random());
    const count = 3 + Math.floor(Math.random() * 3);
    return shuffled
      .slice(0, count)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  const handleStartCall = useCallback(
    (targetId: string) => {
      if (!peerManagerRef.current) return;
      if (targetId === myId) return; // cannot call yourself
      setSelectedId(targetId);
      selectedIdRef.current = targetId;
      peerManagerRef.current.call(targetId);
    },
    [users, myId]
  );

  const handleSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const text = input.trim();
      if (!text || !selectedId || !ws || ws.readyState !== WebSocket.OPEN) return;

      const pm = peerManagerRef.current;
      if (!pm) return;

      try {
        await pm.send(selectedId, text);

        const convo = conversationId(myId, selectedId);
        const optimistic: Message = {
          id: `local-${Date.now()}`,
          conversationId: convo,
          from: myId,
          fromName: myName,
          to: selectedId,
          text,
          encrypted: true,
          timestamp: Date.now(),
          mine: true,
          status: 'sent',
        };

        setMessages((prev) => [...prev, optimistic]);
        setInput('');
      } catch (err) {
        alert('Unable to send — is the peer connected?');
      }
    },
    [input, selectedId, ws, myId, myName]
  );

  const peer = users.find((u) => u.id === selectedId);
  const convoId = selectedId ? conversationId(myId, selectedId) : null;
  const visible = convoId ? messages.filter((m) => m.conversationId === convoId) : [];
  const peerStatus = peer?.status ?? 'idle';
  const isConnected = peerStatus === 'connected';

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">CIPHERP2P</div>
        <div className="meta">
          <span className={`indicator ${status === 'ready' ? 'online' : ''}`} aria-hidden="true" />
          <span>
            You are{' '}
            <b style={{ color: '#66fcf1' }}>{myName || '…'}</b>
            {myId && <span style={{ color: '#666', fontSize: '11px' }}>({myId.slice(0, 8)}…)</span>}
          </span>
          <span className="e2e">Peer-to-peer • E2E encrypted</span>
        </div>
        <div className="count">Online: {users.length}</div>
      </header>

      <div className="split">
        <aside className="panel users">
          <h2>Online Users</h2>
          <ul>
            {users.map((u) => (
              <li
                key={u.id}
                className={selectedId === u.id ? 'active' : ''}
                onClick={() => handleStartCall(u.id)}
                title={u.id === myId ? 'Your session' : 'Start peer-to-peer chat'}
              >
                <span className="dot" aria-hidden="true" />
                <span className="online-tag">
                  {peerStatusFor(u.id) === 'connected' ? 'Connected' : 'Online'}
                </span>
                {u.name}
                {u.id === myId && (
                  <span style={{ color: '#888', fontSize: '12px' }}> (you)</span>
                )}
              </li>
            ))}
            {users.length === 0 && (
              <li style={{ color: '#666', cursor: 'default' }}>No other users online</li>
            )}
          </ul>
          <p className="hint">
            Tap an online user to open a direct WebRTC peer-to-peer chat.
          </p>
        </aside>

        <section className="panel chat">
          {!selectedId || !peer ? (
            <div className="empty">
              <div style={{ fontSize: 16, marginBottom: 6 }}>No conversation selected</div>
              <div style={{ color: '#777', fontSize: 13 }}>
                Pick an online user to start a direct peer-to-peer chat.
              </div>
            </div>
          ) : (
            <>
              <div className="chat-header">
                <div>
                  <div className="peer-name">{peer.name}</div>
                  <div className="peer-status">
                    {peerStatus === 'connected' ? (
                      <span style={{ color: '#2ecc71', fontWeight: 700 }}>
                        🔗 Direct P2P connection active
                      </span>
                    ) : peerStatus === 'calling' ? (
                      <span style={{ color: '#f1c40f' }}>📞 Connecting…</span>
                    ) : (
                      <span style={{ color: '#888' }}>Click to connect</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="messages">
                {visible.map((m) => (
                  <div key={m.id} className={`bubble ${m.mine ? 'mine' : 'theirs'}`}>
                    <div className="text">{m.text}</div>
                    <span className="meta">
                      {m.mine ? 'Sent (P2P encrypted)' : 'Received via WebRTC'}&nbsp;•&nbsp;
                      {new Date(m.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              <form className="composer" onSubmit={handleSend}>
                <input
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a message…"
                  disabled={!isConnected}
                />
                <button type="submit" disabled={!isConnected}>
                  Send
                </button>
              </form>
              {!isConnected && (
                <div className="connecting-note">
                  Establishing direct WebRTC connection… this may take a few seconds.
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <footer className="bar">
        <small>
          ⚠ Ephemeral: no server stores messages. Everything lives in RAM and is gone when
          this window closes. WebRTC connections are direct browser-to-browser.
        </small>
      </footer>
    </div>
  );

  function peerStatusFor(id: string): PeerStatus {
    const u = users.find((x) => x.id === id);
    return u?.status ?? 'idle';
  }
}
