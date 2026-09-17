import { GitHubReadError } from './errors.js';

export async function responseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new GitHubReadError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > maximum) { await reader.cancel(); throw new GitHubReadError('limit'); }
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { reader.releaseLock(); }
}
