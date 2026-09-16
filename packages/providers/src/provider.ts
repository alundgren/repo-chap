import { runClaude } from './claude.js';
import { runCodex } from './codex.js';
import type { ProviderRequest, ProviderResult } from './types.js';

export function runProvider(request: ProviderRequest): Promise<ProviderResult> {
  return request.profile.provider === 'claude' ? runClaude(request) : runCodex(request);
}
