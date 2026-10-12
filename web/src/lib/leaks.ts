// For tests: does a word appear in text as itself — the way leaked plaintext would ("title":"Dentist") — rather than by
// chance inside ciphertext? Base64 / hex runs contain any short letter sequence now and then ("Sam" inside a long
// random string), which made the old "not.toContain" checks fail about once in a few hundred runs.
const RUN = 'A-Za-z0-9+/=_-';
export const leaks = (text: string, word: string) =>
  new RegExp(`(^|[^${RUN}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^${RUN}])`).test(text);
