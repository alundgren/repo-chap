import type { CompanionCommand, CompanionResponse, CompanionState, InputMode } from '@repo-chap/companion';

export interface CompanionBridge {
  current(): Promise<CompanionState>;
  command(command: CompanionCommand): Promise<CompanionResponse>;
  chooseRepository(): Promise<CompanionResponse | null>;
  chooseInput(mode: InputMode): Promise<CompanionResponse | null>;
  choosePackets(): Promise<CompanionResponse | null>;
  onChange(callback: (state: CompanionState) => void): () => void;
}
