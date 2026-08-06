const OPEN_RE = /<think\s*>/i;
const CLOSE_RE = /<\/think\s*>/i;
const PARTIAL_OPEN_RE = /^<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?\s*$/i;
const PARTIAL_CLOSE_RE = /^<(?:\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?)?\s*$/i;

function holdbackLen(text: string, partialRe: RegExp): number {
  for (let i = Math.min(16, text.length); i > 0; i--) {
    if (partialRe.test(text.slice(-i))) return i;
  }
  return 0;
}

export class ThinkStripper {
  private inThink = false;
  private carry = "";

  feed(chunk: string): string {
    if (!chunk) return "";
    this.carry += chunk;
    let out = "";
    for (;;) {
      if (!this.inThink) {
        const m = OPEN_RE.exec(this.carry);
        if (m) {
          out += this.carry.slice(0, m.index);
          this.carry = this.carry.slice(m.index + m[0].length);
          this.inThink = true;
          continue;
        }
        const hold = holdbackLen(this.carry, PARTIAL_OPEN_RE);
        out += this.carry.slice(0, this.carry.length - hold);
        this.carry = this.carry.slice(this.carry.length - hold);
        break;
      }
      const m = CLOSE_RE.exec(this.carry);
      if (m) {
        this.carry = this.carry.slice(m.index + m[0].length);
        this.inThink = false;
        continue;
      }
      const hold = holdbackLen(this.carry, PARTIAL_CLOSE_RE);
      this.carry = this.carry.slice(this.carry.length - hold);
      break;
    }
    return out;
  }

  finish(): string {
    const rest = this.inThink ? "" : this.carry;
    this.carry = "";
    this.inThink = false;
    return rest;
  }
}

export function stripThinking(text: string): string {
  const stripper = new ThinkStripper();
  return stripper.feed(text) + stripper.finish();
}
