export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
}

/** External Email Service boundary (SES / Resend / SMTP can implement this later). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class LogEmailSender implements EmailSender {
  constructor(private readonly log: { info: (obj: unknown, msg?: string) => void }) {}
  async send(message: EmailMessage): Promise<void> {
    this.log.info({ to: message.to, subject: message.subject }, 'email (not actually sent: LogEmailSender)');
  }
}
