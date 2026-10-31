export const MAXIMUM_WORDS_FOR_PHRASE_ANALYSIS = 4;

const MAXIMUM_PRECEDING_CONTEXT_CHARACTERS = 400;
const MAXIMUM_FOLLOWING_CONTEXT_CHARACTERS = 300;
const SENTENCE_END_PATTERN = /[.!?…]["'”’)\]]*(\s+|$)/g;

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function countWords(text) {
  return normalizeWhitespace(text).split(" ").filter(Boolean).length;
}

export function trimSurroundingPunctuation(text) {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function extractPlainTextFromRange(textRange) {
  const clonedFragment = textRange.cloneContents();
  const collectedTextParts = [];
  // PDF.js marks visual line ends with <br>; without turning them into spaces the last
  // word of one line would be glued to the first word of the next.
  const fragmentWalker = document.createTreeWalker(
    clonedFragment,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  while (fragmentWalker.nextNode()) {
    const currentNode = fragmentWalker.currentNode;
    if (currentNode.nodeType === Node.TEXT_NODE) {
      collectedTextParts.push(currentNode.data);
    } else if (currentNode.nodeName === "BR") {
      collectedTextParts.push(" ");
    }
  }
  return collectedTextParts.join("");
}

export function findStartOfLastSentence(precedingText) {
  let sentenceStartIndex = 0;
  for (const sentenceEndMatch of precedingText.matchAll(SENTENCE_END_PATTERN)) {
    const matchEndIndex = sentenceEndMatch.index + sentenceEndMatch[0].length;
    // A boundary at the very end means the selection itself starts a new sentence.
    sentenceStartIndex = matchEndIndex;
  }
  return sentenceStartIndex;
}

export function findEndOfFirstSentence(followingText) {
  SENTENCE_END_PATTERN.lastIndex = 0;
  const firstSentenceEndMatch = SENTENCE_END_PATTERN.exec(followingText);
  SENTENCE_END_PATTERN.lastIndex = 0;
  if (!firstSentenceEndMatch) {
    return followingText.length;
  }
  return firstSentenceEndMatch.index + firstSentenceEndMatch[0].length;
}

export function buildContextSentence(precedingText, selectedText, followingText) {
  const boundedPrecedingText = precedingText.slice(-MAXIMUM_PRECEDING_CONTEXT_CHARACTERS);
  const boundedFollowingText = followingText.slice(0, MAXIMUM_FOLLOWING_CONTEXT_CHARACTERS);
  const sentenceStart = boundedPrecedingText.slice(findStartOfLastSentence(boundedPrecedingText));
  const sentenceEnd = boundedFollowingText.slice(0, findEndOfFirstSentence(boundedFollowingText));
  return joinLineBreakHyphenation(normalizeWhitespace(sentenceStart + selectedText + sentenceEnd));
}

// Justified book layouts split words across lines ("suc- cessful"); a lowercase letter
// right after "- " is almost always such a split, while real compounds keep no space.
export function joinLineBreakHyphenation(text) {
  return text.replace(/(\p{Ll})- (\p{Ll})/gu, "$1$2");
}

// The context is limited to the page's text layer: a sentence split across two pages
// loses its other half, which is acceptable for disambiguating a word's meaning.
export function extractContextSentence(selectionRange, containerElement) {
  const precedingRange = document.createRange();
  precedingRange.setStart(containerElement, 0);
  precedingRange.setEnd(selectionRange.startContainer, selectionRange.startOffset);

  const followingRange = document.createRange();
  followingRange.setStart(selectionRange.endContainer, selectionRange.endOffset);
  followingRange.setEnd(containerElement, containerElement.childNodes.length);

  return buildContextSentence(
    extractPlainTextFromRange(precedingRange),
    extractPlainTextFromRange(selectionRange),
    extractPlainTextFromRange(followingRange),
  );
}

const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}'’-]/u;

function findWordBounds(text, insideIndex) {
  let wordStart = insideIndex;
  while (wordStart > 0 && WORD_CHARACTER_PATTERN.test(text[wordStart - 1])) {
    wordStart -= 1;
  }
  let wordEnd = insideIndex;
  while (wordEnd < text.length && WORD_CHARACTER_PATTERN.test(text[wordEnd])) {
    wordEnd += 1;
  }
  return { wordStart, wordEnd };
}

// A boundary that cuts a word is resolved by majority: if most of that word is inside the
// selection the word is completed ("countabl" -> "accountable"), otherwise the stray letters
// are dropped. The text layer boxes are a few pixels off the glyphs, so a drag often catches
// the last letter of the previous word ("r" of "for"), which must not pull that word in.
export function expandRangeToWordBoundaries(selectionRange) {
  const adjustedRange = selectionRange.cloneRange();

  const startNode = adjustedRange.startContainer;
  if (startNode.nodeType === Node.TEXT_NODE) {
    const startOffset = adjustedRange.startOffset;
    const startCutsWord =
      startOffset > 0 &&
      startOffset < startNode.data.length &&
      WORD_CHARACTER_PATTERN.test(startNode.data[startOffset]) &&
      WORD_CHARACTER_PATTERN.test(startNode.data[startOffset - 1]);
    if (startCutsWord) {
      const { wordStart, wordEnd } = findWordBounds(startNode.data, startOffset);
      const selectedLength = wordEnd - startOffset;
      const unselectedLength = startOffset - wordStart;
      adjustedRange.setStart(startNode, selectedLength >= unselectedLength ? wordStart : wordEnd);
    }
  }

  const endNode = adjustedRange.endContainer;
  if (endNode.nodeType === Node.TEXT_NODE) {
    const endOffset = adjustedRange.endOffset;
    const endCutsWord =
      endOffset > 0 &&
      endOffset < endNode.data.length &&
      WORD_CHARACTER_PATTERN.test(endNode.data[endOffset - 1]) &&
      WORD_CHARACTER_PATTERN.test(endNode.data[endOffset]);
    if (endCutsWord) {
      const { wordStart, wordEnd } = findWordBounds(endNode.data, endOffset - 1);
      const selectedLength = endOffset - wordStart;
      const unselectedLength = wordEnd - endOffset;
      adjustedRange.setEnd(endNode, selectedLength >= unselectedLength ? wordEnd : wordStart);
    }
  }
  return adjustedRange;
}
