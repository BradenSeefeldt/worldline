// The landing page (book.html → #landing): Download for Mac · Open on iPhone, and the steps after each.
import './landing.css';

const $ = (id: string) => document.getElementById(id);
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // (iPadOS says "Mac")

document.body.classList.add('lp-on');
$('landing')!.hidden = false;
document.querySelectorAll<HTMLElement>('.for-mac').forEach((e) => (e.hidden = ios));
document.querySelectorAll<HTMLElement>('.for-ios').forEach((e) => (e.hidden = !ios));
if (ios) $('ios-steps')!.classList.add('open'); // on an iPhone the Home Screen steps are the point

const panels = ['mac-steps', 'phone-steps', 'ios-steps'];
const show = (id: string) => {
  panels.forEach((p) => $(p)!.classList.toggle('open', p === id));
  $(id)!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
$('dl')!.addEventListener('click', () => show('mac-steps')); // the download itself goes ahead (it's a link)
$('iphone')!.addEventListener('click', () => show('phone-steps'));
$('get-mac')!.addEventListener('click', () => show('mac-steps'));
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
  b.addEventListener('click', () => {
    void navigator.clipboard?.writeText($(b.dataset.copy!)!.textContent ?? '');
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = 'Copy'), 1500);
  }),
);
