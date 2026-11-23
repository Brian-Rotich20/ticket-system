import type { AuthUser } from '../auth/auth-user.js';
import type { TicketRepository } from '../repository/ticket.repository.js';

/** Operational overview of one organization. */
export class DashboardService {
  constructor(private readonly tickets: TicketRepository) {}

  async overview(actor: AuthUser) {
    const [byStatus, workload, recent] = await Promise.all([
      this.tickets.countByStatus(actor.tenantId),
      this.tickets.countOpenByAssignee(actor.tenantId),
      this.tickets.list(actor.tenantId, {}, { limit: 5, offset: 0, sortBy: 'createdAt', order: 'desc' }),
    ]);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return {
      totals: { total, ...byStatus },
      /** Open work (not resolved / closed) per assignee; `unassigned` is the shared queue. */
      assigned: {
        mine: workload.find((w) => w.assigneeId === actor.id)?.total ?? 0,
        unassigned: workload.find((w) => w.assigneeId === null)?.total ?? 0,
        byAssignee: workload
          .filter((w) => w.assigneeId !== null)
          .map((w) => ({ userId: w.assigneeId!, name: w.assigneeName ?? '', open: w.total })),
      },
      recentTickets: recent.items,
    };
  }
}
