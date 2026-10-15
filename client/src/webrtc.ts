import {
  importPublicKeyBase64,
  wrapSessionKey,
  unwrapSessionKey,
  encryptText,
  decryptText,
} from './crypto';
import type { User, PeerStatus } from './types';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

type SignalOut =
  | { type: 'join'; id: string; name: string; publicKey: string }
  | { type: 'offer'; to: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'answer'; to: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'ice-candidate'; to: string; payload: { candidate: RTCIceCandidateInit } };

type SignalIn =
  | { type: 'joined'; id: string; name: string }
  | { type: 'left'; id: string; name: string }
  | { type: 'users'; users: User[] }
  | { type: 'offer'; from: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'answer'; from: string; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'ice-candidate'; from: string; payload: { candidate: RTCIceCandidateInit } };

export class PeerManager {
  private ws: WebSocket | null = null;
  private myId = '';
  private myName = '';
  private myKeyPair: CryptoKeyPair | null = null;

  private pcs = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private sessionKeys = new Map<string, CryptoKey>();
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private statuses = new Map<string, PeerStatus>();
  private userNames = new Map<string, string>();
  private peerPublicKeys = new Map<string, CryptoKey>();

  private onUserList?: (users: User[]) => void;
  private onPeerStatus?: (id: string, status: PeerStatus) => void;
  private onPeerMessage?: (fromId: string, fromName: string, text: string) => void;
  private onError?: (msg: string) => void;

  connect(signalingUrl: string) {
    this.ws = new WebSocket(signalingUrl);

    this.ws.onopen = () => {
      if (!this.myKeyPair || !this.myId) return;
      this.ws!.send(
        JSON.stringify({
          type: 'join',
          id: this.myId,
          name: this.myName,
          publicKey: '',
        } as SignalOut)
      );
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as SignalIn;
      switch (msg.type) {
        case 'joined':
          this.userNames.set(msg.id, msg.name);
          this.setStatus(msg.id, 'connected');
          if (this.onUserList)
            this.onUserList(
              Array.from(this.userNames.entries()).map(([id, name]) => ({
                id,
                name,
                publicKey: null,
              }))
            );
          break;

        case 'left':
          this.userNames.delete(msg.id);
          this.closePeer(msg.id);
          this.setStatus(msg.id, 'disconnected');
          if (this.onUserList)
            this.onUserList(
              Array.from(this.userNames.entries()).map(([id, name]) => ({
                id,
                name,
                publicKey: null,
              }))
            );
          break;

        case 'users': {
          const users = msg.users as User[];
          users.forEach((u) => this.userNames.set(u.id, u.name));
          if (this.onUserList) this.onUserList(users);
          break;
        }

        case 'offer': {
          this.handleOffer(msg.from, msg.payload.sdp);
          break;
        }

        case 'answer': {
          this.handleAnswer(msg.from, msg.payload.sdp);
          break;
        }

        case 'ice-candidate': {
          this.addRemoteCandidate(msg.from, msg.payload.candidate);
          break;
        }
      }
    };

    this.ws.onclose = () => {
      this.pcs.forEach((pc) => pc.close());
      this.pcs.clear();
      this.channels.clear();
      this.sessionKeys.clear();
      this.peerPublicKeys.clear();
      this.pendingCandidates.clear();
      this.statuses.clear();
      if (this.onUserList) this.onUserList([]);
    };
  }

  init(myId: string, myName: string) {
    this.myId = myId;
    this.myName = myName;
  }

  setKeyPair(pair: CryptoKeyPair) {
    this.myKeyPair = pair;
  }

  setCallbacks(opts: {
    onUserList?: (users: User[]) => void;
    onPeerStatus?: (id: string, status: PeerStatus) => void;
    onPeerMessage?: (fromId: string, fromName: string, text: string) => void;
    onError?: (msg: string) => void;
  }) {
    this.onUserList = opts.onUserList;
    this.onPeerStatus = opts.onPeerStatus;
    this.onPeerMessage = opts.onPeerMessage;
    this.onError = opts.onError;
  }

  private setStatus(id: string, status: PeerStatus) {
    this.statuses.set(id, status);
    this.onPeerStatus?.(id, status);
  }

  private getStatus(id: string): PeerStatus {
    return this.statuses.get(id) ?? 'idle';
  }

