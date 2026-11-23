import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Executor } from '../config/db.js';
import { trackingTokens, type TrackingToken } from '../model/schema.js';

export class TrackingTokenRepository {
  constructor(private readonly db: Database) {}

  async insert(
    values: Pick<TrackingToken, 'tenantId' | 'ticketId' | 'tokenHash' | 'expiresAt' | 'createdBy'>,
    ex: Executor = this.db,
  ): Promise<TrackingToken> {
    const [row] = await ex.insert(trackingTokens).values(values).returning();
    return row!;
  }

  async findByHash(tokenHash: string, ex: Executor = this.db): Promise<TrackingToken | null> {
    const [row] = await ex.select().from(trackingTokens).where(eq(trackingTokens.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  }

  /** The ticket's non-revoked token (it may have expired). */
  async findActive(tenantId: string, ticketId: number, ex: Executor = this.db): Promise<TrackingToken | null> {
    const [row] = await ex
      .select()
      .from(trackingTokens)
      .where(and(eq(trackingTokens.tenantId, tenantId), eq(trackingTokens.ticketId, ticketId), isNull(trackingTokens.revokedAt)))
      .limit(1);
    return row ?? null;
  }

  /** Revokes the ticket's non-revoked token. Returns true when one was revoked. */
  async revokeActive(tenantId: string, ticketId: number, ex: Executor = this.db): Promise<boolean> {
    const rows = await ex
      .update(trackingTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(trackingTokens.tenantId, tenantId), eq(trackingTokens.ticketId, ticketId), isNull(trackingTokens.revokedAt)))
      .returning({ id: trackingTokens.trackingTokenId });
    return rows.length > 0;
  }
}
