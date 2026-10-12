// The page at the GitHub Pages root (book.html). A scheduling link (https://…/worldline/#…) opens the guest page;
// the bare address — or one of the landing page's own anchors, like "#features" — shows the landing page. Each loads
// only its own code.
import { isLinkHash } from './linkHash';

const isLink = () => isLinkHash(window.location.hash);

if (isLink()) void import('./guest');
else {
  void import('./landing');
  // a link pasted into this tab's address bar: show it
  window.addEventListener('hashchange', () => isLink() && window.location.reload());
}
