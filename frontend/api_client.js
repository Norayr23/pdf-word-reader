async function postJson(endpointPath, requestPayload, abortSignal) {
  const response = await fetch(endpointPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestPayload),
    signal: abortSignal,
  });
  const responsePayload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorDetail = typeof responsePayload.detail === "string"
      ? responsePayload.detail
      : `HTTP ${response.status}`;
    throw new Error(errorDetail);
  }
  return responsePayload;
}

export function requestQuickLookup(phrase, abortSignal) {
  return postJson("/api/quick-lookup", { phrase }, abortSignal);
}

export function requestPhrasePart(phrase, contextSentence, language, partName, abortSignal) {
  return postJson(
    "/api/phrase-part",
    { phrase, context_sentence: contextSentence, language, part_name: partName },
    abortSignal,
  );
}

export function requestSentenceGrammar(text, language) {
  return postJson("/api/sentence-grammar", { text, language });
}

export function requestSentenceTranslation(text, abortSignal) {
  return postJson("/api/translate-sentence", { text }, abortSignal);
}

export function saveVocabularyEntry(vocabularyEntry) {
  return postJson("/api/vocabulary", vocabularyEntry);
}

export async function listVocabularyEntries() {
  const response = await fetch("/api/vocabulary");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()).entries;
}

export async function deleteVocabularyEntry(vocabularyEntryId) {
  const response = await fetch(`/api/vocabulary/${vocabularyEntryId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

export async function requestRecordedPronunciation(word, abortSignal) {
  const response = await fetch(`/api/recorded-pronunciation?word=${encodeURIComponent(word)}`, { signal: abortSignal });
  if (!response.ok) {
    return null;
  }
  return (await response.json()).audio_url;
}
