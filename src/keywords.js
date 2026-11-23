// @ts-check

/**
 * MessageOS answers these words itself, for every agent: it records the opt out or opt in, and it sends the
 * confirmation or the help text. Your webhook still receives each one as `reply.received`, so this app has to
 * know them and stay silent. An answer from here would be a second reply to a person who just asked to stop.
 *
 * The match is on the whole message: trimmed, any case, with a final period or exclamation mark ignored.
 * "stop" is a keyword. "please stop by tomorrow" is not.
 *
 * YES is not on this list. MessageOS reads it as an opt in only from a person who has opted out, and this app
 * keeps no record of who has. From anyone else it is an ordinary answer.
 */
const OPT_OUT = ['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt out'];
const OPT_IN = ['start', 'unstop', 'join', 'subscribe'];
const HELP = ['help', 'info'];

const KEYWORDS = new Set([...OPT_OUT, ...OPT_IN, ...HELP]);

/**
 * True when MessageOS answers this message itself.
 *
 * @param {string | null | undefined} text What the person typed, or the label of the button they tapped.
 */
export function isKeyword(text) {
  const normalized = (text ?? '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  return KEYWORDS.has(normalized);
}
