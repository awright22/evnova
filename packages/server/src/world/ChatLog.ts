/**
 * The recent chat, kept so a captain who has just arrived is not looking at
 * an empty overlay.
 *
 * Memory only, and deliberately so: chat is not a record the world depends
 * on, nothing in the economy reads it, and a restart losing it costs a
 * captain nothing they can measure. Bounded, so a long-running server cannot
 * grow here.
 */

import { CHAT_BACKLOG, type ChatLine } from '@marque/shared';

export class ChatLog {
  /** Global lines, oldest first. */
  private readonly global: ChatLine[] = [];

  /** System lines, per system id, oldest first. */
  private readonly bySystem = new Map<string, ChatLine[]>();

  add(line: ChatLine): void {
    const ring = line.channel === 'global' ? this.global : this.forSystem(line.system);
    ring.push(line);
    if (ring.length > CHAT_BACKLOG) ring.splice(0, ring.length - CHAT_BACKLOG);
  }

  /**
   * What a captain arriving in this system should see: the global chatter and
   * whatever was said here, in the order it was said.
   */
  backlogFor(systemId: string): ChatLine[] {
    const lines = [...this.global, ...(this.bySystem.get(systemId) ?? [])];
    lines.sort((a, b) => a.at - b.at);
    return lines.slice(-CHAT_BACKLOG);
  }

  private forSystem(systemId: string): ChatLine[] {
    const existing = this.bySystem.get(systemId);
    if (existing) return existing;
    const ring: ChatLine[] = [];
    this.bySystem.set(systemId, ring);
    return ring;
  }
}
