// The page at the GitHub Pages root (book.html). A scheduling link (https://…/worldline/#…) opens the guest page;
// the bare address shows the landing page. Each loads only its own code.
const isLink = () => window.location.hash.length > 1;

if (isLink()) void import('./guest');
else {
  void import('./landing');
  // a link pasted into this tab's address bar: show it
  window.addEventListener('hashchange', () => isLink() && window.location.reload());
}
