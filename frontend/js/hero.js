/* NURA hero.js: the homepage slideshow (Oct 2026).

   - It moves on every 5 s.
   - A click or tap anywhere on it (except its links) pauses it, and a play symbol appears
     bottom-right; another click anywhere (the symbol included) carries on. It
     also waits, without counting as paused, while it is scrolled out of view and while the
     browser tab is in the background.
   - It never moves focus. Hidden slides are visibility:hidden (CSS), so their links are out
     of the Tab order and out of the screen reader's way.
   - Slides move right to left: the next one comes in from the right (CSS, .is-leaving here).
   - Reduced motion: it still rotates (there is no other way to reach slides 2-3), but the
     slides swap with no sliding, zoom or slide-in of the text (CSS).
   - No pause button and no pause on hover: the owner's decision (Oct 2026). Click/tap to
     pause covers mouse and touch users for WCAG 2.2.2 (a way to pause anything that moves by
     itself for more than 5 s), but not keyboard users: the hero itself can't be tabbed to.
     A visible button that calls togglePause() would close that gap.

   Which slide is up shows in the main nav (desktop): New In, Women or Men gets an
   underline that fills across in 5 s, while the hero is on screen.

   The timing comes from CSS: an invisible clock element in the hero runs a 5 s animation, and
   its animationend moves the slideshow on. Pausing it (animation-play-state) pauses the
   slideshow at exactly the same point, with no setTimeout to keep in sync. The nav underline
   is a second animation of the same length, started and paused at the same moments. (The
   clock, not the underline, keeps time: the nav links are hidden on phones, and an element
   that isn't displayed never fires animationend.) */
(function () {
  'use strict';
  var hero = document.querySelector('.hero[aria-roledescription="carousel"]');
  if (!hero) return;

  var slides = Array.prototype.slice.call(hero.querySelectorAll('.hero__slide'));
  var clock = hero.querySelector('.hero__clock');
  var playBtn = hero.querySelector('.hero__play');
  var navLists = Array.prototype.slice.call(document.querySelectorAll('.nav__links'));
  // The desktop nav's links underline the section that matches the slide on screen. (Not the
  // phone tab bar: it marks the page you're on, and the homepage is none of its four.)
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav__links [data-hero-slide]'));
  var current = 0;
  var paused = false;     // by the visitor: a click or tap
  var onScreen = true;

  // ---- Showing a slide ----------------------------------------------------------------
  var leaveTimer;
  function show(i) {
    var previous = current;
    current = (i + slides.length) % slides.length;
    // The old slide slides out to the left (.is-leaving), then waits off-screen to the right.
    slides.forEach(function (s) { s.classList.remove('is-leaving'); });
    if (previous !== current && slides[previous]) slides[previous].classList.add('is-leaving');
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(function () {
      slides.forEach(function (s) { s.classList.remove('is-leaving'); });
    }, 800);   // the length of the slide in index.html
    slides.forEach(function (s, n) { s.classList.toggle('is-current', n === current); });
    updateNav();
    restartTimer();
  }

  // The nav underline: only while the hero is on screen. Scrolled past it, the nav goes back
  // to normal (an underline on "Men" while you look at the newsletter would mean nothing).
  function updateNav() {
    navLinks.forEach(function (a) {
      a.classList.toggle('nav-hero-current', onScreen && +a.dataset.heroSlide === current);
    });
  }

  // Restarting both animations: remove the class, force a style flush, add it back.
  function restartTimer() {
    hero.classList.remove('is-playing');
    navLists.forEach(function (l) { l.classList.remove('hero-playing'); });
    void hero.offsetWidth;   // reading layout makes the browser apply the removal first
    hero.classList.add('is-playing');
    navLists.forEach(function (l) { l.classList.add('hero-playing'); });
  }

  // ---- Holding ------------------------------------------------------------------------
  // A hold is temporary: the clock and underline freeze and carry on from the same point.
  function updateHold() {
    var held = paused || !onScreen || document.hidden;
    hero.classList.toggle('is-held', held);
    navLists.forEach(function (l) { l.classList.toggle('hero-held', held); });
  }

  clock.addEventListener('animationend', function (e) {
    if (e.animationName === 'heroTimer') show(current + 1);
  });

  function togglePause() {
    paused = !paused;
    hero.classList.toggle('is-paused', paused);
    playBtn.hidden = !paused;   // the play symbol, bottom-right, only while paused
    updateHold();
  }
  // A click on a link ("Shop now") is a click on the link, not a pause. The play button is
  // inside the hero, so its click lands here too and plays like any other click.
  hero.addEventListener('click', function (e) {
    if (!e.target.closest('a')) togglePause();
  });
  document.addEventListener('visibilitychange', updateHold);

  // On screen = at least a fifth of the hero showing.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      updateHold(); updateNav();
    }, { threshold: 0.2 }).observe(hero);
  }

  // ---- The other photos: loaded after the page, so they never slow the first one --------
  function loadOtherPhotos() {
    hero.querySelectorAll('img[data-srcset]').forEach(function (img) {
      img.srcset = img.dataset.srcset;
      img.removeAttribute('data-srcset');
    });
  }
  if (document.readyState === 'complete') loadOtherPhotos();
  else window.addEventListener('load', loadOtherPhotos);

  // ---- Start ---------------------------------------------------------------------------
  show(0);
})();
