/** Stored notices describe unsupported content; they are not customer text. */
export function isMediaNotice(value: string): boolean {
  return /^\[[^\]\r\n]{1,30} message received — (?:review the media in WhatsApp before replying\.|media cannot be opened here\. Ask the customer for a written description\.)\]$/.test(value);
}
