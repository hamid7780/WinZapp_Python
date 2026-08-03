export interface SessionConfig {
  session: string;
  secretKey?: string;
  phone?: string;
}

export interface WppMessageResponse {
  id: string | { _serialized: string; id: string; fromMe: boolean; remote: string };
  from: string;
  to: string;
  fromMe: boolean;
  type: string;
  body?: string;
  text?: string;
  caption?: string;
  timestamp: number;
  t?: number;
  isStatus?: boolean;
  mimetype?: string;
  deprecatedMms3Url?: string;
  directPath?: string;
  mediaKey?: string;
  filehash?: string;
  size?: number;
  isMedia?: boolean;
}

export interface WppAckEvent {
  id: { _serialized: string } | string;
  ack: number;
  to: string;
}
