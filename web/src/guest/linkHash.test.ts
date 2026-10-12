import { describe, expect, it } from 'vitest';
import { isLinkHash } from './linkHash';
import { linkFragment, newLinkKeys } from '../lib/schedwire';

describe('which addresses open the guest page (L1)', () => {
  it('a scheduling link does, and so does one cut short (the page then says it’s incomplete)', () => {
    for (let i = 0; i < 50; i++) {
      const frag = linkFragment(newLinkKeys());
      expect(isLinkHash(`#${frag}`)).toBe(true);
      expect(isLinkHash(`#${frag.slice(0, 40)}`)).toBe(true);
    }
  });
  it('the landing page’s own anchors and the bare address don’t', () => {
    for (const h of ['', '#', '#features', '#landing', '#mac-steps', '#ios-steps', '#/book/abc123']) expect(isLinkHash(h)).toBe(false);
  });
});
