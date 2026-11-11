import { randomInt } from "node:crypto";

// 31 characters; no 0 O 1 I L, so a code read aloud or typed from a phone
// screen cannot be mistaken for another.
export const REPLY_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const REPLY_CODE_LENGTH = 5;

// Matches "#" plus exactly REPLY_CODE_LENGTH alphabet characters, case-insensitive,
// not followed by another letter or digit. No g flag: a shared global regex keeps
// lastIndex state between calls. Callers that need every match build their own.
export const REPLY_CODE_PATTERN = new RegExp(
  `#[${REPLY_CODE_ALPHABET}]{${REPLY_CODE_LENGTH}}(?![0-9A-Za-z])`,
  "i",
);

/** A fresh code, stored without the "#" prefix. One CSPRNG draw per character. */
export function newReplyCode(): string {
  let code = "";
  for (let i = 0; i < REPLY_CODE_LENGTH; i++) code += REPLY_CODE_ALPHABET[randomInt(REPLY_CODE_ALPHABET.length)];
  return code;
}
