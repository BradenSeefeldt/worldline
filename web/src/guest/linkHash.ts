// Is the address's "#…" a scheduling link? Kept tiny and separate so the page's entry (entry.ts) can ask without
// loading the link code. A link's "#…" is the 65-byte key in base64url (lib/schedwire.ts `linkFragment`) and its first
// byte is the format version (1), so it always starts "A" then one of Q–Z / a–f. The landing page's own anchors
// ("#features") never do. A link cut short when pasted still starts that way, so the guest page can say it's incomplete.
export const LINK_HASH = /^#?\/?A[Q-Za-f][A-Za-z0-9_-]*$/;
export const isLinkHash = (hash: string) => LINK_HASH.test(hash.trim());
