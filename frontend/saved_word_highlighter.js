// Marks words from the user's vocabulary wherever they appear in the open book, in any book.
// The CSS Custom Highlight API paints ranges without touching the text-layer DOM, so text
// selection, word expansion and context extraction keep working on unmodified text nodes.

const HIGHLIGHT_NAME = "saved-vocabulary";
// Simple inflections, so a word saved as "increase" also marks "increased" and "increases".
// Applied to every word of a phrase: "stretch out" must also find "stretched out".
const INFLECTION_SUFFIX_PATTERN = "(?:s|es|ed|d|ing|ly)?";
// PDF.js often puts each word of a justified line into its own element. The text of a whole
// layer is matched as one string, with this marker between elements, so phrases can span
// elements; between words of a phrase any mix of whitespace and markers is accepted.
const NODE_SEPARATOR = "\u0000";
const WORD_GAP_PATTERN = "[\\s\\u0000]+";

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
    .map((phraseForm) =>
      phraseForm
        .split(/\s+/)
        .map((phraseWord) => escapeForRegularExpression(phraseWord) + INFLECTION_SUFFIX_PATTERN)
        .join(WORD_GAP_PATTERN),
    );
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
    const textNodes = [];
    const nodeStartOffsets = [];
    let layerText = "";
    const textWalker = document.createTreeWalker(textLayerElement, NodeFilter.SHOW_TEXT);
    while (textWalker.nextNode()) {
      nodeStartOffsets.push(layerText.length);
      textNodes.push(textWalker.currentNode);
      layerText += textWalker.currentNode.data + NODE_SEPARATOR;
    }
    // Maps a position in the joined layer text back to its text node and offset.
    const locatePosition = (layerOffset, isEndPosition) => {
      let nodeIndex = nodeStartOffsets.length - 1;
      while (nodeIndex > 0 && nodeStartOffsets[nodeIndex] > layerOffset - (isEndPosition ? 1 : 0)) {
        nodeIndex -= 1;
      }
      return { node: textNodes[nodeIndex], offset: layerOffset - nodeStartOffsets[nodeIndex] };
    };
    for (const phraseMatch of layerText.matchAll(savedPhrasePattern)) {
      const matchStart = locatePosition(phraseMatch.index, false);
      const matchEnd = locatePosition(phraseMatch.index + phraseMatch[0].length, true);
      const matchedRange = new Range();
      matchedRange.setStart(matchStart.node, matchStart.offset);
      matchedRange.setEnd(matchEnd.node, matchEnd.offset);
      matchedRanges.push(matchedRange);
    }
  }
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...matchedRanges));
}