  async call(targetId: string) {
    if (!this.myKeyPair) return;
    if (this.pcs.has(targetId)) return;

    this.setStatus(targetId, 'calling');

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    this.pcs.set(targetId, pc);

    const dc = pc.createDataChannel('chat', { ordered: true });
    this.channels.set(targetId, dc);
    this.setupDataChannel(targetId, dc);

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        this.ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            to: targetId,
            payload: { candidate: event.candidate.toJSON() },
          } as SignalOut)
        );
      }
    };

    pc.ondatachannel = (event) => {
      const remoteDc = event.channel;
      this.channels.set(targetId, remoteDc);
      this.setupDataChannel(targetId, remoteDc);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.setStatus(targetId, 'connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.setStatus(targetId, 'disconnected');
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.ws) {
        this.ws.send(
          JSON.stringify({
            type: 'offer',
            to: targetId,
            payload: { sdp: offer },
          } as SignalOut)
        );
      }
    } catch (err) {
      console.error('Failed to create offer', err);
      this.onError?.('Failed to start call');
      this.closePeer(targetId);
    }
  }

  public handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    return this._handleOffer(fromId, sdp);
  }

  public handleAnswer(fromId: string, sdp: RTCSessionDescriptionInit) {
    return this._handleAnswer(fromId, sdp);
  }

  public addRemoteCandidate(fromId: string, candidate: RTCIceCandidateInit) {
    return this._addRemoteCandidate(fromId, candidate);
  }

  private async _handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    if (!this.myKeyPair) return;
    if (this.pcs.has(fromId)) return;

    this.setStatus(fromId, 'calling');

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    this.pcs.set(fromId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        this.ws.send(
          JSON.stringify({
            type: 'ice-candidate',
            to: fromId,
            payload: { candidate: event.candidate.toJSON() },
          } as SignalOut)
        );
      }
    };

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      this.channels.set(fromId, dc);
      this.setupDataChannel(fromId, dc);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.setStatus(fromId, 'connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.setStatus(fromId, 'disconnected');
      }
    };

    try {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (this.ws) {
        this.ws.send(
          JSON.stringify({
            type: 'answer',
            to: fromId,
            payload: { sdp: answer },
          } as SignalOut)
        );
      }
    } catch (err) {
      console.error('Failed to handle offer', err);
      this.closePeer(fromId);
    }
  }

  private async _handleAnswer(fromId: string, sdp: RTCSessionDescriptionInit) {
    const pc = this.pcs.get(fromId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
    } catch (err) {
      console.error('Failed to set remote answer', err);
    }
  }

  private async _addRemoteCandidate(fromId: string, candidate: RTCIceCandidateInit) {
    const pc = this.pcs.get(fromId);
    if (!pc) {
      const q = this.pendingCandidates.get(fromId) ?? [];
      q.push(candidate);
      this.pendingCandidates.set(fromId, q);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      // ignore invalid candidates
    }
  }

  private setupDataChannel(targetId: string, dc: RTCDataChannel) {
    dc.onopen = () => {
      this.setStatus(targetId, 'connected');
      const q = this.pendingCandidates.get(targetId);
      if (q) {
        q.forEach((c) => {
          const pc = this.pcs.get(targetId);
          if (pc) pc.addIceCandidate(c).catch(() => {});
        });
        this.pendingCandidates.delete(targetId);
      }
    };

    dc.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data as string);

        // First message: RSA-2048 wrapped AES-256 session key
        if (data.type === 'session-key' && data.wrappedKey && this.myKeyPair) {
          const key = await unwrapSessionKey(this.myKeyPair.privateKey, data.wrappedKey);
          this.sessionKeys.set(targetId, key);
          return;
        }

        // Regular encrypted message: AES-256-GCM
        const key = this.sessionKeys.get(targetId);
        if (!key) return;

        const text = await decryptText(key, data.iv, data.ciphertext);
        const peerName = this.userNames.get(targetId) ?? 'Unknown';
        this.onPeerMessage?.(targetId, peerName, text);
      } catch {
        // Ignore undecryptable / malformed messages
      }
    };

    dc.onclose = () => {
      this.setStatus(targetId, 'disconnected');
    };

    dc.onerror = () => {
      this.setStatus(targetId, 'disconnected');
    };
  }

  /** Store a peer's RSA-2048 public key (imported from base64 JWK). */
  setPeerPublicKey(targetId: string, publicKeyB64: string) {
    if (!this.myKeyPair) return;
    (async () => {
      const key = await importPublicKeyBase64(publicKeyB64);
      this.peerPublicKeys.set(targetId, key);
    })();
  }

  async send(targetId: string, plaintext: string) {
    const dc = this.channels.get(targetId);
    if (!dc || dc.readyState !== 'open') {
      throw new Error(`DataChannel to ${targetId} not open`);
    }

    // Lazily create and exchange an AES-256 session key wrapped with RSA-2048 OAEP
    let key = this.sessionKeys.get(targetId);
    if (!key) {
      const peerPub = this.peerPublicKeys.get(targetId);
      if (!peerPub) throw new Error(`No public key for ${targetId}`);
      const { wrappedKey, sessionKey } = await wrapSessionKey(peerPub as CryptoKey);
      this.sessionKeys.set(targetId, sessionKey);
      dc.send(JSON.stringify({ type: 'session-key', wrappedKey }));
      key = sessionKey as CryptoKey;
    }

    if (!key) throw new Error(`No session key for ${targetId}`);
    const { iv, ciphertext } = await encryptText(key, plaintext);
    dc.send(JSON.stringify({ iv, ciphertext }));
  }

  closePeer(targetId: string) {
    const pc = this.pcs.get(targetId);
    if (pc) {
      pc.close();
      this.pcs.delete(targetId);
    }
    this.channels.delete(targetId);
    this.sessionKeys.delete(targetId);
    this.peerPublicKeys.delete(targetId);
    this.pendingCandidates.delete(targetId);
    this.setStatus(targetId, 'disconnected');
  }

  disconnect() {
    this.pcs.forEach((pc) => pc.close());
    this.pcs.clear();
    this.channels.clear();
    this.sessionKeys.clear();
    this.peerPublicKeys.clear();
    this.pendingCandidates.clear();
    this.statuses.clear();
    this.ws?.close();
    this.ws = null;
  }

  getStatusFor(id: string): PeerStatus {
    return this.getStatus(id);
  }
}
