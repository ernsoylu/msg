export type User = {
  id: string;
  name: string;
  publicKey: string | null; // base64-encoded ECDH P-256 public key
  status?: PeerStatus;
};

export type Message = {
  id: string;
  conversationId: string;
  from: string;
  fromName: string;
  to: string;
  text: string; // plaintext, in memory only
  encrypted: boolean;
  timestamp: number;
  mine: boolean;
  status: 'sent' | 'delivered';
};

export type PeerStatus = 'idle' | 'calling' | 'connected' | 'disconnected';
