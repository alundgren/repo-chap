import type { ReplayResult } from '@repo-chap/workflow';
import { previewPacket, validatePacket } from './render.js';
import { SlackError, type DecisionPacket, type PacketPreview, type SlackConfiguration } from './types.js';

export interface ReplayHandoffPreview { actionId: string; packet: DecisionPacket; preview: PacketPreview }
/** Render supplied fictional packet context only for the head/outcome actually proposed by replay. */
export function previewReplayHandoffs(result: ReplayResult, input: readonly DecisionPacket[], config?: SlackConfiguration): ReplayHandoffPreview[] {
  const packets = input.map(validatePacket);
  return result.proposedEffects.filter(effect => effect.uses === 'human.publish_packet' && effect.outcome).map(effect => {
    if (!effect.headSha) throw new SlackError('A rendered replay handoff requires an exact head in its fixture observation.');
    const matches = packets.filter(packet => packet.headSha === effect.headSha && packet.outcome === effect.outcome);
    if (matches.length !== 1) throw new SlackError(`Supply exactly one packet for replay head ${effect.headSha} and outcome ${effect.outcome}.`);
    const packet = matches[0]!;
    return { actionId: effect.actionId, packet, preview: previewPacket(packet, config) };
  });
}
