// When the island shows a card. The island holds a sealed card back (`visibility: hidden`, Island.tsx `showCurrent`) until every one of
// the card's sealed frames has reported it is whole, so for the time that takes (1.3 s on a Mac, 2.3 s on a loaded runner) its window is the
// card's full size and empty. A picture taken then is one flat colour (window row 17, run 45013600847: the picture was 400x236, one
// colour, and the app reported the island's buttons visible 2.3 s after the card arrived). A step looks at what the island drew only once
// the card the SDK's `CardFrames` draws (the element carrying its id) is visible, which it inherits from that hold.

/** A page expression: true when the card's element is on the page and not hidden. */
export const cardShownJs = (cardId: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(`[data-moss-card="${cardId}"]`)});
  return !!el && getComputedStyle(el).visibility === 'visible';
})()`;
