

export enum Speaker {
  USER = 'user',
  MODEL = 'model',
  SYSTEM = 'system',
}

export interface ChatMessage {
  id: string;
  speaker: Speaker;
  text: string;
  isPartial?: boolean;
}

export interface VoiceOption {
  name: string;
  displayName: string;
}

export interface SavedTranscriptSession {
  id: string;
  timestamp: number; // Unix timestamp
  messages: ChatMessage[];
}