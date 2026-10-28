import argon2 from 'argon2';

// OWASP's Argon2id minimum: 19 MiB, two passes, one lane.
export const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password) => argon2.hash(password, ARGON_OPTIONS);

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length < 1 || parts[0].length > 64) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 8 && [...value].length <= 128;
}

export function normalizeFullName(value) {
  if (typeof value !== 'string') return null;
  const fullName = value.trim();
  const length = [...fullName].length;
  return length >= 1 && length <= 100 ? fullName : null;
}
