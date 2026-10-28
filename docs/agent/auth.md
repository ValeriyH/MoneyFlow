# Authorization & Security

## Password Hashing
- Passwords are never stored in plain text.
- The browser calculates `passwordHash = SHA-256(password)`.
- The `Users` sheet stores the `passwordHash` or the password itself depends on the bootstrap.

## Login Proof
- To bypass CORS restrictions on custom headers (like `Authorization`), a time-based proof is used.
- Client sends: `proof = SHA-256(passwordHash + timestamp)`.
- Server validates: `SHA-256(StoredPasswordHash + ReceivedTimestamp) == ReceivedProof`.
- `timestamp` has a 60-minute window.

## Brute Force Protection
- The system tracks failed attempts in script properties: `moneyflow.loginAttempts`.
- 5 failed attempts trigger a 15-minute lock.
- Counter is shared across all users (system-wide).
- Lock is checked **before** comparing hashes.
- Error message is identical for all failures: `Невірний логін або пароль` (Incorrect login or password).

## Session & Tokens
- After successful login, the server returns a signed HMAC-SHA256 token (e.g., `sessionToken`).
- The token contains the `login` and `expiresAt`.
- The token is stored in `localStorage.moneyflow.session`.
- Token TTL is defined in `moneyflow.tokenTtlHours` (default 168 hours).
- `moneyflow.tokenSecret` is used for signature verification.
