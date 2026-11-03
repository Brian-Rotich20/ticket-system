export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'FORBIDDEN', message);
  }
}
export class NotFoundError extends AppError {
  constructor(entity: string, id?: number | string) {
    super(404, 'NOT_FOUND', id === undefined ? `${entity} not found` : `${entity} ${id} not found`);
  }
}
export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(409, code, message);
  }
}
export class InvalidStatusTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super(`Invalid status transition: ${from} -> ${to}`, 'INVALID_STATUS_TRANSITION');
  }
}
export class TicketClosedError extends ConflictError {
  constructor(ticketId: number) {
    super(`Ticket ${ticketId} is closed and can no longer be modified`, 'TICKET_CLOSED');
  }
}
export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(413, 'FILE_TOO_LARGE', `File exceeds the maximum size of ${maxBytes} bytes`);
  }
}
export class UnsupportedFileTypeError extends AppError {
  constructor(message: string) {
    super(415, 'UNSUPPORTED_FILE_TYPE', message);
  }
}

/** Postgres error codes may be on the error or wrapped in `cause` (drizzle wraps driver errors). */
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}
export const isUniqueViolation = (err: unknown) => pgErrorCode(err) === '23505';
export const isForeignKeyViolation = (err: unknown) => pgErrorCode(err) === '23503';
