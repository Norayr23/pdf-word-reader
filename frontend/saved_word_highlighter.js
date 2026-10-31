// Marks words from the user's vocabulary wherever they appear in the open book, in any book.
// The CSS Custom Highlight API paints ranges without touching the text-layer DOM, so text
// selection, word expansion and context extraction keep working on unmodified text nodes.

const HIGHLIGHT_NAME = "saved-vocabulary";
// Simple inflections, so a word saved as "increase" also marks "increased" and "increases".
const INFLECTION_SUFFIX_PATTERN = "(?:s|es|ed|d|ing|ly)?";

let savedPhrasePattern = null;

function escapeForRegularExpression(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPhraseForms(vocabularyEntry) {
  const phraseForms = new Set([vocabularyEntry.phrase]);
  // The model also returns the dictionary form ("increased" -> "increase"), which lets the
  // suffix pattern catch the other inflections of the same word.
  for (const analysisOfLanguage of Object.values(vocabularyEntry.analysis || {})) {
    const dictionaryForm = analysisOfLanguage?.core?.phrase;
    if (typeof dictionaryForm === "string" && dictionaryForm.trim()) {
      phraseForms.add(dictionaryForm);
    }
  }
  return [...phraseForms]
    .map((phraseForm) => phraseForm.trim().toLowerCase())
    .filter((phraseForm) => phraseForm.length >= 2);
}

export function setSavedVocabulary(vocabularyEntries) {
  const allPhraseForms = new Set();
  for (const vocabularyEntry of vocabularyEntries) {
    for (const phraseForm of collectPhraseForms(vocabularyEntry)) {
      allPhraseForms.add(phraseForm);
    }
  }
  if (allPhraseForms.size === 0) {
    savedPhrasePattern = null;
    return;
  }
  // Longer phrases first, so "bite the bullet" wins over "bite" when both are saved.
  const alternatives = [...allPhraseForms]
    .sort((firstForm, secondForm) => secondForm.length - firstForm.length)
    .map((phraseForm) => escapeForRegularExpression(phraseForm).replace(/\s+/g, "\\s+") + INFLECTION_SUFFIX_PATTERN);
  savedPhrasePattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

export function refreshSavedWordHighlights(viewerElement) {
  if (!("highlights" in CSS)) {
    return;
  }
  if (!savedPhrasePattern) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  const matchedRanges = [];
  // Only pages currently rendered by PDF.js have a text layer; the rest are covered when
  // their text layer appears and this function runs again.
  for (const textLayerElement of viewerElement.querySelectorAll(".textLayer")) {
    const textWalker = document.createTreeWalker(textLayerElement, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      const textNode = textWalker.currentNode;
      for (const phraseMatch of textNode.data.matchAll(savedPhrasePattern)) {
        const matchedRange = new Range();
        matchedRange.setStart(textNode, phraseMatch.index);
        matchedRange.setEnd(textNode, phraseMatch.index + phraseMatch[0].length);
        matchedRanges.push(matchedRange);
      }
    }
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...matchedRanges));
}
